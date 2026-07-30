#!/usr/bin/env node

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

const extractedRoot = resolve(process.argv[2] || '');
const transcriptPath = process.argv[3] ? resolve(process.argv[3]) : null;
if (!process.argv[2]) throw new Error('usage: test-packaged-mcp.mjs EXTRACTED_DEB_ROOT [TRANSCRIPT.json]');

const gatewayScript = join(extractedRoot, 'usr/lib/agentcall/pc-gateway/src/gatewayd.js');
const gatewayRpcScript = join(extractedRoot, 'usr/lib/agentcall/pc-gateway/src/gateway-rpc.js');
const mcpLauncher = join(extractedRoot, 'usr/lib/agentcall/bin/agentcall-mcp');
await stat(gatewayScript);
await stat(gatewayRpcScript);
const launcherStat = await stat(mcpLauncher);
assert.equal((launcherStat.mode & 0o111) !== 0, true, 'packaged MCP launcher is not executable');
const { GatewayRpcClient } = await import(pathToFileURL(gatewayRpcScript));

function toolPayload(response) {
  assert.deepEqual(Object.keys(response.result).sort(), ['content', 'isError']);
  assert.equal(response.result.isError, false);
  assert.equal(response.result.content.length, 1);
  assert.equal(response.result.content[0].type, 'text');
  return JSON.parse(response.result.content[0].text);
}

const work = await mkdtemp(join(tmpdir(), 'agentcall-packaged-mcp-'));
const socketPath = join(work, 'gatewayd.sock');
const recordingRoot = join(work, 'recordings');
const providerSettingsPath = join(work, 'provider-settings.json');
await mkdir(recordingRoot);
const env = {
  ...process.env,
  AGENTCALL_MODE: 'simulator',
  AGENTCALL_RPC_SOCKET: socketPath,
  AGENTCALL_RECORDING_ROOT: recordingRoot,
  AGENTCALL_PROVIDER_SETTINGS_FILE: providerSettingsPath,
  AGENTCALL_RECORDING_MIN_FREE_BYTES: '1',
  AGENTCALL_DIAL_ENABLED: 'false',
  AGENTCALL_REALTIME_ENABLED: 'false',
  AGENTCALL_CALLER_MEMORY_ENABLED: 'false',
};

const children = new Set();
let gatewayStderr = '';
let mcpStderr = '';
function child(command, args = [], options = {}) {
  const value = spawn(command, args, { env, stdio: ['pipe', 'pipe', 'pipe'], ...options });
  children.add(value);
  value.once('exit', () => children.delete(value));
  return value;
}

async function waitForSocket(process, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (process.exitCode !== null) throw new Error(`gatewayd exited before RPC readiness: ${gatewayStderr.trim()}`);
    try {
      const value = await stat(socketPath);
      if (value.isSocket()) return;
    } catch {}
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  throw new Error('gatewayd RPC socket readiness timeout');
}

