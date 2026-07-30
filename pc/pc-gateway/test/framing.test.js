import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';

import {
  FRAME_MAGIC,
  PROTOCOL_VERSION,
  HEADER_SIZE,
  MAX_PAYLOAD,
  PCM_SAMPLE_RATE,
  PCM_CHANNELS,
  FRAME_MS,
  FRAME_SAMPLES,
  PCM_FRAME_BYTES,
  KIND_CONTROL,
  KIND_EVENT,
  KIND_PCM,
  KIND_ARTIFACT,
  DIR_HOST_TO_DEVICE,
  DIR_DEVICE_TO_HOST,
  encodeFrame,
  decodeFrame,
  FrameAccumulator,
  encodePcmFrame,
  encodeControlFrame,
  encodeEventFrame,
  encodeArtifactFrame,
} from '../src/framing.js';

function loadSharedVectors() {
  const text = readFileSync(new URL('../../../protocol/g2-v1.properties', import.meta.url), 'utf8');
  return Object.fromEntries(text.split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => {
      const separator = line.indexOf('=');
      assert.notEqual(separator, -1, `malformed shared vector line: ${line}`);
      return [line.slice(0, separator), line.slice(separator + 1)];
    }));
}

const SHARED_VECTORS = loadSharedVectors();
const GOLDEN_EMPTY_CONTROL = SHARED_VECTORS['emptyControl.hex'];

test('shared protocol vectors encode decode and reject identically in JavaScript', () => {
  assert.equal(SHARED_VECTORS.magic, FRAME_MAGIC);
  assert.equal(Number(SHARED_VECTORS.version), PROTOCOL_VERSION);
  assert.equal(Number(SHARED_VECTORS.headerSize), HEADER_SIZE);
  assert.equal(Number(SHARED_VECTORS.maxPayload), MAX_PAYLOAD);
  assert.equal(Number(SHARED_VECTORS.pcmBytes), PCM_FRAME_BYTES);

  const expected = Buffer.from(GOLDEN_EMPTY_CONTROL, 'hex');
  const encoded = encodeFrame({
    kind: Number(SHARED_VECTORS['emptyControl.kind']),
    direction: Number(SHARED_VECTORS['emptyControl.direction']),
    flags: Number(SHARED_VECTORS['emptyControl.flags']),
    sessionId: Number(SHARED_VECTORS['emptyControl.sessionId']),
    sequence: Number(SHARED_VECTORS['emptyControl.sequence']),
    timestampMicros: BigInt(SHARED_VECTORS['emptyControl.timestampMicros']),
    payload: Buffer.alloc(0),
  });
  assert.deepEqual(encoded, expected);
  assert.equal(decodeFrame(expected).kind, KIND_CONTROL);

  for (const name of [
    'reject.badMagic.hex',
    'reject.badVersion.hex',
    'reject.badKind.hex',
    'reject.badDirection.hex',
    'reject.reservedFlags.hex',
    'reject.oversizeDeclaredPayload.hex',
    'reject.shortHeader.hex',
    'reject.trailingBytes.hex',
  ]) {
    assert.throws(() => decodeFrame(Buffer.from(SHARED_VECTORS[name], 'hex')), undefined, name);
  }
});

test('shared authentication vectors fix nonce order domains and session endianness in JavaScript', () => {
  const secret = Buffer.from(SHARED_VECTORS['auth.secret.hex'], 'hex');
  const serverNonce = Buffer.from(SHARED_VECTORS['auth.serverNonce.hex'], 'hex');
  const clientNonce = Buffer.from(SHARED_VECTORS['auth.clientNonce.hex'], 'hex');
  const proof = (domain) => createHmac('sha256', secret)
    .update(domain, 'ascii')
    .update(serverNonce)
    .update(clientNonce)
    .digest();

  assert.equal(proof('agentcall-controller-client-v1\0').toString('hex'), SHARED_VECTORS['auth.clientProof.hex']);
  assert.equal(proof('agentcall-controller-server-v1\0').toString('hex'), SHARED_VECTORS['auth.serverProof.hex']);
  const sessionDigest = proof('agentcall-controller-session-v1\0');
  assert.equal(sessionDigest.toString('hex'), SHARED_VECTORS['auth.sessionDigest.hex']);
  assert.equal(sessionDigest.subarray(0, 4).toString('hex'), SHARED_VECTORS['auth.sessionId.hex']);
});

