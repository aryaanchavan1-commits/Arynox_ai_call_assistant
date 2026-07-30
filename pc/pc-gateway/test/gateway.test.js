import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { Gateway } from '../src/gateway.js';
import { DIR_HOST_TO_DEVICE } from '../src/framing.js';

const DESTINATION = '+15551234567';
const RECORDING_CONSENT = Object.freeze({ recorded: true, policy: 'test fixture explicit consent' });

class FakeDevice extends EventEmitter {
  constructor() {
    super();
    this.controls = [];
    this.metrics = { droppedSends: 0 };
    this.state = 'disconnected';
  }

  async connect({ host, port }) {
    this.connection = { host, port };
    this.state = 'connected';
  }

  async disconnect() {
    this.state = 'disconnected';
  }

  async sendControl(frame) {
    this.controls.push(frame);
  }
}

function fakeAdb() {
  const calls = { verifyIdentity: [], forward: [], killForward: [] };
  return {
    calls,
    async selectOne() { return { serial: 'DEV00001', state: 'device' }; },
    async verifyIdentity(serial) { calls.verifyIdentity.push(serial); },
    async forward(args) { calls.forward.push(args); return args; },
    async killForward(args) { calls.killForward.push(args); },
  };
}

function runningGateway(options = {}) {
  const device = new FakeDevice();
  const gateway = new Gateway({
    device,
    idempotencySalt: 'test-salt',
    policy: {
      dialEnabled: true,
      allowNumbers: [DESTINATION],
      requireManualApproval: false,
      ...options.policy,
    },
    recordingHealth: { healthy: true, reason: 'ok' },
    ...options,
  });
  gateway.state = 'running';
  return { gateway, device };
}

test('status exposes bounded authenticated USB connection state without ADB identity', () => {
  const { gateway, device } = runningGateway();
  gateway.forward = { hostPort: 5040, phonePort: 27183 };
  device.state = 'connected';

  const status = gateway.status();

  assert.deepEqual(status.device, {
    connected: true,
    authenticated: true,
    transport: 'usb',
    phase: 'ready',
  });
  assert.equal(JSON.stringify(status.device).includes('serial'), false);
});

test('simulator status is visibly non-hardware even when connected', () => {
  const { gateway, device } = runningGateway({ runtimeIdentity: { identity: 'SIMULATOR', simulator: true } });
  device.state = 'connected';

  assert.deepEqual(gateway.status().device, {
    connected: true,
    authenticated: true,
    transport: 'simulator',
    phase: 'simulator',
  });
});

test('Gateway refuses to construct a real device client without a controller secret', () => {
  assert.throws(() => new Gateway(), /controller secret/i);
  assert.doesNotThrow(() => new Gateway({ controllerSecret: Buffer.alloc(32, 0x5a) }));
});

test('provider health delegates only to the active registry and fails closed when inactive', async () => {
  const calls = [];
  const { gateway } = runningGateway({
    checkProviderHealth: async (request) => {
      calls.push(request);
      return { kind: request.kind, provider: 'openai', healthy: true, scope: 'credential' };
    },
  });
  assert.deepEqual(await gateway.providerHealth({ kind: 'stt' }), {
    kind: 'stt', provider: 'openai', healthy: true, scope: 'credential',
  });
  assert.deepEqual(calls, [{ kind: 'stt' }]);

  const inactive = runningGateway().gateway;
  await assert.rejects(inactive.providerHealth({ kind: 'stt' }), /realtime.*inactive/i);
});

test('provider pair test delegates only to the active registry and fails closed when inactive', async () => {
  const result = { healthy: true, transcript: 'AgentCall speech test.', playbackPath: '/run/agentcall/provider-test.wav' };
  const { gateway } = runningGateway({ testProviders: async () => result });
  assert.deepEqual(await gateway.testProviders(), result);
  await assert.rejects(runningGateway().gateway.testProviders(), /realtime.*inactive/i);
});

test('phone-data snapshots are private, capability-negotiated, and readable offline', async () => {
  const calls = { capabilities: [], consumed: [] };
  const phoneData = {
    setCapabilities(values) { calls.capabilities.push(values); },
    syncRequests() { return [{ command: 'sync_contacts', requestId: 'contacts-1' }]; },
    async consume(value) { calls.consumed.push(value); return true; },
    listContacts: async () => ({ rows: [{ id: '1', name: 'Ada', number: '+10000000000' }], sync: { state: 'ready', count: 1 } }),
    listCallLog: async () => ({ rows: [], sync: { state: 'ready', count: 0 } }),
    publicStatus: async () => ({ contacts: { state: 'ready', count: 1 }, callLog: { state: 'ready', count: 0 } }),
    setDisconnected() {},
  };
  const { gateway, device } = runningGateway({ phoneData });
  const publicEvents = [];
  gateway.on('event', (value) => publicEvents.push(value));
  device.emit('event', { payload: Buffer.from(JSON.stringify({ event: 'capabilities', values: ['contacts_sync_v1'] })) });
  await gateway.flushPhoneData();
  assert.deepEqual(calls.capabilities, [['contacts_sync_v1']]);
  assert.deepEqual(JSON.parse(device.controls.at(-1).payload), { command: 'sync_contacts', requestId: 'contacts-1' });
  const snapshot = { event: 'contacts_snapshot_v1', requestId: 'contacts-1', page: 0, final: true, rows: [{ id: '1', name: 'Ada', number: '+10000000000' }] };
  device.emit('event', { payload: Buffer.from(JSON.stringify(snapshot)) });
  await gateway.flushPhoneData();
  assert.deepEqual(calls.consumed, [snapshot]);
  assert.equal(publicEvents.some((value) => value.event === 'contacts_snapshot_v1'), false);
  assert.equal((await gateway.listContacts({ limit: 20 })).rows.length, 1);
  assert.equal((await gateway.phoneDataStatus()).contacts.count, 1);
});

test('explicit simulator start bypasses ADB and remains visibly identified', async () => {
  const adb = fakeAdb();
  const device = new FakeDevice();
  const gateway = new Gateway({
    adb,
    device,
    runtimeIdentity: { identity: 'SIMULATOR', simulator: true },
    recording: { health: async () => ({ healthy: true, reason: 'ok' }) },
  });
  await gateway.start({ simulator: true, phoneHost: '127.0.0.1', phonePort: 31337 });
  assert.deepEqual(adb.calls.verifyIdentity, []);
  assert.deepEqual(adb.calls.forward, []);
  assert.deepEqual(device.connection, { host: '127.0.0.1', port: 31337 });
  assert.equal(gateway.status().identity, 'SIMULATOR');
  assert.equal(gateway.status().simulator, true);
  assert.equal(gateway.capabilities().identity, 'SIMULATOR');
  assert.equal(gateway.capabilities().simulator, true);
  await gateway.stop();
  assert.deepEqual(adb.calls.killForward, []);
});

test('start preserves ADB identity gate and loopback-only device connection', async () => {
  const adb = fakeAdb();
  const device = new FakeDevice();
  const gateway = new Gateway({ adb, device, hostPort: 5040, phonePort: 5040 });
  await gateway.start();
  assert.deepEqual(adb.calls.verifyIdentity, ['DEV00001']);
  assert.deepEqual(adb.calls.forward, [{ serial: 'DEV00001', hostPort: 5040, phonePort: 5040 }]);
  assert.deepEqual(device.connection, { host: '127.0.0.1', port: 5040 });
  await gateway.stop();
  await assert.rejects(() => gateway.start({ phoneHost: '10.0.0.1' }), /loopback/i);
});

test('identity mismatch fails before forward or device connect', async () => {
  const calls = [];
  const adb = {
    selectBySerial: async (serial) => { calls.push(['select', serial]); return { serial }; },
    verifyIdentity: async (serial) => {
      calls.push(['identity', serial]);
      throw new Error('identity mismatch: fingerprint');
    },
    forward: async (spec) => { calls.push(['forward', spec]); return spec; },
    killForward: async () => {},
  };
  const device = new FakeDevice();
  const gateway = new Gateway({ adb, device, hostPort: 5040, phonePort: 27183 });
  await assert.rejects(
    () => gateway.start({ serial: 'exact-serial', phonePort: 27183 }),
    /identity mismatch/i,
  );
  assert.deepEqual(calls, [
    ['select', 'exact-serial'],
    ['identity', 'exact-serial'],
  ]);
  assert.equal(gateway.forward, null);
  assert.equal(device.connection, undefined);
  assert.equal(gateway.state, 'stopped');
});