async function waitForGatewayReady(process, timeoutMs = 15_000) {
  const client = new GatewayRpcClient({ socketPath, timeoutMs: 1_000 });
  const deadline = Date.now() + timeoutMs;
  let lastStatus = null;
  while (Date.now() < deadline) {
    if (process.exitCode !== null) throw new Error(`gatewayd exited before device readiness: ${gatewayStderr.trim()}`);
    try {
      lastStatus = await client.status();
      if (lastStatus?.state === 'running'
          && lastStatus.device?.connected === true
          && lastStatus.device?.authenticated === true) return lastStatus;
    } catch {}
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  throw new Error(`gatewayd device readiness timeout: ${JSON.stringify(lastStatus)}`);
}

async function stopChild(process, signal = 'SIGTERM') {
  if (!process || process.exitCode !== null) return;
  process.kill(signal);
  await Promise.race([
    new Promise((resolvePromise) => process.once('exit', resolvePromise)),
    new Promise((_, reject) => setTimeout(() => reject(new Error('child shutdown timeout')), 5_000)),
  ]);
}

const resourceUris = [
  'agentcall://gateway/status',
  'agentcall://gateway/capabilities',
  'agentcall://calls/current',
  'agentcall://events/recent',
  'agentcall://phone-data/status',
];
const requests = [
  { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
  { jsonrpc: '2.0', method: 'notifications/initialized', params: {} },
  { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
  { jsonrpc: '2.0', id: 3, method: 'resources/list', params: {} },
  { jsonrpc: '2.0', id: 4, method: 'resources/subscribe', params: { uri: 'agentcall://events/recent' } },
  { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'status', arguments: {} } },
  { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'capabilities', arguments: {} } },
  // The synthetic strict-E.164 fixture is never written to evidence; the policy-denial response must remain redacted.
  { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'dial', arguments: {
    destination: '+15551230123', idempotencyKey: 'packaged-smoke-dial', approved: true,
    openingText: 'Good afternoon. May I confirm who I am speaking with, please?',
    preparedReplies: ['Hello. I am calling on behalf of the person who requested this call.'],
    consent: { recorded: true, policy: 'packaged simulator smoke consent' },
  } } },
  { jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'answer', arguments: { callId: 'packaged-smoke-call', idempotencyKey: 'packaged-smoke-answer' } } },
  { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'answer', arguments: { callId: 'packaged-smoke-call', idempotencyKey: 'packaged-smoke-answer' } } },
  { jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'send_dtmf', arguments: { callId: 'packaged-smoke-call', digits: '12#', idempotencyKey: 'packaged-smoke-dtmf' } } },
  { jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'reject', arguments: { callId: 'packaged-smoke-call', idempotencyKey: 'packaged-smoke-reject' } } },
  { jsonrpc: '2.0', id: 12, method: 'tools/call', params: { name: 'hangup', arguments: { callId: 'packaged-smoke-call', idempotencyKey: 'packaged-smoke-hangup' } } },
  { jsonrpc: '2.0', id: 13, method: 'tools/call', params: { name: 'speak', arguments: { callId: 'packaged-smoke-call', text: 'Package smoke response.', idempotencyKey: 'packaged-smoke-speak' } } },
  { jsonrpc: '2.0', id: 14, method: 'tools/call', params: { name: 'status', arguments: { unexpected: true } } },
  ...resourceUris.map((uri, index) => ({ jsonrpc: '2.0', id: 15 + index, method: 'resources/read', params: { uri } })),
];
const expectedIds = requests.flatMap((request) => Number.isInteger(request.id) ? [request.id] : []);