test('wire constants match the canonical G2 v1 contract', () => {
  assert.equal(FRAME_MAGIC, 'G2');
  assert.equal(FRAME_MAGIC.length, 2);
  assert.equal(PROTOCOL_VERSION, 1);
  assert.equal(HEADER_SIZE, 24);
  assert.equal(MAX_PAYLOAD, 4096);
  assert.equal(KIND_CONTROL, 1);
  assert.equal(KIND_EVENT, 2);
  assert.equal(KIND_PCM, 3);
  assert.equal(KIND_ARTIFACT, 4);
  assert.equal(DIR_HOST_TO_DEVICE, 1);
  assert.equal(DIR_DEVICE_TO_HOST, 2);
});

test('PCM frame is exactly 640 bytes (16k mono 20ms PCM16 LE)', () => {
  assert.equal(PCM_SAMPLE_RATE, 16000);
  assert.equal(PCM_CHANNELS, 1);
  assert.equal(FRAME_MS, 20);
  assert.equal(FRAME_SAMPLES, 320);
  assert.equal(PCM_FRAME_BYTES, 640);
});

test('encodeFrame of an empty CONTROL frame matches the golden hex byte-for-byte', () => {
  const buf = encodeFrame({
    kind: KIND_CONTROL,
    direction: DIR_HOST_TO_DEVICE,
    flags: 0,
    sessionId: 1,
    sequence: 42,
    timestampMicros: 1000n,
    payload: Buffer.alloc(0),
  });
  assert.equal(buf.length, HEADER_SIZE);
  assert.equal(buf.toString('hex'), GOLDEN_EMPTY_CONTROL);
  // Field-by-field confirmation against the golden layout.
  assert.equal(buf.subarray(0, 2).toString('ascii'), 'G2');
  assert.equal(buf.readUInt8(2), PROTOCOL_VERSION);
  assert.equal(buf.readUInt8(3), KIND_CONTROL);
  assert.equal(buf.readUInt8(4), DIR_HOST_TO_DEVICE);
  assert.equal(buf.readUInt8(5), 0); // flags
  assert.equal(buf.readUInt32BE(6), 1); // session
  assert.equal(buf.readUInt32BE(10), 42); // sequence
  assert.equal(buf.readBigUInt64BE(14), 1000n); // timestampMicros
  assert.equal(buf.readUInt16BE(22), 0); // payloadLen u16 BE
});

test('decodeFrame round-trips the golden empty CONTROL hex', () => {
  const decoded = decodeFrame(Buffer.from(GOLDEN_EMPTY_CONTROL, 'hex'));
  assert.equal(decoded.version, PROTOCOL_VERSION);
  assert.equal(decoded.kind, KIND_CONTROL);
  assert.equal(decoded.direction, DIR_HOST_TO_DEVICE);
  assert.equal(decoded.flags, 0);
  assert.equal(decoded.sessionId, 1);
  assert.equal(decoded.sequence, 42);
  assert.equal(decoded.timestampMicros, 1000n);
  assert.equal(decoded.payloadLength, 0);
  assert.equal(decoded.payload.length, 0);
});

