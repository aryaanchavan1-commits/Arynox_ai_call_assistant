import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { Gateway } from '../src/gateway.js';
import { GatewayRpcServer, GatewayRpcClient } from '../src/gateway-rpc.js';

const testSocketPath = (name) => process.platform === 'win32'
  ? `\\\\.\\pipe\\agentcall-${name}-${randomUUID()}`
  : join(tmpdir(), `agentcall-${name}-${randomUUID()}.sock`);

class EvidenceDevice extends EventEmitter {
  constructor(onSend = null) {
    super();
    this.onSend = onSend;
    this.sent = [];
    this.state = 'connected';
  }

  async sendControl(value) {
    const payload = JSON.parse(value.payload.toString('utf8'));
    this.sent.push(payload);
    return this.onSend?.(payload);
  }

  async disconnect() {
    this.state = 'disconnected';
  }
}

const args = {
  observedSystemFingerprint: 'system-fingerprint',
  observedVendorFingerprint: 'vendor-fingerprint',
  attestedOn: '2026-07-21',
  attestedSystemDescription: 'Android 15 API 35 custom Lineage userdebug system',
  idempotencyKey: 'provision-1',
};

test('owner-only RPC forwards bounded evidence through the authenticated device client', async (t) => {
  let gateway;
  const device = new EvidenceDevice((payload) => setImmediate(() => gateway._handleDeviceEventValue({
    event: 'command_result', idempotencyKey: payload.idempotencyKey,
    command: payload.command, accepted: true,
  })));
  gateway = new Gateway({ device, controllerSecret: Buffer.alloc(32, 1) });
  gateway.state = 'running';
  const socketPath = testSocketPath('evidence');
  const server = new GatewayRpcServer(gateway, { socketPath });
  await server.start();
  t.after(() => server.stop());
  const client = new GatewayRpcClient({ socketPath });
  assert.deepEqual(await client.provisionDeviceEvidence(args), { accepted: true });
  assert.deepEqual(device.sent, [{ command: 'provision_device_evidence', ...args }]);
  await assert.rejects(
    () => client.provisionDeviceEvidence({ ...args, source: 'externally_provisioned' }),
    /arguments not allowed/,
  );
});

