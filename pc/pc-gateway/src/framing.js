// Canonical G2 v1 binary framing for the ADB-forwarded localhost socket.
// ponytail: fixed 24-byte header, u16 payload length, one alloc + one copy.
//
// Wire layout (all big-endian):
//   magic          2B  ASCII "G2" (0x47 0x32)
//   version        1B  = 1
//   kind           1B  CONTROL=1 EVENT=2 PCM=3 ARTIFACT=4
//   direction      1B  HOST_TO_DEVICE=1 DEVICE_TO_HOST=2
//   flags          1B
//   sessionId      4B  u32 BE
//   sequence       4B  u32 BE
//   timestampMicros 8B u64 BE
//   payloadLen     2B  u16 BE
//   payload        payloadLen bytes
// Header = 24. Max payload = 4096. PCM payload is exactly 640.

export const FRAME_MAGIC = 'G2'; // 2 ASCII bytes
export const PROTOCOL_VERSION = 1;

export const KIND_CONTROL = 0x01; // ordered JSON commands / call control
export const KIND_EVENT = 0x02; // device -> host events (ringing, hangup, dtmf...)
export const KIND_PCM = 0x03; // binary PCM16 frames
export const KIND_ARTIFACT = 0x04; // finalized recording chunk, host -> device only

export const DIR_HOST_TO_DEVICE = 0x01; // PC -> phone
export const DIR_DEVICE_TO_HOST = 0x02; // phone -> PC

export const HEADER_SIZE = 24;
export const MAX_PAYLOAD = 4096;

// Approved PCM contract: 16 kHz, mono, PCM16 LE, 20 ms frames.
export const PCM_SAMPLE_RATE = 16000;
export const PCM_CHANNELS = 1;
export const FRAME_MS = 20;
export const FRAME_SAMPLES = (PCM_SAMPLE_RATE * FRAME_MS) / 1000; // 320
export const PCM_FRAME_BYTES = FRAME_SAMPLES * PCM_CHANNELS * 2; // 640

const VALID_KINDS = new Set([KIND_CONTROL, KIND_EVENT, KIND_PCM, KIND_ARTIFACT]);
const VALID_DIRS = new Set([DIR_HOST_TO_DEVICE, DIR_DEVICE_TO_HOST]);
const FLAG_MASK = 0x03; // END_OF_STREAM | RETRANSMIT; mirror Kotlin FrameFlags.MASK

/**
 * Encode exactly one frame. All fields validated; never interpolates into a shell.
 * PCM payloads must be exactly PCM_FRAME_BYTES (640); others capped at MAX_PAYLOAD.
 * @returns {Buffer}
 */
export function encodeFrame({
  kind,
  direction,
  flags = 0,
  sessionId,
  sequence,
  timestampMicros,
  payload,
}) {
  if (!Number.isInteger(kind) || !VALID_KINDS.has(kind)) throw new TypeError('invalid kind');
  if (!Number.isInteger(direction) || !VALID_DIRS.has(direction)) throw new TypeError('invalid direction');
  if (!Number.isInteger(flags) || (flags & 0xff) !== flags || (flags & ~FLAG_MASK) !== 0) {
    throw new TypeError('invalid flags: reserved bits must be zero');
  }
  if (!Number.isInteger(sessionId) || sessionId < 0 || sessionId > 0xffffffff) throw new TypeError('invalid sessionId');
  if (!Number.isInteger(sequence) || sequence < 0 || sequence > 0xffffffff) throw new TypeError('invalid sequence');
  if (typeof timestampMicros !== 'bigint' || timestampMicros < 0n || timestampMicros > 0xffffffffffffffffn) throw new TypeError('invalid timestampMicros');
  if (!Buffer.isBuffer(payload)) throw new TypeError('payload must be a Buffer');
  if (kind === KIND_PCM) {
    if (payload.length !== PCM_FRAME_BYTES) throw new RangeError(`PCM frame must be exactly ${PCM_FRAME_BYTES} bytes, got ${payload.length}`);
  } else if (payload.length > MAX_PAYLOAD) {
    throw new RangeError(`payload exceeds MAX_PAYLOAD (${MAX_PAYLOAD})`);
  }

  const buf = Buffer.allocUnsafe(HEADER_SIZE + payload.length);
  buf.write(FRAME_MAGIC, 0, 'ascii');
  buf.writeUInt8(PROTOCOL_VERSION, 2);
  buf.writeUInt8(kind, 3);
  buf.writeUInt8(direction, 4);
  buf.writeUInt8(flags, 5);
  buf.writeUInt32BE(sessionId, 6);
  buf.writeUInt32BE(sequence, 10);
  buf.writeBigUInt64BE(timestampMicros, 14);
  buf.writeUInt16BE(payload.length, 22);
  payload.copy(buf, HEADER_SIZE);
  return buf;
}

export function encodePcmFrame({ direction, sessionId, sequence, timestampMicros, payload, flags = 0 }) {
  return encodeFrame({ kind: KIND_PCM, direction, flags, sessionId, sequence, timestampMicros, payload });
}

