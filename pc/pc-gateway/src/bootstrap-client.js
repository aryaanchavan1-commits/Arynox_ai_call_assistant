import { generateKeyPairSync, randomBytes } from 'node:crypto';

import {
  canonicalTranscript, deriveControllerKey, openTranscriptProof, sealTranscriptProof,
} from './bootstrap-protocol.js';

export class BootstrapClient {
  constructor({ store, transport, g2Authenticate }) {
    if (!store || !transport || typeof g2Authenticate !== 'function') throw new Error('bootstrap dependencies are required');
    this.store = store;
    this.transport = transport;
    this.g2Authenticate = g2Authenticate;
  }

  async recover(recovery = null) {
    recovery ??= await this.store.recover();
    if (recovery.state !== 'staged') return recovery;
    try {
      await this.g2Authenticate(recovery.key);
      await this.store.commit(recovery.transaction);
      return { authenticated: true, recovered: true };
    } finally {
      recovery.key.fill(0);
    }
  }

  async pair({ identity }) {
    const keyPair = generateKeyPairSync('x25519');
    const desktopPublicKey = Buffer.from(keyPair.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32));
    const desktopNonce = randomBytes(32);
    let controllerKey;
    let transcript;
    let transaction;
    let confirmed = false;
    try {
      const response = await this.transport.exchange({ desktopNonce, desktopPublicKey, identity });
      transcript = canonicalTranscript({
        identity,
        desktopNonce,
        phoneNonce: response.phoneNonce,
        desktopPublicKey,
        phonePublicKey: response.phonePublicKey,
      });
      controllerKey = deriveControllerKey({
        privateKey: keyPair.privateKey,
        peerPublicKey: response.phonePublicKey,
        desktopNonce,
        phoneNonce: response.phoneNonce,
        transcript,
      });
      openTranscriptProof({ key: controllerKey, transcript, role: 'server', proof: response.proof });
      transaction = await this.store.stage(controllerKey, { serial: identity.serial });
      const confirmProof = sealTranscriptProof({ key: controllerKey, transcript, role: 'client' });
      try {
        await this.transport.confirm({ proof: confirmProof });
        confirmed = true;
      } finally {
        confirmProof.ciphertext.fill(0);
        confirmProof.tag.fill(0);
        confirmProof.nonce.fill(0);
      }
      await this.transport.close();
      await this.g2Authenticate(controllerKey);
      await this.store.commit(transaction);
      transaction = null;
      return { authenticated: true };
    } catch (error) {
      // Once the confirmation was written, Android may already hold the same
      // staged key. Keep our durable staged record so the next daemon start can
      // finish the mandatory G2 proof instead of creating asymmetric state.
      if (transaction && !confirmed) {
        await this.store.abort(transaction);
      }
      try { await this.transport.close(); } catch {}
      throw error;
    } finally {
      desktopNonce.fill(0);
      desktopPublicKey.fill(0);
      transcript?.fill(0);
      controllerKey?.fill(0);
    }
  }
}
