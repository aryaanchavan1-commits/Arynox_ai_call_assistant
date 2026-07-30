import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { EventEmitter, once } from 'node:events';
import net from 'node:net';
import { randomUUID } from 'node:crypto';

import { GatewayRpcClient, GatewayRpcServer } from '../src/gateway-rpc.js';

function fakeGateway() {
  const gateway = new EventEmitter();
  gateway.calls = [];
  gateway.status = () => ({ state: 'running' });
  gateway.capabilities = () => ({ tools: ['status'] });
  gateway.dial = async (args) => (gateway.calls.push(['dial', args]), { accepted: true });
  gateway.answer = async (args) => (gateway.calls.push(['answer', args]), { accepted: true });
  gateway.reject = async (args) => (gateway.calls.push(['reject', args]), { accepted: true });
  gateway.hangup = async (args) => (gateway.calls.push(['hangup', args]), { accepted: true });
  gateway.sendDtmf = async (args) => (gateway.calls.push(['sendDtmf', args]), { accepted: true });
  gateway.speak = async (args) => (gateway.calls.push(['speak', args]), { accepted: true });
  gateway.manualAudioAvailable = ({ callId }) => callId === 'call-audio-1';
  gateway.sendManualPcm = async ({ callId, payload }) => {
    gateway.calls.push(['sendManualPcm', { callId, payload: Buffer.from(payload) }]);
    return { accepted: true, callId };
  };
  gateway.listRecordings = async (args) => (gateway.calls.push(['listRecordings', args]), [{ callId: 'call-recorded' }]);
  gateway.listContacts = async (args) => (gateway.calls.push(['listContacts', args]), {
    rows: [{ id: '1', name: 'Ada', number: '+10000000000' }], sync: { state: 'ready', count: 1 },
  });
  gateway.listCallLog = async (args) => (gateway.calls.push(['listCallLog', args]), {
    rows: [], sync: { state: 'ready', count: 0 },
  });
  gateway.phoneDataStatus = async () => ({
    contacts: { state: 'ready', count: 1 }, callLog: { state: 'ready', count: 0 },
  });
  gateway.recordingArtifact = async (args) => (gateway.calls.push(['recordingArtifact', args]), '/private/call-recorded/conversation.mkv');
  gateway.exportRecordingArtifact = async (args) => (
    gateway.calls.push(['exportRecordingArtifact', args]),
    '/run/agentcall/recording-exports/call-recorded/conversation.mkv'
  );
  gateway.syncRecording = async (args) => (gateway.calls.push(['syncRecording', args]), { state: 'stored', callId: args.callId, bytes: 42 });
  gateway.deleteRecording = async (args) => (gateway.calls.push(['deleteRecording', args]), { deleted: true, callId: args.callId });
  gateway.providerStatus = async () => ({
    state: 'unconfigured', configured: false, enabled: false, restartRequired: false,
    stt: { configured: false, active: false },
    tts: { configured: false, active: false },
  });
  gateway.providerHealth = async (args) => {
    gateway.calls.push(['providerHealth', args]);
    return { kind: args.kind, provider: 'openai', healthy: true, scope: 'credential' };
  };
  gateway.testProviders = async () => {
    gateway.calls.push(['testProviders', {}]);
    return {
      healthy: true, phrase: 'AgentCall speech test.', transcript: 'AgentCall speech test.',
      sttProvider: 'openai', ttsProvider: 'supertonic', sampleRate: 16_000, samples: 640,
      playbackPath: '/run/agentcall/provider-test.wav',
    };
  };
  gateway.configureProvider = async (args) => {
    gateway.calls.push(['configureProvider', args]);
    return {
      accepted: true,
      kind: args.kind,
      provider: args.provider,
      configured: true,
      restartRequired: true,
    };
  };
  gateway.prewarmSpeech = async (args) => {
    gateway.calls.push(['prewarmSpeech', args]);
    return { ready: true };
  };
  gateway.agentAnsweringStatus = async () => ({ enabled: false, instructions: '' });
  gateway.configureAgentAnswering = async (args) => {
    gateway.calls.push(['configureAgentAnswering', args]);
    return { enabled: args.enabled, instructions: args.instructions.trim() };
  };
  return gateway;
}

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'agentcall-rpc-'));
  const socketPath = process.platform === 'win32'
    ? `\\\\.\\pipe\\agentcall-rpc-test-${process.pid}-${randomUUID()}`
    : join(dir, 'gatewayd.sock');
  const gateway = fakeGateway();
  const server = new GatewayRpcServer(gateway, { socketPath });
  await server.start();
  t.after(async () => { await server.stop(); await rm(dir, { recursive: true, force: true }); });
  return { gateway, socketPath, client: new GatewayRpcClient({ socketPath }) };
}

