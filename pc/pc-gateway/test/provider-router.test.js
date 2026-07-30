import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ProviderRouter } from '../src/provider-router.js';

test('router pins explicit healthy STT and TTS providers for a call', async () => {
  const stt = { health: async () => ({ healthy: true }), open: async () => ({}) };
  const tts = { health: async () => ({ healthy: true }), synthesize: async function *() {} };
  const router = new ProviderRouter({
    stt: new Map([['openai-realtime', stt]]),
    tts: new Map([['supertonic-local', tts]]),
  });
  const selection = await router.pin({
    callId: 'call-1',
    stt: { provider: 'openai-realtime', model: 'gpt-4o-transcribe' },
    tts: { provider: 'supertonic-local', model: 'supertonic-3', voice: 'female-1' },
  });
  assert.equal(selection.callId, 'call-1');
  assert.equal(selection.stt.provider, stt);
  assert.equal(selection.tts.provider, tts);
  assert.deepEqual(selection.manifest, {
    stt: { provider: 'openai-realtime', model: 'gpt-4o-transcribe' },
    tts: { provider: 'supertonic-local', model: 'supertonic-3', voice: 'female-1' },
  });
  assert.equal(Object.isFrozen(selection), true);
  assert.equal(Object.isFrozen(selection.manifest.stt), true);
});

test('router fails closed for unknown or unhealthy providers and never falls back', async () => {
  let fallbackHealthCalls = 0;
  const router = new ProviderRouter({
    stt: new Map([
      ['primary', { health: async () => ({ healthy: false, reason: 'offline' }) }],
      ['fallback', { health: async () => { fallbackHealthCalls++; return { healthy: true }; } }],
    ]),
    tts: new Map([['tts', { health: async () => ({ healthy: true }) }]]),
  });
  await assert.rejects(() => router.pin({
    callId: 'call-1', stt: { provider: 'primary', model: 'm' }, tts: { provider: 'tts', model: 'v', voice: 'x' },
  }), /primary.*offline/i);
  assert.equal(fallbackHealthCalls, 0);
  await assert.rejects(() => router.pin({
    callId: 'call-1', stt: { provider: 'missing', model: 'm' }, tts: { provider: 'tts', model: 'v', voice: 'x' },
  }), /unknown STT provider/i);
});

test('router rejects malformed IDs and mutable secret-bearing selection fields', async () => {
  const router = new ProviderRouter({ stt: new Map(), tts: new Map() });
  await assert.rejects(() => router.pin({ callId: '../escape', stt: {}, tts: {} }), /callId/i);
  await assert.rejects(() => router.pin({
    callId: 'call-1', stt: { provider: 'x', model: 'm', apiKey: 'secret' }, tts: { provider: 'y', model: 'v', voice: 'z' },
  }), /unknown field.*apiKey/i);
});
