import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DeviceClient, DIR_HOST_TO_DEVICE, PCM_FRAME_BYTES } from '../src/device-client.js';
import { PhoneSimulator } from '../src/phone-simulator.js';

async function waitFor(check, message) {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(`timeout: ${message}`);
}

function json(frame) { return JSON.parse(frame.payload.toString('utf8')); }

const CONTROLLER_SECRET = Buffer.alloc(32, 0x5a);

test('phone simulator announces explicit identity and exercises canonical full-duplex frames', async (t) => {
  const simulator = new PhoneSimulator({ enrollmentSecret: CONTROLLER_SECRET });
  const endpoint = await simulator.start();
  t.after(() => simulator.stop());
  assert.deepEqual(endpoint, { identity: 'SIMULATOR', host: '127.0.0.1', port: simulator.port, simulator: true });

  const client = new DeviceClient({ enrollmentSecret: CONTROLLER_SECRET });
  t.after(() => client.disconnect());
  const controls = [];
  const events = [];
  const remote = [];
  client.on('control', (frame) => controls.push(json(frame)));
  client.on('event', (frame) => events.push(json(frame)));
  client.on('pcm', (frame) => remote.push(frame.payload));
  await client.connect({ host: '127.0.0.1', port: simulator.port });
  await waitFor(() => controls.length === 1, 'simulator identity');
  assert.deepEqual(controls[0], { event: 'identity', identity: 'SIMULATOR', simulator: true });

  await client.sendControl({
    payload: Buffer.from(JSON.stringify({ command: 'dial', callId: 'call-1' })),
  });
  await client.sendPcm({ direction: DIR_HOST_TO_DEVICE, payload: Buffer.alloc(PCM_FRAME_BYTES, 0x12) });
  simulator.sendRemotePcm(Buffer.alloc(PCM_FRAME_BYTES, 0x34));
  await waitFor(() => events.length === 1 && simulator.metrics.receivedPcm === 1 && remote.length === 1, 'full duplex');
  assert.deepEqual(events[0], { event: 'active', callId: 'call-1', direction: 'outgoing', simulator: true });
  assert.equal(remote[0][0], 0x34);
});

test('phone simulator requires enrollment and never promotes a wrong-secret client', async (t) => {
  assert.throws(() => new PhoneSimulator(), /enrollment secret.*32 bytes/i);
  const simulator = new PhoneSimulator({ enrollmentSecret: CONTROLLER_SECRET, authTimeoutMs: 100 });
  await simulator.start();
  t.after(() => simulator.stop());
  const client = new DeviceClient({ enrollmentSecret: Buffer.alloc(32, 0x33), authTimeoutMs: 500 });
  t.after(() => client.disconnect());
  await assert.rejects(
    () => client.connect({ host: '127.0.0.1', port: simulator.port }),
    /authentication|proof|closed/i,
  );
  assert.equal(simulator.sockets.size, 0);
  assert.equal(simulator.metrics.connections, 0);
});

test('phone simulator grants exactly one pending or authenticated controller lease', async (t) => {
  const simulator = new PhoneSimulator({ enrollmentSecret: CONTROLLER_SECRET });
  await simulator.start();
  t.after(() => simulator.stop());
  const first = new DeviceClient({ enrollmentSecret: CONTROLLER_SECRET });
  const second = new DeviceClient({ enrollmentSecret: CONTROLLER_SECRET, authTimeoutMs: 500 });
  t.after(() => first.disconnect());
  t.after(() => second.disconnect());

  await first.connect({ host: '127.0.0.1', port: simulator.port });
  await assert.rejects(
    () => second.connect({ host: '127.0.0.1', port: simulator.port }),
    /authentication|closed|reset/i,
  );
  assert.equal(simulator.sockets.size, 1);
  assert.equal(simulator.metrics.connections, 1);
});

test('phone simulator emits an explicit terminal error transition', async (t) => {
  const simulator = new PhoneSimulator({ enrollmentSecret: CONTROLLER_SECRET });
  await simulator.start();
  t.after(() => simulator.stop());
  const client = new DeviceClient({ enrollmentSecret: CONTROLLER_SECRET });
  t.after(() => client.disconnect());
  const events = [];
  client.on('event', (frame) => events.push(json(frame)));
  await client.connect({ host: '127.0.0.1', port: simulator.port });

  simulator.incoming('failed-call');
  await waitFor(() => events.some((event) => event.event === 'ringing'), 'ringing event');
  simulator.errorCall('failed-call', 'provider_unavailable');
  await waitFor(() => events.some((event) => event.event === 'error'), 'error event');

  assert.deepEqual(events.at(-1), {
    event: 'error', callId: 'failed-call', reason: 'provider_unavailable', simulator: true,
  });
  assert.equal(simulator.calls.has('failed-call'), false, 'error is terminal');
});

test('100 simulated calls and socket-loss reconnect leave bounded state', async (t) => {
  const simulator = new PhoneSimulator({ enrollmentSecret: CONTROLLER_SECRET });
  await simulator.start();
  t.after(() => simulator.stop());
  const client = new DeviceClient({ enrollmentSecret: CONTROLLER_SECRET });
  t.after(() => client.disconnect());
  let ended = 0;
  client.on('event', (frame) => { if (json(frame).event === 'ended') ended++; });
  await client.connect({ host: '127.0.0.1', port: simulator.port });
  const firstSessionId = client.sessionId;
  for (let i = 0; i < 100; i++) {
    const callId = `soak-${i}`;
    simulator.incoming(callId);
    await client.sendControl({ payload: Buffer.from(JSON.stringify({ command: 'answer', callId })) });
    simulator.sendRemotePcm(Buffer.alloc(PCM_FRAME_BYTES, i));
    await client.sendPcm({ payload: Buffer.alloc(PCM_FRAME_BYTES, 255 - i) });
    await client.sendControl({ payload: Buffer.from(JSON.stringify({ command: 'hangup', callId })) });
  }
  await waitFor(() => ended === 100, '100 ended calls');
  assert.equal(simulator.calls.size, 0);
  assert.equal(simulator.metrics.calls, 0, 'incoming calls do not masquerade as dialed hardware calls');
  assert.equal(simulator.metrics.receivedPcm, 100);
  assert.equal(client.metrics.receivedPcm, 100);

  simulator.incoming('interrupted-call');
  await client.sendControl({
    payload: Buffer.from(JSON.stringify({ command: 'answer', callId: 'interrupted-call' })),
  });
  await waitFor(() => simulator.calls.get('interrupted-call') === 'active', 'interrupted call active');
  simulator.dropConnections();
  await waitFor(() => client.state === 'disconnected', 'disconnect');
  assert.equal(simulator.sockets.size, 0);
  assert.equal(simulator.calls.size, 0, 'connection loss must fail closed instead of retaining an active call');
  await client.connect({ host: '127.0.0.1', port: simulator.port });
  assert.equal(client.state, 'connected');
  assert.notEqual(client.sessionId, firstSessionId, 'reconnect derives a fresh authenticated session');
  assert.ok(simulator.metrics.connections >= 2);
});
