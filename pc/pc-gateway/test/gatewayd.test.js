import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { dirname, join } from 'node:path';
import test from 'node:test';

import {
  classifyPhoneSetupFailure,
  deviceEvidenceProvisioningArgs,
  LocalControlPlane,
  runGatewayd,
} from '../src/gatewayd.js';

const ENV = Object.freeze({
  AGENTCALL_DEVICE_SERIAL: 'exact-serial',
  AGENTCALL_DEVICE_FINGERPRINT: 'vendor/gram/gram:15/build',
  AGENTCALL_CONTROLLER_SECRET_FILE: '/etc/agentcall/controller.key',
  AGENTCALL_REDACTION_SALT_FILE: '/etc/agentcall/redaction-salt',
  AGENTCALL_RPC_SOCKET: '/tmp/agentcall-test.sock',
});

const CONTROLLER_SECRET = Buffer.alloc(32, 0x5a);

test('phone setup failures expose actionable bounded reason codes without raw ADB detail', () => {
  assert.deepEqual(
    classifyPhoneSetupFailure({ code: 'ADB_AUTHORIZATION_REQUIRED', message: 'private detail' }, 'VERIFYING_DEVICE'),
    { stage: 'WAITING_FOR_PHONE', reasonCode: 'usb_debugging_authorization_required' },
  );
  assert.deepEqual(
    classifyPhoneSetupFailure(new Error('connect ECONNREFUSED 127.0.0.1:55123'), 'PAIRING'),
    { stage: 'WAITING_FOR_PHONE_START', reasonCode: 'phone_app_not_ready' },
  );
  assert.deepEqual(
    classifyPhoneSetupFailure(new Error('identity mismatch: private fingerprint'), 'VERIFYING_DEVICE'),
    { stage: 'BLOCKED', reasonCode: 'unsupported_phone_build' },
  );
});

test('matched POCO identity produces bounded evidence provisioning arguments', () => {
  const args = deviceEvidenceProvisioningArgs({
    serial: 'c27d0cd8',
    identity: {
      product: 'lineage_miatoll',
      device: 'gram',
      model: 'POCO M2 Pro',
      api: '35',
      fingerprint: 'lineage/lineage_miatoll/gram:15/AP3A.240905.015.A2/build:userdebug/dev-keys',
      vendorFingerprint: 'POCO/gram_in/gram:12/RKQ1.211019.001/V14.0.5.0.SJPINXM:user/release-keys',
    },
  }, new Date(2026, 7, 2, 12, 0, 0));

  assert.equal(args.attestedOn, '2026-08-02');
  assert.equal(args.observedSystemFingerprint.includes('lineage_miatoll'), true);
  assert.equal(args.observedVendorFingerprint.startsWith('POCO/gram_in/gram:'), true);
  assert.match(args.attestedSystemDescription, /POCO M2 Pro.*Android API 35/u);
  assert.match(args.idempotencyKey, /^matched-device-evidence-[a-f0-9]{32}$/u);
});

test('unqualified or incomplete phone identities are never auto-provisioned', () => {
  const complete = {
    serial: 'c27d0cd8',
    identity: {
      product: 'lineage_miatoll', device: 'gram', model: 'POCO M2 Pro', api: '35',
      fingerprint: 'system/fingerprint',
      vendorFingerprint: 'POCO/gram_in/gram:12/RKQ1.211019.001/V14.0.5.0.SJPINXM:user/release-keys',
    },
  };
  assert.equal(deviceEvidenceProvisioningArgs({ ...complete, identity: { ...complete.identity, device: 'other' } }), null);
  assert.equal(deviceEvidenceProvisioningArgs({ ...complete, identity: { ...complete.identity, fingerprint: '' } }), null);
  assert.equal(deviceEvidenceProvisioningArgs({ ...complete, identity: { ...complete.identity, vendorFingerprint: 'other' } }), null);
});

