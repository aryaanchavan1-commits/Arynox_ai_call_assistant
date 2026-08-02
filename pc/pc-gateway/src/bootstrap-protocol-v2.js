import { timingSafeEqual } from 'node:crypto';

const MAGIC = Buffer.from('G2B2', 'ascii');
export const MAX_MESSAGE_BYTES = 4096;
const TEXT_LIMITS = Object.freeze([128, 128, 128, 512, 512, 255, 64]);

function canonicalText(value, max) {
  if (typeof value !== 'string' || value.length === 0 || value !== value.normalize('NFC') || /[\x00-\x1f\x7f]/u.test(value)) throw new Error('text must be canonical NFC UTF-8');
  for (let at = 0; at < value.length; at += 1) {
    const unit = value.charCodeAt(at);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const low = value.charCodeAt(at + 1);
      if (!(low >= 0xdc00 && low <= 0xdfff)) throw new Error('text must be canonical NFC UTF-8');
      at += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new Error('text must be canonical NFC UTF-8');
    }
  }
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length > max) throw new Error('text exceeds v2 limit');
  return bytes;
}
function exact(value, name) { if (!Buffer.isBuffer(value) || value.length !== 32 || value.every((byte) => byte === 0)) throw new Error(`${name} must be a nonzero 32-byte value`); }
function u32(value) { if (!Number.isInteger(value) || value <= 0 || value > 0x7fffffff) throw new Error('invalid v2 integer'); const out = Buffer.alloc(4); out.writeUInt32BE(value); return out; }
function text(value, max) { const bytes = canonicalText(value, max); const size = Buffer.alloc(2); size.writeUInt16BE(bytes.length); return Buffer.concat([size, bytes]); }

function validate(value) {
  if (!value || !value.identity) throw new Error('v2 transcript is invalid');
  for (const [name, bytes] of [['desktop nonce', value.desktopNonce], ['phone nonce', value.phoneNonce], ['desktop public key', value.desktopPublicKey], ['phone public key', value.phonePublicKey]]) exact(bytes, name);
  if (value.desktopNonce.equals(value.phoneNonce) || value.desktopPublicKey.equals(value.phonePublicKey)) throw new Error('v2 reflection is invalid');
  const i = value.identity;
  if (i.desktopBootstrapVersion !== 2) throw new Error('v2 downgrade is invalid');
  u32(i.api); u32(i.versionCode); u32(i.desktopBootstrapVersion);
  exact(i.signingCertificateSha256, 'signing digest'); exact(i.matchedManifestSha256, 'manifest digest');
  [i.adbSerial, i.product, i.device, i.systemFingerprint, i.vendorFingerprint, i.packageName, i.desktopPackageVersion].forEach((v, n) => canonicalText(v, TEXT_LIMITS[n]));
}

export function encodeTranscript(value) {
  validate(value); const i = value.identity;
  const bytes = Buffer.concat([MAGIC, Buffer.from([2, 1, 0, 0]), value.desktopNonce, value.phoneNonce, value.desktopPublicKey, value.phonePublicKey,
    text(i.adbSerial, 128), text(i.product, 128), text(i.device, 128), u32(i.api), text(i.systemFingerprint, 512), text(i.vendorFingerprint, 512),
    text(i.packageName, 255), u32(i.versionCode), i.signingCertificateSha256, i.matchedManifestSha256, u32(i.desktopBootstrapVersion), text(i.desktopPackageVersion, 64)]);
  if (bytes.length > MAX_MESSAGE_BYTES) throw new Error('v2 transcript exceeds limit');
  return bytes;
}

function digestEqual(expected, actual) {
  return Buffer.isBuffer(expected) && Buffer.isBuffer(actual) && expected.length === 32 && actual.length === 32 && timingSafeEqual(expected, actual);
}
function identityMatches(expected, actual) {
  if (!expected || typeof expected !== 'object') return false;
  return expected.adbSerial === actual.adbSerial && expected.product === actual.product && expected.device === actual.device &&
    expected.api === actual.api && expected.systemFingerprint === actual.systemFingerprint && expected.vendorFingerprint === actual.vendorFingerprint &&
    expected.packageName === actual.packageName && expected.versionCode === actual.versionCode &&
    digestEqual(expected.signingCertificateSha256, actual.signingCertificateSha256) && digestEqual(expected.matchedManifestSha256, actual.matchedManifestSha256) &&
    expected.desktopBootstrapVersion === actual.desktopBootstrapVersion && expected.desktopPackageVersion === actual.desktopPackageVersion;
}

export function decodeTranscript(bytes, expectedIdentity) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > MAX_MESSAGE_BYTES) throw new Error('invalid v2 transcript length');
  let at = 0; const take = (n) => { if (at + n > bytes.length) throw new Error('truncated v2 transcript'); const out = bytes.subarray(at, at + n); at += n; return Buffer.from(out); };
  if (!take(4).equals(MAGIC) || take(1)[0] !== 2 || take(1)[0] !== 1 || !take(2).equals(Buffer.alloc(2))) throw new Error('invalid v2 header');
  const readText = (max) => { const size = take(2).readUInt16BE(); if (size < 1 || size > max) throw new Error('invalid v2 text length'); const raw = take(size); const decoded = new TextDecoder('utf-8', { fatal: true }).decode(raw); if (!Buffer.from(decoded, 'utf8').equals(raw)) throw new Error('noncanonical UTF-8'); canonicalText(decoded, max); return decoded; };
  const readU32 = () => { const n = take(4).readUInt32BE(); if (n < 1 || n > 0x7fffffff) throw new Error('invalid v2 integer'); return n; };
  const value = { desktopNonce: take(32), phoneNonce: take(32), desktopPublicKey: take(32), phonePublicKey: take(32), identity: {} };
  const i = value.identity; i.adbSerial = readText(128); i.product = readText(128); i.device = readText(128); i.api = readU32(); i.systemFingerprint = readText(512); i.vendorFingerprint = readText(512); i.packageName = readText(255); i.versionCode = readU32(); i.signingCertificateSha256 = take(32); i.matchedManifestSha256 = take(32); i.desktopBootstrapVersion = readU32(); i.desktopPackageVersion = readText(64);
  if (at !== bytes.length) throw new Error('trailing v2 bytes'); validate(value);
  if (expectedIdentity && !identityMatches(expectedIdentity, i)) throw new Error('v2 identity mismatch');
  return value;
}

export function syntheticTranscript() {
  return { desktopNonce: Buffer.from(Array.from({ length: 32 }, (_, n) => n + 1)), phoneNonce: Buffer.from(Array.from({ length: 32 }, (_, n) => n + 33)), desktopPublicKey: Buffer.from(Array.from({ length: 32 }, (_, n) => n + 65)), phonePublicKey: Buffer.from(Array.from({ length: 32 }, (_, n) => n + 97)), identity: { adbSerial: 'SYNTHETIC-ADB-0001', product: 'synthetic_product', device: 'synthetic_device', api: 35, systemFingerprint: 'synthetic/system/device:15/AP3A/public:user/release-keys', vendorFingerprint: 'synthetic/vendor/device:15/AP3A/public:user/release-keys', packageName: 'com.callagent.gateway', versionCode: 332, signingCertificateSha256: Buffer.alloc(32, 0x55), matchedManifestSha256: Buffer.alloc(32, 0x66), desktopBootstrapVersion: 2, desktopPackageVersion: '1.0.0' } };
}