test('authentication failure rolls back the owned ADB forward and device state', async () => {
  const adb = fakeAdb();
  const device = new FakeDevice();
  let disconnects = 0;
  device.connect = async () => { throw new Error('controller authentication failed'); };
  device.disconnect = async () => { disconnects++; device.state = 'disconnected'; };
  const gateway = new Gateway({ adb, device, hostPort: 5040, phonePort: 27183 });

  await assert.rejects(() => gateway.start(), /controller authentication failed/i);

  assert.deepEqual(adb.calls.forward, [{ serial: 'DEV00001', hostPort: 5040, phonePort: 27183 }]);
  assert.deepEqual(adb.calls.killForward, [{ serial: 'DEV00001', hostPort: 5040 }]);
  assert.equal(disconnects, 1);
  assert.equal(gateway.forward, null);
  assert.equal(gateway.state, 'stopped');
});

test('start acknowledges recorder health to Android immediately after connecting', async () => {
  const adb = fakeAdb();
  const device = new FakeDevice();
  const gateway = new Gateway({
    adb,
    device,
    hostPort: 5040,
    phonePort: 27183,
    recordingHealth: { healthy: true, reason: 'ok' },
  });
  await gateway.start();
  assert.equal(device.controls.length, 2);
  assert.deepEqual(JSON.parse(device.controls[0].payload.toString('utf8')), { command: 'capabilities' });
  assert.deepEqual(JSON.parse(device.controls[1].payload.toString('utf8')), {
    command: 'recording_health',
    healthy: true,
  });
});

test('start selects the configured exact serial before identity and forwarding', async () => {
  const calls = [];
  const adb = {
    selectBySerial: async (serial) => { calls.push(['select', serial]); return { serial }; },
    verifyIdentity: async (serial) => { calls.push(['identity', serial]); },
    forward: async (spec) => { calls.push(['forward', spec]); return spec; },
    killForward: async () => {},
  };
  const device = new FakeDevice();
  const gateway = new Gateway({ adb, device, hostPort: 5040, phonePort: 27183 });
  await gateway.start({ serial: 'exact-serial', phonePort: 27183 });
  assert.deepEqual(calls, [
    ['select', 'exact-serial'],
    ['identity', 'exact-serial'],
    ['forward', { serial: 'exact-serial', hostPort: 5040, phonePort: 27183 }],
  ]);
  assert.deepEqual(device.connection, { host: '127.0.0.1', port: 5040 });
});

test('explicit consented recording lifecycle captures remote and agent PCM and finalizes on ended', async () => {
  const calls = [];
  const recorder = {
    ready: true,
    writeRemote: async (frame) => calls.push(['remote', Buffer.from(frame)]),
    writeAgent: async (frame) => calls.push(['agent', Buffer.from(frame)]),
    appendEvent: async (event) => calls.push(['event', event]),
    finalize: async (options) => { calls.push(['finalize', options]); return { complete: true }; },
  };
  const recording = {
    health: async () => ({ healthy: true, reason: 'ok' }),
    start: async (metadata) => { calls.push(['start', metadata]); return recorder; },
  };
  const { gateway, device } = runningGateway({ recording });
  device.sendPcm = async ({ payload }) => calls.push(['send', Buffer.from(payload)]);
  await gateway.beginRecording({
    callId: 'call-1',
    consent: { recorded: true, policy: 'fixture' },
  });
  const remote = Buffer.alloc(640, 0x11);
  const agent = Buffer.alloc(640, 0x22);
  device.emit('pcm', { payload: remote });
  await gateway.sendAgentPcm(agent);
  device.emit('event', { payload: Buffer.from(JSON.stringify({ event: 'ended', callId: 'call-1' })) });
  await gateway.flushRecording();

  assert.deepEqual(calls.map(([name]) => name), ['start', 'remote', 'agent', 'send', 'event', 'finalize']);
  assert.deepEqual(calls.at(-1), ['finalize', { outcome: 'ended' }]);
  assert.deepEqual(device.controls.slice(-2).map(({ payload }) => JSON.parse(payload.toString('utf8'))), [
    { command: 'recording_session', callId: 'call-1', active: true },
    { command: 'recording_session', callId: 'call-1', active: false },
  ]);
  assert.equal(gateway.status().recording.active, false);
});

test('remote recording write failure revokes media and finalizes incomplete exactly once', async () => {
  const calls = [];
  let remoteWrites = 0;
  const recorder = {
    ready: true,
    appendEvent: async (event) => calls.push(['event', event]),
    writeRemote: async () => {
      calls.push(['remote']);
      remoteWrites++;
      throw new Error('disk full');
    },
    finalize: async (options) => {
      calls.push(['finalize', options]);
      return { complete: false };
    },
  };
  const realtime = {
    callId: 'call-write-failure',
    close: async () => calls.push(['realtime:close']),
  };
  const { gateway, device } = runningGateway({ recording: { start: async () => recorder } });
  await gateway.beginRecording({ callId: 'call-write-failure', consent: { recorded: true } });
  await gateway.attachRealtime(realtime);
  device.emit('event', {
    payload: Buffer.from(JSON.stringify({ event: 'active', callId: 'call-write-failure' })),
  });
  await gateway.flushRecording();

  device.emit('pcm', { payload: Buffer.alloc(640, 1) });
  device.emit('pcm', { payload: Buffer.alloc(640, 2) });
  await gateway.flushRecording();
  assert.deepEqual(gateway.status().currentCall, {
    callId: 'call-write-failure',
    phase: 'active',
    mediaState: 'failed',
  });
  device.emit('event', {
    payload: Buffer.from(JSON.stringify({ event: 'ended', callId: 'call-write-failure' })),
  });
  await gateway.flushRecording();

  assert.equal(remoteWrites, 1, 'queued PCM after the failed owner must be discarded');
  assert.deepEqual(device.controls.slice(-3).map(({ payload }) => JSON.parse(payload.toString('utf8'))), [
    { command: 'recording_session', callId: 'call-write-failure', active: true },
    { command: 'recording_session', callId: 'call-write-failure', active: false },
    { command: 'recording_health', healthy: false },
  ]);
  assert.deepEqual(calls, [
    ['event', { event: 'active', callId: 'call-write-failure' }],
    ['remote'],
    ['realtime:close'],
    ['event', { event: 'recording_failed', callId: 'call-write-failure', reason: 'recording_write_failed' }],
    ['finalize', { outcome: 'recording_write_failed' }],
  ]);
  assert.deepEqual(gateway.status().recording, {
    healthy: false, reason: 'recording write failed', active: false,
  });
  assert.equal(gateway.status().realtime.active, false);
  assert.equal(gateway.status().currentCall, null);
});

test('recording write failure blocks a replacement recorder until failed-owner teardown finishes', async () => {
  let releaseFinalize;
  const finalizeStarted = new Promise((resolve) => { releaseFinalize = resolve; });
  let finishFinalize;
  const finalizeFinished = new Promise((resolve) => { finishFinalize = resolve; });
  const failedRecorder = {
    ready: true,
    writeRemote: async () => { throw new Error('disk full'); },
    appendEvent: async () => {},
    finalize: async () => {
      releaseFinalize();
      await finalizeFinished;
      return { complete: false };
    },
  };
  const { gateway, device } = runningGateway({ recording: { start: async () => failedRecorder } });
  await gateway.beginRecording({ callId: 'call-failed-owner', consent: { recorded: true } });
  device.emit('pcm', { payload: Buffer.alloc(640) });
  await finalizeStarted;

  await assert.rejects(
    gateway.beginRecording({ callId: 'call-replacement', consent: { recorded: true } }),
    /already active/i,
  );
  finishFinalize();
  await gateway.flushRecording();
});

