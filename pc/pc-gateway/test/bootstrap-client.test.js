import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';

import { BootstrapClient } from '../src/bootstrap-client.js';
import { canonicalTranscript, deriveControllerKey, sealTranscriptProof } from '../src/bootstrap-protocol.js';

const identity = Object.freeze({
  serial: '0123456789ABCDEF', product: 'gram', device: 'atoll', api: 35,
  systemFingerprint: 'xiaomi/gram/gram:15/AP3A/build:user/release-keys',
  vendorFingerprint: 'xiaomi/gram/gram:15/AP3A/vendor:user/release-keys',
  packageName: 'com.callagent.gateway', versionCode: 42,
  signingCertSha256: 'a'.repeat(64), artifactManifestSha256: 'b'.repeat(64),
  desktopBootstrapVersion: 1,
});

function fixture({ failG2 = false, invalidProof = false, failConfirm = false } = {}) {
  const actions = [];
  let stagedKey;
  const store = {
    stage: async (key, metadata) => {
      assert.deepEqual(metadata, { serial: identity.serial });
      actions.push('store:stage');
      stagedKey = Buffer.from(key);
      return { stagedPath: '/state/key.staged', stagedSerialPath: '/state/key.staged-serial' };
    },
    commit: async () => actions.push('store:commit'),

    abort: async () => actions.push('store:abort'),
  };
  const phone = generateKeyPairSync('x25519');
  const phonePublicKey = phone.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const phoneNonce = Buffer.alloc(32, 2);
  let transcript;
  let phoneKey;
  const transport = {
    exchange: async (hello) => {
      actions.push('bootstrap:hello');
      transcript = canonicalTranscript({ identity, desktopNonce: hello.desktopNonce, phoneNonce, desktopPublicKey: hello.desktopPublicKey, phonePublicKey });
      phoneKey = deriveControllerKey({ privateKey: phone.privateKey, peerPublicKey: hello.desktopPublicKey, desktopNonce: hello.desktopNonce, phoneNonce, transcript });
      const proof = sealTranscriptProof({ key: phoneKey, transcript, role: 'server' });
      if (invalidProof) proof.tag[0] ^= 1;
      return { phoneNonce, phonePublicKey, proof };
    },
    confirm: async () => {
      actions.push('bootstrap:confirm');
      if (failConfirm) throw new Error('confirm failed');
      return { staged: true };
    },
    close: async () => { actions.push('bootstrap:close'); phoneKey?.fill(0); },
  };
  const g2Authenticate = async (key) => {
    actions.push('g2:authenticate');
    assert.deepEqual(key, stagedKey);
    if (failG2) throw new Error('G2 failed');
  };
  return { actions, store, transport, g2Authenticate, get phoneKey() { return phoneKey; } };
}

test('bootstrap client commits local store only after Android stages on confirm and mandatory G2 proof', async () => {
  const f = fixture();
  const client = new BootstrapClient({ store: f.store, transport: f.transport, g2Authenticate: f.g2Authenticate });
  const result = await client.pair({ identity });
  assert.deepEqual(result, { authenticated: true });
  assert.deepEqual(f.actions, [
    'bootstrap:hello', 'store:stage', 'bootstrap:confirm', 'bootstrap:close',
    'g2:authenticate', 'store:commit',
  ]);
  assert.equal(typeof f.transport.commit, 'undefined');
  f.phoneKey.fill(0);
});

test('bootstrap client preserves confirmed host staging for recovery when G2 fails', async () => {
  const f = fixture({ failG2: true });
  const client = new BootstrapClient({ store: f.store, transport: f.transport, g2Authenticate: f.g2Authenticate });
  await assert.rejects(() => client.pair({ identity }), /G2 failed/);
  assert.equal(f.actions.includes('store:commit'), false);
  assert.equal(f.actions.includes('store:abort'), false);
  assert.equal(f.actions.includes('bootstrap:close'), true);
  f.phoneKey.fill(0);
});

test('bootstrap client aborts local staging when one-way confirm write fails', async () => {
  const f = fixture({ failConfirm: true });
  const client = new BootstrapClient({ store: f.store, transport: f.transport, g2Authenticate: f.g2Authenticate });
  await assert.rejects(() => client.pair({ identity }), /confirm failed/);
  assert.equal(f.actions.includes('g2:authenticate'), false);
  assert.equal(f.actions.includes('store:commit'), false);
  assert.equal(f.actions.includes('store:abort'), true);
  f.phoneKey.fill(0);
});

test('bootstrap recovery proves staged G2 before idempotent host commit', async () => {
  const f = fixture();
  const transaction = { stagedPath: '/state/key.staged' };
  f.store.recover = async () => ({ state: 'staged', key: Buffer.alloc(32, 0x44), transaction });
  f.store.commit = async (supplied) => { assert.equal(supplied, transaction); f.actions.push('store:commit'); };

  f.g2Authenticate = async (key) => { assert.deepEqual(key, Buffer.alloc(32, 0x44)); f.actions.push('g2:authenticate'); };
  const client = new BootstrapClient({ store: f.store, transport: f.transport, g2Authenticate: f.g2Authenticate });
  const recovery = await f.store.recover();
  assert.deepEqual(await client.recover(recovery), { authenticated: true, recovered: true });
  assert.deepEqual(f.actions, ['g2:authenticate', 'store:commit']);
});

test('bootstrap client rejects invalid server proof before staging authority', async () => {
  const f = fixture({ invalidProof: true });
  const client = new BootstrapClient({ store: f.store, transport: f.transport, g2Authenticate: f.g2Authenticate });
  await assert.rejects(() => client.pair({ identity }), /proof/i);
  assert.equal(f.actions.includes('store:stage'), false);
  assert.equal(f.actions.includes('g2:authenticate'), false);
  assert.equal(f.actions.includes('bootstrap:close'), true);
  f.phoneKey.fill(0);
});
