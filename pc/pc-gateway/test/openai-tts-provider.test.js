import { test } from 'node:test';
import assert from 'node:assert/strict';

import { OpenAiTtsProvider } from '../src/openai-tts-provider.js';

function pcmStream(...chunks) {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(Uint8Array.from(chunk));
      controller.close();
    },
  });
}

test('OpenAI TTS posts pinned PCM speech request and yields exact 24 kHz mono metadata', async () => {
  const requests = [];
  const provider = new OpenAiTtsProvider({
    apiKey: async () => 'test-only-secret',
    fetchImpl: async (url, options) => {
      requests.push([url, options]);
      return new Response(pcmStream([1], [0, 254, 255, 44, 1]), {
        status: 200,
        headers: { 'content-type': 'audio/pcm' },
      });
    },
  });

  assert.deepEqual(await provider.health(), {
    healthy: true,
    scope: 'credential',
    model: 'gpt-4o-mini-tts-2025-12-15',
    sampleRate: 24_000,
  });
  const signal = new AbortController().signal;
  const chunks = [];
  for await (const chunk of provider.synthesize({ text: 'Hello', voice: 'alloy', language: 'en' }, signal)) {
    chunks.push(chunk);
  }

  assert.equal(requests[0][0], 'https://api.openai.com/v1/audio/speech');
  assert.equal(requests[0][1].signal, signal);
  assert.equal(requests[0][1].headers.authorization, 'Bearer test-only-secret');
  assert.deepEqual(JSON.parse(requests[0][1].body), {
    model: 'gpt-4o-mini-tts-2025-12-15', input: 'Hello', voice: 'alloy', response_format: 'pcm',
  });
  assert.deepEqual(chunks.map((chunk) => ({
    pcm16: Array.from(chunk.pcm16), sampleRate: chunk.sampleRate, channels: chunk.channels, sequence: chunk.sequence,
  })), [{ pcm16: [1, -2, 300], sampleRate: 24_000, channels: 1, sequence: 0 }]);
});

test('OpenAI TTS validates bounded input, voice, language, origin, and final PCM alignment', async () => {
  assert.throws(() => new OpenAiTtsProvider({ baseUrl: 'http://api.openai.com' }), /HTTPS/i);
  assert.throws(() => new OpenAiTtsProvider({ model: 'unknown-model' }), /model.*unsupported/i);
  const provider = new OpenAiTtsProvider({
    apiKey: async () => 'x',
    fetchImpl: async () => new Response(pcmStream([1]), {
      status: 200,
      headers: { 'content-type': 'application/octet-stream' },
    }),
  });
  await assert.rejects(async () => {
    for await (const _ of provider.synthesize({ text: '', voice: 'alloy', language: 'en' })) {}
  }, /1-4096/);
  await assert.rejects(async () => {
    for await (const _ of provider.synthesize({ text: 'Hello', voice: '../alloy', language: 'en' })) {}
  }, /voice/i);
  await assert.rejects(async () => {
    for await (const _ of provider.synthesize({ text: 'Hello', voice: 'alloy', language: 'english' })) {}
  }, /language/i);
  await assert.rejects(async () => {
    for await (const _ of provider.synthesize({ text: 'Hello', voice: 'alloy', language: 'en' })) {}
  }, /odd final PCM byte/i);
});

test('OpenAI TTS redacts auth, quota, HTTP bodies, and credentials from failures', async () => {
  const secret = 'test-only-secret';
  for (const [status, expected] of [[401, /authentication failed/i], [429, /quota unavailable/i], [500, /status 500/i]]) {
    const provider = new OpenAiTtsProvider({
      apiKey: async () => secret,
      fetchImpl: async () => new Response(JSON.stringify({ error: { message: `leak ${secret}` } }), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    });
    await assert.rejects(async () => {
      for await (const _ of provider.synthesize({ text: 'Hello', voice: 'alloy', language: 'en' })) {}
    }, (error) => {
      assert.match(error.message, expected);
      assert.equal(error.message.includes(secret), false);
      assert.equal(error.message.includes('leak'), false);
      return true;
    });
  }
});

test('OpenAI TTS forwards AbortSignal and rejects missing credentials or non-PCM responses', async () => {
  const missing = new OpenAiTtsProvider({ apiKey: async () => '' });
  assert.deepEqual(await missing.health(), { healthy: false, reason: 'credential unavailable' });

  let forwarded;
  const controller = new AbortController();
  const aborting = new OpenAiTtsProvider({
    apiKey: async () => 'x',
    fetchImpl: async (_url, options) => {
      forwarded = options.signal;
      return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
    },
  });
  const work = (async () => {
    for await (const _ of aborting.synthesize({ text: 'Hello', voice: 'alloy', language: 'en' }, controller.signal)) {}
  })();
  while (!forwarded) await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  await assert.rejects(work, /aborted/);
  assert.equal(forwarded, controller.signal);

  const wrongType = new OpenAiTtsProvider({
    apiKey: async () => 'x',
    fetchImpl: async () => new Response('not pcm', { status: 200, headers: { 'content-type': 'audio/mpeg' } }),
  });
  await assert.rejects(async () => {
    for await (const _ of wrongType.synthesize({ text: 'Hello', voice: 'alloy', language: 'en' })) {}
  }, /PCM response/i);

  const empty = new OpenAiTtsProvider({
    apiKey: async () => 'x',
    fetchImpl: async () => new Response(pcmStream(), { status: 200, headers: { 'content-type': 'audio/pcm' } }),
  });
  await assert.rejects(async () => {
    for await (const _ of empty.synthesize({ text: 'Hello', voice: 'alloy', language: 'en' })) {}
  }, /empty PCM response/i);
});

test('OpenAI TTS cancels an unfinished response reader when consumption stops early', async () => {
  let cancelCalls = 0;
  const body = new ReadableStream({
    pull(controller) { controller.enqueue(Uint8Array.from([1, 0])); },
    cancel() { cancelCalls += 1; },
  });
  const provider = new OpenAiTtsProvider({
    apiKey: async () => 'x',
    fetchImpl: async () => new Response(body, { status: 200, headers: { 'content-type': 'audio/pcm' } }),
  });

  for await (const _ of provider.synthesize({ text: 'Hello', voice: 'alloy', language: 'en' })) break;

  assert.equal(cancelCalls, 1);
});