test('local control plane remains useful offline and denies every live phone action', async () => {
  const recording = {
    list: async ({ limit }) => [{ callId: `saved-${limit}`, complete: true }],
    artifact: async ({ callId, artifact }) => `/recordings/${callId}/${artifact}`,
    exportArtifact: async ({ callId, artifact }) => `/run/agentcall/recording-exports/${callId}/${artifact}`,
    delete: async ({ callId }) => ({ deleted: true, callId }),
  };
  const providerSettings = {
    publicStatus: async () => ({ state: 'unconfigured', configured: false, enabled: false }),
    configure: async ({ kind, provider }) => ({ accepted: true, kind, provider, configured: true, restartRequired: true }),
  };
  const phoneData = {
    listContacts: async ({ limit }) => ({ rows: [{ id: String(limit), name: 'Saved', number: '+10000000000' }], sync: { state: 'offline', count: 1 } }),
    listCallLog: async () => ({ rows: [], sync: { state: 'offline', count: 0 } }),
    publicStatus: async () => ({ contacts: { state: 'offline', count: 1 }, callLog: { state: 'offline', count: 0 } }),
  };
  const control = new LocalControlPlane({ recording, providerSettings, phoneData });

  assert.deepEqual(control.status(), {
    identity: 'HARDWARE', simulator: false, state: 'running',
    device: { connected: false, authenticated: false, transport: 'usb', phase: 'disconnected' },
    setup: { stage: 'WAITING_FOR_PHONE', reasonCode: 'phone_not_connected' },
  });
  assert.deepEqual(await control.listRecordings({ limit: 7 }), [{ callId: 'saved-7', complete: true }]);
  assert.equal((await control.listContacts({ limit: 7 })).rows[0].id, '7');
  assert.equal((await control.listCallLog({ limit: 7 })).sync.state, 'offline');
  assert.equal((await control.phoneDataStatus()).contacts.count, 1);
  assert.equal(await control.recordingArtifact({ callId: 'saved-7', artifact: 'conversation.mkv' }), '/recordings/saved-7/conversation.mkv');
  assert.equal(
    await control.exportRecordingArtifact({ callId: 'saved-7', artifact: 'conversation.mkv' }),
    '/run/agentcall/recording-exports/saved-7/conversation.mkv',
  );
  assert.deepEqual(await control.deleteRecording({ callId: 'saved-7' }), { deleted: true, callId: 'saved-7' });
  assert.deepEqual(await control.providerStatus(), { state: 'unconfigured', configured: false, enabled: false });
  assert.equal((await control.configureProvider({ kind: 'stt', provider: 'openai' })).accepted, true);
  for (const [method, args] of [
    ['dial', { destination: '+15551234567', idempotencyKey: 'offline-dial', approved: true, consent: { recorded: true, policy: 'test' } }],
    ['answer', { callId: 'call-1', idempotencyKey: 'offline-answer' }],
    ['reject', { callId: 'call-1', idempotencyKey: 'offline-reject' }],
    ['hangup', { callId: 'call-1', idempotencyKey: 'offline-hangup' }],
    ['sendDtmf', { callId: 'call-1', digits: '1', idempotencyKey: 'offline-dtmf' }],
    ['speak', { callId: 'call-1', text: 'hello', idempotencyKey: 'offline-speak' }],
  ]) {
    assert.deepEqual(await control[method](args), { accepted: false, reason: 'phone disconnected' });
  }
});

test('local control plane forwards the isolated manual audio bridge only while a phone gateway is attached', async () => {
  const control = new LocalControlPlane();
  const gateway = new EventEmitter();
  gateway.manualAudioAvailable = ({ callId }) => callId === 'call-audio-1';
  gateway.sendManualPcm = async ({ callId, payload }) => ({ accepted: true, callId, bytes: payload.length });
  const received = [];
  control.on('monitorPcm', (frame) => received.push(frame));

  assert.equal(control.manualAudioAvailable({ callId: 'call-audio-1' }), false);
  assert.throws(() => control.sendManualPcm({ callId: 'call-audio-1', payload: Buffer.alloc(2) }), /unavailable/);

  control.attach(gateway);
  assert.equal(control.manualAudioAvailable({ callId: 'call-audio-1' }), true);
  assert.deepEqual(
    await control.sendManualPcm({ callId: 'call-audio-1', payload: Buffer.alloc(4) }),
    { accepted: true, callId: 'call-audio-1', bytes: 4 },
  );
  gateway.emit('monitorPcm', { callId: 'call-audio-1', payload: Buffer.from([1, 2]) });
  assert.equal(received.length, 1);

  control.detach();
  gateway.emit('monitorPcm', { callId: 'call-audio-1', payload: Buffer.from([3, 4]) });
  assert.equal(received.length, 1);
});

