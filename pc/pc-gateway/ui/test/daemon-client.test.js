import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import net from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { once } from 'node:events';

import { DesktopDaemonClient, READ_METHODS, desktopSocketFromEnv } from '../electron/daemon-client.js';

async function rawSocketFixture(t, onConnection) {
  const dir = await mkdtemp(join(tmpdir(), 'agentcall-desktop-rpc-'));
  const socketPath = process.platform === 'win32'
    ? `\\\\.\\pipe\\agentcall-desktop-test-${process.pid}-${randomUUID()}`
    : join(dir, 'gatewayd.sock');
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    onConnection(socket);
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

async function socketFixture(t, onRequest) {
  return rawSocketFixture(t, (socket) => {
    socket.setEncoding('utf8');
    socket.once('data', (chunk) => {
      const request = JSON.parse(chunk.trim());
      socket.end(`${JSON.stringify(onRequest(request))}\n`);
    });
  });
}

async function boundedOutcome(promise, timeoutMs = 150) {
  return Promise.race([
    promise.then(() => 'resolved', (error) => error),
    new Promise((resolve) => setTimeout(() => resolve('outer-timeout'), timeoutMs)),
  ]);
}

test('desktop socket config is absolute and independent of device credentials', () => {
  assert.equal(desktopSocketFromEnv({}), '/run/agentcall/gatewayd.sock');
  assert.equal(desktopSocketFromEnv({ AGENTCALL_RPC_SOCKET: '/tmp/gateway.sock' }), '/tmp/gateway.sock');
  assert.throws(() => desktopSocketFromEnv({ AGENTCALL_RPC_SOCKET: 'relative.sock' }), /absolute/i);
  assert.throws(() => new DesktopDaemonClient({ socketPath: '/tmp/gateway.sock', timeoutMs: 0 }), /bounded/i);
  assert.throws(() => new DesktopDaemonClient({ socketPath: '/tmp/gateway.sock', timeoutMs: 120_001 }), /bounded/i);
});

test('desktop daemon allowlist contains only the intended semantic methods', () => {
  assert.deepEqual([...READ_METHODS].sort(), [
    'agentAnsweringStatus', 'answer', 'capabilities', 'configureAgentAnswering', 'configureProvider',
    'deleteRecording', 'dial', 'exportRecordingArtifact', 'hangup', 'listCallLog',
    'listContacts', 'listRecordings', 'phoneDataStatus', 'providerCatalog', 'providerHealth',
    'providerStatus', 'reject', 'sendDtmf', 'status', 'syncRecording', 'testProviders',
  ]);
});

test('desktop daemon client exposes semantic status and correlated call controls', async (t) => {
  const requests = [];
  const socketPath = await socketFixture(t, (request) => {
    requests.push(request);
    return { id: request.id, result: request.method === 'status' ? { state: 'running' } : { tools: ['status'] } };
  });
  const client = new DesktopDaemonClient({ socketPath });

  assert.deepEqual(await client.status(), { state: 'running' });
  assert.deepEqual(await client.capabilities(), { tools: ['status'] });
  await client.dial({
    destination: '+10000000001', approved: true,
    consent: { recorded: true, policy: 'confirmed' }, idempotencyKey: 'dial-1',
  });
  await client.answer({ callId: 'call-1', idempotencyKey: 'answer-1' });
  await client.reject({ callId: 'call-1', idempotencyKey: 'reject-1' });
  await client.hangup({ callId: 'call-1', idempotencyKey: 'hangup-1' });
  await client.sendDtmf({ callId: 'call-1', digits: '12#', idempotencyKey: 'dtmf-1' });
  await client.listRecordings({ limit: 100 });
  await client.exportRecordingArtifact({ callId: 'call-1', artifact: 'conversation.mkv' });
  await client.syncRecording({ callId: 'call-1' });
  await client.deleteRecording({
    callId: 'call-1', consent: { recorded: true }, operatorRole: 'operator', reason: 'user requested deletion',
  });
  await client.listContacts({ limit: 500 });
  await client.listCallLog({ limit: 200 });
  await client.phoneDataStatus();
  await client.providerHealth({ kind: 'stt' });
  await client.testProviders();
  assert.deepEqual(requests.map(({ method, args }) => ({ method, args })), [
    { method: 'status', args: {} },
    { method: 'capabilities', args: {} },
    { method: 'dial', args: {
      destination: '+10000000001', approved: true,
      consent: { recorded: true, policy: 'confirmed' }, idempotencyKey: 'dial-1',
    } },
    { method: 'answer', args: { callId: 'call-1', idempotencyKey: 'answer-1' } },
    { method: 'reject', args: { callId: 'call-1', idempotencyKey: 'reject-1' } },
    { method: 'hangup', args: { callId: 'call-1', idempotencyKey: 'hangup-1' } },
    { method: 'sendDtmf', args: { callId: 'call-1', digits: '12#', idempotencyKey: 'dtmf-1' } },
    { method: 'listRecordings', args: { limit: 100 } },
    { method: 'exportRecordingArtifact', args: { callId: 'call-1', artifact: 'conversation.mkv' } },
    { method: 'syncRecording', args: { callId: 'call-1' } },
    { method: 'deleteRecording', args: {
      callId: 'call-1', consent: { recorded: true }, operatorRole: 'operator', reason: 'user requested deletion',
    } },
    { method: 'listContacts', args: { limit: 500 } },
    { method: 'listCallLog', args: { limit: 200 } },
    { method: 'phoneDataStatus', args: {} },
    { method: 'providerHealth', args: { kind: 'stt' } },
    { method: 'testProviders', args: {} },
  ]);
  assert.equal(typeof client.dial, 'function');
  assert.equal(client.speak, undefined);
});

test('desktop client receives semantic events and correlated bidirectional audio on separate streams', async (t) => {
  let connection = 0;
  let uplink = null;
  const socketPath = await rawSocketFixture(t, (socket) => {
    const kind = ++connection;
    socket.setEncoding('utf8');
    let pending = '';
    socket.on('data', (chunk) => {
      pending += chunk;
      for (;;) {
        const newline = pending.indexOf('\n');
        if (newline < 0) break;
        const message = JSON.parse(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
        if (kind === 1) {
          socket.write(`${JSON.stringify({ id: message.id, result: { subscribed: true } })}\n`);
          socket.write(`${JSON.stringify({ event: { event: 'incoming', callId: 'call-audio-1' } })}\n`);
          setImmediate(() => socket.end());
        } else if (message.method === 'audio') {
          socket.write(`${JSON.stringify({ id: message.id, result: { connected: true, callId: 'call-audio-1' } })}\n`);
          socket.write(`${JSON.stringify({ audio: { callId: 'call-audio-1', pcm: Buffer.alloc(640, 0x31).toString('base64') } })}\n`);
        } else if (message.audio) {
          uplink = Buffer.from(message.audio.pcm, 'base64');
        }
      }
    });
  });
  const client = new DesktopDaemonClient({ socketPath, timeoutMs: 500 });
  t.after(() => { client.stopAudio(); client.stopEvents(); });

  const eventReceived = once(client, 'event');
  const eventsClosed = once(client, 'eventsClosed');
  await client.startEvents();
  assert.deepEqual((await eventReceived)[0], { event: 'incoming', callId: 'call-audio-1' });
  await eventsClosed;
  const audioReceived = once(client, 'audio');
  await client.startAudio('call-audio-1');
  assert.deepEqual((await audioReceived)[0].payload, Buffer.alloc(640, 0x31));
  client.sendAudioPcm('call-audio-1', Buffer.alloc(640, 0x42));
  for (let attempt = 0; attempt < 20 && !uplink; attempt++) await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(uplink, Buffer.alloc(640, 0x42));
});

test('desktop daemon client rejects oversized responses', async (t) => {
  const socketPath = await socketFixture(t, (request) => ({ id: request.id, result: { text: 'x'.repeat(70_000) } }));
  const client = new DesktopDaemonClient({ socketPath });
  await assert.rejects(client.status(), /too large/i);
});

test('desktop daemon client rejects incomplete EOF instead of leaving the request pending', async (t) => {
  const socketPath = await rawSocketFixture(t, (socket) => {
    socket.once('data', () => socket.end('{"id":1'));
  });
  const client = new DesktopDaemonClient({ socketPath, timeoutMs: 50 });

  const outcome = await boundedOutcome(client.status());
  assert.ok(outcome instanceof Error, `expected rejection, got ${outcome}`);
  assert.match(outcome.message, /incomplete|closed|response|timed out/i);
});

test('desktop daemon client times out a silent connected daemon', async (t) => {
  const socketPath = await rawSocketFixture(t, (socket) => {
    socket.once('data', () => {});
  });
  const client = new DesktopDaemonClient({ socketPath, timeoutMs: 25 });

  const outcome = await boundedOutcome(client.providerHealth({ kind: 'stt' }));
  assert.ok(outcome instanceof Error, `expected rejection, got ${outcome}`);
  assert.match(outcome.message, /timed out/i);
});
