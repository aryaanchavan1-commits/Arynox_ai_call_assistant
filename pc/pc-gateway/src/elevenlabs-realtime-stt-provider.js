import WebSocket from 'ws';

const MODEL = 'scribe_v2_realtime';
const ENDPOINT = 'wss://api.elevenlabs.io/v1/speech-to-text/realtime';
const LANGUAGE = /^[a-z]{2,3}$/;
const MAX_EVENT_BYTES = 64 * 1024;
const MAX_QUEUE_EVENTS = 64;
const MAX_TRANSCRIPT_CHARS = 8_192;
const ERROR_TYPES = new Set([
  'auth_error', 'quota_exceeded', 'transcriber_error', 'input_error', 'error',
  'commit_throttled', 'unaccepted_terms', 'rate_limited', 'queue_overflow',
  'resource_exhausted', 'session_time_limit_exceeded', 'chunk_size_exceeded',
  'insufficient_audio_activity',
]);

class AsyncEventQueue {
  constructor() { this.values = []; this.waiters = []; this.ended = false; }
  push(value) {
    if (this.ended) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value, done: false });
    else if (this.values.length < MAX_QUEUE_EVENTS) this.values.push(value);
    else this.fail('queue_overflow');
  }
  fail(code) {
    if (this.ended) return;
    this.values = [{ type: 'error', code }];
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) waiter({ value: this.values.shift(), done: false });
  }
  end() {
    if (this.ended) return;
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true });
  }
  [Symbol.asyncIterator]() {
    return { next: () => {
      if (this.values.length) return Promise.resolve({ value: this.values.shift(), done: false });
      if (this.ended) return Promise.resolve({ value: undefined, done: true });
      return new Promise((resolve) => this.waiters.push(resolve));
    } };
  }
}

function waitForOpen(socket, signal) {
  if (socket.readyState === WebSocket.OPEN || socket.readyState === 1) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => { socket.off('open', open); socket.off('error', error); socket.off('close', close); signal?.removeEventListener('abort', abort); };
    const open = () => { cleanup(); resolve(); };
    const stop = (error) => { cleanup(); if (socket.readyState !== 3) socket.close(); reject(error); };
    const error = (value) => stop(value);
    const close = () => stop(new Error('ElevenLabs socket closed before opening'));
    const abort = () => stop(signal.reason ?? new Error('aborted'));
    socket.once('open', open); socket.once('error', error);
    socket.once('close', close);
    signal?.addEventListener('abort', abort, { once: true });
  });
}

function encodePcm16(samples) {
  if (!(samples instanceof Int16Array) || samples.length !== 320) {
    throw new RangeError('ElevenLabs STT input must contain exactly 320 PCM16 samples');
  }
  const output = Buffer.allocUnsafe(640);
  for (let index = 0; index < 320; index++) output.writeInt16LE(samples[index], index * 2);
  return output;
}

class ElevenLabsSttSession {
  constructor(socket, signal) {
    this.socket = socket;
    this.signal = signal;
    this.queue = new AsyncEventQueue();
    this.closed = false;
    this.onMessage = (data) => this.#message(data);
    this.onClose = () => {
      this.closed = true;
      this.signal?.removeEventListener('abort', this.onAbort);
      this.socket.off('message', this.onMessage);
      this.socket.off('error', this.onError);
      this.queue.end();
    };
    this.onError = () => {
      this.closed = true;
      this.signal?.removeEventListener('abort', this.onAbort);
      this.socket.off('message', this.onMessage);
      this.queue.fail('socket_error');
      if (this.socket.readyState !== WebSocket.CLOSED && this.socket.readyState !== 3) this.socket.close();
    };
    this.onAbort = () => this.close();
    socket.on('message', this.onMessage);
    socket.once('close', this.onClose);
    socket.once('error', this.onError);
    signal?.addEventListener('abort', this.onAbort, { once: true });
  }