test('Unix socket is owner/group-only and client exposes semantic gateway surface', async (t) => {
  const { client, socketPath } = await fixture(t);
  if (process.platform !== 'win32') assert.equal((await stat(socketPath)).mode & 0o777, 0o660);
  assert.deepEqual(await client.status(), { state: 'running' });
  assert.deepEqual(await client.capabilities(), { tools: ['status'] });
});

test('RPC forwards fixed call methods and exact one-object arguments', async (t) => {
  const { client, gateway } = await fixture(t);
  await client.dial({
    destination: '+155****0100', idempotencyKey: 'k', approved: true,
    consent: { recorded: true, policy: 'test fixture explicit consent' },
  });
  await client.sendDtmf({ callId: 'call-1', digits: '12#', idempotencyKey: 'd' });
  await client.speak({ callId: 'call-1', text: 'Hello', idempotencyKey: 's' });
  await client.speak({
    callId: 'call-1', text: 'Protected opening', interruptible: false, idempotencyKey: 'opening',
  });
  assert.deepEqual(gateway.calls, [
    ['dial', {
      destination: '+155****0100', idempotencyKey: 'k', approved: true,
      consent: { recorded: true, policy: 'test fixture explicit consent' },
    }],
    ['sendDtmf', { callId: 'call-1', digits: '12#', idempotencyKey: 'd' }],
    ['speak', { callId: 'call-1', text: 'Hello', idempotencyKey: 's' }],
    ['speak', {
      callId: 'call-1', text: 'Protected opening', interruptible: false, idempotencyKey: 'opening',
    }],
  ]);
  await assert.rejects(
    client.call('speak', {
      callId: 'call-1', text: 'Invalid mode', interruptible: 'no', idempotencyKey: 'invalid',
    }),
    /interruption mode/i,
  );
});

test('RPC exposes bounded desktop recording operations without arbitrary paths or arguments', async (t) => {
  const { client, gateway } = await fixture(t);
  assert.deepEqual(await client.listRecordings({ limit: 25 }), [{ callId: 'call-recorded' }]);
  assert.equal(
    await client.recordingArtifact({ callId: 'call-recorded', artifact: 'conversation.mkv' }),
    '/private/call-recorded/conversation.mkv',
  );
  assert.equal(
    await client.exportRecordingArtifact({ callId: 'call-recorded', artifact: 'conversation.mkv' }),
    '/run/agentcall/recording-exports/call-recorded/conversation.mkv',
  );
  assert.deepEqual(await client.syncRecording({ callId: 'call-recorded' }), {
    state: 'stored', callId: 'call-recorded', bytes: 42,
  });
  assert.deepEqual(await client.deleteRecording({
    callId: 'call-recorded', consent: { recorded: true }, operatorRole: 'operator', reason: 'user requested deletion',
  }), { deleted: true, callId: 'call-recorded' });
  assert.deepEqual(gateway.calls, [
    ['listRecordings', { limit: 25 }],
    ['recordingArtifact', { callId: 'call-recorded', artifact: 'conversation.mkv' }],
    ['exportRecordingArtifact', { callId: 'call-recorded', artifact: 'conversation.mkv' }],
    ['syncRecording', { callId: 'call-recorded' }],
    ['deleteRecording', {
      callId: 'call-recorded', consent: { recorded: true }, operatorRole: 'operator', reason: 'user requested deletion',
    }],
  ]);
  await assert.rejects(client.call('recordingArtifact', { callId: 'call-recorded', artifact: '../../etc/passwd' }), /arguments not allowed|artifact/i);
  await assert.rejects(client.call('exportRecordingArtifact', { callId: 'call-recorded', artifact: '../../etc/passwd' }), /arguments not allowed|artifact/i);
});

