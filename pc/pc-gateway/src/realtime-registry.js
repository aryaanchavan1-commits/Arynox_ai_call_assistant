import { ElevenLabsRealtimeSttProvider } from './elevenlabs-realtime-stt-provider.js';
import { ElevenLabsTtsProvider } from './elevenlabs-tts-provider.js';
import { GroqRealtimeSttProvider } from './groq-realtime-stt-provider.js';
import { GroqTtsProvider } from './groq-tts-provider.js';
import { OpenAiRealtimeSttProvider } from './openai-realtime-stt-provider.js';
import { OpenAiTtsProvider } from './openai-tts-provider.js';
import { SupertonicTtsProvider } from './supertonic-provider.js';
import { createProviderSpeechTest } from './provider-speech-test.js';
import { PrewarmedTtsProvider } from './prewarmed-tts-provider.js';
import {
  standardAcknowledgementOptions,
  standardGreetingOptions,
} from './conversation-phrases.js';

function secret(env, name) {
  return async () => {
    const value = env[name];
    return typeof value === 'string' ? value : '';
  };
}

function publicHealth(kind, provider, value) {
  const healthy = value?.healthy === true;
  const response = { kind, provider, healthy };
  if (value?.scope === 'credential' || value?.scope === 'endpoint' || value?.scope === 'session') response.scope = value.scope;
  if (value?.retention === 'zero') response.retention = 'zero';
  if (typeof value?.model === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.model)) {
    response.model = value.model;
  }
  if (Number.isInteger(value?.sampleRate) && value.sampleRate >= 8_000 && value.sampleRate <= 192_000) {
    response.sampleRate = value.sampleRate;
  }
  if (!healthy) {
    response.reason = typeof value?.reason === 'string' && value.reason.length <= 120
      ? value.reason
      : 'provider unavailable';
  }
  return response;
}

export function createActiveProviderHealth({ config, sttProviders, ttsProviders, timeoutMs = 5_000 }) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
    throw new Error('provider health timeout is invalid');
  }
  return async ({ kind } = {}) => {
    if (kind !== 'stt' && kind !== 'tts') throw new Error('provider kind is invalid');
    const provider = kind === 'stt' ? config?.sttProvider : config?.ttsProvider;
    const registry = kind === 'stt' ? sttProviders : ttsProviders;
    const adapter = registry instanceof Map ? registry.get(provider) : null;
    if (!adapter || typeof adapter.health !== 'function') {
      return publicHealth(kind, provider, { healthy: false, reason: 'active provider unavailable' });
    }
    let timer;
    try {
      const value = await Promise.race([
        adapter.health(),
        new Promise((resolve) => {
          timer = setTimeout(
            () => resolve({ healthy: false, reason: 'provider health check timed out' }),
            timeoutMs,
          );
        }),
      ]);
      return publicHealth(kind, provider, value);
    } catch {
      return publicHealth(kind, provider, { healthy: false, reason: 'provider health check failed' });
    } finally {
      clearTimeout(timer);
    }
  };
}

export function createRealtimeRegistry(config, env = process.env, { artifactPath } = {}) {
  if (!config?.enabled) return { sttProviders: new Map(), ttsProviders: new Map() };
  const sttProviders = new Map();
  const ttsProviders = new Map();
  if (config.sttProvider === 'openai') {
    sttProviders.set('openai', new OpenAiRealtimeSttProvider({ apiKey: secret(env, 'OPENAI_API_KEY'), model: config.sttModel }));
  } else if (config.sttProvider === 'elevenlabs') {
    sttProviders.set('elevenlabs', new ElevenLabsRealtimeSttProvider({
      apiKey: secret(env, 'ELEVENLABS_API_KEY'), model: config.sttModel, zeroRetention: config.elevenLabsZeroRetention === true,
    }));
  } else if (config.sttProvider === 'groq') {
    sttProviders.set('groq', new GroqRealtimeSttProvider({ apiKey: secret(env, 'GROQ_API_KEY'), model: config.sttModel }));
  }
  if (config.ttsProvider === 'openai') {
    ttsProviders.set('openai', new OpenAiTtsProvider({ apiKey: secret(env, 'OPENAI_API_KEY'), model: config.ttsModel }));
  } else if (config.ttsProvider === 'elevenlabs') {
    ttsProviders.set('elevenlabs', new ElevenLabsTtsProvider({
      apiKey: secret(env, 'ELEVENLABS_API_KEY'), model: config.ttsModel, zeroRetention: config.elevenLabsZeroRetention === true,
    }));
  } else if (config.ttsProvider === 'supertonic') {
    ttsProviders.set('supertonic', new SupertonicTtsProvider({ model: config.ttsModel }));
  } else if (config.ttsProvider === 'groq') {
    ttsProviders.set('groq', new GroqTtsProvider({ apiKey: secret(env, 'GROQ_API_KEY'), model: config.ttsModel }));
  }
  const selectedTts = ttsProviders.get(config.ttsProvider);
  if (selectedTts) {
    ttsProviders.set(config.ttsProvider, new PrewarmedTtsProvider({ provider: selectedTts }));
  }
  const sttProvider = sttProviders.get(config.sttProvider);
  const ttsProvider = ttsProviders.get(config.ttsProvider);
  const prewarmSpeech = ({ text }) => ttsProvider.prewarm({
    text,
    voice: config.voice,
    language: config.ttsLanguage,
  });
  return {
    sttProviders,
    ttsProviders,
    checkHealth: createActiveProviderHealth({ config, sttProviders, ttsProviders }),
    prewarmSpeech,
    prewarmGreetings: async () => {
      for (const text of [
        ...standardGreetingOptions(),
        ...standardAcknowledgementOptions(),
      ]) await prewarmSpeech({ text });
    },
    ...(artifactPath ? {
      testSpeech: createProviderSpeechTest({ sttProvider, ttsProvider, config, artifactPath }),
    } : {}),
  };
}

export default createRealtimeRegistry;