test('recording write failure closes realtime attached after the failing PCM was queued', async () => {
  let releaseQueue;
  const queueBlocked = new Promise((resolve) => { releaseQueue = resolve; });
  const calls = [];
  const recorder = {
    ready: true,
    writeRemote: async () => { throw new Error('disk full'); },
    appendEvent: async () => {},
    finalize: async () => ({ complete: false }),
  };
  const { gateway, device } = runningGateway({ recording: { start: async () => recorder } });
  await gateway.beginRecording({ callId: 'call-late-realtime', consent: { recorded: true } });
  gateway._queueRecording(() => queueBlocked);
  device.emit('pcm', { payload: Buffer.alloc(640) });
  await gateway.attachRealtime({
    callId: 'call-late-realtime',
    close: async () => calls.push('realtime:close'),
  });
  releaseQueue();
  await gateway.flushRecording();

  assert.deepEqual(calls, ['realtime:close']);
  assert.equal(gateway.status().realtime.active, false);
});

test('recording write failure cannot orphan a realtime session whose start resolves late', async () => {
  let releaseStart;
  const startBlocked = new Promise((resolve) => { releaseStart = resolve; });
  const calls = [];
  const recorder = {
    ready: true,
    writeRemote: async () => { throw new Error('disk full'); },
    appendEvent: async () => {},
    finalize: async (options) => calls.push(['finalize', options]),
  };
  const { gateway, device } = runningGateway({ recording: { start: async () => recorder } });
  await gateway.beginRecording({ callId: 'call-delayed-start', consent: { recorded: true } });
  const attaching = gateway.attachRealtime({
    callId: 'call-delayed-start',
    start: async () => startBlocked,
    close: async () => calls.push(['realtime:close']),
  });
  device.emit('pcm', { payload: Buffer.alloc(640) });
  await gateway.flushRecording();
  releaseStart();

  await assert.rejects(attaching, /recording.*inactive/i);
  assert.deepEqual(calls, [
    ['finalize', { outcome: 'recording_write_failed' }],
    ['realtime:close'],
  ]);
  assert.equal(gateway.status().realtime.active, false);
});

test('recording failure during realtime creation finalizes the failed owner exactly once', async () => {
  let releaseFactory;
  const factoryBlocked = new Promise((resolve) => { releaseFactory = resolve; });
  const finalized = [];
  const recorder = {
    ready: true,
    writeRemote: async () => { throw new Error('disk full'); },
    appendEvent: async () => {},
    finalize: async (options) => finalized.push(options),
  };
  const device = new FakeDevice();
  const gateway = new Gateway({
    device,
    recording: { start: async () => recorder },
    createRealtimeSession: async () => factoryBlocked,
    runtimeIdentity: { identity: 'SIMULATOR', simulator: true },
  });
  gateway.state = 'running';
  device.state = 'connected';
  const beginning = gateway.beginRecording({
    callId: 'call-startup-failure', consent: { recorded: true },
  });
  await Promise.resolve();
  assert.equal(gateway.status().recording.active, true);
  device.emit('pcm', { payload: Buffer.alloc(640) });
  await gateway.flushRecording();
  releaseFactory({ callId: 'call-startup-failure' });

  await assert.rejects(beginning, /recording.*inactive/i);
  assert.deepEqual(finalized, [{ outcome: 'recording_write_failed' }]);
});

test('recording write failure disconnects transport when Android revocation cannot be delivered', async () => {
  let disconnects = 0;
  const recorder = {
    ready: true,
    writeRemote: async () => { throw new Error('disk full'); },
    appendEvent: async () => {},
    finalize: async () => ({ complete: false }),
  };
  const { gateway, device } = runningGateway({ recording: { start: async () => recorder } });
  const sendControl = device.sendControl.bind(device);
  device.sendControl = async (frame) => {
    const value = JSON.parse(frame.payload.toString('utf8'));
    if (value.command === 'recording_session' && value.active === false) {
      throw new Error('transport lost');
    }
    return sendControl(frame);
  };
  device.disconnect = async () => { disconnects++; device.state = 'disconnected'; };
  await gateway.beginRecording({ callId: 'call-revoke-failure', consent: { recorded: true } });
  device.emit('pcm', { payload: Buffer.alloc(640) });
  await gateway.flushRecording();

  assert.equal(disconnects, 1);
  assert.equal(device.state, 'disconnected');
});

test('finalized recording syncs to phone only after explicit capability negotiation', async () => {
  const syncCalls = [];
  const recorder = {
    ready: true,
    writeRemote: async () => {},
    writeAgent: async () => {},
    appendEvent: async () => {},
    finalize: async () => ({ complete: true, directory: '/authoritative/call-sync' }),
  };
  const { gateway, device } = runningGateway({
    recording: { start: async () => recorder },
    syncFinalizedRecording: async (args) => { syncCalls.push(args); return { stored: true, bytes: 1234 }; },
  });
  device.emit('event', { payload: Buffer.from(JSON.stringify({ event: 'capabilities', values: ['recording_sync_v1'] })) });
  await gateway.beginRecording({ callId: 'call-sync', consent: { recorded: true } });
  device.emit('event', { payload: Buffer.from(JSON.stringify({ event: 'ended', callId: 'call-sync' })) });
  await gateway.flushRecording();
  assert.equal(syncCalls.length, 1);
  assert.equal(syncCalls[0].directory, '/authoritative/call-sync');
  assert.equal(syncCalls[0].callId, 'call-sync');
  assert.deepEqual(gateway.status().phoneRecordingCopy, { state: 'stored', callId: 'call-sync', bytes: 1234 });
});

test('failed automatic phone recording copy retries after the phone reconnects', async () => {
  let attempts = 0;
  const recorder = {
    ready: true,
    writeRemote: async () => {},
    writeAgent: async () => {},
    appendEvent: async () => {},
    finalize: async () => ({ complete: true, directory: '/authoritative/call-reconnect' }),
  };
  const { gateway, device } = runningGateway({
    recording: { start: async () => recorder },
    syncFinalizedRecording: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('phone disconnected during transfer');
      return { stored: true, bytes: 2468 };
    },
  });
  const capabilities = {
    payload: Buffer.from(JSON.stringify({
      event: 'capabilities',
      values: ['recording_sync_v1'],
    })),
  };

  device.state = 'connected';
  device.emit('event', capabilities);
  await gateway.beginRecording({
    callId: 'call-reconnect',
    consent: { recorded: true },
  });
  device.emit('event', {
    payload: Buffer.from(JSON.stringify({
      event: 'ended',
      callId: 'call-reconnect',
    })),
  });
  await gateway.flushRecording();
  assert.equal(attempts, 1);
  assert.equal(gateway.status().phoneRecordingCopy.state, 'failed');

  device.emit('state', 'disconnected');
  device.state = 'connected';
  device.emit('event', capabilities);
  await gateway.flushRecording();

  assert.equal(attempts, 2);
  assert.deepEqual(gateway.status().phoneRecordingCopy, {
    state: 'stored',
    callId: 'call-reconnect',
    bytes: 2468,
  });

  device.emit('event', capabilities);
  await gateway.flushRecording();
  assert.equal(attempts, 2);
});

test('failed automatic phone recording copy retries while the same phone remains connected', async () => {
  let attempts = 0;
  const scheduled = [];
  const recorder = {
    ready: true,
    writeRemote: async () => {},
    writeAgent: async () => {},
    appendEvent: async () => {},
    finalize: async () => ({ complete: true, directory: '/authoritative/call-connected-retry' }),
  };
  const { gateway, device } = runningGateway({
    recording: { start: async () => recorder },
    recordingSyncRetryDelaysMs: [2_000],
    setRecordingSyncRetryTimer: (callback, delay) => {
      const timer = { callback, delay, unref() {} };
      scheduled.push(timer);
      return timer;
    },
    clearRecordingSyncRetryTimer: () => {},
    syncFinalizedRecording: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('phone recording store was temporarily busy');
      return { stored: true, bytes: 8642 };
    },
  });
  device.state = 'connected';
  device.emit('event', {
    payload: Buffer.from(JSON.stringify({ event: 'capabilities', values: ['recording_sync_v1'] })),
  });
  await gateway.beginRecording({
    callId: 'call-connected-retry',
    consent: { recorded: true },
  });
  device.emit('event', {
    payload: Buffer.from(JSON.stringify({ event: 'ended', callId: 'call-connected-retry' })),
  });
  await gateway.flushRecording();

  assert.equal(attempts, 1);
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].delay, 2_000);
  scheduled[0].callback();
  await gateway.flushRecording();

  assert.equal(attempts, 2);
  assert.deepEqual(gateway.status().phoneRecordingCopy, {
    state: 'stored',
    callId: 'call-connected-retry',
    bytes: 8642,
  });
});

