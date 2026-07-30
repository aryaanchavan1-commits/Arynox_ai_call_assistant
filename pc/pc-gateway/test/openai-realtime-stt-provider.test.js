import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { OpenAiRealtimeSttProvider } from '../src/openai-realtime-stt-provider.js';

class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.sent = [];
    this.readyState = 0;
    queueMicrotask(() => { this.readyState = 1; this.emit('open'); });
  }
  send(value) { this.sent.push(JSON.parse(value)); }
  close() { this.readyState = 3; this.emit('close'); }
  server(value) { this.emit('message', Buffer.from(JSON.stringify(value))); }
}

test('OpenAI realtime STT authenticates, resamples canonical PCM, commits manually, and maps final transcripts', async () => {
  let connection;
  const socket = new FakeSocket();
  const provider = new OpenAiRealtimeSttProvider({
    apiKey: async () => 'secret-key',
    socketFactory: (url, options) => { connection = { url, options }; return socket; },
  });
  assert.deepEqual(await provider.health(), { healthy: true, model: 'gpt-4o-transcribe', sampleRate: 24_000 });
  const abort = new AbortController();
  const session = await provider.open({ language: 'en' }, abort.signal);
  assert.equal(connection.url, 'wss://api.openai.com/v1/realtime?intent=transcription');
  assert.equal(connection.options.headers.Authorization, 'Bearer secret-key');
  assert.deepEqual(socket.sent[0], {
    type: 'session.update',
    session: {
      type: 'transcription',
      audio: { input: {
        format: { type: 'audio/pcm', rate: 24_000 },
        noise_reduction: { type: 'near_field' },
        transcription: {
          model: 'gpt-4o-transcribe',
          language: 'en',
          prompt: 'Telephone conversation. Transcribe only clearly spoken words; ignore background noise, music, line echo, and synthetic speech from the other side.',
        },
        turn_detection: null,
      } },
    },
  });

  const samples = new Int16Array(320);
  samples[0] = 1000;
  samples[319] = -1000;
  await session.pushPcm16(samples, 42n);
  await session.commitTurn();
  assert.equal(socket.sent[1].type, 'input_audio_buffer.append');
  assert.equal(Buffer.from(socket.sent[1].audio, 'base64').length, 960);
  assert.deepEqual(socket.sent[2], { type: 'input_audio_buffer.commit' });

  const iterator = session.events()[Symbol.asyncIterator]();
  socket.server({
    type: 'conversation.item.input_audio_transcription.completed',
    item_id: 'item_3', transcript: 'Hello world',
  });
  assert.deepEqual((await iterator.next()).value, {
    type: 'final', text: 'Hello world', providerItemId: 'item_3',
  });
  await session.close();
  assert.equal(socket.readyState, 3);
});

test('OpenAI realtime STT maps bounded transcription failures without exposing provider messages', async () => {
  const socket = new FakeSocket();
  const provider = new OpenAiRealtimeSttProvider({
    apiKey: async () => 'secret-key',
    socketFactory: () => socket,
  });
  const session = await provider.open();
  const iterator = session.events()[Symbol.asyncIterator]();
  socket.server({
    type: 'conversation.item.input_audio_transcription.failed',
    item_id: 'item_4',
    error: {
      type: 'transcription_error',
      code: 'audio_unintelligible',
      message: 'sensitive provider detail',
    },
  });
  assert.deepEqual((await iterator.next()).value, {
    type: 'error', code: 'audio_unintelligible',
  });
  await session.close();
});