test('zero-touch gatewayd binds RPC and stays running when no phone is connected', async () => {
  const actions = [];
  let exposed;
  const rpc = {
    start: async () => actions.push('rpc:start'),
    stop: async () => actions.push('rpc:stop'),
  };
  const runtime = await runGatewayd({
    env: {
      AGENTCALL_REDACTION_SALT_FILE: '/etc/agentcall/redaction-salt',
      AGENTCALL_RPC_SOCKET: '/tmp/agentcall-offline.sock',
      AGENTCALL_SYSTEM_FINGERPRINT: 'system/fingerprint',
      AGENTCALL_VENDOR_FINGERPRINT: 'vendor/fingerprint',
      AGENTCALL_APK_VERSION_CODE: '330',
      AGENTCALL_APK_SIGNING_CERT_SHA256: 'a'.repeat(64),
      AGENTCALL_ARTIFACT_MANIFEST_SHA256: 'b'.repeat(64),
    },
    phoneRetryMs: 60_000,
    signals: { once: () => {} },
    createProviderSettings: () => ({
      runtimeEnv: async (env) => env,
      publicStatus: async () => ({ state: 'unconfigured', configured: false, enabled: false }),
      configure: async () => ({ accepted: true }),
    }),
    loadOrCreateRedactionSalt: async () => 'private-redaction-salt',
    createRecordingManager: () => ({
      list: async () => [], artifact: async () => '', delete: async () => ({ deleted: true }),
    }),
    createPhoneDataStore: () => ({
      listContacts: async () => ({ rows: [], sync: { state: 'never', count: 0 } }),
      listCallLog: async () => ({ rows: [], sync: { state: 'never', count: 0 } }),
      publicStatus: async () => ({ contacts: { state: 'never', count: 0 }, callLog: { state: 'never', count: 0 } }),
    }),
    createControllerCredentialStore: () => ({ recover: async () => ({ state: 'absent' }), load: async () => null }),
    createAdbManager: () => ({ selectOne: async () => { actions.push('adb:no-phone'); throw new Error('no device attached'); } }),
    createRpcServer: (gateway) => { exposed = gateway; return rpc; },
  });
  assert.equal(runtime.gateway, exposed);
  assert.deepEqual(actions.slice(0, 2), ['rpc:start', 'adb:no-phone']);
  assert.deepEqual(exposed.status().setup, { stage: 'WAITING_FOR_PHONE', reasonCode: 'phone_not_connected' });
  assert.equal((await exposed.dial({})).reason, 'phone disconnected');
  await runtime.stop();
  assert.equal(actions.includes('rpc:stop'), true);
});

function fixture({ rpcStartError } = {}) {
  const actions = [];
  const gateway = {
    start: async () => { actions.push('gateway:start'); },
    stop: async () => { actions.push('gateway:stop'); },
  };
  const rpc = {
    start: async () => {
      actions.push('rpc:start');
      if (rpcStartError) throw rpcStartError;
    },
    stop: async () => { actions.push('rpc:stop'); },
  };
  const signalHandlers = new Map();
  const signals = { once: (name, handler) => signalHandlers.set(name, handler) };
  return {
    actions,
    gateway,
    rpc,
    signals,
    signalHandlers,
    options: {
      env: ENV,
      signals,
      createProviderSettings: () => ({ runtimeEnv: async (env) => env }),
      loadControllerSecret: async (path) => {
        assert.equal(path, ENV.AGENTCALL_CONTROLLER_SECRET_FILE);
        actions.push('controller-secret:load');
        return Buffer.from(CONTROLLER_SECRET);
      },
      loadRedactionSalt: async (path) => {
        assert.equal(path, ENV.AGENTCALL_REDACTION_SALT_FILE);
        actions.push('redaction-salt:load');
        return 'private-redaction-salt';
      },
      loadOrCreateRedactionSalt: async (path) => {
        assert.equal(path, ENV.AGENTCALL_REDACTION_SALT_FILE);
        actions.push('redaction-salt:load');
        return 'private-redaction-salt';
      },
      createRecordingManager: (options) => {
        actions.push(['recording:create', options]);
        return { kind: 'recording-manager' };
      },
      createPhoneDataStore: () => ({ kind: 'phone-data-store' }),
      createProviderSettings: () => ({
        runtimeEnv: async (env) => env,
      }),
      createGateway: (options) => {
        assert.deepEqual(options.controllerSecret, CONTROLLER_SECRET);
        assert.equal(options.idempotencySalt, 'private-redaction-salt');
        actions.push(['gateway:create', options.recording?.kind]);
        return gateway;
      },
      createRpcServer: (_gateway, options) => {
        assert.equal(_gateway, gateway);
        assert.deepEqual(options, { socketPath: ENV.AGENTCALL_RPC_SOCKET });
        return rpc;
      },
    },
  };
}