test('a recording finalized while phone sync is unavailable transfers on the next handshake', async () => {
  const syncCalls = [];
  const recorder = {
    ready: true,
    writeRemote: async () => {},
    writeAgent: async () => {},
    appendEvent: async () => {},
    finalize: async () => ({ complete: true, directory: '/authoritative/call-pending' }),
  };
  const { gateway, device } = runningGateway({
    recording: { start: async () => recorder },
    syncFinalizedRecording: async (args) => {
      syncCalls.push(args);
      return { stored: true, bytes: 9753 };
    },
  });

  await gateway.beginRecording({
    callId: 'call-pending',
    consent: { recorded: true },
  });
  device.emit('event', {
    payload: Buffer.from(JSON.stringify({
      event: 'ended',
      callId: 'call-pending',
    })),
  });
  await gateway.flushRecording();
  assert.equal(syncCalls.length, 0);
  assert.deepEqual(gateway.status().phoneRecordingCopy, {
    state: 'pending',
    callId: 'call-pending',
    reason: 'waiting for phone connection',
  });

  device.state = 'connected';
  device.emit('event', {
    payload: Buffer.from(JSON.stringify({
      event: 'capabilities',
      values: ['recording_sync_v1'],
    })),
  });
  await gateway.flushRecording();

  assert.equal(syncCalls.length, 1);
  assert.deepEqual(gateway.status().phoneRecordingCopy, {
    state: 'stored',
    callId: 'call-pending',
    bytes: 9753,
  });
});

test('operator can retry a finalized recording copy while the connected phone is idle', async () => {
  const syncCalls = [];
  const { gateway, device } = runningGateway({
    recording: {
      artifact: async ({ callId, artifact }) => `/authoritative/${callId}/${artifact}`,
    },
    syncFinalizedRecording: async (args) => {
      syncCalls.push(args);
      return { stored: true, bytes: 4321 };
    },
  });
  device.state = 'connected';
  device.emit('event', { payload: Buffer.from(JSON.stringify({ event: 'capabilities', values: ['recording_sync_v1'] })) });

  assert.deepEqual(await gateway.syncRecording({ callId: 'call-retry' }), {
    state: 'stored', callId: 'call-retry', bytes: 4321,
  });
  assert.equal(syncCalls[0].directory, '/authoritative/call-retry');
  assert.equal(syncCalls[0].callId, 'call-retry');
});

test('gateway stop fails an active call closed with one audited interruption', async () => {
  const calls = [];
  const recorder = {
    ready: true,
    appendEvent: async (event) => calls.push(['event', event]),
    finalize: async (options) => calls.push(['finalize', options]),
  };
  const realtime = {
    callId: 'call-stop',
    close: async () => calls.push(['realtime:close']),
  };
  const adb = fakeAdb();
  const device = new FakeDevice();
  const gateway = new Gateway({
    adb,
    device,
    hostPort: 5040,
    phonePort: 27183,
    recordingHealth: { healthy: true, reason: 'ok' },
    recording: { start: async () => recorder },
  });
  await gateway.start();
  await gateway.beginRecording({ callId: 'call-stop', consent: { recorded: true } });
  await gateway.attachRealtime(realtime);
  device.emit('event', {
    payload: Buffer.from(JSON.stringify({ event: 'active', callId: 'call-stop', direction: 'incoming' })),
  });
  assert.equal(gateway.status().currentCall?.phase, 'active');

  await gateway.stop();
  await gateway.stop();

  assert.equal(gateway.status().currentCall, null);
  assert.equal(gateway.status().recording.active, false);
  assert.equal(gateway.status().realtime.active, false);
  assert.deepEqual(calls, [
    ['event', { event: 'active', callId: 'call-stop', direction: 'incoming' }],
    ['event', { event: 'gateway_stopped', callId: 'call-stop', reason: 'gateway_shutdown' }],
    ['realtime:close'],
    ['finalize', { outcome: 'gateway_stopped' }],
  ]);
});

test('gateway stop still closes realtime and finalizes when the shutdown audit write fails', async () => {
  const calls = [];
  const recorder = {
    ready: true,
    appendEvent: async () => { calls.push(['event']); throw new Error('disk lost'); },
    finalize: async (options) => calls.push(['finalize', options]),
  };
  const { gateway } = runningGateway({ recording: { start: async () => recorder } });
  await gateway.beginRecording({ callId: 'call-stop-failure', consent: { recorded: true } });
  await gateway.attachRealtime({
    callId: 'call-stop-failure',
    close: async () => calls.push(['realtime:close']),
  });

  await gateway.stop();

  assert.equal(gateway.status().state, 'stopped');
  assert.equal(gateway.status().recording.active, false);
  assert.equal(gateway.status().realtime.active, false);
  assert.deepEqual(calls, [
    ['event'],
    ['realtime:close'],
    ['finalize', { outcome: 'gateway_stopped' }],
  ]);
});

test('device disconnect fails an active call closed and finalizes its recording as interrupted', async () => {
  const calls = [];
  const recorder = {
    ready: true,
    appendEvent: async (event) => calls.push(['event', event]),
    finalize: async (options) => { calls.push(['finalize', options]); return { complete: false }; },
  };
  const realtime = {
    callId: 'call-drop',
    close: async () => calls.push(['realtime:close']),
  };
  const { gateway, device } = runningGateway({ recording: { start: async () => recorder } });
  await gateway.beginRecording({ callId: 'call-drop', consent: { recorded: true } });
  await gateway.attachRealtime(realtime);
  device.emit('event', {
    payload: Buffer.from(JSON.stringify({ event: 'active', callId: 'call-drop', direction: 'incoming' })),
  });
  assert.equal(gateway.status().currentCall?.phase, 'active');

  device.state = 'disconnected';
  device.emit('state', 'disconnected');
  device.emit('state', 'disconnected');
  await gateway.flushRecording();

  assert.equal(gateway.status().currentCall, null);
  assert.deepEqual(gateway.status().recording, { healthy: true, reason: 'ok', active: false });
  assert.equal(gateway.status().realtime.active, false);
  assert.deepEqual(calls, [
    ['event', { event: 'active', callId: 'call-drop', direction: 'incoming' }],
    ['event', { event: 'transport_lost', callId: 'call-drop', reason: 'device_disconnected' }],
    ['realtime:close'],
    ['finalize', { outcome: 'transport_lost' }],
  ]);
});

test('explicit realtime factory starts before Android media acknowledgement and fails closed on startup error', async () => {
  const calls = [];
  const recorder = {
    ready: true,
    finalize: async (options) => calls.push(['finalize', options]),
  };
  const recording = { start: async () => recorder };
  const { gateway, device } = runningGateway({
    recording,
    createRealtimeSession: async ({ callId, gateway: boundary }) => {
      calls.push(['create', callId, boundary === gateway]);
      return { callId, start: async () => calls.push(['realtime:start']), close: async () => calls.push(['realtime:close']) };
    },
  });
  device.sendControl = async (frame) => calls.push(['control', JSON.parse(frame.payload.toString('utf8'))]);
  await gateway.beginRecording({ callId: 'call-rt', consent: { recorded: true } });
  assert.deepEqual(calls.map(([name]) => name), ['create', 'realtime:start', 'control']);
  assert.equal(gateway.status().realtime.active, true);

  const failed = runningGateway({
    recording,
    createRealtimeSession: async () => { throw new Error('provider unavailable'); },
  });
  failed.device.sendControl = async () => calls.push(['unexpected-control']);
  await assert.rejects(
    () => failed.gateway.beginRecording({ callId: 'call-fail', consent: { recorded: true } }),
    /provider unavailable/,
  );
  assert.deepEqual(calls.at(-1), ['finalize', { outcome: 'realtime_start_failed' }]);
  assert.equal(calls.some(([name]) => name === 'unexpected-control'), false);
});