test('provisioning resolves only after matching authoritative Android acceptance', async () => {
  const device = new EvidenceDevice();
  const gateway = new Gateway({ device, commandResultTimeoutMs: 100 });
  gateway.state = 'running';
  let settled = false;
  const result = gateway.provisionDeviceEvidence(args).finally(() => { settled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  gateway._handleDeviceEventValue({
    event: 'command_result', idempotencyKey: 'other-key',
    command: 'provision_device_evidence', accepted: true,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  gateway._handleDeviceEventValue({
    event: 'command_result', idempotencyKey: args.idempotencyKey,
    command: 'provision_device_evidence', accepted: true,
  });
  assert.deepEqual(await result, { accepted: true });
});

test('malformed command results cannot settle authoritative provisioning', async () => {
  const device = new EvidenceDevice();
  const gateway = new Gateway({ device, commandResultTimeoutMs: 100 });
  gateway.state = 'running';
  let settled = false;
  const result = gateway.provisionDeviceEvidence(args).finally(() => { settled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  for (const malformed of [
    { event: 'command_result', idempotencyKey: args.idempotencyKey, command: 'provision_device_evidence', accepted: true, extra: true },
    { event: 'command_result', idempotencyKey: args.idempotencyKey, command: 'provision_device_evidence', accepted: false },
    { event: 'command_result', idempotencyKey: args.idempotencyKey, command: 'provision_device_evidence', accepted: false, reason: 'x'.repeat(161) },
  ]) {
    gateway._handleDeviceEventValue(malformed);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false, `malformed result settled: ${JSON.stringify(malformed)}`);
  }
  gateway._handleDeviceEventValue({
    event: 'command_result', idempotencyKey: args.idempotencyKey,
    command: 'provision_device_evidence', accepted: true,
  });
  assert.deepEqual(await result, { accepted: true });
});

test('Android rejection is propagated instead of reported as accepted', async () => {
  let gateway;
  const device = new EvidenceDevice((payload) => setImmediate(() => gateway._handleDeviceEventValue({
    event: 'command_result', idempotencyKey: payload.idempotencyKey,
    command: payload.command, accepted: false, reason: 'strict read-back failed',
  })));
  gateway = new Gateway({ device, commandResultTimeoutMs: 100 });
  gateway.state = 'running';
  await assert.rejects(() => gateway.provisionDeviceEvidence(args), /strict read-back failed/);
});

test('disconnect after write rejects pending provisioning', async () => {
  const device = new EvidenceDevice();
  const gateway = new Gateway({ device, commandResultTimeoutMs: 100 });
  gateway.state = 'running';
  const result = gateway.provisionDeviceEvidence(args);
  await new Promise((resolve) => setImmediate(resolve));
  device.state = 'disconnected';
  device.emit('state', 'disconnected');
  await assert.rejects(() => result, /disconnected before command result/);
});

test('missing Android acknowledgement times out and clears pending state', async () => {
  const device = new EvidenceDevice();
  const gateway = new Gateway({ device, commandResultTimeoutMs: 10 });
  gateway.state = 'running';
  await assert.rejects(() => gateway.provisionDeviceEvidence(args), /timed out/);
  assert.equal(gateway.pendingCommandResults.size, 0);
});

test('transport send failure rejects once, clears pending state, and permits same-key retry', async () => {
  let gateway;
  let attempts = 0;
  const device = new EvidenceDevice((payload) => {
    attempts++;
    if (attempts === 1) throw new Error('transport write failed');
    setImmediate(() => gateway._handleDeviceEventValue({
      event: 'command_result', idempotencyKey: payload.idempotencyKey,
      command: payload.command, accepted: true,
    }));
  });
  gateway = new Gateway({ device, commandResultTimeoutMs: 100 });
  gateway.state = 'running';

  await assert.rejects(() => gateway.provisionDeviceEvidence(args), /transport write failed/);
  assert.equal(gateway.pendingCommandResults.size, 0);
  assert.deepEqual(await gateway.provisionDeviceEvidence(args), { accepted: true });
  assert.equal(attempts, 2);
});

async function assertLifecycleDuringInFlightSend(action, expectedError, lateSendError = null) {
  let releaseSend;
  let rejectSend;
  const device = new EvidenceDevice(() => new Promise((resolve, reject) => {
    releaseSend = resolve;
    rejectSend = reject;
  }));
  const gateway = new Gateway({ device, commandResultTimeoutMs: 1_000 });
  gateway.state = 'running';
  const unhandled = [];
  const onUnhandled = (error) => unhandled.push(error);
  process.on('unhandledRejection', onUnhandled);
  try {
    let settled = false;
    const result = gateway.provisionDeviceEvidence(args).then(
      (value) => { settled = true; return { value }; },
      (error) => { settled = true; return { error }; },
    );
    await new Promise((resolve) => setImmediate(resolve));
    await action({ device, gateway });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(settled, true, 'outer provisioning promise remained unsettled');
    const observed = await result;
    assert.match(observed.error?.message ?? '', expectedError);
    assert.equal(gateway.pendingCommandResults.size, 0);
    assert.deepEqual(unhandled, []);
    if (lateSendError) rejectSend?.(lateSendError);
    else releaseSend?.();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', onUnhandled);
    releaseSend?.();
  }
}

test('disconnect during an in-flight transport write rejects outer provisioning without unhandled rejection', async () => {
  await assertLifecycleDuringInFlightSend(async ({ device }) => {
    device.state = 'disconnected';
    device.emit('state', 'disconnected');
  }, /disconnected before command result/);
});

test('stop during an in-flight transport write rejects outer provisioning without unhandled rejection', async () => {
  await assertLifecycleDuringInFlightSend(async ({ gateway }) => {
    await gateway.stop();
  }, /gateway stopped before command result/);
});

test('late transport rejection after disconnect remains observed', async () => {
  await assertLifecycleDuringInFlightSend(async ({ device }) => {
    device.state = 'disconnected';
    device.emit('state', 'disconnected');
  }, /disconnected before command result/, new Error('late transport rejection'));
});