test('gatewayd binds semantic RPC before device startup and stops RPC before gateway', async () => {
  const f = fixture();
  const runtime = await runGatewayd(f.options);
  assert.deepEqual(f.actions, [
    'controller-secret:load',
    'redaction-salt:load',
    ['recording:create', {
      root: '/var/lib/agentcall/recordings',
      exportRoot: '/tmp/recording-exports',
      minFreeBytes: 1_073_741_824,
      ffmpegPath: 'ffmpeg',
    }],
    ['gateway:create', 'recording-manager'],
    'rpc:start', 'gateway:start',
  ]);
  assert.equal(runtime.gateway, f.gateway);
  assert.equal(runtime.rpc, f.rpc);
  await runtime.stop();
  await runtime.stop();
  assert.deepEqual(f.actions.slice(-4), ['rpc:start', 'gateway:start', 'rpc:stop', 'gateway:stop']);
});

test('gatewayd simulator mode owns simulator gateway and RPC lifecycle without ADB credentials', async () => {
  const f = fixture();
  const simulator = {
    start: async () => { f.actions.push('simulator:start'); return { identity: 'SIMULATOR', simulator: true, host: '127.0.0.1', port: 31337 }; },
    stop: async () => { f.actions.push('simulator:stop'); },
  };
  let gatewayOptions;
  let secretLoads = 0;
  f.options.createGateway = (options) => {
    gatewayOptions = options;
    f.actions.push(['gateway:create', options.recording?.kind]);
    return f.gateway;
  };
  const runtime = await runGatewayd({
    ...f.options,
    env: {
      AGENTCALL_MODE: 'simulator',
      AGENTCALL_RPC_SOCKET: ENV.AGENTCALL_RPC_SOCKET,
      AGENTCALL_RECORDING_ROOT: '/tmp/agentcall-simulator-recordings',
      AGENTCALL_RECORDING_MIN_FREE_BYTES: '1',
    },
    loadControllerSecret: async () => { secretLoads++; throw new Error('simulator must not load a secret file'); },
    createPhoneSimulator: () => simulator,
  });
  assert.deepEqual(gatewayOptions.runtimeIdentity, { identity: 'SIMULATOR', simulator: true });
  assert.equal(secretLoads, 0);
  assert.equal(Buffer.isBuffer(gatewayOptions.controllerSecret), true);
  assert.equal(gatewayOptions.controllerSecret.length, 32);
  assert.deepEqual(f.actions.slice(-4), [
    'simulator:start', ['gateway:create', 'recording-manager'], 'rpc:start', 'gateway:start',
  ]);
  await runtime.stop();
  assert.deepEqual(f.actions.slice(-3), ['rpc:stop', 'gateway:stop', 'simulator:stop']);
});

test('gatewayd constructs no realtime providers when disabled', async () => {
  const f = fixture();
  let registryCalls = 0;
  await runGatewayd({
    ...f.options,
    createRealtimeRegistry: () => { registryCalls++; return { sttProviders: new Map(), ttsProviders: new Map() }; },
  });
  assert.equal(registryCalls, 0);
  const gatewayCreate = f.actions.find((item) => Array.isArray(item) && item[0] === 'gateway:create');
  assert.deepEqual(gatewayCreate, ['gateway:create', 'recording-manager']);
});

