import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createRealtimeFactory } from '../src/realtime-runtime.js';

test('realtime runtime is absent when disabled', () => {
  assert.equal(createRealtimeFactory({ config: { enabled: false } }), null);
});

test('realtime runtime pins configured providers and builds a consent-bound session', async () => {
  const health = [];
  const sttProvider = {
    health: async () => { health.push('stt'); return { healthy: true }; },
    open: async () => ({ pushPcm16: async () => {}, commitTurn: async () => {}, events: async function* () {}, close: async () => {} }),
  };
  const ttsProvider = {
    health: async () => { health.push('tts'); return { healthy: true }; },
    synthesize: async function* () {},
  };
  const factory = createRealtimeFactory({
    config: {
      enabled: true, sttProvider: 'openai', ttsProvider: 'supertonic', voice: 'F1',
      sttLanguage: 'hi', ttsLanguage: 'en',
    },
    sttProviders: new Map([['openai', sttProvider]]),
    ttsProviders: new Map([['supertonic', ttsProvider]]),
  });
  const gateway = { appendTranscript: async () => {}, sendAgentPcm: async () => {} };
  const session = await factory({ callId: 'call-1', gateway });
  assert.deepEqual(health, ['stt', 'tts']);
  assert.equal(session.callId, 'call-1');
  assert.deepEqual(session.sttConfig, { language: 'hi' });
  assert.deepEqual(session.ttsDefaults, { voice: 'F1', language: 'en' });
  assert.ok(session.vad);
});

test('realtime runtime never falls back when configured provider is unavailable', async () => {
  const factory = createRealtimeFactory({
    config: {
      enabled: true, sttProvider: 'openai', ttsProvider: 'supertonic', voice: 'F1',
      sttLanguage: 'en', ttsLanguage: 'en',
    },
    sttProviders: new Map([['elevenlabs', { health: async () => ({ healthy: true }) }]]),
    ttsProviders: new Map([['supertonic', { health: async () => ({ healthy: true }) }]]),
  });
  await assert.rejects(
    () => factory({ callId: 'call-1', gateway: { appendTranscript() {}, sendAgentPcm() {} } }),
    /unknown STT provider: openai/,
  );
});
