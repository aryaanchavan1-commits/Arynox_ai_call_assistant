import {
  createCipheriv, createDecipheriv, createPublicKey, diffieHellman, hkdfSync,
} from 'node:crypto';

export const BOOTSTRAP_INFO = 'agentcall/controller-bootstrap/v1';
export const BOOTSTRAP_MAX_FRAME_BYTES = 4096;
export const BOOTSTRAP_PROOF_BYTES = Buffer.byteLength('agentcall-bootstrap-proof-v1');
const TRANSCRIPT_PREFIX = Buffer.from('agentcall/controller-bootstrap/transcript/v1', 'ascii');
const CLIENT_MAGIC = Buffer.from('G2B1', 'ascii');
const PROOF_PLAINTEXT = Buffer.from('agentcall-bootstrap-proof-v1', 'ascii');
const RAW_X25519_SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');
const IDENTITY_FIELDS = Object.freeze([
  'serial', 'product', 'device', 'api', 'systemFingerprint', 'vendorFingerprint',
  'packageName', 'versionCode', 'signingCertSha256', 'artifactManifestSha256',
  'desktopBootstrapVersion',
]);
const ANDROID_IDENTITY_FIELDS = Object.freeze([
  'serial', 'systemFingerprint', 'vendorFingerprint', 'packageName', 'versionCode',
  'signingCertSha256', 'artifactManifestSha256', 'desktopBootstrapVersion',
]);
const HEX_256_RE = /^[a-f0-9]{64}$/;
const TOKEN_RE = /^[A-Za-z0-9._:/-]{1,512}$/;
const UNPAIRED_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function exactBuffer(value, name) {
  if (!Buffer.isBuffer(value) || value.length !== 32) throw new Error(`${name} must contain exactly 32 bytes`);
}

function strictText(value, name) {
  const text = String(value);
  if (text.includes('\0') || UNPAIRED_SURROGATE_RE.test(text)) throw new Error(`bootstrap ${name} identity is invalid`);
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length < 1 || bytes.length > 512) throw new Error(`bootstrap ${name} identity exceeds the 512-byte limit`);
  return bytes;
}

function validateIdentity(identity) {
  if (!identity || typeof identity !== 'object' || Array.isArray(identity)
      || Object.keys(identity).length !== IDENTITY_FIELDS.length
      || !IDENTITY_FIELDS.every((field) => Object.hasOwn(identity, field))) {
    throw new Error('bootstrap identity fields must match the v1 schema exactly');
  }
  for (const field of ['serial', 'product', 'device', 'systemFingerprint', 'vendorFingerprint', 'packageName']) {
    if (typeof identity[field] !== 'string' || !TOKEN_RE.test(identity[field])) throw new Error(`bootstrap ${field} is invalid`);
  }
  if (identity.api !== 35) throw new Error('bootstrap api must be exactly 35');
  if (!Number.isSafeInteger(identity.versionCode) || identity.versionCode < 1) throw new Error('bootstrap versionCode is invalid');
  if (identity.desktopBootstrapVersion !== 1) throw new Error('bootstrap desktop version downgrade is not allowed');
  if (!HEX_256_RE.test(identity.signingCertSha256) || !HEX_256_RE.test(identity.artifactManifestSha256)) {
    throw new Error('bootstrap artifact digest is invalid');
  }
  for (const name of ANDROID_IDENTITY_FIELDS) strictText(identity[name], name);
}

function encodedText(value, name) {
  const bytes = strictText(value, name);
  const length = Buffer.alloc(2);
  length.writeUInt16BE(bytes.length);
  return Buffer.concat([length, bytes]);
}

export function encodeClientHello({ identity, desktopNonce, desktopPublicKey }) {
  validateIdentity(identity);
  exactBuffer(desktopNonce, 'desktop nonce');
  exactBuffer(desktopPublicKey, 'desktop public key');
  if (!desktopPublicKey.some((byte) => byte !== 0)) throw new Error('desktop public key must be non-zero');
  const header = Buffer.from([0x47, 0x32, 0x42, 0x31, 1, 1, 0, 0]);
  const frame = Buffer.concat([
    header, desktopNonce, desktopPublicKey,
    ...ANDROID_IDENTITY_FIELDS.map((name) => encodedText(identity[name], name)),
  ]);
  if (frame.length > BOOTSTRAP_MAX_FRAME_BYTES) throw new Error('bootstrap client hello exceeds 4096 bytes');
  return frame;
}

