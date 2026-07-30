import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ElevenLabsTtsProvider } from '../src/elevenlabs-tts-provider.js';

function pcmStream(...chunks) {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(Uint8Array.from(chunk));
      controller.close();
    },
  });
}

test('ElevenLabs provider checks voice access and streams raw pcm_16000 without exposing its key', async () => {
  const requests = [];
  const provider = new ElevenLabsTtsProvider({
    apiKey: async () => 'top-secret',
    model: 'eleven_flash_v2_5',
    zeroRetention: true,
    fetchImpl: async (url, options) => {
      requests.push([url, options]);
      if (url.endsWith('/v2/voices?page_size=1')) return new Response(JSON.stringify({
        voices: [{ voice_id: 'voice_123' }],
      }), { status: 200 });
      return new Response(pcmStream([1], [0, 254, 255, 44, 1]), {
        status: 200,
        headers: { 'content-type': 'audio/pcm' },
      });
    },
  });
  assert.deepEqual(await provider.health(), { healthy: true, model: 'eleven_flash_v2_5', sampleRate: 16_000, retention: 'zero' });
  const chunks = [];
  for await (const chunk of provider.synthesize({ text: 'Hello', voice: 'voice_123', language: 'fil' }, new AbortController().signal)) {
    chunks.push(chunk);
  }
  assert.match(requests[1][0], /\/v1\/text-to-speech\/voice_123\/stream\?output_format=pcm_16000&enable_logging=false$/);
  assert.equal(requests[1][1].headers['xi-api-key'], 'top-secret');
  assert.deepEqual(JSON.parse(requests[1][1].body), {
    text: 'Hello', model_id: 'eleven_flash_v2_5', language_code: 'fil', apply_text_normalization: 'auto',
    voice_settings: {
      stability: 0.5,
      similarity_boost: 0.75,
      style: 0,
      use_speaker_boost: true,
      speed: 0.9,
    },
  });
  assert.deepEqual(chunks.map((value) => Array.from(value.pcm16)), [[1, -2, 300]]);
  assert.equal(JSON.stringify(await provider.health()).includes('top-secret'), false);
});

test('ElevenLabs provider fails closed on missing secret, unsupported model, odd final PCM byte, and non-HTTPS origin', async () => {
  assert.throws(() => new ElevenLabsTtsProvider({ baseUrl: 'http://api.elevenlabs.io', apiKey: async () => 'x' }), /HTTPS/i);
  const missing = new ElevenLabsTtsProvider({ apiKey: async () => '' });
  assert.deepEqual(await missing.health(), { healthy: false, reason: 'credential unavailable' });
  assert.throws(() => new ElevenLabsTtsProvider({ apiKey: async () => 'x', model: 'wrong' }), /unsupported/i);
  const odd = new ElevenLabsTtsProvider({
    apiKey: async () => 'x',
    fetchImpl: async () => new Response(pcmStream([1]), { status: 200, headers: { 'content-type': 'audio/pcm' } }),
  });
  await assert.rejects(async () => {
    for await (const _ of odd.synthesize({ text: 'Hello', voice: 'voice_123', language: 'en' }, new AbortController().signal)) {}
  }, /odd final PCM byte/i);
});

test('ElevenLabs provider forwards barge-in AbortSignal to streaming fetch', async () => {
  let signal;
  const provider = new ElevenLabsTtsProvider({
    apiKey: async () => 'x',
    fetchImpl: async (_url, options) => {
      signal = options.signal;
      if (options.signal.aborted) throw new Error('aborted');
      return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
    },
  });
  const controller = new AbortController();
  const work = (async () => {
    for await (const _ of provider.synthesize({ text: 'Hello', voice: 'voice_123', language: 'en' }, controller.signal)) {}
  })();
  controller.abort();
  await assert.rejects(work, /aborted/);
  assert.equal(signal.aborted, true);
});

test('ElevenLabs TTS rejects JSON and empty 200 responses and redacts HTTP failures', async () => {
  for (const [response, pattern] of [
    [new Response(JSON.stringify({ detail: 'secret quota body' }), { status: 200, headers: { 'content-type': 'application/json' } }), /content type/i],
    [new Response(pcmStream(), { status: 200, headers: { 'content-type': 'application/octet-stream' } }), /empty/i],
    [new Response('secret auth body', { status: 401 }), /status 401/i],
    [new Response('secret quota body', { status: 429 }), /status 429/i],
  ]) {
    const provider = new ElevenLabsTtsProvider({ apiKey: async () => 'secret-key', fetchImpl: async () => response });
    await assert.rejects(async () => {
      for await (const _ of provider.synthesize({ text: 'Hello', voice: 'voice_123', language: 'en' })) {}
    }, (error) => pattern.test(error.message) && !error.message.includes('secret'));
  }
});

test('ElevenLabs TTS cancels unfinished readers when the consumer stops early', async () => {
  let cancelled = 0;
  const stream = new ReadableStream({
    pull(controller) { controller.enqueue(Uint8Array.from([1, 0])); },
    cancel() { cancelled += 1; },
  });
  const provider = new ElevenLabsTtsProvider({
    apiKey: async () => 'x',
    fetchImpl: async () => new Response(stream, { status: 200, headers: { 'content-type': 'application/octet-stream' } }),
  });
  for await (const _ of provider.synthesize({ text: 'Hello', voice: 'voice_123', language: 'hi' })) break;
  assert.equal(cancelled, 1);
});

test('ElevenLabs TTS accepts bounded provider language codes and proves zero retention in health', async () => {
  const urls = [];
  const provider = new ElevenLabsTtsProvider({
    apiKey: async () => 'x', zeroRetention: true,
    fetchImpl: async (url) => {
      urls.push(url);
      if (url.endsWith('/v2/voices?page_size=1')) return new Response(JSON.stringify({ voices: [{ voice_id: 'voice_123' }] }), { status: 200 });
      return new Response(pcmStream([0, 0]), { status: 200, headers: { 'content-type': 'audio/pcm' } });
    },
  });
  assert.deepEqual(await provider.health(), { healthy: true, model: 'eleven_flash_v2_5', sampleRate: 16_000, retention: 'zero' });
  for (const language of ['en', 'hi', 'fil']) for await (const _ of provider.synthesize({ text: 'Hello', voice: 'voice_123', language })) {}
  await assert.rejects(async () => {
    for await (const _ of provider.synthesize({ text: 'Hello', voice: 'voice_123', language: 'english' })) {}
  }, /language/i);
  assert.ok(urls.slice(1).every((url) => new URL(url).searchParams.get('enable_logging') === 'false'));
});
