import { test } from 'node:test';
import assert from 'node:assert/strict';

import { GroqTtsProvider } from '../src/groq-tts-provider.js';

function wavBytes(samples, { rate = 24_000, format = 1, bits = 16, channels = 1 } = {}) {
  const bytesPerSample = bits / 8;
  const dataSize = samples.length * bytesPerSample;
  const out = Buffer.alloc(44 + dataSize);
  out.write('RIFF', 0);
  out.writeUInt32LE(36 + dataSize, 4);
  out.write('WAVE', 8);
  out.write('fmt ', 12);
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(format, 20);
  out.writeUInt16LE(channels, 22);
  out.writeUInt32LE(rate, 24);
  out.writeUInt32LE(rate * bytesPerSample * channels, 28);
  out.writeUInt16LE(bytesPerSample * channels, 32);
  out.writeUInt16LE(bits, 34);
  out.write('data', 36);
  out.writeUInt32LE(dataSize, 40);
  for (let index = 0; index < samples.length; index++) out.writeInt16LE(samples[index], 44 + index * bytesPerSample);
  return out;
}

function pcmStream(...chunks) {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(Uint8Array.from(chunk));
      controller.close();
    },
  });
}

test('Groq TTS posts a WAV speech request and yields exact 24 kHz mono metadata', async () => {
  const requests = [];
  const wav = wavBytes([1, -2, 300]);
  const provider = new GroqTtsProvider({
    apiKey: async () => 'gsk_test_only',
    fetchImpl: async (url, options) => {
      requests.push([url, options]);
      return new Response(pcmStream(wav.subarray(0, 40), wav.subarray(40)), {
        status: 200,
        headers: { 'content-type': 'audio/wav' },
      });
    },
  });

  assert.deepEqual(await provider.health(), {
    healthy: true, scope: 'credential', model: 'playai-tts', sampleRate: 24_000,
  });
  const signal = new AbortController().signal;
  const chunks = [];
  for await (const chunk of provider.synthesize({ text: 'Hello', voice: 'Arista-PlayAI', language: 'en' }, signal)) {
    chunks.push(chunk);
  }

  assert.equal(requests[0][0], 'https://api.groq.com/openai/v1/audio/speech');
  assert.equal(requests[0][1].signal, signal);
  assert.equal(requests[0][1].headers.authorization, 'Bearer gsk_test_only');
  assert.deepEqual(JSON.parse(requests[0][1].body), {
    model: 'playai-tts', input: 'Hello', voice: 'Arista-PlayAI',
    response_format: 'wav', sample_rate: 24_000,
  });
  assert.deepEqual(chunks.map((chunk) => ({
    pcm16: Array.from(chunk.pcm16), sampleRate: chunk.sampleRate, channels: chunk.channels, sequence: chunk.sequence,
  })), [{ pcm16: [1, -2, 300], sampleRate: 24_000, channels: 1, sequence: 0 }]);
});

test('Groq TTS yields native-rate PCM and splits large streams into bounded chunks', async () => {
  const rate = 16_000;
  const samples = new Int16Array(20_000);
  for (let index = 0; index < samples.length; index++) samples[index] = index & 1 ? -1 : 1;
  const wav = wavBytes(samples, { rate });
  const provider = new GroqTtsProvider({
    apiKey: async () => 'gsk_test_only',
    fetchImpl: async () => new Response(pcmStream(wav), { status: 200, headers: { 'content-type': 'audio/wav' } }),
  });
  const chunks = [];
  for await (const chunk of provider.synthesize({ text: 'Hello', voice: 'troy', language: 'en' })) {
    chunks.push(chunk);
  }
  assert.ok(chunks.length >= 2);
  assert.equal(chunks.reduce((sum, chunk) => sum + chunk.pcm16.length, 0), samples.length);
  assert.equal(chunks[0].sampleRate, rate);
  assert.ok(chunks.every((chunk) => chunk.channels === 1));
  assert.deepEqual(chunks.map((chunk) => chunk.sequence), chunks.map((_, index) => index));
});

