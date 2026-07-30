import assert from 'node:assert/strict';
import { lstat, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  ProviderSettingsStore,
  providerSettingsPathFromEnv,
} from '../src/provider-settings.js';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'agentcall-provider-settings-'));
  const path = join(root, 'provider-settings.json');
  t.after(() => rm(root, { recursive: true, force: true }));
  return { path, store: new ProviderSettingsStore({ path }) };
}

const STT = Object.freeze({
  kind: 'stt',
  provider: 'openai',
  model: 'gpt-4o-transcribe',
  language: 'en',
  apiKey: 'test-only-openai-key',
});
const TTS = Object.freeze({
  kind: 'tts',
  provider: 'supertonic',
  model: 'supertonic-3',
  language: 'en',
  voice: 'F1',
  apiKey: '',
});

test('provider settings path is absolute, bounded, and defaults to private state', () => {
  assert.equal(providerSettingsPathFromEnv({}), '/var/lib/agentcall/provider-settings.json');
  assert.equal(
    providerSettingsPathFromEnv({ AGENTCALL_PROVIDER_SETTINGS_FILE: '/tmp/provider-settings.json' }),
    '/tmp/provider-settings.json',
  );
  assert.throws(
    () => providerSettingsPathFromEnv({ AGENTCALL_PROVIDER_SETTINGS_FILE: 'relative.json' }),
    /absolute/i,
  );
});

test('write-only provider updates persist atomically with mode 0600 and never echo secrets', async (t) => {
  const { path, store } = await fixture(t);
  const receipt = await store.configure(STT);

  assert.deepEqual(receipt, {
    accepted: true,
    kind: 'stt',
    provider: 'openai',
    configured: true,
    restartRequired: false,
  });
  assert.equal(JSON.stringify(receipt).includes(STT.apiKey), false);
  if (process.platform !== 'win32') assert.equal((await lstat(path)).mode & 0o777, 0o600);
  assert.equal((await readFile(path, 'utf8')).includes(STT.apiKey), true);

  assert.equal((await store.runtimeEnv({})).AGENTCALL_REALTIME_ENABLED, 'false');
  const publicStatus = await store.publicStatus();
  assert.deepEqual(publicStatus, {
    state: 'incomplete', configured: false, enabled: false, restartRequired: false,
    stt: {
      provider: 'openai', model: 'gpt-4o-transcribe', language: 'en', configured: true, active: false,
    },
    tts: { configured: false, active: false },
  });
  assert.equal(JSON.stringify(publicStatus).includes(STT.apiKey), false);
});

test('provider status distinguishes the active startup snapshot from pending saved settings', async (t) => {
  const { store } = await fixture(t);
  await store.configure(STT);
  await store.configure({ ...TTS, language: 'fr' });

  const runtimeEnv = await store.runtimeEnv({ AGENTCALL_MODE: 'simulator' });
  assert.equal(runtimeEnv.AGENTCALL_REALTIME_ENABLED, 'true');
  assert.equal(runtimeEnv.AGENTCALL_STT_PROVIDER, 'openai');
  assert.equal(runtimeEnv.AGENTCALL_STT_MODEL, 'gpt-4o-transcribe');
  assert.equal(runtimeEnv.AGENTCALL_TTS_PROVIDER, 'supertonic');
  assert.equal(runtimeEnv.AGENTCALL_TTS_MODEL, 'supertonic-3');
  assert.equal(runtimeEnv.AGENTCALL_TTS_VOICE, 'F1');
  assert.equal(runtimeEnv.AGENTCALL_STT_LANGUAGE, 'en');
  assert.equal(runtimeEnv.AGENTCALL_TTS_LANGUAGE, 'fr');
  assert.equal(runtimeEnv.AGENTCALL_REALTIME_LANGUAGE, 'en');
  assert.equal(runtimeEnv.OPENAI_API_KEY, STT.apiKey);
  assert.equal(Object.hasOwn(runtimeEnv, 'ELEVENLABS_API_KEY'), false);

  assert.deepEqual(await store.publicStatus(), {
    state: 'active', configured: true, enabled: true, restartRequired: false,
    stt: {
      provider: 'openai', model: 'gpt-4o-transcribe', language: 'en', configured: true, active: true,
    },
    tts: {
      provider: 'supertonic', model: 'supertonic-3', language: 'fr', voice: 'F1', configured: true, active: true,
    },
  });

  assert.deepEqual(await store.configure(STT), {
    accepted: true, kind: 'stt', provider: 'openai', configured: true, restartRequired: false,
  });
  assert.deepEqual(await store.configure({ ...TTS, language: 'fr', voice: 'F2' }), {
    accepted: true, kind: 'tts', provider: 'supertonic', configured: true, restartRequired: true,
  });
  assert.deepEqual(await store.publicStatus(), {
    state: 'restart-required', configured: true, enabled: true, restartRequired: true,
    stt: {
      provider: 'openai', model: 'gpt-4o-transcribe', language: 'en', configured: true, active: true,
    },
    tts: {
      provider: 'supertonic', model: 'supertonic-3', language: 'fr', voice: 'F2', configured: true, active: false,
    },
  });
});

