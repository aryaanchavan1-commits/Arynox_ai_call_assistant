import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SupertonicTtsProvider } from '../src/supertonic-provider.js';

function wav(samples, sampleRate = 44_100) {
  const dataBytes = samples.length * 2;
  const output = Buffer.alloc(44 + dataBytes);
  output.write('RIFF', 0); output.writeUInt32LE(36 + dataBytes, 4); output.write('WAVE', 8);
  output.write('fmt ', 12); output.writeUInt32LE(16, 16); output.writeUInt16LE(1, 20);
  output.writeUInt16LE(1, 22); output.writeUInt32LE(sampleRate, 24);
  output.writeUInt32LE(sampleRate * 2, 28); output.writeUInt16LE(2, 32); output.writeUInt16LE(16, 34);
  output.write('data', 36); output.writeUInt32LE(dataBytes, 40);
  samples.forEach((sample, index) => output.writeInt16LE(sample, 44 + index * 2));
  return output;
}

test('Supertonic provider health and synthesis use documented loopback API and decode mono PCM16 WAV', async () => {
  const requests = [];
  const fetchImpl = async (url, options = {}) => {
    requests.push([url, options]);
    if (url.endsWith('/v1/health')) return new Response(JSON.stringify({
      status: 'ok', model: 'supertonic-3', sample_rate: 44_100, version: '1.3.1', voices_loaded: 10,
    }), { status: 200, headers: { 'content-type': 'application/json' } });
    return new Response(wav([1, -2, 300]), {
      status: 200,
      headers: { 'content-type': 'audio/wav', 'content-length': '50' },
    });
  };
  const provider = new SupertonicTtsProvider({ fetchImpl });
  assert.deepEqual(await provider.health(), { healthy: true, model: 'supertonic-3', sampleRate: 44_100 });
  const chunks = [];
  for await (const chunk of provider.synthesize({ text: 'Namaste', voice: 'F1', language: 'hi' }, new AbortController().signal)) {
    chunks.push(chunk);
  }
  assert.equal(requests[0][0], 'http://127.0.0.1:7788/v1/health');
  assert.equal(requests[1][0], 'http://127.0.0.1:7788/v1/tts');
  assert.deepEqual(JSON.parse(requests[1][1].body), {
    text: 'Namaste', voice: 'F1', lang: 'hi', response_format: 'wav', model: 'supertonic-3',
  });
  assert.equal(chunks.length, 1);
  assert.deepEqual(Array.from(chunks[0].pcm16), [1, -2, 300]);
  assert.equal(chunks[0].sampleRate, 44_100);
  assert.equal(chunks[0].channels, 1);
});

test('Supertonic provider rejects non-loopback endpoints, unhealthy models, and unsafe WAV', async () => {
  assert.throws(() => new SupertonicTtsProvider({ baseUrl: 'http://192.168.1.8:7788' }), /loopback/i);
  const unhealthy = new SupertonicTtsProvider({ fetchImpl: async () => new Response(JSON.stringify({
    status: 'ok', model: 'supertonic-2', sample_rate: 44_100,
  }), { status: 200 }) });
  assert.deepEqual(await unhealthy.health(), { healthy: false, reason: 'unexpected model or sample rate' });

  const malformed = new SupertonicTtsProvider({ fetchImpl: async () => new Response(Buffer.from('not-wav'), { status: 200 }) });
  await assert.rejects(async () => {
    for await (const _ of malformed.synthesize({ text: 'hello', voice: 'F1', language: 'en' }, new AbortController().signal)) {}
  }, /WAV/i);
});

test('Supertonic provider propagates barge-in cancellation to fetch', async () => {
  let observedSignal;
  const provider = new SupertonicTtsProvider({ fetchImpl: async (_url, options) => {
    observedSignal = options.signal;
    return new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(options.signal.reason ?? new Error('aborted')), { once: true });
    });
  } });
  const controller = new AbortController();
  const work = (async () => {
    for await (const _ of provider.synthesize({ text: 'hello', voice: 'F1', language: 'en' }, controller.signal)) {}
  })();
  controller.abort();
  await assert.rejects(work);
  assert.equal(observedSignal.aborted, true);
});