test('RPC exposes bounded private phone-data mirrors with exact arguments', async (t) => {
  const { client, gateway } = await fixture(t);
  assert.deepEqual(await client.listContacts({ limit: 20 }), {
    rows: [{ id: '1', name: 'Ada', number: '+10000000000' }], sync: { state: 'ready', count: 1 },
  });
  assert.deepEqual(await client.listCallLog({ limit: 50 }), {
    rows: [], sync: { state: 'ready', count: 0 },
  });
  assert.deepEqual(await client.phoneDataStatus(), {
    contacts: { state: 'ready', count: 1 }, callLog: { state: 'ready', count: 0 },
  });
  assert.deepEqual(gateway.calls, [
    ['listContacts', { limit: 20 }],
    ['listCallLog', { limit: 50 }],
  ]);
  await assert.rejects(client.listContacts({ limit: 501 }), /contact limit/i);
  await assert.rejects(client.listCallLog({ limit: 201 }), /call-log limit/i);
  await assert.rejects(client.call('phoneDataStatus', { extra: true }), /arguments/i);
});

test('RPC exposes redacted provider status, health, and write-only configuration', async (t) => {
  const { client, gateway } = await fixture(t);
  const secret = 'test-only-provider-key';
  const credentialField = 'api' + 'Key';
  const request = {
    kind: 'stt', provider: 'openai', model: 'gpt-4o-transcribe', language: 'en',
    [credentialField]: secret,
  };

  assert.deepEqual(await client.providerStatus(), {
    state: 'unconfigured', configured: false, enabled: false, restartRequired: false,
    stt: { configured: false, active: false },
    tts: { configured: false, active: false },
  });
  const receipt = await client.configureProvider(request);
  assert.deepEqual(receipt, {
    accepted: true, kind: 'stt', provider: 'openai', configured: true, restartRequired: true,
  });
  assert.equal(JSON.stringify(receipt).includes(secret), false);
  assert.deepEqual(await client.providerHealth({ kind: 'stt' }), {
    kind: 'stt', provider: 'openai', healthy: true, scope: 'credential',
  });
  assert.deepEqual(await client.testProviders(), {
    healthy: true, phrase: 'AgentCall speech test.', transcript: 'AgentCall speech test.',
    sttProvider: 'openai', ttsProvider: 'supertonic', sampleRate: 16_000, samples: 640,
    playbackPath: '/run/agentcall/provider-test.wav',
  });
  assert.deepEqual(await client.prewarmSpeech({ text: 'Good morning.' }), { ready: true });
  assert.deepEqual(gateway.calls, [
    ['configureProvider', request],
    ['providerHealth', { kind: 'stt' }],
    ['testProviders', {}],
    ['prewarmSpeech', { text: 'Good morning.' }],
  ]);
  await assert.rejects(client.call('testProviders', { injected: true }), /arguments/i);
  await assert.rejects(client.prewarmSpeech({ text: '' }), /prewarm|arguments/i);
  await assert.rejects(client.prewarmSpeech({ text: 'hello', injected: true }), /arguments/i);
  await assert.rejects(client.providerHealth({ kind: 'stt', injected: true }), /arguments/i);
  await assert.rejects(client.providerHealth({ kind: 'other' }), /kind|arguments/i);
  await assert.rejects(
    client.configureProvider({ ...request, model: 'other' }),
    /model|arguments/i,
  );
});

test('RPC allowlist accepts supported OpenAI TTS models only', async (t) => {
  const { client, gateway } = await fixture(t);
  const request = { kind: 'tts', provider: 'openai', model: 'gpt-4o-mini-tts-2025-12-15', language: 'en', voice: 'alloy', apiKey: 'rpc-test-key' };
  const receipt = await client.configureProvider(request);
  assert.equal(JSON.stringify(receipt).includes(request.apiKey), false);
  const current = { ...request, model: 'gpt-4o-mini-tts' };
  await client.configureProvider(current);
  assert.deepEqual(gateway.calls, [['configureProvider', request], ['configureProvider', current]]);
  await assert.rejects(client.configureProvider({ ...request, model: 'unknown-model' }), /arguments/i);
});