test('Groq TTS validates bounded input, voice, language, model, and origin', async () => {
  assert.throws(() => new GroqTtsProvider({ baseUrl: 'http://api.groq.com' }), /HTTPS/i);
  assert.throws(() => new GroqTtsProvider({ model: 'unknown-model' }), /model.*unsupported/i);
  const provider = new GroqTtsProvider({
    apiKey: async () => 'x',
    fetchImpl: async () => new Response(pcmStream(wavBytes([1])), { status: 200, headers: { 'content-type': 'audio/wav' } }),
  });
  await assert.rejects(async () => {
    for await (const _ of provider.synthesize({ text: '', voice: 'troy', language: 'en' })) {}
  }, /1-4096/);
  await assert.rejects(async () => {
    for await (const _ of provider.synthesize({ text: 'Hello', voice: '../troy', language: 'en' })) {}
  }, /voice/i);
  await assert.rejects(async () => {
    for await (const _ of provider.synthesize({ text: 'Hello', voice: 'troy', language: 'english' })) {}
  }, /language/i);
});

test('Groq TTS redacts auth, quota, and HTTP bodies from failures', async () => {
  const secret = 'gsk_secret_only';
  for (const [status, expected] of [[401, /authentication failed/i], [429, /quota unavailable/i], [500, /status 500/i]]) {
    const provider = new GroqTtsProvider({
      apiKey: async () => secret,
      fetchImpl: async () => new Response(JSON.stringify({ error: { message: `leak ${secret}` } }), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    });
    await assert.rejects(async () => {
      for await (const _ of provider.synthesize({ text: 'Hello', voice: 'troy', language: 'en' })) {}
    }, (error) => {
      assert.match(error.message, expected);
      assert.equal(error.message.includes(secret), false);
      assert.equal(error.message.includes('leak'), false);
      return true;
    });
  }
});

test('Groq TTS forwards AbortSignal and rejects invalid or empty WAV responses', async () => {
  const missing = new GroqTtsProvider({ apiKey: async () => '' });
  assert.deepEqual(await missing.health(), { healthy: false, reason: 'credential unavailable' });

  let forwarded;
  const controller = new AbortController();
  const aborting = new GroqTtsProvider({
    apiKey: async () => 'x',
    fetchImpl: async (_url, options) => {
      forwarded = options.signal;
      return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
    },
  });
  const work = (async () => {
    for await (const _ of aborting.synthesize({ text: 'Hello', voice: 'troy', language: 'en' }, controller.signal)) {}
  })();
  while (!forwarded) await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  await assert.rejects(work, /aborted/);
  assert.equal(forwarded, controller.signal);

  const nonPcm = new GroqTtsProvider({
    apiKey: async () => 'x',
    fetchImpl: async () => new Response(pcmStream(wavBytes([1], { format: 3 })), {
      status: 200, headers: { 'content-type': 'audio/wav' },
    }),
  });
  await assert.rejects(async () => {
    for await (const _ of nonPcm.synthesize({ text: 'Hello', voice: 'troy', language: 'en' })) {}
  }, /WAV payload/i);

  const empty = new GroqTtsProvider({
    apiKey: async () => 'x',
    fetchImpl: async () => new Response(pcmStream(), { status: 200, headers: { 'content-type': 'audio/wav' } }),
  });
  await assert.rejects(async () => {
    for await (const _ of empty.synthesize({ text: 'Hello', voice: 'troy', language: 'en' })) {}
  }, /empty WAV/i);
});

test('Groq TTS cancels an unfinished response reader when consumption stops early', async () => {
  let cancelCalls = 0;
  const body = new ReadableStream({
    pull(controller) { controller.enqueue(Uint8Array.from([1, 0])); },
    cancel() { cancelCalls += 1; },
  });
  const provider = new GroqTtsProvider({
    apiKey: async () => 'x',
    fetchImpl: async () => new Response(body, { status: 200, headers: { 'content-type': 'audio/wav' } }),
  });

  await assert.rejects(async () => {
    for await (const _ of provider.synthesize({ text: 'Hello', voice: 'troy', language: 'en' })) {}
  }, /invalid WAV/i);
  assert.equal(cancelCalls, 1);
});