test('encodePcmFrame attaches a 640-byte PCM payload and round-trips', () => {
  const pcm = Buffer.alloc(PCM_FRAME_BYTES, 0x01);
  const buf = encodePcmFrame({
    direction: DIR_HOST_TO_DEVICE,
    sessionId: 7,
    sequence: 3,
    timestampMicros: 55n,
    payload: pcm,
  });
  assert.equal(buf.length, HEADER_SIZE + PCM_FRAME_BYTES);
  assert.equal(buf.readUInt16BE(22), PCM_FRAME_BYTES);
  const decoded = decodeFrame(buf);
  assert.equal(decoded.kind, KIND_PCM);
  assert.equal(decoded.direction, DIR_HOST_TO_DEVICE);
  assert.equal(decoded.sessionId, 7);
  assert.equal(decoded.sequence, 3);
  assert.equal(decoded.timestampMicros, 55n);
  assert.equal(decoded.payloadLength, PCM_FRAME_BYTES);
  assert.deepEqual(decoded.payload, pcm);
});

test('encodeFrame rejects a PCM payload that is not exactly 640 bytes', () => {
  for (const len of [0, 1, 639, 641, 1280]) {
    assert.throws(
      () => encodeFrame({
        kind: KIND_PCM,
        direction: DIR_HOST_TO_DEVICE,
        sessionId: 1,
        sequence: 1,
        timestampMicros: 0n,
        payload: Buffer.alloc(len),
      }),
      /640|pcm/i,
      `expected rejection for PCM length ${len}`,
    );
  }
});

test('encodeFrame rejects a payload exceeding MAX_PAYLOAD (4096) for non-PCM kinds', () => {
  const tooBig = Buffer.alloc(MAX_PAYLOAD + 1, 0);
  assert.throws(
    () => encodeFrame({
      kind: KIND_EVENT,
      direction: DIR_HOST_TO_DEVICE,
      sessionId: 1,
      sequence: 1,
      timestampMicros: 0n,
      payload: tooBig,
    }),
    /payload/i,
  );
});

test('encodeFrame rejects unknown kind / direction / range values', () => {
  const base = { sessionId: 1, sequence: 1, timestampMicros: 0n, payload: Buffer.alloc(0) };
  assert.throws(() => encodeFrame({ ...base, kind: 0, direction: DIR_HOST_TO_DEVICE }), /kind/i);
  assert.throws(() => encodeFrame({ ...base, kind: 9, direction: DIR_HOST_TO_DEVICE }), /kind/i);
  assert.throws(() => encodeFrame({ ...base, kind: KIND_CONTROL, direction: 0 }), /direction/i);
  assert.throws(() => encodeFrame({ ...base, kind: KIND_CONTROL, direction: 9 }), /direction/i);
  assert.throws(() => encodeFrame({ ...base, kind: KIND_CONTROL, direction: DIR_HOST_TO_DEVICE, sessionId: 0x100000000 }), /session/i);
  assert.throws(() => encodeFrame({ ...base, kind: KIND_CONTROL, direction: DIR_HOST_TO_DEVICE, sequence: -1 }), /sequence/i);
  assert.throws(() => encodeFrame({ ...base, kind: KIND_CONTROL, direction: DIR_HOST_TO_DEVICE, timestampMicros: -1n }), /timestamp/i);
});

test('encodeFrame rejects a non-Buffer payload', () => {
  assert.throws(
    () => encodeFrame({
      kind: KIND_CONTROL,
      direction: DIR_HOST_TO_DEVICE,
      sessionId: 1,
      sequence: 1,
      timestampMicros: 0n,
      payload: 'nope',
    }),
    /payload/i,
  );
});

test('decodeFrame rejects a buffer shorter than the 24-byte header', () => {
  assert.throws(() => decodeFrame(Buffer.alloc(HEADER_SIZE - 1)), /header/i);
});

test('decodeFrame rejects truncated payload (claimed length exceeds buffer)', () => {
  const buf = encodeFrame({
    kind: KIND_EVENT,
    direction: DIR_DEVICE_TO_HOST,
    sessionId: 1,
    sequence: 1,
    timestampMicros: 0n,
    payload: Buffer.alloc(10),
  });
  assert.throws(() => decodeFrame(buf.subarray(0, buf.length - 1)), /truncat/i);
});