  #message(data) {
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (buffer.length > MAX_EVENT_BYTES) { this.queue.push({ type: 'error', code: 'event_too_large' }); return; }
    let value;
    try { value = JSON.parse(buffer.toString('utf8')); } catch { return; }
    if ((value?.message_type === 'committed_transcript' || value?.message_type === 'committed_transcript_with_timestamps') && typeof value.text === 'string') {
      if (value.text.length > MAX_TRANSCRIPT_CHARS) { this.queue.fail('transcript_too_large'); this.close(); return; }
      this.queue.push({ type: 'final', text: value.text, ...(typeof value.language_code === 'string' ? { language: value.language_code } : {}) });
    } else if (ERROR_TYPES.has(value?.message_type)) {
      this.queue.push({ type: 'error', code: value.message_type });
    }
  }

  async pushPcm16(samples, _timestampMicros) {
    if (this.closed) throw new Error('ElevenLabs STT session is closed');
    const pcm = encodePcm16(samples);
    try {
      this.socket.send(JSON.stringify({
        message_type: 'input_audio_chunk', audio_base_64: pcm.toString('base64'), commit: false, sample_rate: 16_000,
      }));
    } finally { pcm.fill(0); }
  }

  async commitTurn() {
    if (this.closed) throw new Error('ElevenLabs STT session is closed');
    this.socket.send(JSON.stringify({ message_type: 'input_audio_chunk', audio_base_64: '', commit: true, sample_rate: 16_000 }));
  }

  events() { return this.queue; }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.signal?.removeEventListener('abort', this.onAbort);
    this.socket.off('message', this.onMessage);
    this.socket.off('error', this.onError);
    this.queue.end();
    if (this.socket.readyState !== WebSocket.CLOSED && this.socket.readyState !== 3) this.socket.close();
  }
}

export class ElevenLabsRealtimeSttProvider {
  constructor({ apiKey, socketFactory = (url, options) => new WebSocket(url, options), zeroRetention = false } = {}) {
    this.apiKey = typeof apiKey === 'function' ? apiKey : async () => '';
    this.socketFactory = socketFactory;
    this.zeroRetention = zeroRetention;
  }

  async #credential() {
    const value = await this.apiKey();
    return typeof value === 'string' && value.length >= 1 && value.length <= 512 ? value : null;
  }

  async #credentialWithSignal(signal) {
    if (signal?.aborted) throw signal.reason ?? new Error('aborted');
    if (!signal) return this.#credential();
    let onAbort;
    try {
      return await Promise.race([
        this.#credential(),
        new Promise((_, reject) => {
          onAbort = () => reject(signal.reason ?? new Error('aborted'));
          signal.addEventListener('abort', onAbort, { once: true });
        }),
      ]);
    } finally {
      if (onAbort) signal.removeEventListener('abort', onAbort);
    }
  }

  async health() {
    if (!await this.#credential()) return { healthy: false, reason: 'credential unavailable' };
    try {
      const session = await this.open();
      await session.close();
      return { healthy: true, scope: 'session', model: MODEL, sampleRate: 16_000, ...(this.zeroRetention ? { retention: 'zero' } : {}) };
    } catch {
      return { healthy: false, reason: 'session probe unavailable' };
    }
  }

  async open({ language } = {}, signal) {
    if (language !== undefined && !LANGUAGE.test(language)) throw new Error('invalid transcription language');
    const key = await this.#credentialWithSignal(signal);
    if (!key) throw new Error('ElevenLabs credential unavailable');
    signal?.throwIfAborted();
    const url = new URL(ENDPOINT);
    url.searchParams.set('model_id', MODEL);
    url.searchParams.set('audio_format', 'pcm_16000');
    url.searchParams.set('commit_strategy', 'manual');
    url.searchParams.set('include_timestamps', 'false');
    if (language !== undefined) url.searchParams.set('language_code', language);
    if (this.zeroRetention) url.searchParams.set('enable_logging', 'false');
    let socket;
    try {
      signal?.throwIfAborted();
      socket = this.socketFactory(url.toString(), {
        headers: { 'xi-api-key': key }, maxPayload: MAX_EVENT_BYTES, perMessageDeflate: false,
      });
      signal?.throwIfAborted();
    } catch (error) {
      if (socket && socket.readyState !== WebSocket.CLOSED && socket.readyState !== 3) socket.close();
      throw error;
    }
    try {
      await waitForOpen(socket, signal);
      signal?.throwIfAborted();
      return new ElevenLabsSttSession(socket, signal);
    } catch (error) {
      if (socket.readyState !== WebSocket.CLOSED && socket.readyState !== 3) socket.close();
      throw error;
    }
  }
}

export default ElevenLabsRealtimeSttProvider;