test('provider settings reject unsupported models, malformed languages, and missing required keys', async (t) => {
  const { store } = await fixture(t);
  await assert.rejects(store.configure({ ...STT, model: 'arbitrary-model' }), /model/i);
  await assert.rejects(store.configure({ ...STT, language: 'english' }), /language/i);
  await assert.rejects(store.configure({ ...STT, apiKey: '' }), /api key/i);
  await assert.rejects(store.configure({ ...TTS, provider: 'elevenlabs', model: 'eleven_flash_v2_5', zeroRetention: true, apiKey: '' }), /api key/i);
});

test('provider settings require explicit ElevenLabs retention and bounded provider language codes', async (t) => {
  const { store } = await fixture(t);
  const eleven = { ...TTS, provider: 'elevenlabs', model: 'eleven_flash_v2_5', voice: 'voice_123', apiKey: 'x' };
  await assert.rejects(store.configure(eleven), /retention/i);
  await assert.rejects(store.configure({ ...eleven, zeroRetention: true, language: 'english' }), /language/i);
  await store.configure(STT);
  await store.configure({ ...eleven, zeroRetention: true, language: 'hi' });
  const env = await store.runtimeEnv({});
  assert.equal(env.AGENTCALL_ELEVENLABS_ZERO_RETENTION, 'true');
  assert.equal((await store.publicStatus()).tts.zeroRetention, true);
});

test('provider settings reject conflicting ElevenLabs retention policies across adapters', async (t) => {
  const { store } = await fixture(t);
  await store.configure({
    ...STT, provider: 'elevenlabs', model: 'scribe_v2_realtime', zeroRetention: true, apiKey: 'stt-key',
  });
  await assert.rejects(store.configure({
    ...TTS, provider: 'elevenlabs', model: 'eleven_flash_v2_5', zeroRetention: false, apiKey: 'tts-key',
  }), /conflicting.*retention/i);
});

test('provider settings persist OpenAI TTS write-only and export its shared runtime credential', async (t) => {
  const { store } = await fixture(t);
  const value = { kind: 'tts', provider: 'openai', model: 'gpt-4o-mini-tts-2025-12-15', language: 'en', voice: 'alloy', apiKey: 'tts-test-key' };
  await store.configure(STT);
  const receipt = await store.configure(value);
  assert.equal(JSON.stringify(receipt).includes(value.apiKey), false);
  const env = await store.runtimeEnv({});
  assert.equal(env.AGENTCALL_TTS_PROVIDER, 'openai');
  assert.equal(env.OPENAI_API_KEY, value.apiKey);
  assert.equal((await store.publicStatus()).tts.model, value.model);
});

test('provider settings preserve selectable ElevenLabs and OpenAI TTS models in runtime env', async (t) => {
  const { store } = await fixture(t);
  await store.configure(STT);
  await store.configure({
    ...TTS, provider: 'elevenlabs', model: 'eleven_multilingual_v2', voice: 'voice_123',
    apiKey: 'tts-test-key', zeroRetention: true,
  });
  assert.equal((await store.runtimeEnv({})).AGENTCALL_TTS_MODEL, 'eleven_multilingual_v2');
});

