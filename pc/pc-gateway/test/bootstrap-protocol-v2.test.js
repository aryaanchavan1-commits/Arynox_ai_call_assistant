import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { decodeTranscript, encodeTranscript } from '../src/bootstrap-protocol-v2.js';

const protocol = new URL('../../../protocol/', import.meta.url);
const props = (text) => Object.fromEntries(text.trimEnd().split(/\r?\n/u).map((line) => { const at = line.indexOf('='); assert(at > 0); return [line.slice(0, at), line.slice(at + 1)]; }));
const expectedNames = new Set(['unknownVersion', 'unknownType', 'reserved', 'trailing', 'truncated', 'overlongAdbSerial', 'malformedUtf8', 'noncanonicalUtf8', 'zeroDesktopNonce', 'zeroPhoneNonce', 'zeroDesktopKey', 'zeroPhoneKey', 'nonceReflection', 'keyReflection', 'productDrift', 'deviceDrift', 'apiDrift', 'systemFingerprintDrift', 'vendorFingerprintDrift', 'packageDrift', 'versionDrift', 'signerDrift', 'manifestDrift', 'downgrade', 'desktopPackageDrift', 'adbSerialDrift']);

function strictDecimal(value) { assert.match(value, /^(?:0|[1-9]\d*)$/); const n = Number(value); assert(Number.isSafeInteger(n)); return n; }
function strictHex(value) { assert.match(value, /^(?:[0-9a-f]{2})+$/); return Buffer.from(value, 'hex'); }
function mutate(valid, spec) {
  assert(spec.length > 0); let bytes = Buffer.from(valid);
  for (const operation of spec.split(';')) {
    const p = operation.split(':');
    if (p[0] === 'set') { assert.equal(p.length, 3); const at = strictDecimal(p[1]); const value = strictHex(p[2]); assert(at <= bytes.length - value.length); value.copy(bytes, at); }
    else if (p[0] === 'zero') { assert.equal(p.length, 3); const at = strictDecimal(p[1]); const count = strictDecimal(p[2]); assert(count > 0 && at <= bytes.length - count); bytes.fill(0, at, at + count); }
    else if (p[0] === 'copy') { assert.equal(p.length, 4); const from = strictDecimal(p[1]); const to = strictDecimal(p[2]); const count = strictDecimal(p[3]); assert(count > 0 && from <= bytes.length - count && to <= bytes.length - count); Buffer.from(bytes.subarray(from, from + count)).copy(bytes, to); }
    else if (p[0] === 'append') { assert.equal(p.length, 2); bytes = Buffer.concat([bytes, strictHex(p[1])]); assert(bytes.length <= 4096); }
    else if (p[0] === 'truncate') { assert.equal(p.length, 2); const count = strictDecimal(p[1]); assert(count > 0 && count < bytes.length); bytes = bytes.subarray(0, bytes.length - count); }
    else throw new Error('unknown mutation operation');
  }
  return bytes;
}
function mutateIdentity(identity, spec) {
  const p = spec.split(':'); assert.equal(p.length, 2); assert.equal(p[0], 'identity');
  const field = p[1]; const supported = new Set(['adbSerial', 'product', 'device', 'api', 'systemFingerprint', 'vendorFingerprint', 'packageName', 'versionCode', 'signingCertificateSha256', 'matchedManifestSha256', 'desktopBootstrapVersion', 'desktopPackageVersion']);
  assert(supported.has(field)); const changed = { ...identity };
  if (field.endsWith('Sha256')) changed[field] = Buffer.alloc(32, 1);
  else if (field === 'api') changed[field] = 34;
  else if (field === 'versionCode') changed[field] = 329;
  else if (field === 'desktopBootstrapVersion') changed[field] = 1;
  else changed[field] = field === 'desktopPackageVersion' ? '0.2.2' : 'drift';
  return changed;
}

test('shared positive transcript is canonical', async () => {
  const vectors = props(await readFile(new URL('bootstrap-v2-vectors.properties', protocol), 'ascii'));
  const hex = vectors['positive.transcript.hex']; assert.match(hex, /^(?:[0-9a-f]{2})+$/);
  const bytes = Buffer.from(hex, 'hex'); assert(bytes.length > 0); assert.deepEqual(encodeTranscript(decodeTranscript(bytes)), bytes);
});

