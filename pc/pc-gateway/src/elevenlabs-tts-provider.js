const DEFAULT_BASE_URL = 'https://api.elevenlabs.io';
const DEFAULT_MODEL = 'eleven_flash_v2_5';
const MODELS = new Set([DEFAULT_MODEL, 'eleven_multilingual_v2', 'eleven_v3']);
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const LANGUAGE = /^[a-z]{2,3}$/;
const MAX_STREAM_BYTES = 32 * 1024 * 1024;
const TELEPHONE_VOICE_SETTINGS = Object.freeze({
  stability: 0.5,
  similarity_boost: 0.75,
  style: 0,
  use_speaker_boost: true,
  speed: 0.9,
});

function validateOrigin(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    throw new Error('ElevenLabs base URL must be an HTTPS origin');
  }
  return url.origin;
}

function decodePcm(buffer, sequence) {
  const pcm16 = new Int16Array(buffer.length / 2);
  for (let index = 0; index < pcm16.length; index++) pcm16[index] = buffer.readInt16LE(index * 2);
  return { pcm16, sampleRate: 16_000, channels: 1, sequence };
}

export class ElevenLabsTtsProvider {
  constructor({ baseUrl = DEFAULT_BASE_URL, apiKey, model = DEFAULT_MODEL, fetchImpl = globalThis.fetch, zeroRetention = false } = {}) {
    if (typeof apiKey !== 'function') apiKey = async () => '';
    if (!MODELS.has(model)) throw new Error('unsupported ElevenLabs model');
    if (typeof fetchImpl !== 'function') throw new TypeError('fetch implementation is required');
    this.baseUrl = validateOrigin(baseUrl);
    this.apiKey = apiKey;
    this.model = model;
    this.fetch = fetchImpl;
    this.zeroRetention = zeroRetention;
  }

  async #credential() {
    const value = await this.apiKey();
    return typeof value === 'string' && value.length >= 1 && value.length <= 512 ? value : null;
  }

  async health() {
    const key = await this.#credential();
    if (!key) return { healthy: false, reason: 'credential unavailable' };
    try {
      const response = await this.fetch(`${this.baseUrl}/v2/voices?page_size=1`, {
        method: 'GET', headers: { 'xi-api-key': key, accept: 'application/json' },
      });
      if (!response.ok) return { healthy: false, reason: 'voices endpoint unavailable' };
      const result = await response.json();
      if (!Array.isArray(result?.voices) || !result.voices.some((voice) => SAFE_ID.test(voice?.voice_id ?? ''))) {
        return { healthy: false, reason: 'no usable voices available' };
      }
      return { healthy: true, model: this.model, sampleRate: 16_000, ...(this.zeroRetention ? { retention: 'zero' } : {}) };
    } catch {
      return { healthy: false, reason: 'voices endpoint unavailable' };
    }
  }

  async *synthesize({ text, voice, language } = {}, signal) {
    if (typeof text !== 'string' || text.length < 1 || text.length > 4_000) throw new Error('TTS text must contain 1-4000 characters');
    if (!SAFE_ID.test(voice ?? '')) throw new Error('invalid ElevenLabs voice');
    if (language !== undefined && !LANGUAGE.test(language)) throw new Error('invalid ElevenLabs language');
    const key = await this.#credential();
    if (!key) throw new Error('ElevenLabs credential unavailable');
    const logging = this.zeroRetention ? 'false' : 'true';
    const url = `${this.baseUrl}/v1/text-to-speech/${encodeURIComponent(voice)}/stream?output_format=pcm_16000&enable_logging=${logging}`;
    const body = {
      text,
      model_id: this.model,
      ...(language === undefined ? {} : { language_code: language }),
      apply_text_normalization: 'auto',
      voice_settings: TELEPHONE_VOICE_SETTINGS,
    };
    const response = await this.fetch(url, {
      method: 'POST',
      headers: { 'xi-api-key': key, 'content-type': 'application/json', accept: 'audio/pcm' },
      body: JSON.stringify(body),
      signal,
    });
    if (!response.ok || !response.body) throw new Error(`ElevenLabs synthesis failed with status ${response.status}`);
    const contentType = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
    if (contentType !== 'audio/pcm' && contentType !== 'application/octet-stream') {
      throw new Error('ElevenLabs synthesis returned an invalid content type');
    }
    const reader = response.body.getReader();
    let carry = Buffer.alloc(0);
    let total = 0;
    let sequence = 0;
    let finished = false;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) { finished = true; break; }
        const incoming = Buffer.from(value);
        total += incoming.length;
        if (total > MAX_STREAM_BYTES) throw new Error('ElevenLabs stream is too large');
        const combined = carry.length ? Buffer.concat([carry, incoming]) : incoming;
        const usable = combined.length & ~1;
        if (usable > 0) yield decodePcm(combined.subarray(0, usable), sequence++);
        carry = usable < combined.length ? Buffer.from(combined.subarray(usable)) : Buffer.alloc(0);
      }
      if (carry.length !== 0) throw new Error('ElevenLabs stream ended with odd final PCM byte');
      if (total === 0) throw new Error('ElevenLabs synthesis returned empty PCM');
    } finally {
      carry.fill(0);
      if (!finished) await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
}

export default ElevenLabsTtsProvider;
