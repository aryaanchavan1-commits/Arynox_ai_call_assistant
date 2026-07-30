import { EnergyVad } from './energy-vad.js';
import { ProviderRouter } from './provider-router.js';
import { RealtimeSession } from './realtime-session.js';

const DEFAULT_MODELS = Object.freeze({
  stt: Object.freeze({ openai: 'gpt-4o-transcribe', elevenlabs: 'scribe_v2_realtime' }),
  tts: Object.freeze({ supertonic: 'supertonic-3', elevenlabs: 'eleven_flash_v2_5', openai: 'gpt-4o-mini-tts-2025-12-15' }),
});

export function createRealtimeFactory({ config, sttProviders = new Map(), ttsProviders = new Map() } = {}) {
  if (!config?.enabled) return null;
  const router = new ProviderRouter({ stt: sttProviders, tts: ttsProviders });
  return async ({ callId, gateway }) => {
    const selection = await router.pin({
      callId,
      stt: { provider: config.sttProvider, model: config.sttModel ?? DEFAULT_MODELS.stt[config.sttProvider] },
      tts: { provider: config.ttsProvider, model: config.ttsModel ?? DEFAULT_MODELS.tts[config.ttsProvider], voice: config.voice },
    });
    return new RealtimeSession({
      callId,
      gateway,
      sttProvider: selection.stt.provider,
      ttsProvider: selection.tts.provider,
      sttConfig: { language: config.sttLanguage },
      ttsDefaults: { voice: config.voice, language: config.ttsLanguage },
      vad: new EnergyVad(),
    });
  };
}

export default createRealtimeFactory;
