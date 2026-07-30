import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

import { GatewayRpcServer } from '../src/gateway-rpc.js';

const dir = await mkdtemp(join(tmpdir(), 'agentcall-process-smoke-'));
const socketPath = process.platform === 'win32'
  ? `\\\\.\\pipe\\agentcall-process-smoke-${process.pid}-${randomUUID()}`
  : join(dir, 'gatewayd.sock');
const gateway = new EventEmitter();
Object.assign(gateway, {
  status: () => ({ state: 'running', metrics: { commandsSent: 0 } }),
  capabilities: () => ({ tools: ['status', 'capabilities'], transport: 'stdio' }),
  dial: async () => ({ accepted: false }),
  answer: async () => ({ accepted: true }),
  reject: async () => ({ accepted: true }),
  hangup: async () => ({ accepted: true }),
  sendDtmf: async () => ({ accepted: true }),
});
const server = new GatewayRpcServer(gateway, { socketPath });
await server.start();

const child = spawn(process.execPath, ['src/mcp-server.js'], {
  cwd: fileURLToPath(new URL('..', import.meta.url)),
  env: { PATH: process.env.PATH, AGENTCALL_RPC_SOCKET: socketPath },
  stdio: ['pipe', 'pipe', 'pipe'],
});
const lines = createInterface({ input: child.stdout });
const messages = [];
let stderr = '';
let childExit = null;
child.stderr.setEncoding('utf8');
child.stderr.on('data', (chunk) => { stderr += chunk; });
child.on('exit', (code, signal) => { childExit = { code, signal }; });
lines.on('line', (line) => messages.push(JSON.parse(line)));
const send = (value) => child.stdin.write(`${JSON.stringify(value)}\n`);
const toolReceipt = (message) => {
  const item = message?.result?.content?.[0];
  assert.equal(item?.type, 'text');
  return JSON.parse(item.text);
};
const waitFor = async (predicate, timeoutMs = 3000) => {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const value = messages.find(predicate);
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const socketStats = [...server.sockets].map((socket) => ({ bytesRead: socket.bytesRead, bytesWritten: socket.bytesWritten, destroyed: socket.destroyed }));
  throw new Error(`timed out; messages=${JSON.stringify(messages)} stderr=${JSON.stringify(stderr)} exit=${JSON.stringify(childExit)} socketStats=${JSON.stringify(socketStats)} eventSockets=${server.eventSockets.size}`);
};

try {
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  assert.equal((await waitFor((m) => m.id === 1)).result.protocolVersion, '2024-11-05');

  send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'status', arguments: {} } });
  assert.equal(toolReceipt(await waitFor((m) => m.id === 2)).state, 'running');

  send({ jsonrpc: '2.0', id: 3, method: 'resources/subscribe', params: { uri: 'agentcall://events/recent' } });
  await waitFor((m) => m.id === 3);
  gateway.emit('event', {
    callId: 'call-smoke',
    state: 'ringing',
    phone: '+15551234567',
    pcm: Buffer.alloc(640),
    token: 'secret',
  });
  await waitFor((m) => m.method === 'notifications/resources/updated');

  send({ jsonrpc: '2.0', id: 4, method: 'resources/read', params: { uri: 'agentcall://events/recent' } });
  const resource = await waitFor((m) => m.id === 4);
  const text = resource.result.contents[0].text;
  assert.match(text, /call-smoke/);
  assert.doesNotMatch(text, /15551234567|secret|pcm|token/);
  console.log(JSON.stringify({
    initialize: 'ok',
    statusViaRpc: 'running',
    resourceNotification: 'ok',
    redaction: 'ok',
    adbEnvironmentRequiredByMcp: false,
  }));
} finally {
  child.stdin.end();
  await new Promise((resolve) => child.once('exit', resolve));
  await server.stop();
  await rm(dir, { recursive: true, force: true });
}