test('decodeFrame rejects a claimed payload length over MAX_PAYLOAD', () => {
  const buf = encodeFrame({
    kind: KIND_CONTROL,
    direction: DIR_HOST_TO_DEVICE,
    sessionId: 1,
    sequence: 1,
    timestampMicros: 0n,
    payload: Buffer.alloc(0),
  });
  const bad = Buffer.from(buf);
  bad.writeUInt16BE(MAX_PAYLOAD + 1, 22);
  assert.throws(() => decodeFrame(bad), /payload/i);
});

test('decodeFrame rejects wrong magic and unsupported version', () => {
  const good = encodeFrame({
    kind: KIND_CONTROL,
    direction: DIR_HOST_TO_DEVICE,
    sessionId: 1,
    sequence: 1,
    timestampMicros: 0n,
    payload: Buffer.alloc(0),
  });
  const badMagic = Buffer.from(good);
  badMagic.write('XX', 0, 'ascii');
  assert.throws(() => decodeFrame(badMagic), /magic/i);
  const badVer = Buffer.from(good);
  badVer.writeUInt8(99, 2);
  assert.throws(() => decodeFrame(badVer), /version/i);
});

test('decodeFrame strictly rejects trailing bytes after one complete frame', () => {
  const one = encodeFrame({
    kind: KIND_CONTROL,
    direction: DIR_HOST_TO_DEVICE,
    sessionId: 1,
    sequence: 1,
    timestampMicros: 0n,
    payload: Buffer.alloc(0),
  });
  const withTrailing = Buffer.concat([one, Buffer.from([0x00, 0x01])]);
  assert.throws(() => decodeFrame(withTrailing), /trailing/i);
});

test('decodeFrame rejects an unknown kind byte', () => {
  const good = encodeFrame({
    kind: KIND_CONTROL,
    direction: DIR_HOST_TO_DEVICE,
    sessionId: 1,
    sequence: 1,
    timestampMicros: 0n,
    payload: Buffer.alloc(0),
  });
  const badKind = Buffer.from(good);
  badKind.writeUInt8(0x07, 3); // not 1/2/3
  assert.throws(() => decodeFrame(badKind), /kind/i);
});

test('encode and decode reject reserved flag bits like the Kotlin codec', () => {
  const base = {
    kind: KIND_CONTROL,
    direction: DIR_HOST_TO_DEVICE,
    sessionId: 1,
    sequence: 1,
    timestampMicros: 0n,
    payload: Buffer.alloc(0),
  };
  assert.throws(() => encodeFrame({ ...base, flags: 0x04 }), /flag|reserved/i);
  const wire = encodeFrame({ ...base, flags: 0x03 });
  wire.writeUInt8(0x80, 5);
  assert.throws(() => decodeFrame(wire), /flag|reserved/i);
});

test('specialized encoders set the right kind including bounded artifact chunks', () => {
  const c = encodeControlFrame({ direction: DIR_HOST_TO_DEVICE, sessionId: 1, sequence: 1, timestampMicros: 0n, payload: Buffer.alloc(0) });
  assert.equal(decodeFrame(c).kind, KIND_CONTROL);
  const e = encodeEventFrame({ direction: DIR_DEVICE_TO_HOST, sessionId: 1, sequence: 1, timestampMicros: 0n, payload: Buffer.from('{}', 'utf8') });
  assert.equal(decodeFrame(e).kind, KIND_EVENT);
  assert.equal(decodeFrame(e).payload.toString('utf8'), '{}');
  const a = encodeArtifactFrame({ direction: DIR_HOST_TO_DEVICE, sessionId: 1, sequence: 2, timestampMicros: 0n, payload: Buffer.alloc(MAX_PAYLOAD, 7) });
  assert.equal(decodeFrame(a).kind, KIND_ARTIFACT);
  assert.equal(decodeFrame(a).payload.length, MAX_PAYLOAD);
});

