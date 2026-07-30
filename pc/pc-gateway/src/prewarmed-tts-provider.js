const DEFAULT_MAX_ENTRIES = 32;
const DEFAULT_MAX_SAMPLES = 2_400_000;

function cacheKey(provider, { text, voice, language } = {}) {
  return JSON.stringify({
    adapter: provider?.constructor?.name ?? null,
    model: provider?.model ?? null,
    text,
    voice: voice ?? null,
    language: language ?? null,
  });
}

function copyChunk(chunk) {
  if (!(chunk?.pcm16 instanceof Int16Array)
      || !Number.isInteger(chunk.sampleRate) || chunk.sampleRate < 8_000 || chunk.sampleRate > 192_000
      || chunk.channels !== 1) {
    throw new Error('TTS provider returned an invalid PCM chunk');
  }
  return {
    ...chunk,
    pcm16: new Int16Array(chunk.pcm16),
  };
}

function clearEntry(entry) {
  for (const chunk of entry.chunks) chunk.pcm16.fill(0);
}

export class PrewarmedTtsProvider {
  constructor({ provider, maxEntries = DEFAULT_MAX_ENTRIES, maxSamples = DEFAULT_MAX_SAMPLES } = {}) {
    if (!provider?.synthesize || typeof provider.synthesize !== 'function') {
      throw new Error('TTS provider is required');
    }
    if (!Number.isInteger(maxEntries) || maxEntries < 1 || maxEntries > 64) {
      throw new Error('TTS cache entry limit is invalid');
    }
    if (!Number.isInteger(maxSamples) || maxSamples < 8_000 || maxSamples > 9_600_000) {
      throw new Error('TTS cache sample limit is invalid');
    }
    this.provider = provider;
    this.model = provider.model;
    this.zeroRetention = provider.zeroRetention;
    this.maxEntries = maxEntries;
    this.maxSamples = maxSamples;
    this.entries = new Map();
    this.pending = new Map();
    this.sampleCount = 0;
  }

  health(...args) {
    if (typeof this.provider.health !== 'function') throw new Error('TTS provider health is unavailable');
    return this.provider.health(...args);
  }

  async prewarm(request = {}) {
    const key = cacheKey(this.provider, request);
    if (this.entries.has(key)) {
      this.#touch(key);
      return { cached: true };
    }
    const active = this.pending.get(key);
    if (active) {
      await active;
      return { cached: true };
    }
    const work = this.#prepare(key, request);
    this.pending.set(key, work);
    try {
      await work;
      return { cached: false };
    } finally {
      this.pending.delete(key);
    }
  }

  async #prepare(key, request) {
    const chunks = [];
    let samples = 0;
    try {
      for await (const chunk of this.provider.synthesize(request)) {
        const copy = copyChunk(chunk);
        samples += copy.pcm16.length;
        if (samples > this.maxSamples) throw new Error('prewarmed TTS phrase is too large');
        chunks.push(copy);
      }
      if (chunks.length === 0) throw new Error('TTS provider returned no audio');
      while (this.entries.size >= this.maxEntries || this.sampleCount + samples > this.maxSamples) {
        const oldestKey = this.entries.keys().next().value;
        if (oldestKey === undefined) throw new Error('prewarmed TTS phrase is too large');
        const oldest = this.entries.get(oldestKey);
        this.entries.delete(oldestKey);
        this.sampleCount -= oldest.samples;
        clearEntry(oldest);
      }
      this.entries.set(key, { chunks, samples });
      this.sampleCount += samples;
    } catch (error) {
      for (const chunk of chunks) chunk.pcm16.fill(0);
      throw error;
    }
  }

  #touch(key) {
    const entry = this.entries.get(key);
    if (!entry) return null;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry;
  }

  async *synthesize(request = {}, signal) {
    const key = cacheKey(this.provider, request);
    const entry = this.#touch(key);
    if (!entry) {
      yield* this.provider.synthesize(request, signal);
      return;
    }
    for (const chunk of entry.chunks) {
      if (signal?.aborted) return;
      yield copyChunk(chunk);
    }
  }

  clear() {
    for (const entry of this.entries.values()) clearEntry(entry);
    this.entries.clear();
    this.sampleCount = 0;
  }
}