test('speech RPCs can finish beyond the short control timeout', async (t) => {
  const { client, gateway } = await fixture(t);
  client.timeoutMs = 15;
  gateway.speak = async (args) => {
    await new Promise((resolve) => setTimeout(resolve, 35));
    gateway.calls.push(['speak', args]);
    return { accepted: true };
  };
  gateway.prewarmSpeech = async (args) => {
    await new Promise((resolve) => setTimeout(resolve, 35));
    gateway.calls.push(['prewarmSpeech', args]);
    return { ready: true };
  };

  assert.deepEqual(await client.speak({
    callId: 'call-slow-speech', text: 'A complete sentence.', idempotencyKey: 'slow-speech',
  }), { accepted: true });
  assert.deepEqual(await client.prewarmSpeech({ text: 'A prepared complete sentence.' }), { ready: true });
  await assert.rejects(client.call('status', {}, { timeoutMs: 0 }), /timeout is invalid/i);
});

test('RPC persists only bounded AI incoming-call context and mode', async (t) => {
  const { client, gateway } = await fixture(t);
  assert.deepEqual(await client.agentAnsweringStatus(), {
    enabled: false,
    instructions: '',
  });
  assert.deepEqual(await client.configureAgentAnswering({
    enabled: true,
    instructions: 'I am in a meeting. Ask for the reason and promise a callback.',
  }), {
    enabled: true,
    instructions: 'I am in a meeting. Ask for the reason and promise a callback.',
  });
  assert.deepEqual(gateway.calls, [[
    'configureAgentAnswering',
    {
      enabled: true,
      instructions: 'I am in a meeting. Ask for the reason and promise a callback.',
    },
  ]]);
  await assert.rejects(client.configureAgentAnswering({
    enabled: true,
    instructions: 'x'.repeat(2_001),
  }), /arguments/i);
  await assert.rejects(client.configureAgentAnswering({
    enabled: true,
    instructions: 'hello',
    extra: true,
  }), /arguments/i);
});

test('persistent event stream forwards only bounded redacted semantic events', async (t) => {
  const { client, gateway } = await fixture(t);
  t.after(() => client.stopEvents());
  await client.startEvents();
  const received = once(client, 'event');
  gateway.emit('event', {
    callId: 'call-1',
    state: 'ringing',
    phone: '+15551234567',
    pcm: Buffer.alloc(640),
    payload: 'raw-device-payload',
    token: 'secret-token',
  });
  const [value] = await received;
  assert.deepEqual(value, { callId: 'call-1', state: 'ringing' });
});

test('dedicated correlated audio stream carries PCM without exposing it to semantic events', async (t) => {
  const { socketPath, gateway } = await fixture(t);
  const socket = net.createConnection(socketPath);
  t.after(() => socket.destroy());
  socket.setEncoding('utf8');
  const lines = [];
  const waiters = [];
  let pending = '';
  socket.on('data', (chunk) => {
    pending += chunk;
    for (;;) {
      const newline = pending.indexOf('\n');
      if (newline < 0) break;
      const value = JSON.parse(pending.slice(0, newline));
      pending = pending.slice(newline + 1);
      const waiter = waiters.shift();
      if (waiter) waiter(value); else lines.push(value);
    }
  });
  gateway.providerCatalog = async (args) => ({
    kind: args.kind, provider: args.provider, models: ['gpt-4o-transcribe'], languages: ['en'],
    voices: [], voiceState: 'not-applicable',
  });
  const nextLine = () => lines.length > 0 ? Promise.resolve(lines.shift()) : new Promise((resolve) => waiters.push(resolve));
  await once(socket, 'connect');
  socket.write(`${JSON.stringify({ id: 41, method: 'audio', args: { callId: 'call-audio-1' } })}\n`);
  assert.deepEqual(await nextLine(), { id: 41, result: { connected: true, callId: 'call-audio-1' } });

  const remote = Buffer.alloc(640, 0x31);
  gateway.emit('monitorPcm', { callId: 'call-audio-1', payload: remote });
  const downlink = await nextLine();
  assert.equal(downlink.audio.callId, 'call-audio-1');
  assert.deepEqual(Buffer.from(downlink.audio.pcm, 'base64'), remote);

  const uplink = Buffer.alloc(640, 0x42);
  socket.write(`${JSON.stringify({ audio: { callId: 'call-audio-1', pcm: uplink.toString('base64') } })}\n`);
  for (let attempt = 0; attempt < 20 && !gateway.calls.some(([name]) => name === 'sendManualPcm'); attempt++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  const sent = gateway.calls.find(([name]) => name === 'sendManualPcm');
  assert.equal(sent[1].callId, 'call-audio-1');
  assert.deepEqual(sent[1].payload, uplink);
});

test('RPC rejects unknown methods instead of indexing gateway dynamically', async (t) => {
  const { client } = await fixture(t);
  await assert.rejects(client.call('constructor', {}), /method not allowed/);
});

test('RPC rejects binary-shaped and oversized request data', async (t) => {
  const { client } = await fixture(t);
  await assert.rejects(client.call('dial', { pcm: 'AAAA' }), /arguments not allowed|invalid arguments/);
  await assert.rejects(client.call('dial', { destination: 'x'.repeat(70_000) }), /request too large/);
});

async function rawServerFixture(t, respond) {
  const dir = await mkdtemp(join(tmpdir(), 'agentcall-raw-rpc-'));
  const socketPath = process.platform === 'win32'
    ? `\\\\.\\pipe\\agentcall-raw-rpc-test-${process.pid}-${randomUUID()}`
    : join(dir, 'gatewayd.sock');
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    respond(socket);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });
  return socketPath;
}