let gateway;
let mcp;
try {
  gateway = child(process.execPath, [gatewayScript]);
  gateway.stderr.setEncoding('utf8');
  gateway.stderr.on('data', (chunk) => { gatewayStderr += chunk; });
  await waitForSocket(gateway);
  await waitForGatewayReady(gateway);

  mcp = child(mcpLauncher, [], { env: {
    ...env,
    AGENTCALL_NODE_BIN: process.execPath,
    AGENTCALL_MCP_SCRIPT: join(extractedRoot, 'usr/lib/agentcall/pc-gateway/src/mcp-server.js'),
  } });
  mcp.stderr.setEncoding('utf8');
  mcp.stderr.on('data', (chunk) => { mcpStderr += chunk; });
  const responses = new Map();
  const notifications = [];
  let subscriptionReadyResolve;
  const subscriptionReady = new Promise((resolvePromise) => { subscriptionReadyResolve = resolvePromise; });
  let resourceUpdatedResolve;
  const resourceUpdated = new Promise((resolvePromise) => { resourceUpdatedResolve = resolvePromise; });
  const lines = createInterface({ input: mcp.stdout, crlfDelay: Infinity });
  const complete = new Promise((resolvePromise, reject) => {
    lines.on('line', (line) => {
      try {
        const response = JSON.parse(line);
        if (response.id !== undefined && response.id !== null) responses.set(response.id, response);
        else if (response.method) {
          notifications.push(response);
          if (response.method === 'notifications/resources/updated'
              && response.params?.uri === 'agentcall://events/recent') resourceUpdatedResolve();
        }
        if (response.id === 4) subscriptionReadyResolve();
        if (expectedIds.every((id) => responses.has(id))) resolvePromise();
      } catch (error) {
        reject(error);
      }
    });
    mcp.once('exit', (code) => {
      if (!expectedIds.every((id) => responses.has(id))) {
        reject(new Error(`MCP exited ${code} before all responses: ${mcpStderr.trim()}`));
      }
    });
  });
  for (const request of requests.slice(0, 5)) mcp.stdin.write(`${JSON.stringify(request)}\n`);
  await Promise.race([
    subscriptionReady,
    new Promise((_, reject) => setTimeout(() => reject(new Error('MCP subscription timeout')), 10_000)),
  ]);
  for (const request of requests.slice(5)) mcp.stdin.write(`${JSON.stringify(request)}\n`);
  await Promise.race([
    complete,
    new Promise((_, reject) => setTimeout(() => reject(new Error('MCP response timeout')), 10_000)),
  ]);
  await Promise.race([
    resourceUpdated,
    new Promise((_, reject) => setTimeout(() => reject(new Error(
      `MCP resource update timeout; notifications=${notifications.length}; `
      + `gateway=${gatewayStderr.trim() || '<empty>'}; mcp=${mcpStderr.trim() || '<empty>'}`,
    )), 10_000)),
  ]);

  assert.equal(responses.get(1).result.protocolVersion, '2024-11-05');
  const tools = responses.get(2).result.tools;
  assert.deepEqual(tools.map(({ name }) => name), [
    'status', 'capabilities', 'wait_for_incoming_call', 'wait_for_turn',
    'dial', 'prepare_speech', 'answer', 'reject', 'hangup', 'send_dtmf', 'speak',
  ]);
  assert(tools.every(({ inputSchema }) => inputSchema.additionalProperties === false));
  assert.deepEqual(responses.get(3).result.resources.map(({ uri }) => uri), resourceUris);
  assert.deepEqual(responses.get(4).result, {});
  const status = toolPayload(responses.get(5));
  const capabilities = toolPayload(responses.get(6));
  assert.equal(status.identity, 'SIMULATOR');
  assert.equal(status.simulator, true);
  assert.equal(status.state, 'running');
  assert.equal(capabilities.identity, 'SIMULATOR');
  assert.equal(capabilities.simulator, true);
  assert.equal(capabilities.transport, 'stdio');
  assert.equal(toolPayload(responses.get(7)).accepted, false);
  assert.deepEqual(toolPayload(responses.get(8)), toolPayload(responses.get(9)), 'idempotent replay result changed');
  for (const id of [8, 10, 11, 12]) assert.equal(toolPayload(responses.get(id)).accepted, true);
  assert.equal(toolPayload(responses.get(13)).accepted, false);
  assert.equal(responses.get(14).error.code, -32602);
  const resourceReads = resourceUris.map((uri, index) => {
    const response = responses.get(15 + index);
    assert.equal(response.result.contents[0].uri, uri);
    assert.equal(response.result.contents[0].mimeType, 'application/json');
    JSON.parse(response.result.contents[0].text);
    return response;
  });
  const phoneData = JSON.parse(resourceReads.at(-1).result.contents[0].text);
  assert.deepEqual(Object.keys(phoneData).sort(), ['callLog', 'contacts']);
  for (const value of Object.values(phoneData)) {
    assert.deepEqual(Object.keys(value).sort(), Object.hasOwn(value, 'syncedAt')
      ? ['count', 'state', 'syncedAt'] : ['count', 'state']);
    assert.equal(Number.isInteger(value.count) && value.count >= 0, true);
    assert.equal(typeof value.state, 'string');
  }
  assert.equal(/"(?:rows|name|number|path)"\s*:/.test(JSON.stringify(phoneData)), false,
    'private phone-data fields leaked through packaged MCP');
  assert(notifications.some((value) => value.method === 'notifications/resources/updated'
    && value.params?.uri === 'agentcall://events/recent'));

  const transcript = {
    artifact: 'extracted Debian package',
    mode: 'simulator',
    initialize: responses.get(1),
    toolsList: responses.get(2),
    resourcesList: responses.get(3),
    status: responses.get(5),
    capabilities: responses.get(6),
    policyDeniedDial: responses.get(7),
    answer: responses.get(8),
    idempotentReplay: responses.get(9),
    sendDtmf: responses.get(10),
    reject: responses.get(11),
    hangup: responses.get(12),
    speakDenied: responses.get(13),
    unknownFieldRejected: responses.get(14),
    resourceReads,
    resourceUpdated: notifications.find((value) => value.method === 'notifications/resources/updated'),
  };
  const serialized = `${JSON.stringify(transcript, null, 2)}\n`;
  assert.equal(/\+[1-9]\d{5,14}/.test(serialized), false, 'full E.164 leaked into transcript');
  assert.equal(/"(?:pcm|base64|payload|audio|apiKey|token|secret|authorization)"\s*:/i.test(serialized), false, 'binary or secret-shaped field leaked into transcript');
  if (transcriptPath) await writeFile(transcriptPath, serialized, { mode: 0o600 });
  process.stdout.write('packaged-mcp-smoke-ok\n');
} finally {
  if (mcp && mcp.exitCode === null) {
    mcp.stdin.end();
    await stopChild(mcp, 'SIGTERM').catch(() => mcp.kill('SIGKILL'));
  }
  if (gateway && gateway.exitCode === null) await stopChild(gateway).catch(() => gateway.kill('SIGKILL'));
  for (const process of children) process.kill('SIGKILL');
  await rm(work, { recursive: true, force: true });
}