test('provider settings reuse a write-only credential when only model or voice changes', async (t) => {
  const { store } = await fixture(t);
  await store.configure(STT);
  await store.configure({ ...TTS, provider: 'openai', model: 'gpt-4o-mini-tts', voice: 'alloy', apiKey: 'saved-key' });
  await store.configure({ ...TTS, provider: 'openai', model: 'tts-1-hd', voice: 'nova', apiKey: '' });
  const env = await store.runtimeEnv({});
  assert.equal(env.AGENTCALL_TTS_MODEL, 'tts-1-hd');
  assert.equal(env.OPENAI_API_KEY, 'saved-key');
});

test('provider settings allow Supertonic catalog HTTP only on an exact loopback origin', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agentcall-provider-loopback-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'provider-settings.json');
  for (const supertonicBaseUrl of [
    'http://192.0.2.1:7788',
    'https://127.0.0.1:7788',
    'http://user:password@127.0.0.1:7788',
    'http://127.0.0.1:7788/unsafe',
  ]) {
    assert.throws(
      () => new ProviderSettingsStore({ path, supertonicBaseUrl }),
      /loopback HTTP origin/,
    );
  }
  assert.doesNotThrow(
    () => new ProviderSettingsStore({ path, supertonicBaseUrl: 'http://127.0.0.1:7788' }),
  );
});

test('provider catalog loads bounded ElevenLabs account voices without returning its credential', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agentcall-provider-catalog-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const requests = [];
  const store = new ProviderSettingsStore({
    path: join(root, 'provider-settings.json'),
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      if (url.endsWith('/v1/models')) {
        return {
          ok: true,
          json: async () => [{
            model_id: 'eleven_flash_v2_5',
            languages: [{ language_id: 'en' }, { language_id: 'hi' }],
          }],
        };
      }
      return {
        ok: true,
        json: async () => ({
          voices: [
            { voice_id: 'voice_123', name: 'Support Voice' },
            { voice_id: '../invalid', name: 'Drop me' },
          ],
        }),
      };
    },
  });
  await store.configure({
    ...TTS, provider: 'elevenlabs', model: 'eleven_flash_v2_5', voice: 'voice_123',
    apiKey: 'catalog-test-key', zeroRetention: true,
  });
  const catalog = await store.catalog({ kind: 'tts', provider: 'elevenlabs', model: 'eleven_flash_v2_5' });
  assert.deepEqual(catalog.voices, [{ value: 'voice_123', label: 'Support Voice' }]);
  assert.equal(catalog.voiceState, 'ready');
  assert.deepEqual(catalog.models, ['eleven_flash_v2_5']);
  assert.equal(catalog.modelState, 'provider');
  assert.equal(catalog.languages.includes('hi'), true);
  assert.equal(JSON.stringify(catalog).includes('catalog-test-key'), false);
  assert.equal(catalog.languageState, 'provider');
  assert.deepEqual(catalog.languages, ['en', 'hi']);
  assert.equal(requests[0].options.headers['xi-api-key'], 'catalog-test-key');
});

test('ElevenLabs catalog keeps supported models and languages usable when a restricted key can only list voices', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agentcall-provider-restricted-catalog-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new ProviderSettingsStore({
    path: join(root, 'provider-settings.json'),
    fetchImpl: async (url) => url.endsWith('/v1/models')
      ? { ok: false, status: 401, json: async () => ({}) }
      : {
          ok: true,
          json: async () => ({ voices: [{ voice_id: 'voice_123', name: 'Support Voice' }] }),
        },
  });
  await store.configure({
    ...TTS, provider: 'elevenlabs', model: 'eleven_flash_v2_5', voice: 'voice_123',
    apiKey: 'restricted-catalog-key', zeroRetention: true,
  });

  const catalog = await store.catalog({
    kind: 'tts', provider: 'elevenlabs', model: 'eleven_flash_v2_5',
  });

  assert.equal(catalog.modelState, 'built-in');
  assert.equal(catalog.languageState, 'built-in');
  assert.equal(catalog.voiceState, 'ready');
  assert.deepEqual(catalog.voices, [{ value: 'voice_123', label: 'Support Voice' }]);
  assert.equal(catalog.models.includes('eleven_flash_v2_5'), true);
  assert.equal(catalog.languages.includes('en'), true);
});

