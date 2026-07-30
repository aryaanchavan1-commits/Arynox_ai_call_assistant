import assert from 'node:assert/strict';
import test from 'node:test';

import { createActiveProviderHealth, createRealtimeRegistry } from '../src/realtime-registry.js';

test('active provider health invokes only the configured adapter and returns bounded public fields', async () => {
  const calls = [];
  const health = createActiveProviderHealth({
    config: { sttProvider: 'openai', ttsProvider: 'supertonic' },
    sttProviders: new Map([['openai', {
      health: async () => {
        calls.push('openai');
        return {
          healthy: true,
          scope: 'session',
          retention: 'zero',
          model: 'gpt-4o-transcribe',
          sampleRate: 24_000,
          apiKey: 'must-not-leak',
          extra: 'must-not-leak',
        };
      },
    }]]),
    ttsProviders: new Map([['supertonic', {
      health: async () => {
        calls.push('supertonic');
        return { healthy: true, scope: 'endpoint', model: 'supertonic-3', sampleRate: 16_000 };
      },
    }]]),
  });

  assert.deepEqual(await health({ kind: 'stt' }), {
    kind: 'stt',
    provider: 'openai',
    healthy: true,
    scope: 'session',
    retention: 'zero',
    model: 'gpt-4o-transcribe',
    sampleRate: 24_000,
  });
  assert.deepEqual(calls, ['openai']);
  assert.equal(JSON.stringify(await health({ kind: 'stt' })).includes('must-not-leak'), false);
  assert.deepEqual(calls, ['openai', 'openai']);
  await assert.rejects(health({ kind: 'other' }), /kind/i);
});

test('realtime registry constructs OpenAI TTS with write-only environment credential', async () => {
  const registry = createRealtimeRegistry({ enabled: true, sttProvider: 'openai', ttsProvider: 'openai' }, { OPENAI_API_KEY: 'registry-test-key' });
  assert.deepEqual(await registry.ttsProviders.get('openai').health(), {
    healthy: true, scope: 'credential', model: 'gpt-4o-mini-tts-2025-12-15', sampleRate: 24_000,
  });
});

test('realtime registry passes explicit zero-retention policy to both ElevenLabs adapters', () => {
  const registry = createRealtimeRegistry({ enabled: true, sttProvider: 'elevenlabs', ttsProvider: 'elevenlabs', elevenLabsZeroRetention: true }, { ELEVENLABS_API_KEY: 'x' });
  assert.equal(registry.sttProviders.get('elevenlabs').zeroRetention, true);
  assert.equal(registry.ttsProviders.get('elevenlabs').zeroRetention, true);
});

test('active provider health returns a bounded failure when an adapter stalls', async () => {
  const health = createActiveProviderHealth({
    config: { sttProvider: 'openai', ttsProvider: 'supertonic' },
    sttProviders: new Map([['openai', { health: async () => new Promise(() => {}) }]]),
    ttsProviders: new Map(),
    timeoutMs: 10,
  });

  const started = Date.now();
  assert.deepEqual(await health({ kind: 'stt' }), {
    kind: 'stt', provider: 'openai', healthy: false, reason: 'provider health check timed out',
  });
  assert.ok(Date.now() - started < 250, 'health timeout exceeded its bounded test deadline');
});