export function canonicalTranscript({ identity, desktopNonce, phoneNonce, desktopPublicKey, phonePublicKey }) {
  exactBuffer(phoneNonce, 'phone nonce');
  exactBuffer(phonePublicKey, 'phone public key');
  if (!phonePublicKey.some((byte) => byte !== 0)) throw new Error('phone public key must be non-zero');
  const hello = encodeClientHello({ identity, desktopNonce, desktopPublicKey });
  const length = Buffer.alloc(2);
  length.writeUInt16BE(hello.length);
  return Buffer.concat([TRANSCRIPT_PREFIX, length, hello, phoneNonce, phonePublicKey]);
}

function publicKeyFromRaw(raw) {
  exactBuffer(raw, 'peer public key');
  if (!raw.some((byte) => byte !== 0)) throw new Error('peer public key must be non-zero');
  return createPublicKey({ key: Buffer.concat([RAW_X25519_SPKI_PREFIX, raw]), format: 'der', type: 'spki' });
}

export function deriveControllerKey({ privateKey, peerPublicKey, desktopNonce, phoneNonce, transcript }) {
  exactBuffer(desktopNonce, 'desktop nonce');
  exactBuffer(phoneNonce, 'phone nonce');
  if (!Buffer.isBuffer(transcript) || transcript.length < 1 || transcript.length > BOOTSTRAP_MAX_FRAME_BYTES) throw new Error('bootstrap transcript is invalid');
  const shared = diffieHellman({ privateKey, publicKey: publicKeyFromRaw(peerPublicKey) });
  const salt = Buffer.concat([desktopNonce, phoneNonce]);
  const info = Buffer.concat([Buffer.from(BOOTSTRAP_INFO, 'ascii'), transcript]);
  try {
    if (!shared.some((byte) => byte !== 0)) throw new Error('invalid X25519 peer key');
    return Buffer.from(hkdfSync('sha256', shared, salt, info, 32));
  } finally {
    shared.fill(0); salt.fill(0); info.fill(0);
  }
}

function proofNonce(role) {
  if (role !== 'server' && role !== 'client') throw new Error('bootstrap proof role is invalid');
  const nonce = Buffer.alloc(12);
  nonce[11] = role === 'server' ? 1 : 2;
  return nonce;
}

export function sealTranscriptProof({ key, transcript, role }) {
  exactBuffer(key, 'controller key');
  if (!Buffer.isBuffer(transcript) || transcript.length < 1 || transcript.length > BOOTSTRAP_MAX_FRAME_BYTES) throw new Error('bootstrap transcript is invalid');
  const nonce = proofNonce(role);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(transcript);
  const ciphertext = Buffer.concat([cipher.update(PROOF_PLAINTEXT), cipher.final()]);
  return { nonce, ciphertext, tag: cipher.getAuthTag() };
}

export function openTranscriptProof({ key, transcript, role, proof }) {
  exactBuffer(key, 'controller key');
  try {
    const expectedNonce = proofNonce(role);
    if (!proof || !Buffer.isBuffer(proof.nonce) || !proof.nonce.equals(expectedNonce)
        || !Buffer.isBuffer(proof.ciphertext) || proof.ciphertext.length !== BOOTSTRAP_PROOF_BYTES
        || !Buffer.isBuffer(proof.tag) || proof.tag.length !== 16) throw new Error('shape');
    const decipher = createDecipheriv('aes-256-gcm', key, proof.nonce);
    decipher.setAAD(transcript);
    decipher.setAuthTag(proof.tag);
    const plaintext = Buffer.concat([decipher.update(proof.ciphertext), decipher.final()]);
    const valid = plaintext.equals(PROOF_PLAINTEXT);
    plaintext.fill(0);
    if (!valid) throw new Error('content');
    return true;
  } catch {
    throw new Error('bootstrap transcript proof is invalid');
  }
}
