import { test } from 'node:test';
import assert from 'node:assert/strict';

import { GroqRealtimeSttProvider } from '../src/groq-realtime-stt-provider.js';

function wavBytes(samples) {
  const dataSize = samples.length * 2;
  const out = Buffer.alloc(44 + dataSize);
  out.write('RIFF', 0);
  out.writeUInt32LE(36 + dataSize, 4);
  out.write('WAVE', 8);
  out.write('fmt ', 12);
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(1, 22);
  out.writeUInt32LE(16_000, 24);
  out.writeUInt32LE(32_000, 28);
  out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34);
  out.write('data', 36);
  out.writeUInt32LE(dataSize, 40);
  for (let index = 0; index < samples.length; index++) out.writeInt16LE(samples[index], 44 + index * 2);
  return out;
}

async function inspectForm(form) {
  const entries = [];
  for (const [key, value] of form.entries()) {
    if (key === 'file') {
      const bytes = Buffer.from(await value.arrayBuffer());
      entries.push(['file', { length: bytes.length, riff: bytes.toString('ascii', 0, 4), rate: bytes.readUInt32LE(24), dataSize: bytes.readUInt32LE(40), firstSample: bytes.readInt16LE(44) }]);
    } else {
      entries.push([key, String(value)]);
    }
  }
  return entries;
}

test('Groq STT buffers canonical PCM, commits a 16 kHz WAV turn, and maps final transcripts', async () => {
  let captured;
  const provider = new GroqRealtimeSttProvider({
    apiKey: async () => 'gsk_test_only',
    fetchImpl: async (url, options) => {
      captured = { url, options };
      return new Response(JSON.stringify({ text: 'Hello world' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  assert.deepEqual(await provider.health(), {
    healthy: true, model: 'whisper-large-v3-turbo', sampleRate: 16_000,
  });

  const session = await provider.open({ language: 'en' });
  const iterator = session.events()[Symbol.asyncIterator]();
  const samples = new Int16Array(320);
  samples[0] = 1000;
  samples[319] = -1000;
  await session.pushPcm16(samples, 42n);
  await session.commitTurn();
  assert.deepEqual(await iterator.next(), { value: { type: 'final', text: 'Hello world' }, done: false });

  assert.equal(captured.url, 'https://api.groq.com/openai/v1/audio/transcriptions');
  assert.equal(captured.options.method, 'POST');
  assert.equal(captured.options.headers.authorization, 'Bearer gsk_test_only');
  const form = await inspectForm(captured.options.body);
  const file = form.find(([key]) => key === 'file');
  assert.equal(file[1].length, 44 + 320 * 2);
  assert.equal(file[1].riff, 'RIFF');
  assert.equal(file[1].rate, 16_000);
  assert.equal(file[1].dataSize, 640);
  assert.equal(file[1].firstSample, 1000);
  assert.deepEqual(form.filter(([key]) => key !== 'file'), [
    ['model', 'whisper-large-v3-turbo'],
    ['language', 'en'],
    ['prompt', 'Telephone conversation. Transcribe only clearly spoken words; ignore background noise, music, line echo, and synthetic speech from the other side.'],
    ['response_format', 'json'],
    ['temperature', '0'],
  ]);
  await session.close();
});

test('Groq STT serializes multiple turns and reports bounded provider failures', async () => {
  const responses = [
    { status: 200, body: { text: 'First turn' } },
    { status: 429, body: {} },
    { status: 500, body: {} },
  ];
  const provider = new GroqRealtimeSttProvider({
    apiKey: async () => 'gsk_test_only',
    fetchImpl: async () => {
      const next = responses.shift();
      return new Response(JSON.stringify(next.body), { status: next.status });
    },
  });
  const session = await provider.open({ language: 'en' });
  const iterator = session.events()[Symbol.asyncIterator]();
  for (const value of [1000, 2000, 3000]) {
    const frame = new Int16Array(320);
    frame[0] = value;
    await session.pushPcm16(frame, 0n);
    await session.commitTurn();
  }
  assert.deepEqual((await iterator.next()).value, { type: 'final', text: 'First turn' });
  assert.deepEqual((await iterator.next()).value, { type: 'error', code: 'quota_exceeded' });
  assert.deepEqual((await iterator.next()).value, { type: 'error', code: 'request_failed' });
  await session.close();
});

test('Groq STT validates input, requires credentials, and aborts pending transcription on close', async () => {
  const provider = new GroqRealtimeSttProvider({
    apiKey: async () => 'gsk_test_only',
    fetchImpl: async () => new Response(JSON.stringify({ text: 'too late' }), { status: 200 }),
  });
  await assert.rejects(provider.open({ language: 'english' }), /language/i);
  assert.deepEqual(await new GroqRealtimeSttProvider({ apiKey: async () => '' }).health(), {
    healthy: false, reason: 'credential unavailable',
  });
  await assert.rejects(new GroqRealtimeSttProvider({ apiKey: async () => '' }).open(), /credential/i);

  let aborted = false;
  const provider2 = new GroqRealtimeSttProvider({
    apiKey: async () => 'gsk_test_only',
    fetchImpl: async (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); }, { once: true });
    }),
  });
  const session = await provider2.open({ language: 'en' });
  const iterator = session.events()[Symbol.asyncIterator]();
  const frame = new Int16Array(320);
  await session.pushPcm16(frame, 0n);
  await session.commitTurn();
  await session.close();
  assert.equal(aborted, true);
  assert.deepEqual(await iterator.next(), { value: undefined, done: true });

  const oversized = await provider.open({ language: 'en' });
  const long = new Int16Array(320);
  await assert.rejects(async () => {
    for (let index = 0; index < 10_000; index++) await oversized.pushPcm16(long, 0n);
  }, /maximum duration/i);
  await oversized.close();
});