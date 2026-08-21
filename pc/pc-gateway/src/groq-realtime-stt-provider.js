const DEFAULT_MODEL = 'whisper-large-v3-turbo';
const MODELS = new Set([
  DEFAULT_MODEL,
  'whisper-large-v3',
  'distil-whisper-large-v3-en',
]);
const ENDPOINT = 'https://api.groq.com/openai/v1/audio/transcriptions';
const LANGUAGE = /^[a-z]{2}$/;
const SAMPLE_RATE = 16_000;
const FRAME_SAMPLES = 320;
const MAX_TURN_SAMPLES = SAMPLE_RATE * 40;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const TRANSCRIPTION_PROMPT = 'Telephone conversation. Transcribe only clearly spoken words; ignore background noise, music, line echo, and synthetic speech from the other side.';

function errorCodeFor(status) {
  if (status === 401 || status === 403) return 'authentication_failed';
  if (status === 429) return 'quota_exceeded';
  return 'request_failed';
}

function encodeWav(samples) {
  const output = Buffer.alloc(44 + samples.length * 2);
  output.write('RIFF', 0);
  output.writeUInt32LE(36 + samples.length * 2, 4);
  output.write('WAVE', 8);
  output.write('fmt ', 12);
  output.writeUInt32LE(16, 16);
  output.writeUInt16LE(1, 20);
  output.writeUInt16LE(1, 22);
  output.writeUInt32LE(SAMPLE_RATE, 24);
  output.writeUInt32LE(SAMPLE_RATE * 2, 28);
  output.writeUInt16LE(2, 32);
  output.writeUInt16LE(16, 34);
  output.write('data', 36);
  output.writeUInt32LE(samples.length * 2, 40);
  for (let index = 0; index < samples.length; index++) output.writeInt16LE(samples[index], 44 + index * 2);
  return output;
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

export class GroqSttSession {
  constructor({ apiKey, model, language, fetchImpl, signal }) {
    this.apiKey = apiKey;
    this.model = model;
    this.language = language;
    this.fetch = fetchImpl;
    this.chunks = [];
    this.samples = 0;
    this.queue = new AsyncEventQueue();
    this.closed = false;
    this.transcriptionWork = Promise.resolve();
    this.internalAbort = new AbortController();
    this.onExternalAbort = () => this.internalAbort.abort();
    signal?.addEventListener('abort', this.onExternalAbort, { once: true });
  }

  #boundedError(reason) {
    if (typeof reason === 'string' && /^[a-z0-9_.-]{1,64}$/i.test(reason)) return reason;
    return 'request_failed';
  }

  async pushPcm16(samples, _timestampMicros) {
    if (this.closed) throw new Error('Groq STT session is closed');
    if (!(samples instanceof Int16Array) || samples.length !== FRAME_SAMPLES) {
      throw new RangeError('Groq STT input must contain exactly 320 PCM16 samples');
    }
    this.chunks.push(Int16Array.from(samples));
    this.samples += samples.length;
    if (this.samples > MAX_TURN_SAMPLES) {
      this.queue.push({ type: 'error', code: 'turn_too_long' });
      this.chunks = [];
      this.samples = 0;
      throw new Error('Groq STT turn exceeds the maximum duration');
    }
  }

  async commitTurn() {
    if (this.closed) throw new Error('Groq STT session is closed');
    if (this.samples === 0) return;
    const samples = new Int16Array(this.samples);
    let cursor = 0;
    for (const chunk of this.chunks) {
      samples.set(chunk, cursor);
      cursor += chunk.length;
      chunk.fill(0);
    }
    this.chunks = [];
    this.samples = 0;
    const wav = encodeWav(samples);
    samples.fill(0);
    this.transcriptionWork = this.transcriptionWork.then(async () => {
      await this.#transcribe(wav);
    }).catch(() => {});
  }

  async #transcribe(wav) {
    if (this.closed || this.internalAbort.signal.aborted) return;
    try {
      const form = new FormData();
      form.append('file', new Blob([wav], { type: 'audio/wav' }), 'turn.wav');
      form.append('model', this.model);
      if (this.language !== undefined) form.append('language', this.language);
      form.append('prompt', TRANSCRIPTION_PROMPT);
      form.append('response_format', 'json');
      form.append('temperature', '0');
      const response = await this.fetch(ENDPOINT, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.apiKey}` },
        body: form,
        signal: this.internalAbort.signal,
      });
      if (this.closed || this.internalAbort.signal.aborted) return;
      if (!response.ok) {
        this.queue.push({ type: 'error', code: errorCodeFor(response.status) });
        return;
      }
      const text = await response.text();
      if (this.closed || this.internalAbort.signal.aborted) return;
      if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) {
        this.queue.push({ type: 'error', code: 'response_too_large' });
        return;
      }
      const payload = JSON.parse(text);
      const transcript = typeof payload?.text === 'string' ? payload.text.trim() : '';
      if (!transcript || transcript.length > 4_000) {
        this.queue.push({ type: 'error', code: 'transcription_invalid' });
        return;
      }
      this.queue.push({ type: 'final', text: transcript });
    } catch (error) {
      if (this.closed || this.internalAbort.signal.aborted) return;
      this.queue.push({ type: 'error', code: this.#boundedError(error?.code) });
    }
  }

  events() { return this.queue; }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.internalAbort.abort();
    this.signal?.removeEventListener('abort', this.onExternalAbort);
    this.queue.end();
    await this.transcriptionWork;
  }
}

export class GroqRealtimeSttProvider {
  constructor({ apiKey, model = DEFAULT_MODEL, fetchImpl = globalThis.fetch } = {}) {
    if (!MODELS.has(model)) throw new Error('Groq realtime STT model is unsupported');
    if (typeof fetchImpl !== 'function') throw new TypeError('fetch implementation is required');
    this.apiKey = typeof apiKey === 'function' ? apiKey : async () => '';
    this.model = model;
    this.fetch = fetchImpl;
  }

  async #credential() {
    const value = await this.apiKey();
    return typeof value === 'string' && value.length >= 1 && value.length <= 512 ? value : null;
  }

  async health() {
    return await this.#credential()
      ? { healthy: true, model: this.model, sampleRate: SAMPLE_RATE }
      : { healthy: false, reason: 'credential unavailable' };
  }

  async open({ language } = {}, signal) {
    if (language !== undefined && !LANGUAGE.test(language)) throw new Error('invalid transcription language');
    const key = await this.#credential();
    if (!key) throw new Error('Groq credential unavailable');
    return new GroqSttSession({
      apiKey: key,
      model: this.model,
      language,
      fetchImpl: this.fetch,
      signal,
    });
  }
}

export default GroqRealtimeSttProvider;