test('FrameAccumulator yields complete frames across arbitrary chunk boundaries', () => {
  const acc = new FrameAccumulator();
  const f1 = encodePcmFrame({
    direction: DIR_DEVICE_TO_HOST,
    sessionId: 1,
    sequence: 1,
    timestampMicros: 1n,
    payload: Buffer.alloc(PCM_FRAME_BYTES, 0xa),
  });
  const f2 = encodeControlFrame({
    direction: DIR_DEVICE_TO_HOST,
    sessionId: 1,
    sequence: 2,
    timestampMicros: 2n,
    payload: Buffer.from('{}', 'utf8'),
  });
  const combined = Buffer.concat([f1, f2]);
  const out = [];
  for (let i = 0; i < combined.length; i += 13) {
    out.push(...acc.push(combined.subarray(i, i + 13)));
  }
  assert.equal(out.length, 2);
  assert.equal(out[0].kind, KIND_PCM);
  assert.equal(out[0].sequence, 1);
  assert.equal(out[1].kind, KIND_CONTROL);
  assert.equal(out[1].sequence, 2);
  assert.equal(acc.failed, false);
});

test('FrameAccumulator drains multiple coalesced maximum frames before enforcing held-byte bound', () => {
  const acc = new FrameAccumulator();
  const make = (sequence) => encodeFrame({
    kind: KIND_EVENT,
    direction: DIR_DEVICE_TO_HOST,
    sessionId: 1,
    sequence,
    timestampMicros: BigInt(sequence),
    payload: Buffer.alloc(MAX_PAYLOAD, sequence),
  });
  const out = acc.push(Buffer.concat([make(1), make(2)]));
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((f) => f.sequence), [1, 2]);
  assert.equal(acc.failed, false);
});

test('FrameAccumulator fails closed on garbage that never syncs to magic', () => {
  const acc = new FrameAccumulator();
  const garbage = Buffer.from('NOTG2GARBAGEHEREXXXXXXXXXXXXXXXX', 'ascii');
  const real = encodePcmFrame({
    direction: DIR_DEVICE_TO_HOST,
    sessionId: 1,
    sequence: 1,
    timestampMicros: 1n,
    payload: Buffer.alloc(PCM_FRAME_BYTES),
  });
  // First push: garbage with no magic in reach -> fail closed, no frames.
  const first = acc.push(garbage);
  assert.equal(first.length, 0);
  assert.equal(acc.failed, true);
  // Once failed, the accumulator stays closed even if valid frames arrive later.
  const after = acc.push(real);
  assert.equal(after.length, 0);
  assert.equal(acc.failed, true);
});

test('FrameAccumulator fails closed when leftover exceeds the bounded buffer cap', () => {
  const acc = new FrameAccumulator();
  // A huge chunk with no valid magic and no resync point: bounded buffer must reject it.
  const huge = Buffer.alloc(HEADER_SIZE + MAX_PAYLOAD + 1024, 0x41);
  const out = acc.push(huge);
  assert.equal(out.length, 0);
  assert.equal(acc.failed, true);
});

test('FrameAccumulator fails closed on a header claiming an over-limit payload length', () => {
  const acc = new FrameAccumulator();
  const good = encodeFrame({
    kind: KIND_CONTROL,
    direction: DIR_HOST_TO_DEVICE,
    sessionId: 1,
    sequence: 1,
    timestampMicros: 0n,
    payload: Buffer.alloc(0),
  });
  const bad = Buffer.from(good);
  bad.writeUInt16BE(MAX_PAYLOAD + 1, 22);
  const out = acc.push(bad);
  assert.equal(out.length, 0);
  assert.equal(acc.failed, true);
});