test('RPC call rejects a silent peer at its bounded timeout and tears down the socket', async (t) => {
  let peerClosed;
  const socketPath = await rawServerFixture(t, (socket) => {
    socket.resume();
    peerClosed = once(socket, 'close');
  });
  const client = new GatewayRpcClient({ socketPath, timeoutMs: 30 });
  await assert.rejects(client.status(), /timed out/i);
  await peerClosed;
});

test('RPC call rejects incomplete EOF instead of remaining pending', async (t) => {
  const socketPath = await rawServerFixture(t, (socket) => {
    socket.once('data', () => socket.end('{"id":1'));
  });
  const client = new GatewayRpcClient({ socketPath, timeoutMs: 500 });
  await assert.rejects(client.status(), /closed before response/i);
});

test('RPC call rejects a response with the wrong correlation id', async (t) => {
  const socketPath = await rawServerFixture(t, (socket) => {
    socket.once('data', () => socket.end(`${JSON.stringify({ id: 999, result: { state: 'forged' } })}\n`));
  });
  const client = new GatewayRpcClient({ socketPath, timeoutMs: 500 });
  await assert.rejects(client.status(), /response id mismatch/i);
});

test('RPC call supports AbortSignal cancellation with deterministic teardown', async (t) => {
  let peerClosed;
  const socketPath = await rawServerFixture(t, (socket) => {
    socket.resume();
    peerClosed = once(socket, 'close');
  });
  const client = new GatewayRpcClient({ socketPath, timeoutMs: 500 });
  const controller = new AbortController();
  const pending = client.call('status', {}, { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, /aborted/i);
  await peerClosed;
});

test('server survives a client disconnect while an RPC response is pending', async (t) => {
  const { gateway, socketPath, client } = await fixture(t);
  let releaseFirstStatus;
  let firstStatusStarted;
  const started = new Promise((resolve) => { firstStatusStarted = resolve; });
  const release = new Promise((resolve) => { releaseFirstStatus = resolve; });
  let statusCalls = 0;
  gateway.status = async () => {
    statusCalls += 1;
    if (statusCalls === 1) {
      firstStatusStarted();
      await release;
    }
    return { state: 'running' };
  };

  const abandoned = net.createConnection(socketPath);
  await once(abandoned, 'connect');
  abandoned.write(`${JSON.stringify({ id: 1, method: 'status', args: {} })}\n`);
  await started;
  abandoned.destroy();
  await once(abandoned, 'close');
  releaseFirstStatus();
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(await client.status(), { state: 'running' });
  assert.equal(statusCalls, 2);
});

test('RPC event subscription validates correlation and times out silently', async (t) => {
  const silentPath = await rawServerFixture(t, (socket) => socket.resume());
  await assert.rejects(new GatewayRpcClient({ socketPath: silentPath, timeoutMs: 30 }).startEvents(), /timed out/i);

  const wrongIdPath = await rawServerFixture(t, (socket) => {
    socket.once('data', () => socket.write(`${JSON.stringify({ id: 999, result: { subscribed: true } })}\n`));
  });
  await assert.rejects(new GatewayRpcClient({ socketPath: wrongIdPath, timeoutMs: 500 }).startEvents(), /response id mismatch/i);
});
