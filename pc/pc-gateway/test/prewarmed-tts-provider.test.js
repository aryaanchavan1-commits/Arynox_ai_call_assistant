import assert from 'node:assert/strict';
import test from 'node:test';

import { PrewarmedTtsProvider } from '../src/prewarmed-tts-provider.js';

function providerFixture() {
  const calls = [];
  return {
    model: 'test-model',
    calls,
    async health() { return { healthy: true }; },
    async *synthesize(request, signal) {
      calls.push({ request, signal });
      yield { pcm16: Int16Array.from([1, 2, 3]), sampleRate: 16_000, channels: 1, sequence: 0 };
      yield { pcm16: Int16Array.from([4, 5]), sampleRate: 16_000, channels: 1, sequence: 1 };
    },
  };
}

test('prewarmed speech replays immediately without another provider request', async () => {
  const provider = providerFixture();
  const cached = new PrewarmedTtsProvider({ provider, maxSamples: 8_000 });
  const request = { text: 'Good morning.', voice: 'voice-1', language: 'en' };

  assert.deepEqual(await cached.prewarm(request), { cached: false });
  assert.deepEqual(await cached.prewarm(request), { cached: true });

  const first = [];
  for await (const chunk of cached.synthesize(request)) first.push(chunk);
  first[0].pcm16.fill(99);
  const second = [];
  for await (const chunk of cached.synthesize(request)) second.push(chunk);

  assert.equal(provider.calls.length, 1);
  assert.deepEqual(Array.from(second[0].pcm16), [1, 2, 3]);
  assert.equal(second[0].sampleRate, 16_000);
  assert.deepEqual(await cached.health(), { healthy: true });
});

test('uncached and differently voiced speech streams from the provider', async () => {
  const provider = providerFixture();
  const cached = new PrewarmedTtsProvider({ provider, maxSamples: 8_000 });
  await cached.prewarm({
    text: 'Good morning.',
    voice: 'voice-1',
    language: 'en',
  });
  const chunks = [];
  for await (const chunk of cached.synthesize({
    text: 'Good morning.',
    voice: 'voice-2',
    language: 'en',
  })) chunks.push(chunk);

  assert.equal(provider.calls.length, 2);
  assert.deepEqual(Array.from(chunks[1].pcm16), [4, 5]);
});

test('voice, language, and model changes cannot replay stale pre-generated audio', async () => {
  const provider = providerFixture();
  const cached = new PrewarmedTtsProvider({ provider, maxSamples: 8_000 });
  const base = { text: 'Good morning.', voice: 'voice-1', language: 'en' };
  await cached.prewarm(base);

  for await (const _chunk of cached.synthesize({ ...base, voice: 'voice-2' })) {}
  for await (const _chunk of cached.synthesize({ ...base, language: 'hi' })) {}
  provider.model = 'new-model';
  for await (const _chunk of cached.synthesize(base)) {}

  assert.equal(provider.calls.length, 4);
  assert.deepEqual(provider.calls.map((call) => call.request), [
    base,
    { ...base, voice: 'voice-2' },
    { ...base, language: 'hi' },
    base,
  ]);
});

test('aborted cached playback emits no PCM', async () => {
  const provider = providerFixture();
  const cached = new PrewarmedTtsProvider({ provider, maxSamples: 8_000 });
  const request = { text: 'Hello.', voice: 'voice-1', language: 'en' };
  await cached.prewarm(request);
  const controller = new AbortController();
  controller.abort();
  const chunks = [];
  for await (const chunk of cached.synthesize(request, controller.signal)) chunks.push(chunk);
  assert.deepEqual(chunks, []);
});