test('provider catalog loads only supported OpenAI models available to the saved account', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agentcall-openai-catalog-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const requests = [];
  const store = new ProviderSettingsStore({
    path: join(root, 'provider-settings.json'),
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return {
        ok: true,
        json: async () => ({
          data: [
            { id: 'gpt-4o-transcribe' },
            { id: 'whisper-1' },
            { id: 'unrelated-chat-model' },
          ],
        }),
      };
    },
  });
  await store.configure(STT);

  const catalog = await store.catalog({ kind: 'stt', provider: 'openai', model: STT.model });

  assert.deepEqual(catalog.models, ['gpt-4o-transcribe', 'whisper-1']);
  assert.equal(catalog.modelState, 'provider');
  assert.equal(requests[0].url, 'https://api.openai.com/v1/models');
  assert.equal(requests[0].options.headers.authorization, `Bearer ${STT.apiKey}`);
  assert.equal(JSON.stringify(catalog).includes(STT.apiKey), false);
});

test('provider catalog verifies the local Supertonic model through its loopback health endpoint', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agentcall-supertonic-catalog-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const requests = [];
  const store = new ProviderSettingsStore({
    path: join(root, 'provider-settings.json'),
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return {
        ok: true,
        json: async () => ({ status: 'ok', model: 'supertonic-3', sample_rate: 44_100 }),
      };
    },
  });

  const catalog = await store.catalog({ kind: 'tts', provider: 'supertonic', model: 'supertonic-3' });

  assert.deepEqual(catalog.models, ['supertonic-3']);
  assert.equal(catalog.modelState, 'provider');
  assert.equal(requests[0].url, 'http://127.0.0.1:7788/v1/health');
  assert.equal(requests[0].options.method, 'GET');
});

test('default provider catalog networking runs off the gateway event loop', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agentcall-provider-worker-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ status: 'ok', model: 'supertonic-3' }));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  const store = new ProviderSettingsStore({
    path: join(root, 'provider-settings.json'),
    supertonicBaseUrl: `http://127.0.0.1:${address.port}`,
  });

  const catalog = await store.catalog({ kind: 'tts', provider: 'supertonic', model: 'supertonic-3' });

  assert.equal(catalog.modelState, 'provider');
  assert.deepEqual(catalog.models, ['supertonic-3']);
});

test('provider catalog falls back promptly when a platform fetch ignores abort', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agentcall-provider-timeout-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new ProviderSettingsStore({
    path: join(root, 'provider-settings.json'),
    fetchImpl: async () => new Promise(() => {}),
    catalogTimeoutMs: 20,
  });
  await store.configure(STT);

  const startedAt = Date.now();
  const catalog = await store.catalog({ kind: 'stt', provider: 'openai', model: STT.model });

  assert.equal(catalog.modelState, 'unavailable');
  assert.equal(catalog.languageState, 'unavailable');
  assert.ok(Date.now() - startedAt < 1_000);
  assert.ok(catalog.models.includes(STT.model));
});

test('provider settings migrate the retired OpenAI transcription model at load time', async (t) => {
  const { path, store } = await fixture(t);
  const { writeFile } = await import('node:fs/promises');
  await writeFile(path, `${JSON.stringify({
    version: 1,
    stt: { ...STT, model: 'gpt-realtime-whisper' },
    tts: TTS,
  })}\n`, { mode: 0o600 });
  const runtimeEnv = await store.runtimeEnv({});
  assert.equal(runtimeEnv.AGENTCALL_STT_MODEL, 'gpt-4o-transcribe');
  assert.equal((await store.publicStatus()).stt.model, 'gpt-4o-transcribe');
});

test('provider settings reject malformed persisted state instead of silently enabling realtime', async (t) => {
  const { path, store } = await fixture(t);
  const { writeFile } = await import('node:fs/promises');
  await writeFile(path, '{"version":999,"stt":{}}\n', { mode: 0o600 });
  await assert.rejects(store.publicStatus(), /version|invalid/i);
  await assert.rejects(store.runtimeEnv({}), /version|invalid/i);
});
