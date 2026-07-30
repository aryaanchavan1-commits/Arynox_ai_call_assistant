import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import { Worker } from 'node:worker_threads';

const DEFAULT_PATH = '/var/lib/agentcall/provider-settings.json';
const DEFAULT_SUPERTONIC_BASE_URL = 'http://127.0.0.1:7788';
const DEFAULT_CATALOG_TIMEOUT_MS = 8_000;
const MAX_CATALOG_RESPONSE_BYTES = 4 * 1024 * 1024;
const CATALOG_WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
const parsed = new URL(workerData.url);
const transport = parsed.protocol === 'https:'
  ? require('node:https')
  : parsed.protocol === 'http:'
    ? require('node:http')
    : null;
if (!transport) {
  parentPort.postMessage({ error: 'provider catalog protocol is unsupported' });
} else {
  const chunks = [];
  let bytes = 0;
  const request = transport.request(parsed, {
    method: workerData.method,
    headers: workerData.headers,
  }, (response) => {
    response.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > workerData.maxBytes) {
        request.destroy(new Error('provider catalog response is too large'));
        return;
      }
      chunks.push(chunk);
    });
    response.once('error', (error) => {
      parentPort.postMessage({ error: String(error?.message || 'provider catalog response failed').slice(0, 160) });
    });
    response.once('end', () => {
      parentPort.postMessage({
        status: response.statusCode,
        body: Buffer.concat(chunks).toString('utf8'),
      });
    });
  });
  request.once('error', (error) => {
    parentPort.postMessage({ error: String(error?.message || 'provider catalog request failed').slice(0, 160) });
  });
  request.end();
}
`;
const VERSION = 1;
const LANGUAGE = /^[a-z]{2,3}$/;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const OPENAI_TRANSCRIPTION_LANGUAGES = Object.freeze([
  'af', 'ar', 'hy', 'az', 'be', 'bs', 'bg', 'ca', 'zh', 'hr', 'cs', 'da', 'nl', 'en', 'et', 'fi',
  'fr', 'gl', 'de', 'el', 'he', 'hi', 'hu', 'is', 'id', 'it', 'ja', 'kn', 'kk', 'ko', 'lv', 'lt',
  'mk', 'ms', 'mr', 'mi', 'ne', 'no', 'fa', 'pl', 'pt', 'ro', 'ru', 'sr', 'sk', 'sl', 'es', 'sw',
  'sv', 'tl', 'ta', 'th', 'tr', 'uk', 'ur', 'vi', 'cy',
]);
const ELEVEN_STT_LANGUAGES = Object.freeze([
  'ar', 'bg', 'cs', 'da', 'de', 'el', 'en', 'es', 'et', 'fi', 'fil', 'fr', 'hi', 'hr', 'hu', 'id',
  'it', 'ja', 'ko', 'lt', 'lv', 'ms', 'nl', 'no', 'pl', 'pt', 'ro', 'ru', 'sk', 'sl', 'sv', 'ta',
  'tr', 'uk', 'vi', 'zh',
]);
const ELEVEN_MULTILINGUAL_LANGUAGES = Object.freeze([
  'en', 'ja', 'zh', 'de', 'hi', 'fr', 'ko', 'pt', 'it', 'es', 'id', 'nl', 'tr', 'fil', 'pl', 'sv',
  'bg', 'ro', 'ar', 'cs', 'el', 'fi', 'hr', 'ms', 'sk', 'da', 'ta', 'uk', 'ru',
]);
const ELEVEN_FLASH_LANGUAGES = Object.freeze([...ELEVEN_MULTILINGUAL_LANGUAGES, 'hu', 'no', 'vi']);
const SUPERTONIC_LANGUAGES = Object.freeze(['en', 'ko', 'es', 'pt', 'fr', 'na']);
const CATALOG_LANGUAGES = Object.freeze({
  stt: Object.freeze({
    openai: OPENAI_TRANSCRIPTION_LANGUAGES,
    elevenlabs: ELEVEN_STT_LANGUAGES,
  }),
  tts: Object.freeze({
    supertonic: SUPERTONIC_LANGUAGES,
    openai: OPENAI_TRANSCRIPTION_LANGUAGES,
    elevenlabs: Object.freeze({
      eleven_flash_v2_5: ELEVEN_FLASH_LANGUAGES,
      eleven_multilingual_v2: ELEVEN_MULTILINGUAL_LANGUAGES,
      eleven_v3: ELEVEN_FLASH_LANGUAGES,
    }),
  }),
});
const CATALOG_VOICES = Object.freeze({
  openai: Object.freeze(['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse', 'marin', 'cedar']),
  supertonic: Object.freeze(['F1', 'F2', 'F3', 'F4', 'F5', 'M1', 'M2', 'M3', 'M4', 'M5']),
});
const PROVIDERS = Object.freeze({
  stt: Object.freeze({
    openai: Object.freeze({
      defaultModel: 'gpt-4o-transcribe',
      models: Object.freeze([
        'gpt-4o-transcribe',
        'gpt-4o-mini-transcribe',
        'gpt-4o-mini-transcribe-2025-12-15',
        'whisper-1',
      ]),
      secret: 'OPENAI_API_KEY',
    }),
    elevenlabs: Object.freeze({ defaultModel: 'scribe_v2_realtime', models: Object.freeze(['scribe_v2_realtime']), secret: 'ELEVENLABS_API_KEY' }),
  }),
  tts: Object.freeze({
    supertonic: Object.freeze({ defaultModel: 'supertonic-3', models: Object.freeze(['supertonic-3']), secret: null }),
    elevenlabs: Object.freeze({
      defaultModel: 'eleven_flash_v2_5',
      models: Object.freeze(['eleven_flash_v2_5', 'eleven_multilingual_v2', 'eleven_v3']),
      secret: 'ELEVENLABS_API_KEY',
    }),
    openai: Object.freeze({
      defaultModel: 'gpt-4o-mini-tts-2025-12-15',
      models: Object.freeze(['gpt-4o-mini-tts-2025-12-15', 'gpt-4o-mini-tts', 'tts-1', 'tts-1-hd']),
      secret: 'OPENAI_API_KEY',
    }),
  }),
});

function emptyState() {
  return { version: VERSION, stt: null, tts: null };
}

function stateFromEnv(env) {
  if (env.AGENTCALL_REALTIME_ENABLED !== 'true') return emptyState();
  const sttProvider = env.AGENTCALL_STT_PROVIDER;
  const ttsProvider = env.AGENTCALL_TTS_PROVIDER;
  const fallbackLanguage = env.AGENTCALL_REALTIME_LANGUAGE || 'en';
  const sttLanguage = env.AGENTCALL_STT_LANGUAGE || fallbackLanguage;
  const ttsLanguage = env.AGENTCALL_TTS_LANGUAGE || fallbackLanguage;
  const sttDefinition = PROVIDERS.stt[sttProvider];
  const ttsDefinition = PROVIDERS.tts[ttsProvider];
  if (!sttDefinition || !ttsDefinition) return emptyState();
  const stt = validateEntry({
    kind: 'stt',
    provider: sttProvider,
    model: env.AGENTCALL_STT_MODEL || sttDefinition.defaultModel,
    language: sttLanguage,
    apiKey: sttDefinition.secret ? env[sttDefinition.secret] || '' : '',
  }, 'stt');
  const tts = validateEntry({
    kind: 'tts',
    provider: ttsProvider,
    model: env.AGENTCALL_TTS_MODEL || ttsDefinition.defaultModel,
    language: ttsLanguage,
    voice: env.AGENTCALL_TTS_VOICE,
    apiKey: ttsDefinition.secret ? env[ttsDefinition.secret] || '' : '',
  }, 'tts');
  return { version: VERSION, stt, tts };
}

function migrateState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  if (value.version === VERSION && value.stt?.provider === 'openai'
      && value.stt.model === 'gpt-realtime-whisper') {
    return {
      ...value,
      stt: { ...value.stt, model: PROVIDERS.stt.openai.defaultModel },
    };
  }
  return value;
}

function catalogLanguages(kind, provider, model) {
  const catalog = CATALOG_LANGUAGES[kind]?.[provider];
  if (Array.isArray(catalog)) return [...catalog];
  return [...(catalog?.[model] ?? [])];
}

function validateSupertonicBaseUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname)
      || url.username || url.password || url.search || url.hash
      || (url.pathname !== '/' && url.pathname !== '')) {
    throw new Error('Supertonic catalog endpoint must be a loopback HTTP origin');
  }
  return url.origin;
}

function providerEntry(state, provider, preferredKind) {
  if (state[preferredKind]?.provider === provider) return state[preferredKind];
  if (state.stt?.provider === provider) return state.stt;
  if (state.tts?.provider === provider) return state.tts;
  return null;
}

function availableModels(payload, supported) {
  const ids = Array.isArray(payload?.data)
    ? payload.data.map((item) => item?.id)
    : Array.isArray(payload)
      ? payload.map((item) => item?.model_id)
      : [];
  const available = new Set(ids.filter((id) => typeof id === 'string'));
  return supported.filter((id) => available.has(id));
}

function requestCatalogJson(url, { method = 'GET', headers = {}, signal } = {}) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return Promise.reject(new Error('provider catalog protocol is unsupported'));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const worker = new Worker(CATALOG_WORKER_SOURCE, {
      eval: true,
      workerData: {
        url: parsed.href,
        method,
        headers,
        maxBytes: MAX_CATALOG_RESPONSE_BYTES,
      },
    });
    worker.unref();
    const cleanup = () => signal?.removeEventListener?.('abort', onAbort);
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(result);
    };
    const onAbort = () => {
      void worker.terminate();
      finish(new Error('provider catalog request aborted'));
    };
    signal?.addEventListener?.('abort', onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }
    worker.once('message', (message) => {
      void worker.terminate();
      if (message?.error) {
        finish(new Error(message.error));
        return;
      }
      const status = message?.status;
      const body = message?.body;
      if (!Number.isInteger(status) || typeof body !== 'string') {
        finish(new Error('provider catalog response is invalid'));
        return;
      }
      finish(null, {
        ok: status >= 200 && status < 300,
        status,
        json: async () => JSON.parse(body),
      });
    });
    worker.once('error', (error) => finish(error));
    worker.once('exit', (code) => {
      if (!settled) finish(new Error(code === 0
        ? 'provider catalog worker returned no response'
        : 'provider catalog worker failed'));
    });
  });
}

function boundedString(value, name, { allowEmpty = false, max = 4096 } = {}) {
  if (typeof value !== 'string' || value.length > max || (!allowEmpty && value.length === 0)) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

function validateEntry(value, expectedKind) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('provider settings are invalid');
  const allowed = new Set(['kind', 'provider', 'model', 'language', 'voice', 'apiKey', 'zeroRetention']);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw new Error('provider settings are invalid');
  if (value.kind !== expectedKind) throw new Error('provider kind is invalid');
  const provider = boundedString(value.provider, 'provider', { max: 32 });
  const definition = PROVIDERS[expectedKind][provider];
  if (!definition) throw new Error('provider is unsupported');
  const model = boundedString(value.model, 'model', { max: 128 });
  if (!definition.models.includes(model)) throw new Error('provider model is unsupported');
  const language = boundedString(value.language, 'language', { max: 8 });
  if (!LANGUAGE.test(language)) throw new Error('provider language is invalid');
  const zeroRetention = value.zeroRetention;
  if (provider === 'elevenlabs' && typeof zeroRetention !== 'boolean') throw new Error('provider retention policy is required');
  if (provider !== 'elevenlabs' && zeroRetention !== undefined) throw new Error('provider retention policy is invalid');
  const voice = expectedKind === 'tts'
    ? boundedString(value.voice, 'voice', { max: 128 })
    : undefined;
  if (voice !== undefined && !TOKEN.test(voice)) throw new Error('provider voice is invalid');
  const apiKey = boundedString(value.apiKey, 'api key', { allowEmpty: definition.secret === null });
  if (definition.secret !== null && apiKey.length === 0) throw new Error('provider api key is required');
  return { kind: expectedKind, provider, model, language, ...(voice === undefined ? {} : { voice }), ...(zeroRetention === undefined ? {} : { zeroRetention }), apiKey };
}

function validateState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== VERSION) {
    throw new Error('provider settings version is invalid');
  }
  if (Object.keys(value).some((key) => !['version', 'stt', 'tts'].includes(key))) {
    throw new Error('provider settings are invalid');
  }
  const state = {
    version: VERSION,
    stt: value.stt === null ? null : validateEntry(value.stt, 'stt'),
    tts: value.tts === null ? null : validateEntry(value.tts, 'tts'),
  };
  if (state.stt?.provider === 'elevenlabs' && state.tts?.provider === 'elevenlabs'
      && state.stt.zeroRetention !== state.tts.zeroRetention) {
    throw new Error('conflicting ElevenLabs retention policies are invalid');
  }
  return state;
}

function entriesEqual(left, right) {
  if (!left || !right) return left === right;
  return left.kind === right.kind
    && left.provider === right.provider
    && left.model === right.model
    && left.language === right.language
    && left.voice === right.voice
    && left.zeroRetention === right.zeroRetention
    && left.apiKey === right.apiKey;
}

function publicEntry(value, activeValue) {
  if (!value) return { configured: false, active: false };
  const { provider, model, language, voice, zeroRetention } = value;
  return {
    provider,
    model,
    language,
    ...(voice === undefined ? {} : { voice }),
    ...(zeroRetention === undefined ? {} : { zeroRetention }),
    configured: true,
    active: entriesEqual(value, activeValue),
  };
}

export function providerSettingsPathFromEnv(env = process.env) {
  const path = env.AGENTCALL_PROVIDER_SETTINGS_FILE || DEFAULT_PATH;
  if (typeof path !== 'string' || path.length < 2 || path.length > 300 || !isAbsolute(path)) {
    throw new Error('AGENTCALL_PROVIDER_SETTINGS_FILE must be an absolute path up to 300 characters');
  }
  return path;
}

export class ProviderSettingsStore {
  #activeState = emptyState();
  #fallbackEnv;
  #fetch;
  #supertonicBaseUrl;
  #catalogTimeoutMs;

  constructor({
    path,
    fallbackEnv = {},
    fetchImpl = requestCatalogJson,
    supertonicBaseUrl = DEFAULT_SUPERTONIC_BASE_URL,
    catalogTimeoutMs = DEFAULT_CATALOG_TIMEOUT_MS,
  }) {
    if (typeof path !== 'string' || !isAbsolute(path)) throw new Error('provider settings path must be absolute');
    if (!Number.isInteger(catalogTimeoutMs) || catalogTimeoutMs < 1 || catalogTimeoutMs > 30_000) {
      throw new Error('provider catalog timeout must be a bounded positive integer');
    }
    this.path = path;
    this.#fallbackEnv = { ...fallbackEnv };
    this.#fetch = fetchImpl;
    this.#supertonicBaseUrl = validateSupertonicBaseUrl(supertonicBaseUrl);
    this.#catalogTimeoutMs = catalogTimeoutMs;
  }

  async #loadWithSource() {
    try {
      return { state: validateState(migrateState(JSON.parse(await readFile(this.path, 'utf8')))), persisted: true };
    } catch (error) {
      if (error?.code === 'ENOENT') return { state: stateFromEnv(this.#fallbackEnv), persisted: false };
      if (error instanceof SyntaxError) throw new Error('provider settings are invalid');
      throw error;
    }
  }

  async #load() {
    return (await this.#loadWithSource()).state;
  }

  async #save(value) {
    const state = validateState(value);
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${process.pid}.${Date.now()}.tmp`;
    let handle;
    try {
      handle = await open(temporary, 'wx', 0o600);
      await handle.writeFile(`${JSON.stringify(state)}\n`, 'utf8');
      await handle.sync();
      await handle.close();
      handle = null;
      await rename(temporary, this.path);
    } finally {
      await handle?.close().catch(() => {});
      await rm(temporary, { force: true }).catch(() => {});
    }
  }

  async configure(request) {
    const kind = request?.kind;
    if (kind !== 'stt' && kind !== 'tts') throw new Error('provider kind is invalid');
    const state = await this.#load();
    const previous = state[kind];
    const candidate = request?.apiKey === '' && previous?.provider === request?.provider
      ? { ...request, apiKey: previous.apiKey }
      : request;
    const entry = validateEntry(candidate, kind);
    state[kind] = entry;
    await this.#save(state);
    const configured = state.stt !== null && state.tts !== null;
    const restartRequired = configured && (
      !entriesEqual(state.stt, this.#activeState.stt)
      || !entriesEqual(state.tts, this.#activeState.tts)
    );
    return { accepted: true, kind, provider: entry.provider, configured: true, restartRequired };
  }

  async publicStatus() {
    const state = await this.#load();
    const configured = state.stt !== null && state.tts !== null;
    const enabled = this.#activeState.stt !== null && this.#activeState.tts !== null;
    const restartRequired = configured && (
      !entriesEqual(state.stt, this.#activeState.stt)
      || !entriesEqual(state.tts, this.#activeState.tts)
    );
    return {
      state: !configured ? (state.stt || state.tts ? 'incomplete' : 'unconfigured')
        : restartRequired ? 'restart-required' : 'active',
      configured,
      enabled,
      restartRequired,
      stt: publicEntry(state.stt, this.#activeState.stt),
      tts: publicEntry(state.tts, this.#activeState.tts),
    };
  }

  async catalog({ kind, provider, model } = {}) {
    if ((kind !== 'stt' && kind !== 'tts') || !PROVIDERS[kind]?.[provider]) {
      throw new Error('provider catalog request is invalid');
    }
    const definition = PROVIDERS[kind][provider];
    const selectedModel = model ?? definition.defaultModel;
    if (!definition.models.includes(selectedModel)) throw new Error('provider catalog model is invalid');
    const base = {
      kind,
      provider,
      models: [...definition.models],
      modelState: 'built-in',
      languages: catalogLanguages(kind, provider, selectedModel),
      languageState: 'built-in',
      voices: kind === 'tts' && CATALOG_VOICES[provider] ? [...CATALOG_VOICES[provider]] : [],
      voiceState: kind !== 'tts' ? 'not-applicable' : 'ready',
    };
    const state = await this.#load();
    const entry = providerEntry(state, provider, kind);
    if (definition.secret && !entry?.apiKey) {
      return {
        ...base,
        modelState: 'credential-required',
        ...(kind === 'tts' && provider === 'elevenlabs' ? { voiceState: 'credential-required' } : {}),
      };
    }
    if (typeof this.#fetch !== 'function') {
      return {
        ...base,
        modelState: 'unavailable',
        languageState: 'unavailable',
        ...(kind === 'tts' && provider === 'elevenlabs' ? { voiceState: 'unavailable' } : {}),
      };
    }
    const controller = new AbortController();
    let rejectTimeout;
    const timeout = new Promise((_, reject) => {
      rejectTimeout = reject;
    });
    const timer = setTimeout(() => {
      controller.abort();
      rejectTimeout(new Error('provider catalog request timed out'));
    }, this.#catalogTimeoutMs);
    const fetchCatalog = (url, options) => Promise.race([
      this.#fetch(url, options),
      timeout,
    ]);
    try {
      if (provider === 'supertonic') {
        const response = await fetchCatalog(`${this.#supertonicBaseUrl}/v1/health`, {
          method: 'GET',
          headers: { accept: 'application/json' },
          signal: controller.signal,
        });
        if (!response?.ok) return { ...base, modelState: 'unavailable' };
        const payload = await response.json();
        const models = definition.models.includes(payload?.model) ? [payload.model] : [];
        return {
          ...base,
          models: models.length > 0 ? models : base.models,
          modelState: models.length > 0 && payload?.status === 'ok' ? 'provider' : 'unavailable',
        };
      }
      if (provider === 'openai') {
        const response = await fetchCatalog('https://api.openai.com/v1/models', {
          method: 'GET',
          headers: { authorization: `Bearer ${entry.apiKey}`, accept: 'application/json' },
          signal: controller.signal,
        });
        if (!response?.ok) return { ...base, modelState: 'unavailable' };
        const models = availableModels(await response.json(), definition.models);
        return {
          ...base,
          models: models.length > 0 ? models : base.models,
          modelState: models.length > 0 ? 'provider' : 'unavailable',
        };
      }
      const headers = { 'xi-api-key': entry.apiKey, accept: 'application/json' };
      const [modelsResponse, voicesResponse] = await Promise.all([
        fetchCatalog('https://api.elevenlabs.io/v1/models', {
          method: 'GET', headers, signal: controller.signal,
        }),
        kind === 'tts'
          ? fetchCatalog('https://api.elevenlabs.io/v2/voices?page_size=100', {
            method: 'GET', headers, signal: controller.signal,
          })
          : null,
      ]);
      let models = base.models;
      let modelState = base.modelState;
      let languages = base.languages;
      let languageState = base.languageState;
      if (modelsResponse?.ok) {
        const modelsPayload = await modelsResponse.json();
        const dynamicModels = availableModels(modelsPayload, definition.models);
        if (dynamicModels.length > 0) {
          models = dynamicModels;
          modelState = 'provider';
        }
        const providerModel = Array.isArray(modelsPayload)
          ? modelsPayload.find((item) => item?.model_id === selectedModel)
          : null;
        const dynamicLanguages = Array.isArray(providerModel?.languages)
          ? [...new Set(providerModel.languages.flatMap((item) => {
            const code = typeof item === 'string' ? item : item?.language_id;
            return typeof code === 'string' && LANGUAGE.test(code) ? [code] : [];
          }))]
          : [];
        if (dynamicLanguages.length > 0) {
          languages = dynamicLanguages;
          languageState = 'provider';
        }
      }
      if (kind !== 'tts') return {
        ...base, models, modelState, languages, languageState,
      };
      let voices = [];
      if (voicesResponse?.ok) {
        const voicesPayload = await voicesResponse.json();
        voices = Array.isArray(voicesPayload?.voices) ? voicesPayload.voices.slice(0, 100).flatMap((voice) => {
          const id = typeof voice?.voice_id === 'string' && TOKEN.test(voice.voice_id) ? voice.voice_id : null;
          const name = typeof voice?.name === 'string' && voice.name.length > 0 && voice.name.length <= 128
            ? voice.name
            : id;
          return id ? [{ value: id, label: name }] : [];
        }) : [];
      }
      return {
        ...base,
        models,
        modelState,
        languages,
        languageState,
        voices,
        voiceState: voicesResponse?.ok ? (voices.length > 0 ? 'ready' : 'empty') : 'unavailable',
      };
    } catch {
      return {
        ...base,
        modelState: 'unavailable',
        languageState: 'unavailable',
        ...(kind === 'tts' && provider === 'elevenlabs' ? { voiceState: 'unavailable' } : {}),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  async runtimeEnv(baseEnv = {}) {
    const { state, persisted } = await this.#loadWithSource();
    this.#activeState = state.stt && state.tts ? validateState(state) : emptyState();
    if (!persisted) return baseEnv;
    if (!state.stt || !state.tts) return { ...baseEnv, AGENTCALL_REALTIME_ENABLED: 'false' };
    const env = {
      ...baseEnv,
      AGENTCALL_REALTIME_ENABLED: 'true',
      AGENTCALL_STT_PROVIDER: state.stt.provider,
      AGENTCALL_STT_MODEL: state.stt.model,
      AGENTCALL_TTS_PROVIDER: state.tts.provider,
      AGENTCALL_TTS_MODEL: state.tts.model,
      AGENTCALL_TTS_VOICE: state.tts.voice,
      AGENTCALL_STT_LANGUAGE: state.stt.language,
      AGENTCALL_TTS_LANGUAGE: state.tts.language,
      AGENTCALL_REALTIME_LANGUAGE: state.stt.language,
      ...(state.stt.provider === 'elevenlabs' || state.tts.provider === 'elevenlabs'
        ? { AGENTCALL_ELEVENLABS_ZERO_RETENTION: String((state.stt.provider === 'elevenlabs' ? state.stt : state.tts).zeroRetention) }
        : {}),
    };
    for (const entry of [state.stt, state.tts]) {
      const secretName = PROVIDERS[entry.kind][entry.provider].secret;
      if (secretName) env[secretName] = entry.apiKey;
    }
    return env;
  }
}

export { PROVIDERS, VERSION };