export function encodeControlFrame({ direction, sessionId, sequence, timestampMicros, payload, flags = 0 }) {
  return encodeFrame({ kind: KIND_CONTROL, direction, flags, sessionId, sequence, timestampMicros, payload });
}

export function encodeEventFrame({ direction, sessionId, sequence, timestampMicros, payload, flags = 0 }) {
  return encodeFrame({ kind: KIND_EVENT, direction, flags, sessionId, sequence, timestampMicros, payload });
}

export function encodeArtifactFrame({ direction, sessionId, sequence, timestampMicros, payload, flags = 0 }) {
  return encodeFrame({ kind: KIND_ARTIFACT, direction, flags, sessionId, sequence, timestampMicros, payload });
}

/**
 * Decode exactly one frame from a buffer holding [HEADER_SIZE .. HEADER_SIZE+payloadLen].
 * Strict: rejects bad magic/version, unknown kind/direction, over-limit length, truncated
 * payload, AND any trailing bytes after exactly one complete frame (callers must split
 * streams via FrameAccumulator). Returns a plain object; payload is copied (no aliasing).
 */
export function decodeFrame(buf) {
  if (!Buffer.isBuffer(buf)) throw new TypeError('buf must be a Buffer');
  if (buf.length < HEADER_SIZE) throw new RangeError('buffer shorter than 24-byte header');
  if (buf.subarray(0, 2).toString('ascii') !== FRAME_MAGIC) throw new Error('bad magic');
  const version = buf.readUInt8(2);
  if (version !== PROTOCOL_VERSION) throw new Error(`unsupported protocol version ${version}`);
  const kind = buf.readUInt8(3);
  if (!VALID_KINDS.has(kind)) throw new Error(`unknown kind ${kind}`);
  const direction = buf.readUInt8(4);
  if (!VALID_DIRS.has(direction)) throw new Error(`unknown direction ${direction}`);
  const flags = buf.readUInt8(5);
  if ((flags & ~FLAG_MASK) !== 0) throw new Error('invalid flags: reserved bits must be zero');
  const sessionId = buf.readUInt32BE(6);
  const sequence = buf.readUInt32BE(10);
  const timestampMicros = buf.readBigUInt64BE(14);
  const payloadLength = buf.readUInt16BE(22);
  if (payloadLength > MAX_PAYLOAD) throw new RangeError('payload length exceeds MAX_PAYLOAD');
  if (kind === KIND_PCM && payloadLength !== PCM_FRAME_BYTES) {
    throw new RangeError(`PCM frame must be exactly ${PCM_FRAME_BYTES} bytes, got ${payloadLength}`);
  }
  const end = HEADER_SIZE + payloadLength;
  if (buf.length < end) throw new RangeError('truncated payload');
  if (buf.length > end) throw new RangeError('trailing bytes after frame');
  const payload = Buffer.from(buf.subarray(HEADER_SIZE, end)); // copy, no aliasing
  return { version, kind, direction, flags, sessionId, sequence, timestampMicros, payloadLength, payload };
}

/**
 * Streaming accumulator. Feed arbitrary socket chunks; get back complete decoded frames.
 * Bounded + fail-closed: the held buffer is capped at HEADER_SIZE + MAX_PAYLOAD. On any
 * desync (no magic at the head when a full frame should be readable, over-limit length,
 * or a leftover that blows the cap) the accumulator latches `failed=true` and returns no
 * further frames. It does NOT hunt for a later magic: a corrupted stream is closed, not
 * silently reskipped — fail closed rather than feed garbage to callers.
 */
export class FrameAccumulator {
  constructor() {
    this._buf = Buffer.alloc(0);
    this.failed = false;
  }

  /** Maximum bytes we will ever hold waiting for a frame to complete. */
  static get MAX_BUFFER() {
    return HEADER_SIZE + MAX_PAYLOAD;
  }

  push(chunk) {
    if (this.failed) return [];
    if (!chunk || chunk.length === 0) return [];
    this._buf = this._buf.length ? Buffer.concat([this._buf, chunk]) : Buffer.from(chunk);
    const out = [];
    while (true) {
      if (this._buf.length < HEADER_SIZE) break;
      if (this._buf.subarray(0, 2).toString('ascii') !== FRAME_MAGIC) {
        // No resync hunt: a non-magic head where a header should be is a corrupt stream.
        this._fail();
        return out;
      }
      const payloadLength = this._buf.readUInt16BE(22);
      if (payloadLength > MAX_PAYLOAD) {
        this._fail();
        return out;
      }
      const end = HEADER_SIZE + payloadLength;
      if (this._buf.length < end) break;
      out.push(decodeFrame(this._buf.subarray(0, end)));
      this._buf = Buffer.from(this._buf.subarray(end));
      if (this._buf.length === 0) break;
    }
    // The bound applies to bytes retained while waiting for a frame, not to a
    // socket read that legitimately coalesces several complete frames.
    if (this._buf.length > FrameAccumulator.MAX_BUFFER) {
      this._fail();
      return out;
    }
    return out;
  }

  _fail() {
    this.failed = true;
    this._buf = Buffer.alloc(0);
  }

  reset() {
    this.failed = false;
    this._buf = Buffer.alloc(0);
  }
}