test('final remote transcript emits a bounded semantic agent turn and speak requires matching active realtime call', async () => {
  const { gateway } = runningGateway();
  const transcripts = [];
  const spoken = [];
  const emitted = [];
  gateway.activeRecorder = { appendTranscript: async (value) => transcripts.push(value) };
  gateway.activeRecordingCallId = 'call-agent';
  gateway.activeRealtime = {
    callId: 'call-agent',
    speak: async (request) => spoken.push(request),
  };
  gateway.on('event', (value) => emitted.push(value));

  await gateway.appendTranscript({
    speaker: 'remote', callId: 'call-agent', text: 'Can you help?', final: true, complete: true,
  });
  assert.deepEqual(emitted, [{
    event: 'transcript_final', callId: 'call-agent', speaker: 'remote',
    text: 'Can you help?', complete: true,
  }]);
  assert.deepEqual(await gateway.speak({
    callId: 'call-agent', text: 'Yes, I can help.', idempotencyKey: 'speak-1',
  }), { accepted: true, callId: 'call-agent', interrupted: false });
  assert.deepEqual(spoken, [{ text: 'Yes, I can help.' }]);
  assert.deepEqual(await gateway.speak({
    callId: 'call-agent',
    text: 'Good afternoon. This complete opening must play.',
    interruptible: false,
    idempotencyKey: 'protected-opening',
  }), { accepted: true, callId: 'call-agent', interrupted: false });
  assert.deepEqual(spoken.at(-1), {
    text: 'Good afternoon. This complete opening must play.',
    interruptible: false,
  });
  gateway.activeRealtime.speak = async (request) => {
    spoken.push(request);
    return { interrupted: true };
  };
  assert.deepEqual(await gateway.speak({
    callId: 'call-agent', text: 'Here is the answer that was interrupted.', idempotencyKey: 'speak-interrupted',
  }), { accepted: true, callId: 'call-agent', interrupted: true });
  assert.deepEqual(emitted.at(-1), {
    event: 'transcript_final', callId: 'call-agent', speaker: 'agent',
    text: 'Here is the answer that was interrupted.', complete: false,
  });
  assert.deepEqual(await gateway.speak({
    callId: 'other-call', text: 'No', idempotencyKey: 'speak-2',
  }), { accepted: false, callId: 'other-call', reason: 'realtime unavailable' });
  gateway.activeRealtime.speak = async () => { throw new Error('TTS provider timed out'); };
  assert.deepEqual(await gateway.speak({
    callId: 'call-agent', text: 'Please try again.', idempotencyKey: 'speak-provider-timeout',
  }), { accepted: false, callId: 'call-agent', reason: 'speech provider unavailable' });
});

test('remote PCM is recorded before matching realtime provider fan-out and detaches on call end', async () => {
  const calls = [];
  const recorder = {
    ready: true,
    writeRemote: async (frame) => calls.push(['record', Buffer.from(frame)]),
    appendEvent: async () => {},
    finalize: async () => ({ complete: true }),
  };
  const realtime = {
    callId: 'call-realtime',
    pushRemotePcm: async (frame, timestampMicros) => calls.push(['provider', Buffer.from(frame), timestampMicros]),
    close: async () => calls.push(['close']),
  };
  const { gateway, device } = runningGateway({ recording: { start: async () => recorder } });
  await gateway.beginRecording({ callId: 'call-realtime', consent: { recorded: true } });
  await gateway.attachRealtime(realtime);
  const pcm = Buffer.alloc(640, 0x33);
  device.emit('pcm', { payload: pcm, timestampMicros: 9_000n });
  await gateway.flushRecording();
  assert.deepEqual(calls.slice(0, 2).map(([name]) => name), ['record', 'provider']);
  assert.equal(calls[1][2], 9_000n);
  device.emit('event', { payload: Buffer.from(JSON.stringify({ event: 'ended', callId: 'call-realtime' })) });
  await gateway.flushRecording();
  assert.equal(calls.at(-1)[0], 'close');
  assert.equal(gateway.status().realtime.active, false);
});

test('transcripts require and serialize through the active consented recorder', async () => {
  const calls = [];
  const recorder = {
    ready: true,
    appendTranscript: async (value) => calls.push(value),
    finalize: async () => ({ complete: true }),
  };
  const { gateway } = runningGateway({ recording: { start: async () => recorder } });
  await assert.rejects(() => gateway.appendTranscript({ text: 'before' }), /active recorder/i);
  await gateway.beginRecording({ callId: 'call-transcript', consent: { recorded: true } });
  await gateway.appendTranscript({ speaker: 'remote', text: 'hello', final: true });
  assert.deepEqual(calls, [{ speaker: 'remote', text: 'hello', final: true }]);
});

test('concurrent recording starts reserve one owner before asynchronous recorder creation', async () => {
  const releases = [];
  const started = [];
  const recording = {
    start: ({ callId }) => new Promise((resolve) => {
      started.push(callId);
      releases.push(() => resolve({ ready: true, finalize: async () => ({ complete: false }) }));
    }),
  };
  const { gateway } = runningGateway({ recording });

  const first = gateway.beginRecording({ callId: 'call-owner', consent: { recorded: true } });
  await Promise.resolve();
  const contender = gateway.beginRecording({ callId: 'call-contender', consent: { recorded: true } });
  await Promise.resolve();
  releases.forEach((release) => release());

  const [ownerResult, contenderResult] = await Promise.allSettled([first, contender]);
  assert.equal(ownerResult.status, 'fulfilled');
  assert.equal(contenderResult.status, 'rejected');
  assert.match(contenderResult.reason.message, /already active/i);
  assert.deepEqual(started, ['call-owner']);
  assert.equal(gateway.activeRecordingCallId, 'call-owner');
});

test('recording lifecycle rejects media without explicit consented start', async () => {
  const { gateway } = runningGateway({
    recording: { start: async () => { throw new Error('should not start'); } },
  });
  await assert.rejects(() => gateway.beginRecording({ callId: 'call-1', consent: { recorded: false } }), /consent/i);
  await assert.rejects(() => gateway.sendAgentPcm(Buffer.alloc(640)), /active recorder/i);
});

test('recording health blocks dial, answer, and DTMF but permits reject and hangup', async () => {
  const { gateway, device } = runningGateway({ recordingHealth: { healthy: false, reason: 'disk unavailable' } });
  assert.deepEqual(await gateway.dial({ destination: DESTINATION, consent: RECORDING_CONSENT, idempotencyKey: 'dial-blocked' }), {
    accepted: false, reason: 'recording unavailable',
  });
  assert.deepEqual(await gateway.answer({ callId: 'call-1', idempotencyKey: 'answer-blocked' }), {
    accepted: false, callId: 'call-1', reason: 'recording unavailable',
  });
  assert.deepEqual(await gateway.sendDtmf({ callId: 'call-1', digits: '1', idempotencyKey: 'dtmf-blocked' }), {
    accepted: false, callId: 'call-1', reason: 'recording unavailable',
  });
  assert.equal((await gateway.reject({ callId: 'call-1', idempotencyKey: 'reject-safe' })).accepted, true);
  assert.equal((await gateway.hangup({ callId: 'call-1', idempotencyKey: 'hangup-safe' })).accepted, true);
  assert.deepEqual(device.controls.map(({ payload }) => JSON.parse(payload.toString('utf8')).command), ['reject', 'hangup']);
  assert.deepEqual(gateway.status().recording, { healthy: false, reason: 'disk unavailable', active: false });
});

