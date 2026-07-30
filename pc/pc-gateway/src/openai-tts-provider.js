const DEFAULT_BASE_URL = 'https://api.openai.com';
const MODEL = 'gpt-4o-mini-tts-2025-12-15';
const MODELS = new Set([MODEL, 'gpt-4o-mini-tts', 'tts-1', 'tts-1-hd']);
const VOICE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const LANGUAGE = /^[a-z]{2,3}$/;
const MAX_STREAM_BYTES = 32 * 1024 * 1024;
const PCM_CONTENT_TYPES = new Set(['audio/pcm', 'application/octet-stream']);

function validateOrigin(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
      || (url.pathname !== '/' && url.pathname !== '')) {
    throw new Error('OpenAI base URL must be an HTTPS origin');
  }
  return url.origin;
}

function failureForStatus(status) {
  if (status === 401 || status === 403) return new Error('OpenAI authentication failed');
  if (status === 429) return new Error('OpenAI quota unavailable');
  return new Error(`OpenAI synthesis failed with status ${status}`);
}

function decodePcm(buffer, sequence) {
  const pcm16 = new Int16Array(buffer.length / 2);
  for (let index = 0; index < pcm16.length; index++) pcm16[index] = buffer.readInt16LE(index * 2);
  return { pcm16, sampleRate: 24_000, channels: 1, sequence };
}

export class OpenAiTtsProvider {
  constructor({ baseUrl = DEFAULT_BASE_URL, apiKey, model = MODEL, fetchImpl = globalThis.fetch } = {}) {
    if (!MODELS.has(model)) throw new Error('OpenAI TTS model is unsupported');
    if (typeof fetchImpl !== 'function') throw new TypeError('fetch implementation is required');
    this.baseUrl = validateOrigin(baseUrl);
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
      ? { healthy: true, scope: 'credential', model: this.model, sampleRate: 24_000 }
      : { healthy: false, reason: 'credential unavailable' };
  }

  async *synthesize({ text, voice, language } = {}, signal) {
    if (typeof text !== 'string' || text.length < 1 || text.length > 4_096) {
      throw new Error('TTS text must contain 1-4096 characters');
    }
    if (!VOICE.test(voice ?? '')) throw new Error('invalid OpenAI voice');
    if (language !== undefined && !LANGUAGE.test(language)) throw new Error('invalid OpenAI language');
    const key = await this.#credential();
    if (!key) throw new Error('OpenAI credential unavailable');
    signal?.throwIfAborted();
    const response = await this.fetch(`${this.baseUrl}/v1/audio/speech`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
        accept: 'audio/pcm',
      },
      body: JSON.stringify({ model: this.model, input: text, voice, response_format: 'pcm' }),
      signal,
    });
    if (!response.ok) throw failureForStatus(response.status);
    const contentType = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
    if (!response.body || !PCM_CONTENT_TYPES.has(contentType)) throw new Error('OpenAI synthesis returned an invalid PCM response');

    const reader = response.body.getReader();
    let carry = Buffer.alloc(0);
    let total = 0;
    let sequence = 0;
    let completed = false;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        const incoming = Buffer.from(value);
        total += incoming.length;
        if (total > MAX_STREAM_BYTES) throw new Error('OpenAI PCM response is too large');
        const combined = carry.length ? Buffer.concat([carry, incoming]) : incoming;
        const usable = combined.length & ~1;
        if (usable > 0) yield decodePcm(combined.subarray(0, usable), sequence++);
        carry = usable < combined.length ? Buffer.from(combined.subarray(usable)) : Buffer.alloc(0);
      }
      if (carry.length !== 0) throw new Error('OpenAI stream ended with odd final PCM byte');
      if (total === 0) throw new Error('OpenAI synthesis returned an empty PCM response');
      completed = true;
    } finally {
      carry.fill(0);
      if (!completed) await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
}

export default OpenAiTtsProvider;