test('production source uses textual control escapes and contains no raw controls', async () => {
  const source = await readFile(new URL('../src/bootstrap-protocol-v2.js', import.meta.url));
  assert(source.includes(Buffer.from('/[\\x00-\\x1f\\x7f]/u', 'ascii')));
  const disallowed = [...source].filter((byte) => (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) || byte === 0x7f);
  assert.deepEqual(disallowed, []);
});

test('public transcript APIs reject NUL C0 and DEL text', async () => {
  const vectors = props(await readFile(new URL('bootstrap-v2-vectors.properties', protocol), 'ascii'));
  const valid = strictHex(vectors['positive.transcript.hex']);
  const transcript = decodeTranscript(valid);
  const adbSerial = Buffer.from(transcript.identity.adbSerial, 'utf8');
  const adbSerialAt = valid.indexOf(adbSerial);
  assert(adbSerialAt >= 0);

  for (const control of [0x00, 0x01, 0x1f, 0x7f]) {
    const invalidText = `invalid${String.fromCharCode(control)}text`;
    assert.throws(() => encodeTranscript({ ...transcript, identity: { ...transcript.identity, adbSerial: invalidText } }), /canonical NFC UTF-8/);

    const invalidBytes = Buffer.from(valid);
    invalidBytes[adbSerialAt] = control;
    assert.throws(() => decodeTranscript(invalidBytes), /canonical NFC UTF-8/);
  }
});

test('encoder rejects unpaired surrogates in every text identity field', async () => {
  const vectors = props(await readFile(new URL('bootstrap-v2-vectors.properties', protocol), 'ascii'));
  const transcript = decodeTranscript(strictHex(vectors['positive.transcript.hex']));
  const fields = ['adbSerial', 'product', 'device', 'systemFingerprint', 'vendorFingerprint', 'packageName', 'desktopPackageVersion'];
  for (const surrogate of ['\uD800', '\uDC00']) {
    for (const field of fields) {
      assert.throws(
        () => encodeTranscript({ ...transcript, identity: { ...transcript.identity, [field]: surrogate } }),
        /canonical NFC UTF-8/,
        `${field} must reject an unpaired surrogate`,
      );
    }
  }
});

test('shared mutation corpus is strict complete and non-vacuous', async () => {
  const positive = props(await readFile(new URL('bootstrap-v2-vectors.properties', protocol), 'ascii'));
  const corpus = props(await readFile(new URL('bootstrap-v2-negative.properties', protocol), 'ascii'));
  assert.deepEqual(new Set(Object.keys(corpus)), expectedNames);
  const valid = strictHex(positive['positive.transcript.hex']); const expected = decodeTranscript(valid).identity; const ran = new Set();
  for (const [name, spec] of Object.entries(corpus)) {
    if (spec.startsWith('identity:')) {
      const drift = mutateIdentity(expected, spec); assert.notDeepEqual(drift, expected);
      if (name === 'downgrade') assert.throws(() => encodeTranscript({ ...decodeTranscript(valid), identity: drift }), undefined, name);
      else { const changed = encodeTranscript({ ...decodeTranscript(valid), identity: drift }); assert(!changed.equals(valid)); assert.throws(() => decodeTranscript(changed, expected), /identity mismatch/, name); }
    } else { const changed = mutate(valid, spec); assert(!changed.equals(valid), name); assert.throws(() => decodeTranscript(changed), undefined, name); }
    assert(!ran.has(name)); ran.add(name);
  }
  assert.deepEqual(ran, expectedNames);
});

test('mutation grammar rejects unknown malformed and empty operations', () => {
  const bytes = Buffer.alloc(200, 1);
  for (const spec of ['', 'unknown:1', 'set:1:f', 'set:-1:00', 'append:', 'truncate:0', 'zero:1', 'copy:1:2:999']) assert.throws(() => mutate(bytes, spec));
});
