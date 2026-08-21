const DEFAULT_MODEL = 'playai-tts';
const MODELS = new Set([
  DEFAULT_MODEL,
  'playai-tts-arabic',
  'canopylabs/orpheus-v1-english',
  'canopylabs/orpheus-arabic-saudi',
]);
const DEFAULT_BASE_URL = 'https://api.groq.com';
const TTS_SAMPLE_RATE = 24_000;
const PLAYAI_VOICES = Object.freeze([
  'Arista-PlayAI', 'Atlas-PlayAI', 'Celeste-PlayAI', 'Chip-PlayAI',
  'Daniel-PlayAI', 'Ethan-PlayAI', 'Fritz-PlayAI', 'Jennifer-PlayAI',
  'Nancy-PlayAI', 'Rachel-PlayAI',
]);
const ORPHEUS_VOICES = Object.freeze([
  'austin', 'brady', 'chloe', 'edward', 'emily', 'hannah', 'james',
  'jessica', 'john', 'julie', 'matthew', 'mike', 'rick', 'sam',
  'steve', 'troy',
]);
const VOICES = new Set([...PLAYAI_VOICES, ...ORPHEUS_VOICES]);
const LANGUAGE = /^[a-z]{2,3}$/;
const MAX_STREAM_BYTES = 32 * 1024 * 1024;
const CHUNK_SAMPLES = 8_000;
const MIN_WAV_HEADER_BYTES = 44;

function validateOrigin(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
      || (url.pathname !== '/' && url.pathname !== '')) {
    throw new Error('Groq base URL must be an HTTPS origin');
  }
  return url.origin;
}

function failureForStatus(status) {
  if (status === 401 || status === 403) return new Error('Groq authentication failed');
  if (status === 429) return new Error('Groq quota unavailable');
  return new Error(`Groq synthesis failed with status ${status}`);
}

function parseWavHeader(buffer) {
  if (buffer.length < MIN_WAV_HEADER_BYTES
      || buffer.toString('ascii', 0, 4) !== 'RIFF'
      || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('Groq synthesis returned an invalid WAV response');
  }
  let offset = 12;
  let format = null;
  let dataOffset = -1;
  let dataSize = -1;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ' && size >= 16 && body + 16 <= buffer.length) {
      format = {
        audioFormat: buffer.readUInt16LE(body),
        channels: buffer.readUInt16LE(body + 2),
        sampleRate: buffer.readUInt32LE(body + 4),
        bitsPerSample: buffer.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      dataOffset = body;
      dataSize = size;
    }
    offset = body + size + (size % 2);
  }
  if (!format || format.audioFormat !== 1 || dataOffset < 0 || dataSize < 0) {
    throw new Error('Groq synthesis returned an invalid WAV payload');
  }
  return { ...format, dataOffset, dataSize };
}

function decodePcm(buffer, format, sequence) {
  const bytesPerSample = Math.max(1, format.bitsPerSample / 8);
  const stride = format.channels * bytesPerSample;
  const count = Math.floor(buffer.length / stride);
  const pcm16 = new Int16Array(count);
  for (let index = 0; index < count; index++) {
    const base = index * stride;
    let value = 0;
    if (bytesPerSample === 1) {
      value = (buffer[base] - 128) << 8;
    } else if (bytesPerSample === 2) {
      value = buffer.readInt16LE(base);
    } else if (bytesPerSample === 3) {
      const raw = buffer[base] | (buffer[base + 1] << 8) | (buffer[base + 2] << 16);
      value = (raw << 8) >> 8;
    } else {
      value = buffer.readInt32LE(base) >> 16;
    }
    pcm16[index] = value;
  }
  return { pcm16, sampleRate: format.sampleRate, channels: format.channels, sequence };
}

export class GroqTtsProvider {
  constructor({ baseUrl = DEFAULT_BASE_URL, apiKey, model = DEFAULT_MODEL, fetchImpl = globalThis.fetch } = {}) {
    if (!MODELS.has(model)) throw new Error('Groq TTS model is unsupported');
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
      ? { healthy: true, scope: 'credential', model: this.model, sampleRate: TTS_SAMPLE_RATE }
      : { healthy: false, reason: 'credential unavailable' };
  }

  async *synthesize({ text, voice, language } = {}, signal) {
    if (typeof text !== 'string' || text.length < 1 || text.length > 4_096) {
      throw new Error('TTS text must contain 1-4096 characters');
    }
    if (!VOICES.has(voice ?? '')) throw new Error('invalid Groq voice');
    if (language !== undefined && !LANGUAGE.test(language)) throw new Error('invalid Groq language');
    const key = await this.#credential();
    if (!key) throw new Error('Groq credential unavailable');
    signal?.throwIfAborted();
    const response = await this.fetch(`${this.baseUrl}/openai/v1/audio/speech`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
        accept: 'audio/wav',
      },
      body: JSON.stringify({
        model: this.model,
        input: text,
        voice,
        response_format: 'wav',
        sample_rate: TTS_SAMPLE_RATE,
      }),
      signal,
    });
    if (!response.ok) throw failureForStatus(response.status);

    const reader = response.body.getReader();
    let carry = Buffer.alloc(0);
    let total = 0;
    let header = null;
    let consumedData = 0;
    let sequence = 0;
    let completed = false;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        const incoming = Buffer.from(value);
        total += incoming.length;
        if (total > MAX_STREAM_BYTES) throw new Error('Groq WAV response is too large');
        const combined = carry.length ? Buffer.concat([carry, incoming]) : incoming;
        if (!header) {
          if (combined.length < MIN_WAV_HEADER_BYTES) {
            carry = Buffer.from(combined);
            continue;
          }
          header = parseWavHeader(combined);
        }
        const dataEnd = header.dataOffset + header.dataSize;
        const available = Math.min(combined.length, dataEnd) - header.dataOffset - consumedData;
        const bytesPerSample = Math.max(1, header.bitsPerSample / 8);
        const aligned = available - (available % bytesPerSample);
        if (aligned > 0) {
          const start = header.dataOffset + consumedData;
          const pcm = Buffer.from(combined.subarray(start, start + aligned));
          const perChunk = CHUNK_SAMPLES * bytesPerSample * header.channels;
          for (let offset = 0; offset < aligned; offset += perChunk) {
            yield decodePcm(pcm.subarray(offset, Math.min(offset + perChunk, aligned)), header, sequence++);
          }
          pcm.fill(0);
          consumedData += aligned;
        }
        const consumedEnd = header.dataOffset + consumedData;
        carry = consumedEnd < combined.length ? Buffer.from(combined.subarray(consumedEnd)) : Buffer.alloc(0);
      }
      if (carry.length !== 0) throw new Error('Groq stream ended with a partial PCM frame');
      if (!header || total === 0) throw new Error('Groq synthesis returned an empty WAV response');
      completed = true;
    } finally {
      carry.fill(0);
      if (!completed) await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
}

export default GroqTtsProvider;