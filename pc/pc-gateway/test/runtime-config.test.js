import { test } from 'node:test';
import assert from 'node:assert/strict';

import { configFromEnv, rpcSocketFromEnv } from '../src/runtime-config.js';

const CONTROLLER_SECRET_FILE = '/etc/agentcall/controller.key';
const REDACTION_SALT_FILE = '/etc/agentcall/redaction-salt';
const ARTIFACT_ENV = Object.freeze({
  AGENTCALL_APK_VERSION_CODE: '330',
  AGENTCALL_APK_SIGNING_CERT_SHA256: 'a'.repeat(64),
  AGENTCALL_ARTIFACT_MANIFEST_SHA256: 'b'.repeat(64),
});

function hardwareEnv(extra = {}) {
  return {
    AGENTCALL_DEVICE_SERIAL: 'exact-serial',
    AGENTCALL_DEVICE_FINGERPRINT: 'vendor/gram/gram:15/build',
    AGENTCALL_CONTROLLER_SECRET_FILE: CONTROLLER_SECRET_FILE,
    AGENTCALL_REDACTION_SALT_FILE: REDACTION_SALT_FILE,
    ...extra,
  };
}

test('runtime config boots zero-touch hardware setup from device-neutral artifact identity only', () => {
  const value = configFromEnv(ARTIFACT_ENV);
  assert.equal(value.mode, 'hardware');
  assert.equal(value.serial, undefined);
  assert.equal(value.controllerSecretFile, '/var/lib/agentcall/controller/controller.key');
  assert.equal(value.redactionSaltFile, '/var/lib/agentcall/redaction-salt');
  assert.deepEqual(value.bootstrap, {
    packageName: 'com.callagent.gateway', versionCode: 330,
    signingCertSha256: 'a'.repeat(64), artifactManifestSha256: 'b'.repeat(64),
  });
  assert.deepEqual(value.gateway.expectedIdentity, { product: 'lineage_miatoll', device: 'gram', api: '35' });
  assert.deepEqual(value.start, { phoneHost: '127.0.0.1', phonePort: 27183 });
});

test('runtime config rejects partial device-neutral artifact identity', () => {
  assert.throws(() => configFromEnv({ AGENTCALL_APK_VERSION_CODE: '330' }), /completely/i);
});

test('explicit simulator mode requires no hardware identity and rejects unknown modes', () => {
  const value = configFromEnv({
    AGENTCALL_MODE: 'simulator',
    AGENTCALL_RECORDING_ROOT: '/tmp/agentcall-simulator-recordings',
    AGENTCALL_RECORDING_MIN_FREE_BYTES: '1',
  });
  assert.equal(value.mode, 'simulator');
  assert.equal(value.serial, undefined);
  assert.deepEqual(value.start, { simulator: true, phoneHost: '127.0.0.1' });
  assert.throws(() => configFromEnv({ AGENTCALL_MODE: 'fixture' }), /AGENTCALL_MODE/);
});

test('runtime config parses strict ports and enables only manually approved dialing by default', () => {
  const value = configFromEnv({
    ...hardwareEnv(),
    AGENTCALL_HOST_PORT: '5040',
    AGENTCALL_PHONE_PORT: '27183',
  });
  assert.equal(value.serial, 'exact-serial');
  assert.equal(value.gateway.hostPort, 5040);
  assert.equal(value.gateway.phonePort, 27183);
  assert.equal(value.gateway.policy.dialEnabled, true);
  assert.equal(value.gateway.policy.requireManualApproval, true);
  assert.deepEqual(value.gateway.policy.allowNumbers, []);
  assert.deepEqual(value.gateway.expectedIdentity, {
    product: 'lineage_miatoll', device: 'gram', api: '35', fingerprint: 'vendor/gram/gram:15/build',
  });
  assert.equal(value.controllerSecretFile, CONTROLLER_SECRET_FILE);
  assert.equal(value.redactionSaltFile, REDACTION_SALT_FILE);
  assert.deepEqual(value.recording, {
    root: '/var/lib/agentcall/recordings',
    minFreeBytes: 1_073_741_824,
    ffmpegPath: 'ffmpeg',
  });
});

test('runtime config accepts optional strict E.164 narrowing while retaining manual approval', () => {
  const base = hardwareEnv({ AGENTCALL_DIAL_ENABLED: 'true' });
  assert.deepEqual(configFromEnv(base).gateway.policy.allowNumbers, []);
  assert.throws(() => configFromEnv({ ...base, AGENTCALL_DIAL_ALLOW_NUMBERS: '+10000000000,not-a-number' }), /allowlist/i);
  const value = configFromEnv({ ...base, AGENTCALL_DIAL_ALLOW_NUMBERS: '+10000000000' });
  assert.deepEqual(value.gateway.policy.allowNumbers, ['+10000000000']);
  assert.equal(value.gateway.policy.requireManualApproval, true);
  assert.throws(() => configFromEnv({ ...base, AGENTCALL_DIAL_ENABLED: 'yes' }), /DIAL_ENABLED/);
});

test('realtime config is disabled by default and strict when enabled', () => {
  const base = hardwareEnv();
  assert.deepEqual(configFromEnv(base).realtime, { enabled: false });
  const enabled = configFromEnv({
    ...base,
    AGENTCALL_REALTIME_ENABLED: 'true',
    AGENTCALL_STT_PROVIDER: 'openai',
    AGENTCALL_TTS_PROVIDER: 'supertonic',
    AGENTCALL_TTS_VOICE: 'F1',
    AGENTCALL_REALTIME_LANGUAGE: 'en',
  });
  assert.deepEqual(enabled.realtime, {
    enabled: true, sttProvider: 'openai', sttModel: 'gpt-4o-transcribe',
    ttsProvider: 'supertonic', ttsModel: 'supertonic-3', voice: 'F1',
    sttLanguage: 'en', ttsLanguage: 'en',
  });
  assert.throws(() => configFromEnv({ ...base, AGENTCALL_REALTIME_ENABLED: 'yes' }), /REALTIME_ENABLED/);
  assert.throws(() => configFromEnv({ ...base, AGENTCALL_REALTIME_ENABLED: 'true' }), /STT_PROVIDER/);
});

