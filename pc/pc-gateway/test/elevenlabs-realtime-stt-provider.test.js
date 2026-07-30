import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ElevenLabsRealtimeSttProvider } from '../src/elevenlabs-realtime-stt-provider.js';

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

class ManualSocket extends EventEmitter {
  constructor() { super(); this.readyState = 0; this.sent = []; this.closeCalls = 0; }
  send(value) { this.sent.push(JSON.parse(value)); }
  close() { this.closeCalls += 1; this.readyState = 3; this.emit('close'); }
  server(value) { this.emit('message', Buffer.from(JSON.stringify(value))); }
}

test('ElevenLabs realtime STT uses native pcm_16000, manual commit, and maps committed transcript', async () => {
  let connection;
  const socket = new FakeSocket();
  const provider = new ElevenLabsRealtimeSttProvider({
    apiKey: async () => 'secret-key',
    socketFactory: (url, options) => { connection = { url, options }; return socket; },
  });
  const session = await provider.open({ language: 'hi' }, new AbortController().signal);
  const url = new URL(connection.url);
  assert.equal(`${url.origin}${url.pathname}`, 'wss://api.elevenlabs.io/v1/speech-to-text/realtime');
  assert.equal(url.searchParams.get('model_id'), 'scribe_v2_realtime');
  assert.equal(url.searchParams.get('audio_format'), 'pcm_16000');
  assert.equal(url.searchParams.get('commit_strategy'), 'manual');
  assert.equal(url.searchParams.get('language_code'), 'hi');
  assert.equal(connection.options.headers['xi-api-key'], 'secret-key');

  const samples = new Int16Array(320);
  samples[0] = 0x1234;
  samples[319] = -2;
  await session.pushPcm16(samples, 44n);
  await session.commitTurn();
  assert.equal(socket.sent[0].message_type, 'input_audio_chunk');
  assert.equal(socket.sent[0].sample_rate, 16_000);
  assert.equal(socket.sent[0].commit, false);
  const decoded = Buffer.from(socket.sent[0].audio_base_64, 'base64');
  assert.equal(decoded.length, 640);
  assert.equal(decoded.readInt16LE(0), 0x1234);
  assert.deepEqual(socket.sent[1], {
    message_type: 'input_audio_chunk', audio_base_64: '', commit: true, sample_rate: 16_000,
  });

  const iterator = session.events()[Symbol.asyncIterator]();
  socket.server({ message_type: 'committed_transcript', text: 'नमस्ते दुनिया' });
  assert.deepEqual((await iterator.next()).value, { type: 'final', text: 'नमस्ते दुनिया' });
  socket.server({ message_type: 'quota_exceeded' });
  assert.deepEqual((await iterator.next()).value, { type: 'error', code: 'quota_exceeded' });
  await session.close();
});

test('ElevenLabs realtime STT rejects missing credentials and invalid language', async () => {
  const provider = new ElevenLabsRealtimeSttProvider({ apiKey: async () => '' });
  assert.deepEqual(await provider.health(), { healthy: false, reason: 'credential unavailable' });
  await assert.rejects(() => provider.open({}, new AbortController().signal), /credential unavailable/i);
  const configured = new ElevenLabsRealtimeSttProvider({ apiKey: async () => 'x' });
  await assert.rejects(() => configured.open({ language: '../en' }, new AbortController().signal), /language/i);
});

test('ElevenLabs realtime STT health probes a session and proves zero-retention configuration', async () => {
  let connection;
  const socket = new FakeSocket();
  const provider = new ElevenLabsRealtimeSttProvider({
    apiKey: async () => 'x', zeroRetention: true,
    socketFactory: (url) => { connection = url; return socket; },
  });
  assert.deepEqual(await provider.health(), {
    healthy: true, scope: 'session', model: 'scribe_v2_realtime', sampleRate: 16_000, retention: 'zero',
  });
  assert.equal(new URL(connection).searchParams.get('enable_logging'), 'false');
  assert.equal(socket.readyState, 3);
});

test('ElevenLabs realtime STT open closes connecting sockets on abort, close, and error', async () => {
  for (const terminal of ['abort', 'close', 'error']) {
    const socket = new ManualSocket();
    const controller = new AbortController();
    const provider = new ElevenLabsRealtimeSttProvider({ apiKey: async () => 'x', socketFactory: () => socket });
    const opening = provider.open({}, controller.signal);
    await new Promise((resolve) => setImmediate(resolve));
    if (terminal === 'abort') controller.abort(new Error('stop'));
    else socket.emit(terminal, terminal === 'error' ? new Error('socket failed') : undefined);
    await assert.rejects(opening, /stop|closed|socket failed/i);
    assert.equal(socket.closeCalls, 1, `${terminal} did not close connecting socket`);
  }
  const aborted = new AbortController();
  aborted.abort(new Error('already stopped'));
  let created = false;
  await assert.rejects(new ElevenLabsRealtimeSttProvider({
    apiKey: async () => 'x', socketFactory: () => { created = true; return new ManualSocket(); },
  }).open({}, aborted.signal), /already stopped/i);
  assert.equal(created, false);
});