test('manual PC audio is call-correlated, recorded, and forwarded only as bounded PCM', async () => {
  const writes = [];
  const recorder = {
    ready: true,
    writeAgent: async (payload) => writes.push(['record', Buffer.from(payload)]),
    appendEvent: async () => {},
    finalize: async () => ({ complete: false }),
  };
  const { gateway, device } = runningGateway({ recording: { start: async () => recorder } });
  device.sendPcm = async (frame) => writes.push(['phone', Buffer.from(frame.payload)]);
  gateway.currentCall = { callId: 'call-pc-audio', direction: 'incoming', phase: 'active' };
  await gateway.beginRecording({ callId: 'call-pc-audio', consent: { recorded: true } });
  const pcm = Buffer.alloc(640, 0x22);

  assert.equal(gateway.manualAudioAvailable({ callId: 'call-pc-audio' }), true);
  assert.deepEqual(await gateway.sendManualPcm({ callId: 'call-pc-audio', payload: pcm }), {
    accepted: true, callId: 'call-pc-audio',
  });
  assert.deepEqual(writes.map(([name]) => name), ['record', 'phone']);
  assert.deepEqual(writes[0][1], pcm);
  assert.deepEqual(writes[1][1], pcm);
  await assert.rejects(gateway.sendManualPcm({ callId: 'other-call', payload: pcm }), /unavailable/i);
  await assert.rejects(
    gateway.sendManualPcm({ callId: 'call-pc-audio', payload: Buffer.alloc(641) }),
    /exactly 640/i,
  );
});

test('answering a desktop incoming call starts the mandatory recording and realtime session first', async () => {
  const starts = [];
  const recorder = {
    ready: true,
    appendEvent: async () => {},
    finalize: async () => ({ complete: false }),
  };
  const realtime = {
    callId: 'call-incoming-answer',
    start: async () => {},
    close: async () => {},
  };
  const { gateway, device } = runningGateway({
    recording: { start: async (options) => { starts.push(options); return recorder; } },
    createRealtimeSession: async () => realtime,
  });
  device.emit('event', { payload: Buffer.from(JSON.stringify({
    event: 'incoming', callId: 'call-incoming-answer', direction: 'incoming',
    callerNumber: '+15551234567', displayNumber: '+15*******67',
  })) });
  await gateway.flushRecording();

  assert.deepEqual(await gateway.answer({
    callId: 'call-incoming-answer', idempotencyKey: 'answer-recorded-1',
  }), { accepted: true, callId: 'call-incoming-answer' });
  assert.equal(starts.length, 1);
  assert.equal(starts[0].callId, 'call-incoming-answer');
  assert.equal(starts[0].consent.recorded, true);
  assert.deepEqual(device.controls.map(({ payload }) => JSON.parse(payload.toString('utf8')).command), [
    'recording_session', 'answer',
  ]);
  assert.equal(gateway.status().recording.active, true);
  assert.equal(gateway.status().realtime.active, true);
});

test('gateway startup preflights recording before reporting running', async () => {
  const adb = fakeAdb();
  const device = new FakeDevice();
  const recording = { health: async () => ({ healthy: true, reason: 'ok' }) };
  const gateway = new Gateway({ adb, device, recording, hostPort: 5040, phonePort: 27183 });
  await gateway.start();
  assert.deepEqual(gateway.status().recording, { healthy: true, reason: 'ok', active: false });
});

test('semantic methods send canonical CONTROL JSON host-to-device', async () => {
  const { gateway, device } = runningGateway();
  await gateway.dial({ destination: DESTINATION, consent: RECORDING_CONSENT, idempotencyKey: 'dial-1' });
  await gateway.answer({ callId: 'call-1', idempotencyKey: 'answer-1' });
  await gateway.reject({ callId: 'call-2', idempotencyKey: 'reject-1' });
  await gateway.hangup({ callId: 'call-3', idempotencyKey: 'hangup-1' });
  await gateway.sendDtmf({ callId: 'call-4', digits: '12#A', idempotencyKey: 'dtmf-1' });

  assert.deepEqual(device.controls.map(({ direction }) => direction), Array(5).fill(DIR_HOST_TO_DEVICE));
  assert.deepEqual(device.controls.map(({ payload }) => JSON.parse(payload.toString('utf8'))), [
    { command: 'dial', destination: DESTINATION, idempotencyKey: 'dial-1' },
    { command: 'answer', callId: 'call-1', idempotencyKey: 'answer-1' },
    { command: 'reject', callId: 'call-2', idempotencyKey: 'reject-1' },
    { command: 'hangup', callId: 'call-3', idempotencyKey: 'hangup-1' },
    { command: 'send_dtmf', callId: 'call-4', digits: '12#A', idempotencyKey: 'dtmf-1' },
  ]);
});

test('idempotency replay returns original result without another device command', async () => {
  const { gateway, device } = runningGateway();
  const first = await gateway.dial({ destination: DESTINATION, consent: RECORDING_CONSENT, idempotencyKey: 'same-key' });
  const replay = await gateway.dial({ destination: DESTINATION, consent: RECORDING_CONSENT, idempotencyKey: 'same-key' });
  assert.deepEqual(replay, first);
  assert.equal(device.controls.length, 1);
  assert.equal(gateway.metrics.idempotencyReplays, 1);
});

test('concurrent identical commands coalesce while payload collisions reject', async () => {
  const { gateway, device } = runningGateway();
  const releases = [];
  device.sendControl = async (frame) => {
    device.controls.push(frame);
    await new Promise((resolve) => { releases.push(resolve); });
  };

  const first = gateway.answer({ callId: 'call-1', idempotencyKey: 'coalesce-key' });
  await Promise.resolve();
  const replay = gateway.answer({ callId: 'call-1', idempotencyKey: 'coalesce-key' });
  const collision = gateway.answer({ callId: 'call-2', idempotencyKey: 'coalesce-key' });
  await Promise.resolve();
  releases.forEach((release) => release());

  const [firstResult, replayResult, collisionResult] = await Promise.allSettled([first, replay, collision]);
  assert.equal(device.controls.length, 1);
  assert.deepEqual(firstResult, { status: 'fulfilled', value: { accepted: true, callId: 'call-1' } });
  assert.deepEqual(replayResult, firstResult);
  assert.equal(collisionResult.status, 'rejected');
  assert.match(collisionResult.reason.message, /idempotency key collision/i);
});

test('failed in-flight command is removed so an exact retry can run', async () => {
  const { gateway, device } = runningGateway();
  let attempts = 0;
  device.sendControl = async (frame) => {
    attempts++;
    if (attempts === 1) throw new Error('temporary send failure');
    device.controls.push(frame);
  };
  await assert.rejects(
    () => gateway.answer({ callId: 'call-retry', idempotencyKey: 'retry-key' }),
    /temporary send failure/,
  );
  assert.deepEqual(
    await gateway.answer({ callId: 'call-retry', idempotencyKey: 'retry-key' }),
    { accepted: true, callId: 'call-retry' },
  );
  assert.equal(attempts, 2);
});

test('pending idempotency entries survive completed-entry capacity eviction', async () => {
  const { gateway, device } = runningGateway({ idempotencyCacheSize: 1 });
  const releases = [];
  device.sendControl = async (frame) => {
    device.controls.push(frame);
    await new Promise((resolve) => { releases.push(resolve); });
  };

  const first = gateway.answer({ callId: 'call-1', idempotencyKey: 'key-1' });
  const second = gateway.answer({ callId: 'call-2', idempotencyKey: 'key-2' });
  await Promise.resolve();
  const replay = gateway.answer({ callId: 'call-1', idempotencyKey: 'key-1' });
  await Promise.resolve();

  assert.equal(device.controls.length, 2);
  releases.forEach((release) => release());
  await Promise.all([first, second, replay]);
  assert.equal(device.controls.length, 2);
});

test('idempotency cache is bounded', async () => {
  const { gateway } = runningGateway({ idempotencyCacheSize: 2 });
  await gateway.answer({ callId: 'call-1', idempotencyKey: 'key-1' });
  await gateway.answer({ callId: 'call-2', idempotencyKey: 'key-2' });
  await gateway.answer({ callId: 'call-3', idempotencyKey: 'key-3' });
  assert.equal(gateway.idempotencySize, 2);
});

test('idempotency retention is scoped to one gateway run', async () => {
  const { gateway, device } = runningGateway();
  await gateway.answer({ callId: 'call-session', idempotencyKey: 'session-key' });
  await gateway.stop();
  assert.equal(gateway.idempotencySize, 0);
  gateway.state = 'running';
  await gateway.answer({ callId: 'call-session', idempotencyKey: 'session-key' });
  assert.equal(device.controls.length, 2);
});

