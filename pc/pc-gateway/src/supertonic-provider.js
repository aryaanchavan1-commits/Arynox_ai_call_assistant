const DEFAULT_BASE_URL = 'http://127.0.0.1:7788';
const EXPECTED_MODEL = 'supertonic-3';
const EXPECTED_SAMPLE_RATE = 44_100;
const MAX_AUDIO_BYTES = 32 * 1024 * 1024;
const VOICE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const LANGUAGE = /^(?:na|[a-z]{2})$/;

function validateBaseUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost')) {
    throw new Error('Supertonic endpoint must use HTTP loopback');
  }
  if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    throw new Error('Supertonic endpoint must be an origin without credentials or path');
  }
  return url.origin;
}

function decodePcm16Wav(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('invalid WAV container');
  }
  let format = null;
  let data = null;
  for (let offset = 12; offset + 8 <= buffer.length;) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = start + size;
    if (end > buffer.length) throw new Error('truncated WAV chunk');
    if (id === 'fmt ') {
      if (size < 16) throw new Error('invalid WAV format chunk');
      format = {
        encoding: buffer.readUInt16LE(start),
        channels: buffer.readUInt16LE(start + 2),
        sampleRate: buffer.readUInt32LE(start + 4),
        bits: buffer.readUInt16LE(start + 14),
      };
    } else if (id === 'data') {
      data = buffer.subarray(start, end);
    }
    offset = end + (size & 1);
  }
  if (!format || !data) throw new Error('WAV format or data chunk missing');
  if (format.encoding !== 1 || format.channels !== 1 || format.bits !== 16 || format.sampleRate !== EXPECTED_SAMPLE_RATE) {
    throw new Error('WAV must be mono PCM16 at 44100 Hz');
  }
  if ((data.length & 1) !== 0) throw new Error('WAV PCM data has odd byte length');
  const samples = new Int16Array(data.length / 2);
  for (let index = 0; index < samples.length; index++) samples[index] = data.readInt16LE(index * 2);
  return { pcm16: samples, sampleRate: format.sampleRate, channels: format.channels, sequence: 0 };
}

async function boundedBody(response) {
  const declared = response.headers.get('content-length');
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > MAX_AUDIO_BYTES)) {
    throw new Error('Supertonic response is too large');
  }
  const value = Buffer.from(await response.arrayBuffer());
  if (value.length > MAX_AUDIO_BYTES) throw new Error('Supertonic response is too large');
  return value;
}

export class SupertonicTtsProvider {
  constructor({ baseUrl = DEFAULT_BASE_URL, fetchImpl = globalThis.fetch } = {}) {
    if (typeof fetchImpl !== 'function') throw new TypeError('fetch implementation is required');
    this.baseUrl = validateBaseUrl(baseUrl);
    this.fetch = fetchImpl;
  }

  async health() {
    try {
      const response = await this.fetch(`${this.baseUrl}/v1/health`, { method: 'GET' });
      if (!response.ok) return { healthy: false, reason: 'health endpoint unavailable' };
      const value = await response.json();
      if (value?.status !== 'ok' || value.model !== EXPECTED_MODEL || value.sample_rate !== EXPECTED_SAMPLE_RATE) {
        return { healthy: false, reason: 'unexpected model or sample rate' };
      }
      return { healthy: true, model: value.model, sampleRate: value.sample_rate };
    } catch {
      return { healthy: false, reason: 'health endpoint unavailable' };
    }
  }

  async *synthesize({ text, voice, language = 'na' } = {}, signal) {
    if (typeof text !== 'string' || text.length < 1 || text.length > 4_000) throw new Error('TTS text must contain 1-4000 characters');
    if (!VOICE.test(voice ?? '')) throw new Error('invalid Supertonic voice');
    if (!LANGUAGE.test(language)) throw new Error('invalid Supertonic language');
    const response = await this.fetch(`${this.baseUrl}/v1/tts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'audio/wav' },
      body: JSON.stringify({ text, voice, lang: language, response_format: 'wav', model: EXPECTED_MODEL }),
      signal,
    });
    if (!response.ok) throw new Error(`Supertonic synthesis failed with status ${response.status}`);
    const body = await boundedBody(response);
    const chunk = decodePcm16Wav(body);
    body.fill(0);
    yield chunk;
  }
}

export default SupertonicTtsProvider;
