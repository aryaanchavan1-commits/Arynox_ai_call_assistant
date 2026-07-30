import WebSocket from 'ws';

const MODEL = 'gpt-4o-transcribe';
const MODELS = new Set([
  MODEL,
  'gpt-4o-mini-transcribe',
  'gpt-4o-mini-transcribe-2025-12-15',
  'whisper-1',
]);
const ENDPOINT = 'wss://api.openai.com/v1/realtime?intent=transcription';
const LANGUAGE = /^[a-z]{2}$/;
const MAX_EVENT_BYTES = 64 * 1024;
const TRANSCRIPTION_PROMPT = 'Telephone conversation. Transcribe only clearly spoken words; ignore background noise, music, line echo, and synthetic speech from the other side.';
const ERROR_CODE = /^[a-z0-9_.-]{1,128}$/i;

function providerErrorCode(value) {
  return typeof value === 'string' && ERROR_CODE.test(value) ? value : 'provider_error';
}

class AsyncEventQueue {
  constructor() {
    this.values = [];
    this.waiters = [];
    this.ended = false;
  }

  push(value) {
    if (this.ended) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value, done: false });
    else this.values.push(value);
  }

  end() {
    if (this.ended) return;
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true });
  }

  [Symbol.asyncIterator]() {
    return {
      next: () => {
        if (this.values.length) return Promise.resolve({ value: this.values.shift(), done: false });
        if (this.ended) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

function encodePcm24k(samples) {
  if (!(samples instanceof Int16Array) || samples.length !== 320) {
    throw new RangeError('OpenAI STT input must contain exactly 320 PCM16 samples');
  }
  const outputSamples = 480;
  const output = Buffer.allocUnsafe(outputSamples * 2);
  const scale = 16_000 / 24_000;
  for (let index = 0; index < outputSamples; index++) {
    const source = index * scale;
    const left = Math.min(samples.length - 1, Math.floor(source));
    const right = Math.min(samples.length - 1, left + 1);
    const fraction = source - left;
    const value = Math.round(samples[left] + (samples[right] - samples[left]) * fraction);
    output.writeInt16LE(value, index * 2);
  }
  return output;
}

function waitForOpen(socket, signal) {
  if (socket.readyState === WebSocket.OPEN || socket.readyState === 1) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      socket.off('open', onOpen);
      socket.off('error', onError);
      signal?.removeEventListener('abort', onAbort);
    };
    const onOpen = () => { cleanup(); resolve(); };
    const onError = (error) => { cleanup(); reject(error); };
    const onAbort = () => { cleanup(); reject(signal.reason ?? new Error('aborted')); };
    socket.once('open', onOpen);
    socket.once('error', onError);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

class OpenAiSttSession {
  constructor(socket, signal) {
    this.socket = socket;
    this.signal = signal;
    this.queue = new AsyncEventQueue();
    this.closed = false;
    this.onMessage = (data) => this.#message(data);
    this.onClose = () => this.queue.end();
    this.socket.on('message', this.onMessage);
    this.socket.once('close', this.onClose);
    this.onAbort = () => this.close();
    signal?.addEventListener('abort', this.onAbort, { once: true });
  }

  #message(data) {
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (buffer.length > MAX_EVENT_BYTES) {
      this.queue.push({ type: 'error', code: 'event_too_large' });
      return;
    }
    let value;
    try { value = JSON.parse(buffer.toString('utf8')); } catch { return; }
    if (value?.type === 'conversation.item.input_audio_transcription.completed' &&
        typeof value.item_id === 'string' && typeof value.transcript === 'string') {
      this.queue.push({ type: 'final', text: value.transcript, providerItemId: value.item_id });
    } else if (value?.type === 'conversation.item.input_audio_transcription.failed') {
      this.queue.push({ type: 'error', code: providerErrorCode(value.error?.code) });
    } else if (value?.type === 'error') {
      this.queue.push({ type: 'error', code: providerErrorCode(value.error?.code) });
    }
  }

  async pushPcm16(samples, _timestampMicros) {
    if (this.closed) throw new Error('OpenAI STT session is closed');
    const pcm = encodePcm24k(samples);
    try {
      this.socket.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: pcm.toString('base64') }));
    } finally {
      pcm.fill(0);
    }
  }

  async commitTurn() {
    if (this.closed) throw new Error('OpenAI STT session is closed');
    this.socket.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
  }

  events() { return this.queue; }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.signal?.removeEventListener('abort', this.onAbort);
    this.socket.off('message', this.onMessage);
    this.queue.end();
    if (this.socket.readyState !== WebSocket.CLOSED && this.socket.readyState !== 3) this.socket.close();
  }
}

export class OpenAiRealtimeSttProvider {
  constructor({ apiKey, model = MODEL, socketFactory = (url, options) => new WebSocket(url, options) } = {}) {
    if (!MODELS.has(model)) throw new Error('OpenAI realtime STT model is unsupported');
    this.apiKey = typeof apiKey === 'function' ? apiKey : async () => '';
    this.model = model;
    this.socketFactory = socketFactory;
  }

  async #credential() {
    const value = await this.apiKey();
    return typeof value === 'string' && value.length >= 1 && value.length <= 512 ? value : null;
  }

  async health() {
    return await this.#credential()
      ? { healthy: true, model: this.model, sampleRate: 24_000 }
      : { healthy: false, reason: 'credential unavailable' };
  }

  async open({ language } = {}, signal) {
    if (language !== undefined && !LANGUAGE.test(language)) throw new Error('invalid transcription language');
    const key = await this.#credential();
    if (!key) throw new Error('OpenAI credential unavailable');
    const socket = this.socketFactory(ENDPOINT, {
      headers: { Authorization: `Bearer ${key}` },
      maxPayload: MAX_EVENT_BYTES,
      perMessageDeflate: false,
    });
    await waitForOpen(socket, signal);
    const session = new OpenAiSttSession(socket, signal);
    socket.send(JSON.stringify({
      type: 'session.update',
      session: {
        type: 'transcription',
        audio: { input: {
          format: { type: 'audio/pcm', rate: 24_000 },
          noise_reduction: { type: 'near_field' },
          transcription: {
            model: this.model,
            ...(language === undefined ? {} : { language }),
            prompt: TRANSCRIPTION_PROMPT,
          },
          turn_detection: null,
        } },
      },
    }));
    return session;
  }
}

export default OpenAiRealtimeSttProvider;