test('dial policy denial sends nothing and redacts destination', async () => {
  const { gateway, device } = runningGateway({ policy: { allowNumbers: [] } });
  const result = await gateway.dial({ destination: DESTINATION, consent: RECORDING_CONSENT, idempotencyKey: 'denied-1' });
  assert.equal(result.accepted, false);
  assert.equal(device.controls.length, 0);
  assert.equal(JSON.stringify(result).includes(DESTINATION), false);
  assert.equal(result.destination.last4, '4567');
});

test('approved recorded dial starts recording and realtime for Android generated outgoing call id', async () => {
  const calls = [];
  const recorder = {
    ready: true,
    appendEvent: async () => {},
    finalize: async () => ({ complete: true }),
  };
  const { gateway, device } = runningGateway({
    policy: { dialEnabled: true, requireManualApproval: true, allowNumbers: [DESTINATION] },
    recording: { start: async (metadata) => { calls.push(['recording', metadata]); return recorder; } },
    createRealtimeSession: async ({ callId }) => ({
      callId,
      start: async () => calls.push(['realtime', callId]),
      close: async () => {},
    }),
  });
  const result = await gateway.dial({
    destination: DESTINATION,
    idempotencyKey: 'recorded-dial-1',
    approved: true,
    consent: { recorded: true, policy: 'authorized live-talk test' },
  });
  assert.equal(result.accepted, true, JSON.stringify(result));
  device.emit('event', { payload: Buffer.from(JSON.stringify({
    event: 'dialing', callId: 'android-call-1', direction: 'outgoing',
  })) });
  await gateway.flushRecording();
  assert.equal(gateway.status().recording.active, true);
  assert.equal(gateway.status().realtime.active, true);
  assert.equal(gateway.status().currentCall.callId, 'android-call-1');
  assert.deepEqual(calls.map(([name]) => name), ['recording', 'realtime']);
});

test('approved recorded dial also correlates a direction-confirmed direct active event', async () => {
  let starts = 0;
  const recorder = { ready: true, appendEvent: async () => {}, finalize: async () => ({ complete: true }) };
  const { gateway, device } = runningGateway({
    policy: { dialEnabled: true, requireManualApproval: true, allowNumbers: [DESTINATION] },
    recording: { start: async () => { starts++; return recorder; } },
  });
  await gateway.dial({
    destination: DESTINATION,
    idempotencyKey: 'recorded-dial-direct-active',
    approved: true,
    consent: { recorded: true, policy: 'authorized live-talk test' },
  });
  device.emit('event', { payload: Buffer.from(JSON.stringify({
    event: 'active', callId: 'android-call-direct-active', direction: 'outgoing',
  })) });
  await gateway.flushRecording();
  assert.equal(starts, 1);
  assert.equal(gateway.status().recording.active, true);
});

test('incoming active event cannot consume pending outgoing recording consent', async () => {
  let starts = 0;
  const { gateway, device } = runningGateway({
    policy: { dialEnabled: true, requireManualApproval: true, allowNumbers: [DESTINATION] },
    recording: { start: async () => { starts++; throw new Error('must not start'); } },
  });
  await gateway.dial({
    destination: DESTINATION,
    idempotencyKey: 'recorded-dial-foreign-incoming',
    approved: true,
    consent: { recorded: true, policy: 'authorized live-talk test' },
  });
  device.emit('event', { payload: Buffer.from(JSON.stringify({
    event: 'active', callId: 'foreign-incoming', direction: 'incoming',
  })) });
  await gateway.flushRecording();
  assert.equal(starts, 0);
  assert.equal(gateway.status().recording.active, false);
});

test('recorded outgoing startup failure hangs up the exact Android call fail closed', async () => {
  const { gateway, device } = runningGateway({
    policy: { dialEnabled: true, requireManualApproval: true, allowNumbers: [DESTINATION] },
    recording: { start: async () => { throw new Error('disk unavailable'); } },
  });
  await gateway.dial({
    destination: DESTINATION,
    idempotencyKey: 'recorded-dial-fail',
    approved: true,
    consent: { recorded: true, policy: 'authorized live-talk test' },
  });
  device.emit('event', { payload: Buffer.from(JSON.stringify({
    event: 'dialing', callId: 'android-call-fail', direction: 'outgoing',
  })) });
  await gateway.flushRecording();
  const controls = device.controls.map((frame) => JSON.parse(frame.payload.toString('utf8')));
  assert.ok(controls.some((value) => value.command === 'hangup' && value.callId === 'android-call-fail'));
  assert.equal(gateway.status().recording.active, false);
  assert.equal(gateway.status().realtime.active, false);
});

test('transport loss clears pending outgoing consent before an unrelated later dialing event', async () => {
  let starts = 0;
  const { gateway, device } = runningGateway({
    policy: { dialEnabled: true, requireManualApproval: true, allowNumbers: [DESTINATION] },
    recording: { start: async () => { starts++; throw new Error('must not start'); } },
  });
  await gateway.dial({
    destination: DESTINATION,
    idempotencyKey: 'recorded-dial-disconnected',
    approved: true,
    consent: { recorded: true, policy: 'authorized live-talk test' },
  });
  device.emit('state', 'disconnected');
  device.emit('event', { payload: Buffer.from(JSON.stringify({
    event: 'dialing', callId: 'unrelated-later-call', direction: 'outgoing',
  })) });
  await gateway.flushRecording();
  assert.equal(starts, 0);
  assert.equal(gateway.status().recording.active, false);
});

test('duplicate outgoing dialing events consume one pending approved recording owner', async () => {
  let starts = 0;
  const recorder = { ready: true, appendEvent: async () => {}, finalize: async () => ({ complete: true }) };
  const { gateway, device } = runningGateway({
    policy: { dialEnabled: true, requireManualApproval: true, allowNumbers: [DESTINATION] },
    recording: { start: async () => { starts++; return recorder; } },
  });
  await gateway.dial({
    destination: DESTINATION,
    idempotencyKey: 'recorded-dial-duplicate',
    approved: true,
    consent: { recorded: true, policy: 'authorized live-talk test' },
  });
  const event = { payload: Buffer.from(JSON.stringify({
    event: 'dialing', callId: 'android-call-duplicate', direction: 'outgoing',
  })) };
  device.emit('event', event);
  device.emit('event', event);
  await gateway.flushRecording();
  assert.equal(starts, 1);
  assert.equal(gateway.status().recording.active, true);
});

test('approved outgoing status retains the full destination and resolves its saved contact', async () => {
  const recorder = { ready: true, appendEvent: async () => {}, finalize: async () => ({ complete: true }) };
  const phoneData = {
    findContact: async ({ number }) => {
      assert.equal(number, DESTINATION);
      return { name: 'Ada Lovelace', number };
    },
  };
  const { gateway, device } = runningGateway({
    policy: { dialEnabled: true, requireManualApproval: true, allowNumbers: [DESTINATION] },
    recording: { start: async () => recorder },
    phoneData,
  });
  await gateway.dial({
    destination: DESTINATION,
    idempotencyKey: 'recorded-dial-contact',
    approved: true,
    consent: { recorded: true, policy: 'authorized live-talk test' },
  });
  device.emit('event', { payload: Buffer.from(JSON.stringify({
    event: 'dialing', callId: 'android-call-contact', direction: 'outgoing',
  })) });
  await gateway.flushRecording();

  assert.deepEqual(gateway.status().currentCall, {
    callId: 'android-call-contact',
    phase: 'dialing',
    direction: 'outgoing',
    displayNumber: DESTINATION,
    contactName: 'Ada Lovelace',
  });
});

test('current call status exposes the local contact name and full number for desktop presentation', async () => {
  const incoming = [];
  const phoneData = {
    findContact: async ({ number }) => {
      assert.equal(number, '+15551234567');
      return { name: 'Ada Lovelace', number };
    },
  };
  const { gateway, device } = runningGateway({ phoneData });
  gateway.on('incoming', (event) => incoming.push(event));
  device.emit('event', { payload: Buffer.from(JSON.stringify({
    event: 'incoming', callId: 'call-live', displayNumber: '+15*******67', callerNumber: '+15551234567',
  })) });
  await gateway.flushRecording();
  assert.deepEqual(gateway.status().currentCall, {
    callId: 'call-live', phase: 'ringing', direction: 'incoming',
    displayNumber: '+15551234567', contactName: 'Ada Lovelace', caller: { found: false },
  });
  assert.equal(incoming[0].contactName, 'Ada Lovelace');
  assert.equal('callerNumber' in incoming[0], false);
  device.emit('event', { payload: Buffer.from('{"event":"active","callId":"call-live","direction":"incoming"}') });
  assert.equal(gateway.status().currentCall.phase, 'active');
  device.emit('event', { payload: Buffer.from('{"event":"ended","callId":"call-live"}') });
  assert.equal(gateway.status().currentCall, null);
  assert.equal(JSON.stringify(gateway.status()).includes('+15551234567'), false);
});

