import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { GatewayRpcServer } from '../src/gateway-rpc.js';

const dir = await mkdtemp(join(tmpdir(), 'agentcall-event-child-'));
const socketPath = join(dir, 'gatewayd.sock');
const gateway = new EventEmitter();
const server = new GatewayRpcServer(gateway, { socketPath });
await server.start();
const child = spawn(process.execPath, ['test/event-client-child.mjs'], {
  cwd: new URL('..', import.meta.url).pathname,
  env: { PATH: process.env.PATH, AGENTCALL_RPC_SOCKET: socketPath },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let stdout = '';
let stderr = '';
child.stdout.setEncoding('utf8');
child.stderr.setEncoding('utf8');
child.stdout.on('data', (chunk) => { stdout += chunk; });
child.stderr.on('data', (chunk) => { stderr += chunk; });
try {
  const exit = await Promise.race([
    new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal }))),
    new Promise((resolve) => setTimeout(() => resolve(null), 3000)),
  ]);
  if (!exit) child.kill('SIGKILL');
  assert.ok(exit, `child hung; stdout=${JSON.stringify(stdout)} stderr=${JSON.stringify(stderr)} sockets=${server.sockets.size} eventSockets=${server.eventSockets.size}`);
  assert.deepEqual(exit, { code: 0, signal: null }, stderr);
  assert.equal(stdout, 'EVENTS_READY\n');
  console.log('cross-process event client: PASS');
} finally {
  if (child.exitCode === null) child.kill('SIGKILL');
  await server.stop();
  await rm(dir, { recursive: true, force: true });
}