test('realtime config accepts OpenAI as a TTS provider', () => {
  assert.equal(configFromEnv({ ...hardwareEnv(), AGENTCALL_REALTIME_ENABLED: 'true', AGENTCALL_STT_PROVIDER: 'elevenlabs', AGENTCALL_TTS_PROVIDER: 'openai', AGENTCALL_TTS_VOICE: 'alloy', AGENTCALL_ELEVENLABS_ZERO_RETENTION: 'false' }).realtime.ttsProvider, 'openai');
});

test('realtime config validates and preserves explicit provider models', () => {
  const base = {
    ...hardwareEnv(), AGENTCALL_REALTIME_ENABLED: 'true', AGENTCALL_STT_PROVIDER: 'openai',
    AGENTCALL_STT_MODEL: 'gpt-4o-transcribe', AGENTCALL_TTS_PROVIDER: 'elevenlabs',
    AGENTCALL_TTS_MODEL: 'eleven_multilingual_v2', AGENTCALL_TTS_VOICE: 'voice_123',
    AGENTCALL_ELEVENLABS_ZERO_RETENTION: 'true',
  };
  assert.equal(configFromEnv(base).realtime.ttsModel, 'eleven_multilingual_v2');
  assert.throws(() => configFromEnv({ ...base, AGENTCALL_TTS_MODEL: 'unknown-model' }), /TTS_MODEL/i);
});

test('realtime config requires explicit ElevenLabs retention and bounded TTS language codes', () => {
  const base = { ...hardwareEnv(), AGENTCALL_REALTIME_ENABLED: 'true', AGENTCALL_STT_PROVIDER: 'openai', AGENTCALL_TTS_PROVIDER: 'elevenlabs', AGENTCALL_TTS_VOICE: 'voice_123' };
  assert.throws(() => configFromEnv(base), /RETENTION/i);
  assert.equal(configFromEnv({ ...base, AGENTCALL_ELEVENLABS_ZERO_RETENTION: 'true', AGENTCALL_TTS_LANGUAGE: 'hi' }).realtime.elevenLabsZeroRetention, true);
  assert.throws(() => configFromEnv({ ...base, AGENTCALL_ELEVENLABS_ZERO_RETENTION: 'true', AGENTCALL_TTS_LANGUAGE: 'english' }), /language/i);
});

test('caller memory is disabled by default and requires an explicit root and deployment secret', () => {
  const base = hardwareEnv();
  assert.deepEqual(configFromEnv(base).callerMemory, { enabled: false });
  const env = {
    ...base,
    AGENTCALL_CALLER_MEMORY_ENABLED: 'true',
    AGENTCALL_CALLER_MEMORY_ROOT: '/var/lib/agentcall/caller-memory',
    AGENTCALL_CALLER_MEMORY_SECRET: 'a-long-deployment-secret',
  };
  assert.deepEqual(configFromEnv(env).callerMemory, {
    enabled: true, root: '/var/lib/agentcall/caller-memory', secret: 'a-long-deployment-secret',
  });
  assert.throws(() => configFromEnv({ ...base, AGENTCALL_CALLER_MEMORY_ENABLED: 'yes' }), /CALLER_MEMORY_ENABLED/);
  assert.throws(() => configFromEnv({ ...base, AGENTCALL_CALLER_MEMORY_ENABLED: 'true' }), /CALLER_MEMORY_ROOT/);
});

test('RPC socket config is absolute and independent of device credentials', () => {
  assert.equal(rpcSocketFromEnv({}), '/run/agentcall/gatewayd.sock');
  assert.equal(rpcSocketFromEnv({ AGENTCALL_RPC_SOCKET: '/tmp/agentcall.sock' }), '/tmp/agentcall.sock');
  assert.throws(() => rpcSocketFromEnv({ AGENTCALL_RPC_SOCKET: 'relative.sock' }), /absolute path/);
});

test('runtime config rejects malformed values and placeholders', () => {
  const base = hardwareEnv();
  assert.throws(() => configFromEnv({ ...base, AGENTCALL_HOST_PORT: '0' }), /port/i);
  assert.throws(() => configFromEnv({ ...base, AGENTCALL_PHONE_PORT: '27183x' }), /port/i);
  assert.throws(() => configFromEnv({ ...base, AGENTCALL_RECORDING_ROOT: 'relative' }), /recording.*absolute/i);
  assert.throws(() => configFromEnv({ ...base, AGENTCALL_RECORDING_MIN_FREE_BYTES: '-1' }), /recording.*bytes/i);
  assert.throws(() => configFromEnv({ ...base, AGENTCALL_DEVICE_SERIAL: 'REPLACE_WITH_EXACT_ADB_SERIAL' }), /placeholder|invalid shape/i);
  assert.throws(() => configFromEnv({ ...base, AGENTCALL_CONTROLLER_SECRET_FILE: 'relative.key' }), /CONTROLLER_SECRET_FILE.*absolute/i);
  assert.throws(() => configFromEnv({ ...base, AGENTCALL_REDACTION_SALT_FILE: 'relative.salt' }), /REDACTION_SALT_FILE.*absolute/i);
});