test('call error is terminal for status and an active recording', async () => {
  const finalized = [];
  const recorder = {
    ready: true,
    appendEvent: async () => {},
    finalize: async (options) => { finalized.push(options); return { complete: false }; },
  };
  const { gateway, device } = runningGateway({ recording: { start: async () => recorder } });
  await gateway.beginRecording({ callId: 'call-error', consent: { recorded: true } });
  device.emit('event', { payload: Buffer.from('{"event":"active","callId":"call-error"}') });
  assert.equal(gateway.status().currentCall.phase, 'active');

  device.emit('event', { payload: Buffer.from('{"event":"error","callId":"call-error","reason":"provider_unavailable"}') });
  await gateway.flushRecording();

  assert.equal(gateway.status().currentCall, null);
  assert.equal(gateway.status().recording.active, false);
  assert.deepEqual(finalized, [{ outcome: 'error' }]);
});

test('matching Android media failure finalizes incomplete while foreign failures are ignored', async () => {
  const calls = [];
  const recorder = {
    ready: true,
    appendEvent: async (value) => calls.push(['event', value]),
    finalize: async (options) => {
      calls.push(['finalize', options]);
      return { complete: false };
    },
  };
  const realtime = {
    callId: 'call-media',
    close: async () => calls.push(['realtime:close']),
  };
  const { gateway, device } = runningGateway({ recording: { start: async () => recorder } });
  const emitted = [];
  gateway.on('event', (value) => emitted.push(value));
  await gateway.beginRecording({ callId: 'call-media', consent: { recorded: true } });
  await gateway.attachRealtime(realtime);
  device.emit('event', { payload: Buffer.from('{"event":"active","callId":"call-media"}') });

  device.emit('event', { payload: Buffer.from('{"event":"media_failure","callId":"foreign","reason":"audio_bridge_failed"}') });
  device.emit('event', { payload: Buffer.from('{"event":"media_failure","callId":"call-media","reason":"raw device detail","extra":true}') });
  await gateway.flushRecording();
  assert.equal(gateway.status().currentCall.callId, 'call-media');
  assert.equal(gateway.status().recording.active, true);
  assert.equal(gateway.metrics.malformedDeviceMessages, 1);
  assert.deepEqual(emitted, [{ event: 'active', callId: 'call-media' }]);
  assert.deepEqual(calls, [
    ['event', { event: 'active', callId: 'call-media' }],
  ]);

  device.emit('event', { payload: Buffer.from('{"event":"media_failure","callId":"call-media","reason":"audio_bridge_failed"}') });
  await gateway.flushRecording();

  assert.equal(gateway.status().currentCall, null);
  assert.equal(gateway.status().recording.active, false);
  assert.equal(gateway.status().realtime.active, false);
  assert.deepEqual(calls, [
    ['event', { event: 'active', callId: 'call-media' }],
    ['event', { event: 'media_failure', callId: 'call-media', reason: 'audio_bridge_failed' }],
    ['realtime:close'],
    ['finalize', { outcome: 'media_failure' }],
  ]);
});

test('status, metrics, and capabilities snapshots exclude PCM', () => {
  const { gateway } = runningGateway();
  assert.equal(gateway.status().state, 'running');
  assert.equal(typeof gateway.status().metrics.commandsSent, 'number');
  assert.deepEqual(gateway.capabilities().tools, [
    'status', 'capabilities', 'wait_for_incoming_call', 'wait_for_turn',
    'dial', 'prepare_speech', 'answer', 'reject', 'hangup', 'send_dtmf', 'speak',
  ]);
  assert.equal(/pcm|base64|payload/i.test(JSON.stringify(gateway.capabilities())), false);
});

test('incoming event resolves caller memory and strips raw number before broadcast or persistence', async () => {
  const { gateway, device } = runningGateway();
  const incoming = [];
  const persisted = [];
  gateway.callerMemory = {
    resolve: async ({ phoneNumber }) => {
      assert.equal(phoneNumber, '+15551234567');
      return { found: true, callerId: 'caller-hmac', context: { summary: 'Returning caller' } };
    },
  };
  gateway.activeRecorder = { appendEvent: async (value) => persisted.push(value) };
  gateway.activeRecordingCallId = 'call-memory';
  gateway.on('incoming', (value) => incoming.push(value));
  device.emit('event', { payload: Buffer.from(JSON.stringify({
    event: 'incoming', callId: 'call-memory', displayNumber: '+15*******67', callerNumber: '+15551234567',
  })) });
  await gateway.flushRecording();
  assert.deepEqual(incoming, [{
    event: 'incoming', callId: 'call-memory', displayNumber: '+15*******67',
    caller: { found: true, callerId: 'caller-hmac', context: { summary: 'Returning caller' } },
    agentAnswering: { enabled: false, instructions: '' },
  }]);
  assert.equal(JSON.stringify(incoming).includes('+15551234567'), false);
  assert.equal(JSON.stringify(persisted).includes('+15551234567'), false);
});

test('finalized incoming transcripts append to consented caller history without broadcasting raw identity', async () => {
  const appended = [];
  const recorder = {
    ready: true,
    appendTranscript: async () => {},
    appendEvent: async () => {},
    finalize: async () => ({ complete: true }),
  };
  const callerMemory = {
    resolve: async () => ({
      found: true, callerId: 'a'.repeat(64),
      consent: { memory: true, expiresAt: '2026-08-23T08:00:00.000Z' },
      context: { summary: 'Returning caller', history: [] },
    }),
    appendCall: async (value) => { appended.push(value); return { appended: true }; },
  };
  const { gateway, device } = runningGateway({ recording: { start: async () => recorder }, callerMemory });
  device.emit('event', { payload: Buffer.from(JSON.stringify({
    event: 'incoming', callId: 'call-memory-history', direction: 'incoming',
    callerNumber: '+15551234567', displayNumber: '+15*******67',
  })) });
  await gateway.flushRecording();
  await gateway.beginRecording({ callId: 'call-memory-history', consent: { recorded: true } });
  await gateway.appendTranscript({
    callId: 'call-memory-history', speaker: 'remote', text: 'Please remember Tuesday.', final: true, complete: true,
  });
  await gateway.appendTranscript({
    callId: 'call-memory-history', speaker: 'agent', text: 'I will follow up.', final: true, complete: true,
  });
  device.emit('event', { payload: Buffer.from(JSON.stringify({ event: 'ended', callId: 'call-memory-history' })) });
  await gateway.flushRecording();
  await gateway.callerMemoryWork;

  assert.equal(appended.length, 1);
  assert.equal(appended[0].phoneNumber, '+15551234567');
  assert.equal(appended[0].call.callId, 'call-memory-history');
  assert.equal(appended[0].call.transcript, 'remote: Please remember Tuesday.\nagent: I will follow up.');
  assert.equal(appended[0].call.recordingId, 'call-memory-history');
});

test('device control/event become gateway incoming/events while PCM is not forwarded', () => {
  const { gateway, device } = runningGateway();
  const incoming = [];
  const events = [];
  const pcm = [];
  gateway.on('incoming', (value) => incoming.push(value));
  gateway.on('event', (value) => events.push(value));
  gateway.on('pcm', (value) => pcm.push(value));

  device.emit('control', { payload: Buffer.from('{"event":"incoming","callId":"call-1"}') });
  device.emit('event', { payload: Buffer.from('{"event":"ended","callId":"call-1"}') });
  device.emit('pcm', { payload: Buffer.alloc(640) });
  assert.deepEqual(incoming, [{ event: 'incoming', callId: 'call-1' }]);
  assert.deepEqual(events, [{ event: 'ended', callId: 'call-1' }]);
  assert.deepEqual(pcm, []);
});
