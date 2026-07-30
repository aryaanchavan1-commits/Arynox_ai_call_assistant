import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import test from 'node:test';

import {
  BOOTSTRAP_INFO, canonicalTranscript, deriveControllerKey, encodeClientHello,
  openTranscriptProof, sealTranscriptProof,
} from '../src/bootstrap-protocol.js';

const identity = Object.freeze({
  serial: '0123456789ABCDEF', product: 'gram', device: 'atoll', api: 35,
  systemFingerprint: 'xiaomi/gram/gram:15/AP3A/build:user/release-keys',
  vendorFingerprint: 'xiaomi/gram/gram:15/AP3A/vendor:user/release-keys',
  packageName: 'com.callagent.gateway', versionCode: 42,
  signingCertSha256: 'a'.repeat(64), artifactManifestSha256: 'b'.repeat(64),
  desktopBootstrapVersion: 1,
});

function text(value) {
  const bytes = Buffer.from(String(value), 'utf8');
  const size = Buffer.alloc(2); size.writeUInt16BE(bytes.length);
  return Buffer.concat([size, bytes]);
}

function androidHello({ desktopNonce, desktopPublicKey }) {
  return Buffer.concat([
    Buffer.from('4732423101010000', 'hex'), desktopNonce, desktopPublicKey,
    text(identity.serial), text(identity.systemFingerprint), text(identity.vendorFingerprint),
    text(identity.packageName), text(identity.versionCode), text(identity.signingCertSha256),
    text(identity.artifactManifestSha256), text(identity.desktopBootstrapVersion),
  ]);
}

function fixture() {
  const desktop = generateKeyPairSync('x25519');
  const phone = generateKeyPairSync('x25519');
  const desktopNonce = Buffer.alloc(32, 1);
  const phoneNonce = Buffer.alloc(32, 2);
  const desktopPublicKey = desktop.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const phonePublicKey = phone.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const clientHello = androidHello({ desktopNonce, desktopPublicKey });
  const prefix = Buffer.from('agentcall/controller-bootstrap/transcript/v1', 'ascii');
  const size = Buffer.alloc(2); size.writeUInt16BE(clientHello.length);
  const expectedTranscript = Buffer.concat([prefix, size, clientHello, phoneNonce, phonePublicKey]);
  return { desktop, phone, desktopNonce, phoneNonce, desktopPublicKey, phonePublicKey, clientHello, expectedTranscript };
}

test('client hello and transcript are byte-identical to the active Android v1 codec', () => {
  const f = fixture();
  assert.deepEqual(encodeClientHello({ identity, desktopNonce: f.desktopNonce, desktopPublicKey: f.desktopPublicKey }), f.clientHello);
  assert.deepEqual(canonicalTranscript({
    identity, desktopNonce: f.desktopNonce, phoneNonce: f.phoneNonce,
    desktopPublicKey: f.desktopPublicKey, phonePublicKey: f.phonePublicKey,
  }), f.expectedTranscript);
  assert.equal(BOOTSTRAP_INFO, 'agentcall/controller-bootstrap/v1');
});

test('both X25519 peers derive the same Android transcript-bound key', () => {
  const f = fixture();
  const desktopKey = deriveControllerKey({ privateKey: f.desktop.privateKey, peerPublicKey: f.phonePublicKey, desktopNonce: f.desktopNonce, phoneNonce: f.phoneNonce, transcript: f.expectedTranscript });
  const phoneKey = deriveControllerKey({ privateKey: f.phone.privateKey, peerPublicKey: f.desktopPublicKey, desktopNonce: f.desktopNonce, phoneNonce: f.phoneNonce, transcript: f.expectedTranscript });
  assert.equal(desktopKey.length, 32);
  assert.deepEqual(desktopKey, phoneKey);
  desktopKey.fill(0); phoneKey.fill(0);
});

test('Android fixed-nonce AEAD proof shape authenticates and rejects role/tampering', () => {
  const f = fixture();
  const key = randomBytes(32);
  const server = sealTranscriptProof({ key, transcript: f.expectedTranscript, role: 'server' });
  const client = sealTranscriptProof({ key, transcript: f.expectedTranscript, role: 'client' });
  assert.deepEqual(server.nonce, Buffer.from('000000000000000000000001', 'hex'));
  assert.deepEqual(client.nonce, Buffer.from('000000000000000000000002', 'hex'));
  assert.equal(server.ciphertext.length, Buffer.byteLength('agentcall-bootstrap-proof-v1'));
  assert.equal(openTranscriptProof({ key, transcript: f.expectedTranscript, role: 'server', proof: server }), true);
  assert.throws(() => openTranscriptProof({ key, transcript: f.expectedTranscript, role: 'client', proof: server }), /proof/i);
  const bad = { ...server, tag: Buffer.from(server.tag) }; bad.tag[0] ^= 1;
  assert.throws(() => openTranscriptProof({ key, transcript: f.expectedTranscript, role: 'server', proof: bad }), /proof/i);
  key.fill(0);
});

test('Android client hello rejects unknown, malformed, oversized and downgraded identity', () => {
  const f = fixture();
  const args = { desktopNonce: f.desktopNonce, desktopPublicKey: f.desktopPublicKey };
  assert.throws(() => encodeClientHello({ ...args, identity: { ...identity, extra: 'no' } }), /identity fields/i);
  assert.throws(() => encodeClientHello({ ...args, identity: { ...identity, api: 34 } }), /api/i);
  assert.throws(() => encodeClientHello({ ...args, identity: { ...identity, desktopBootstrapVersion: 2 } }), /downgrade|version/i);
  assert.throws(() => encodeClientHello({ ...args, identity: { ...identity, serial: `bad\0serial` } }), /identity|serial/i);
  assert.throws(() => encodeClientHello({ ...args, identity: { ...identity, systemFingerprint: 'x'.repeat(513) } }), /invalid|identity|512|limit/i);
  assert.throws(() => encodeClientHello({ ...args, desktopNonce: Buffer.alloc(31), identity }), /32 bytes/i);
});