test('gatewayd injects the explicitly enabled realtime factory without exposing credentials', async () => {
  const f = fixture();
  const env = {
    ...ENV,
    AGENTCALL_REALTIME_ENABLED: 'true',
    AGENTCALL_STT_PROVIDER: 'openai',
    AGENTCALL_TTS_PROVIDER: 'supertonic',
    AGENTCALL_TTS_VOICE: 'F1',
    AGENTCALL_STT_LANGUAGE: 'en',
    AGENTCALL_TTS_LANGUAGE: 'fr',
    OPENAI_API_KEY: 'secret-value',
    AGENTCALL_PROVIDER_TEST_PATH: join(process.cwd(), 'provider-test.wav'),
  };
  let registryConfig;
  let registryOptions;
  let gatewayOptions;
  let greetingPrewarms = 0;
  await runGatewayd({
    ...f.options,
    env,
    createRealtimeRegistry: (config, suppliedEnv, options) => {
      registryConfig = config;
      registryOptions = options;
      assert.equal(suppliedEnv, env);
      return {
        sttProviders: new Map([['openai', { health: async () => ({ healthy: true }) }]]),
        ttsProviders: new Map([['supertonic', { health: async () => ({ healthy: true }) }]]),
        checkHealth: async ({ kind }) => ({ kind, healthy: true }),
        testSpeech: async () => ({ healthy: true, playbackPath: '/tmp/provider-test.wav' }),
        prewarmGreetings: async () => { greetingPrewarms += 1; },
      };
    },
    createGateway: (options) => { gatewayOptions = options; return f.gateway; },
  });
  assert.deepEqual(registryConfig, {
    enabled: true, sttProvider: 'openai', sttModel: 'gpt-4o-transcribe',
    ttsProvider: 'supertonic', ttsModel: 'supertonic-3', voice: 'F1',
    sttLanguage: 'en', ttsLanguage: 'fr',
  });
  assert.deepEqual(registryOptions, { artifactPath: env.AGENTCALL_PROVIDER_TEST_PATH });
  assert.equal(typeof gatewayOptions.createRealtimeSession, 'function');
  assert.equal(typeof gatewayOptions.checkProviderHealth, 'function');
  assert.equal(typeof gatewayOptions.testProviders, 'function');
  assert.deepEqual(await gatewayOptions.checkProviderHealth({ kind: 'stt' }), { kind: 'stt', healthy: true });
  assert.deepEqual(await gatewayOptions.testProviders(), { healthy: true, playbackPath: '/tmp/provider-test.wav' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(greetingPrewarms, 1);
  assert.equal(JSON.stringify(gatewayOptions).includes('secret-value'), false);
});

test('gatewayd signal handler performs ordered shutdown', async () => {
  const f = fixture();
  await runGatewayd(f.options);
  await f.signalHandlers.get('SIGTERM')();
  assert.deepEqual(f.actions.slice(-4), ['rpc:start', 'gateway:start', 'rpc:stop', 'gateway:stop']);
});

test('gatewayd stop during gateway startup revokes ownership acquired after initial cleanup', async () => {
  const f = fixture();
  let owned = false;
  let releaseStart;
  f.gateway.start = async () => {
    f.actions.push('gateway:start');
    await new Promise((resolve) => { releaseStart = resolve; });
    owned = true;
  };
  f.gateway.stop = async () => {
    f.actions.push('gateway:stop');
    owned = false;
  };

  const starting = runGatewayd(f.options);
  while (!releaseStart) await Promise.resolve();
  await f.signalHandlers.get('SIGTERM')();
  releaseStart();

  await assert.rejects(starting, /stopped during startup/i);
  assert.equal(owned, false);
  assert.equal(f.actions.filter((action) => action === 'rpc:start').length, 1);
  assert.equal(f.actions.filter((action) => action === 'rpc:stop').length, 1);
  assert.equal(f.actions.filter((action) => action === 'gateway:stop').length, 2);
});

test('gatewayd rolls back partially-started RPC before gateway ownership', async () => {
  const f = fixture({ rpcStartError: new Error('bind failed') });
  await assert.rejects(runGatewayd(f.options), /bind failed/);
  assert.equal(f.actions.includes('gateway:start'), false);
  assert.deepEqual(f.actions.slice(-2), ['rpc:stop', 'gateway:stop']);
});

test('gatewayd zeroizes the loaded controller secret when salt loading throws', async () => {
  const f = fixture();
  const secret = Buffer.from(CONTROLLER_SECRET);
  await assert.rejects(runGatewayd({
    ...f.options,
    loadControllerSecret: async () => secret,
    loadRedactionSalt: async () => { throw new Error('salt failed'); },
  }), /salt failed/);
  assert.deepEqual(secret, Buffer.alloc(32));
});

test('gatewayd zeroizes the loaded controller secret when construction throws', async () => {
  const f = fixture();
  const secret = Buffer.from(CONTROLLER_SECRET);
  await assert.rejects(runGatewayd({
    ...f.options,
    loadControllerSecret: async () => secret,
    createRecordingManager: () => { throw new Error('construction failed'); },
  }), /construction failed/);
  assert.deepEqual(secret, Buffer.alloc(32));
});

test('gatewayd production path pairs an absent credential before starting the authenticated gateway', async () => {
  const f = fixture();
  const pairedKey = Buffer.alloc(32, 0x71);
  const bootstrapForward = { serial: 'exact-serial', hostPort: 54321, remote: 'tcp:27184' };
  const operationalForward = { serial: 'exact-serial', hostPort: 5040, phonePort: 27183 };
  const selected = {
    serial: 'exact-serial',
    identity: {
      product: 'lineage_miatoll', device: 'gram', api: '35',
      model: 'POCO M2 Pro',
      fingerprint: 'POCO/lineage_miatoll/gram:15/AP3A/build:userdebug/dev-keys',
      vendorFingerprint: 'POCO/gram_in/gram:12/RKQ1.211019.001/V14.0.5.0.SJPINXM:user/release-keys',
    },
  };
  const device = {
    state: 'disconnected',
    on: () => {},
    connect: async ({ host, port }) => {
      assert.deepEqual({ host, port }, { host: '127.0.0.1', port: 5040 });
      device.state = 'connected';
      f.actions.push('g2:authenticated');
    },
    disconnect: async () => { device.state = 'disconnected'; f.actions.push('device:disconnect'); },
    sendControl: async () => { f.actions.push('recording-health:send'); },
  };
  const store = {
    recover: async () => { f.actions.push('credential:recover'); return { state: 'absent' }; },
    load: async () => {
      f.actions.push('credential:load');
      return f.actions.includes('bootstrap:pair') ? Buffer.from(pairedKey) : null;
    },
  };
  const adb = {
    selectOne: async () => {
      f.actions.push('adb:select-one');
      return { serial: selected.serial };
    },
    verifyIdentity: async (serial) => { assert.equal(serial, selected.serial); f.actions.push('adb:verify-identity'); return selected; },
    forwardBootstrap: async ({ serial }) => { assert.equal(serial, selected.serial); f.actions.push('adb:forward-bootstrap'); return bootstrapForward; },
    forward: async (args) => { assert.deepEqual(args, { serial: selected.serial, hostPort: 5040, phonePort: 27183 }); f.actions.push('adb:forward-operational'); return operationalForward; },
    killForward: async (forward) => { f.actions.push(`adb:remove:${forward.hostPort}`); },
  };
  let gatewayOptions;
  f.options.createGateway = (options) => {
    gatewayOptions = options;
    f.actions.push('gateway:create');
    return f.gateway;
  };
  f.gateway.start = async (start) => {
    assert.deepEqual(start.existingForward, operationalForward);
    f.actions.push('gateway:start');
  };
  f.gateway.provisionDeviceEvidence = async (args) => {
    assert.equal(args.observedSystemFingerprint, selected.identity.fingerprint);
    assert.equal(args.observedVendorFingerprint, selected.identity.vendorFingerprint);
    assert.match(args.idempotencyKey, /^matched-device-evidence-[a-f0-9]{32}$/u);
    f.actions.push('device-evidence:provision');
    return { accepted: true };
  };

  const starting = runGatewayd({
    ...f.options,
    env: {
      ...ENV,
      AGENTCALL_SYSTEM_FINGERPRINT: selected.identity.fingerprint,
      AGENTCALL_VENDOR_FINGERPRINT: selected.identity.vendorFingerprint,
      AGENTCALL_APK_VERSION_CODE: '330',
      AGENTCALL_APK_SIGNING_CERT_SHA256: 'a'.repeat(64),
      AGENTCALL_ARTIFACT_MANIFEST_SHA256: 'b'.repeat(64),
    },
    createControllerCredentialStore: ({ path }) => {
      assert.equal(path, ENV.AGENTCALL_CONTROLLER_SECRET_FILE);
      return store;
    },
    createAdbManager: () => adb,
    createRpcServer: (setup, options) => {
      f.rpc.gateway = setup;
      assert.equal(typeof setup.status, 'function');
      assert.deepEqual(options, { socketPath: ENV.AGENTCALL_RPC_SOCKET });
      f.actions.push('rpc:create-setup');
      return f.rpc;
    },
    createBootstrapTransport: ({ host, port }) => {
      assert.deepEqual({ host, port }, { host: '127.0.0.1', port: bootstrapForward.hostPort });
      f.actions.push('bootstrap:transport');
      return { kind: 'transport' };
    },
    createDeviceClient: ({ enrollmentSecret }) => {
      assert.deepEqual(enrollmentSecret, pairedKey);
      f.actions.push('g2:client');
      return device;
    },
    createBootstrapClient: ({ store: suppliedStore, transport, g2Authenticate }) => ({
      pair: async ({ identity }) => {
        assert.equal(suppliedStore, store);
        assert.deepEqual(transport, { kind: 'transport' });
        assert.deepEqual(identity, {
          serial: selected.serial,
          product: 'lineage_miatoll', device: 'gram', api: 35,
          systemFingerprint: selected.identity.fingerprint,
          vendorFingerprint: selected.identity.vendorFingerprint,
          packageName: 'com.callagent.gateway', versionCode: 330,
          signingCertSha256: 'a'.repeat(64), artifactManifestSha256: 'b'.repeat(64),
          desktopBootstrapVersion: 1,
        });
        f.actions.push('bootstrap:pair');
        await g2Authenticate(pairedKey);
        return { authenticated: true };
      },
    }),
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.actions.includes('rpc:start'), true, 'semantic RPC binds while setup is in progress');
  const runtime = await starting;
  assert.deepEqual(gatewayOptions.controllerSecret, pairedKey);
  assert.equal(gatewayOptions.device, device);
  assert.deepEqual(f.actions.filter((action) => typeof action === 'string'), [
    'redaction-salt:load', 'rpc:create-setup', 'rpc:start', 'credential:recover',
    'credential:load', 'adb:select-one', 'adb:verify-identity', 'adb:forward-bootstrap', 'bootstrap:transport',
    'bootstrap:pair', 'adb:forward-operational', 'g2:client', 'g2:authenticated',
    'credential:load', 'gateway:create', 'gateway:start', 'device-evidence:provision', 'adb:remove:54321',
  ]);
  await runtime.stop();
});

test('gatewayd derives zero-touch artifact identity from the packaged canonical manifest', async () => {
  const f = fixture();
  let suppliedEnv;
  await assert.rejects(runGatewayd({
    ...f.options,
    env: { AGENTCALL_MATCHED_ARTIFACT_FILE: '/usr/share/agentcall/protocol/matched-artifact.properties' },
    loadMatchedArtifact: async (path) => {
      assert.equal(path, '/usr/share/agentcall/protocol/matched-artifact.properties');
      return {
        manifest: {
          schemaVersion: 1, bootstrapProtocolVersion: 2, desktopPackageVersion: '1.0.0',
          androidPackageName: 'com.callagent.gateway', androidVersionCode: 330,
          androidSigningCertificateSha256: 'a'.repeat(64),
        },
        digest: Buffer.alloc(32, 0xbb),
      };
    },
    createProviderSettings: () => ({ runtimeEnv: async (env) => { suppliedEnv = env; return env; } }),
    loadOrCreateRedactionSalt: async () => { throw new Error('stop-after-config'); },
  }), /stop-after-config/);
  assert.equal(suppliedEnv.AGENTCALL_APK_VERSION_CODE, '330');
  assert.equal(suppliedEnv.AGENTCALL_APK_SIGNING_CERT_SHA256, 'a'.repeat(64));
  assert.equal(suppliedEnv.AGENTCALL_ARTIFACT_MANIFEST_SHA256, 'b'.repeat(64));
});

test('gatewayd recovers durable staged state on one exact serial without reopening bootstrap', async () => {
  const f = fixture();
  const key = Buffer.from(CONTROLLER_SECRET);
  const selected = { serial: 'exact-serial', identity: { product: 'gram', device: 'atoll', api: '35', fingerprint: 'system-fp', vendorFingerprint: 'vendor-fp' } };
  const operationalForward = { serial: selected.serial, hostPort: 5040, phonePort: 27183 };
  const transaction = { stagedPath: '/etc/agentcall/controller.key.staged' };
  const store = {
    recover: async () => { f.actions.push('credential:recover'); return { state: 'staged', key: Buffer.from(key), serial: selected.serial, transaction }; },
    load: async () => { f.actions.push('credential:load'); return f.actions.includes('bootstrap:recover') ? Buffer.from(key) : null; },
  };
  const adb = {
    selectOne: async () => { throw new Error('must select the persisted exact serial during recovery'); },
    selectBySerial: async (serial) => { assert.equal(serial, selected.serial); f.actions.push('adb:select-exact'); return { serial }; },
    verifyIdentity: async (serial) => { assert.equal(serial, selected.serial); f.actions.push('adb:verify-exact'); return selected; },
    forwardBootstrap: async () => { throw new Error('must not reopen bootstrap during staged recovery'); },
    forward: async (args) => { assert.deepEqual(args, { serial: selected.serial, hostPort: 5040, phonePort: 27183 }); f.actions.push('adb:forward-operational'); return operationalForward; },
    killForward: async (owned) => { assert.equal(owned.serial, selected.serial); f.actions.push(`adb:remove:${owned.hostPort}`); },
  };
  const device = { state: 'disconnected', on: () => {}, connect: async () => { device.state = 'connected'; f.actions.push('g2:authenticated'); }, disconnect: async () => {}, sendControl: async () => {} };
  f.gateway.start = async (start) => { assert.deepEqual(start.existingForward, operationalForward); f.actions.push('gateway:start'); };
  await runGatewayd({
    ...f.options,
    env: { ...ENV, AGENTCALL_SYSTEM_FINGERPRINT: 'system-fp', AGENTCALL_VENDOR_FINGERPRINT: 'vendor-fp', AGENTCALL_APK_VERSION_CODE: '330', AGENTCALL_APK_SIGNING_CERT_SHA256: 'a'.repeat(64), AGENTCALL_ARTIFACT_MANIFEST_SHA256: 'b'.repeat(64) },
    createControllerCredentialStore: () => store,
    createAdbManager: () => adb,
    createBootstrapTransport: () => { throw new Error('must not create bootstrap transport during staged recovery'); },
    createDeviceClient: ({ enrollmentSecret }) => { assert.deepEqual(enrollmentSecret, key); return device; },
    createBootstrapClient: ({ g2Authenticate }) => ({
      recover: async (recovery) => {
        assert.equal(recovery.transaction, transaction);
        f.actions.push('bootstrap:recover');
        await g2Authenticate(key);
      },
      pair: async () => { throw new Error('must not start new pairing'); },
    }),
    createRpcServer: () => f.rpc,
  });
  assert.deepEqual(f.actions.filter((action) => typeof action === 'string' && /credential|adb:|bootstrap:|g2:/.test(action)), [
    'credential:recover', 'credential:load', 'adb:select-exact', 'adb:verify-exact',
    'bootstrap:recover', 'adb:forward-operational', 'g2:authenticated', 'credential:load',
  ]);
  assert.equal(f.actions.includes('adb:remove:5040'), false, 'owned operational forward remains for gateway');
});

test('gatewayd committed recovery retains exact serial and completes Android staged G2 without bootstrap', async () => {
  const f = fixture();
  const key = Buffer.from(CONTROLLER_SECRET);
  const selected = { serial: 'exact-serial', identity: { product: 'gram', device: 'atoll', api: '35', fingerprint: 'system-fp', vendorFingerprint: 'vendor-fp' } };
  const store = {
    recover: async () => ({ state: 'committed', serial: selected.serial }),
    load: async () => Buffer.from(key),
  };
  const adb = {
    selectOne: async () => { throw new Error('must use committed exact serial'); },
    selectBySerial: async (serial) => { assert.equal(serial, selected.serial); f.actions.push('adb:select-exact'); return { serial }; },
    verifyIdentity: async () => selected,
    forwardBootstrap: async () => { throw new Error('must not reopen bootstrap'); },
    forward: async () => ({ serial: selected.serial, hostPort: 5040, phonePort: 27183 }),
    killForward: async () => {},
  };
  const device = { state: 'disconnected', on: () => {}, connect: async () => { device.state = 'connected'; f.actions.push('g2:authenticated'); }, disconnect: async () => {}, sendControl: async () => {} };
  await runGatewayd({
    ...f.options,
    env: { ...ENV, AGENTCALL_SYSTEM_FINGERPRINT: 'system-fp', AGENTCALL_VENDOR_FINGERPRINT: 'vendor-fp', AGENTCALL_APK_VERSION_CODE: '330', AGENTCALL_APK_SIGNING_CERT_SHA256: 'a'.repeat(64), AGENTCALL_ARTIFACT_MANIFEST_SHA256: 'b'.repeat(64) },
    createControllerCredentialStore: () => store,
    createAdbManager: () => adb,
    createBootstrapTransport: () => { throw new Error('must not create bootstrap transport'); },
    createDeviceClient: () => device,
    createRpcServer: () => f.rpc,
  });
  assert.deepEqual(f.actions.filter((action) => /adb:select-exact|g2:authenticated/.test(action)), ['adb:select-exact', 'g2:authenticated']);
});