test('ElevenLabs realtime STT aborts credential lookup before creating a socket', async () => {
  const controller = new AbortController();
  let created = false;
  const provider = new ElevenLabsRealtimeSttProvider({
    apiKey: async () => new Promise(() => {}),
    socketFactory: () => { created = true; return new ManualSocket(); },
  });
  const opening = provider.open({}, controller.signal);
  controller.abort(new Error('credential cancelled'));
  await assert.rejects(opening, /credential cancelled/i);
  assert.equal(created, false);
});

test('ElevenLabs realtime STT emits one bounded terminal error for socket error, transcript flood, and queue overflow', async () => {
  for (const attack of ['socket', 'transcript', 'flood']) {
    const socket = new FakeSocket();
    const session = await new ElevenLabsRealtimeSttProvider({ apiKey: async () => 'x', socketFactory: () => socket }).open({});
    if (attack === 'socket') socket.emit('error', new Error('secret provider body'));
    if (attack === 'transcript') socket.server({ message_type: 'committed_transcript', text: 'x'.repeat(8_193) });
    if (attack === 'flood') for (let index = 0; index < 66; index++) socket.server({ message_type: 'committed_transcript', text: String(index) });
    const iterator = session.events()[Symbol.asyncIterator]();
    const event = (await iterator.next()).value;
    assert.deepEqual(event, { type: 'error', code: attack === 'socket' ? 'socket_error' : attack === 'transcript' ? 'transcript_too_large' : 'queue_overflow' });
    assert.equal((await iterator.next()).done, true);
  }
});

test('ElevenLabs realtime STT rejects writes after a remote close or socket error', async () => {
  for (const terminal of ['close', 'error']) {
    const socket = new FakeSocket();
    const session = await new ElevenLabsRealtimeSttProvider({ apiKey: async () => 'x', socketFactory: () => socket }).open({});
    socket.emit(terminal, terminal === 'error' ? new Error('remote failure') : undefined);
    await assert.rejects(() => session.pushPcm16(new Int16Array(320)), /closed/i);
    await assert.rejects(() => session.commitTurn(), /closed/i);
  }
});

test('ElevenLabs realtime STT rechecks abort around socket construction and cleans up the new socket', async () => {
  const beforeSocket = new AbortController();
  let created = false;
  await assert.rejects(new ElevenLabsRealtimeSttProvider({
    apiKey: async () => { beforeSocket.abort(new Error('after credential')); return 'x'; },
    socketFactory: () => { created = true; return new ManualSocket(); },
  }).open({}, beforeSocket.signal), /after credential/i);
  assert.equal(created, false);

  const afterSocket = new AbortController();
  const socket = new ManualSocket();
  await assert.rejects(new ElevenLabsRealtimeSttProvider({
    apiKey: async () => 'x',
    socketFactory: () => { afterSocket.abort(new Error('during construction')); return socket; },
  }).open({}, afterSocket.signal), /during construction/i);
  assert.equal(socket.closeCalls, 1);

  const atOpen = new AbortController();
  const openSocket = new ManualSocket();
  const opening = new ElevenLabsRealtimeSttProvider({
    apiKey: async () => 'x',
    socketFactory: () => openSocket,
  }).open({}, atOpen.signal);
  await new Promise((resolve) => setImmediate(resolve));
  openSocket.readyState = 1;
  openSocket.once('open', () => atOpen.abort(new Error('at open boundary')));
  openSocket.emit('open');
  await assert.rejects(opening, /at open boundary/i);
  assert.equal(openSocket.closeCalls, 1);
});

test('ElevenLabs realtime STT removes credential abort listeners after successful opens', async () => {
  const controller = new AbortController();
  const signal = controller.signal;
  const originalAdd = signal.addEventListener.bind(signal);
  const originalRemove = signal.removeEventListener.bind(signal);
  const active = new Set();
  signal.addEventListener = (type, listener, options) => {
    if (type === 'abort') active.add(listener);
    return originalAdd(type, listener, options);
  };
  signal.removeEventListener = (type, listener, options) => {
    if (type === 'abort') active.delete(listener);
    return originalRemove(type, listener, options);
  };

  for (let index = 0; index < 20; index++) {
    const socket = new FakeSocket();
    const session = await new ElevenLabsRealtimeSttProvider({
      apiKey: async () => 'x',
      socketFactory: () => socket,
    }).open({}, signal);
    await session.close();
    assert.equal(active.size, 0, `abort listeners retained after open ${index + 1}`);
  }
});
