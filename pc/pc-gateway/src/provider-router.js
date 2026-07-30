const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const CALL_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/;

function strictConfig(value, kind) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${kind} selection is required`);
  const allowed = kind === 'STT' ? new Set(['provider', 'model']) : new Set(['provider', 'model', 'voice']);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`unknown field ${key} in ${kind} selection`);
  }
  for (const key of allowed) {
    if (key === 'voice' && kind === 'TTS') continue;
    if (!SAFE_ID.test(value[key] ?? '')) throw new Error(`${kind} ${key} has an invalid shape`);
  }
  if (kind === 'TTS' && value.voice !== undefined && !SAFE_ID.test(value.voice)) {
    throw new Error('TTS voice has an invalid shape');
  }
  return Object.freeze({
    provider: value.provider,
    model: value.model,
    ...(value.voice === undefined ? {} : { voice: value.voice }),
  });
}

async function requireHealthy(kind, id, provider) {
  if (!provider) throw new Error(`unknown ${kind} provider: ${id}`);
  if (typeof provider.health !== 'function') throw new Error(`${kind} provider ${id} has no health contract`);
  const health = await provider.health();
  if (health?.healthy !== true) {
    const reason = typeof health?.reason === 'string' && health.reason.length <= 120 ? health.reason : 'unavailable';
    throw new Error(`${kind} provider ${id} is unhealthy: ${reason}`);
  }
}

export class ProviderRouter {
  constructor({ stt = new Map(), tts = new Map() } = {}) {
    if (!(stt instanceof Map) || !(tts instanceof Map)) throw new TypeError('provider registries must be maps');
    this.stt = new Map(stt);
    this.tts = new Map(tts);
  }

  async pin({ callId, stt, tts } = {}) {
    if (!CALL_ID.test(callId ?? '')) throw new Error('callId has an invalid shape');
    const sttMetadata = strictConfig(stt, 'STT');
    const ttsMetadata = strictConfig(tts, 'TTS');
    const sttProvider = this.stt.get(sttMetadata.provider);
    const ttsProvider = this.tts.get(ttsMetadata.provider);
    await requireHealthy('STT', sttMetadata.provider, sttProvider);
    await requireHealthy('TTS', ttsMetadata.provider, ttsProvider);
    const manifest = Object.freeze({ stt: sttMetadata, tts: ttsMetadata });
    return Object.freeze({
      callId,
      stt: Object.freeze({ provider: sttProvider, metadata: sttMetadata }),
      tts: Object.freeze({ provider: ttsProvider, metadata: ttsMetadata }),
      manifest,
    });
  }
}

export default ProviderRouter;
