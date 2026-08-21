#!/usr/bin/env node
import net from 'node:net';
import { createReadStream } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { open, stat } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RENDERER_ROOT = join(ROOT, 'ui', 'renderer');
const DEFAULT_PORT = 8456;
const DEFAULT_SOCKET = '/run/agentcall/gatewayd.sock';
const MAX_LINE_BYTES = 64 * 1024;
const MAX_BODY_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 65_000;

const METHODS = new Set([
  'status', 'capabilities', 'dial', 'answer', 'reject', 'hangup', 'sendDtmf',
  'listRecordings', 'exportRecordingArtifact', 'syncRecording', 'deleteRecording',
  'listContacts', 'listCallLog', 'phoneDataStatus',
  'providerStatus', 'providerHealth', 'testProviders', 'configureProvider',
  'providerCatalog', 'agentAnsweringStatus', 'configureAgentAnswering',
]);

const CALL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MIME = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.mkv': 'video/x-matroska',
  '.webm': 'video/webm',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
});

function socketPathFromEnv(env = process.env) {
  const value = env.AGENTCALL_RPC_SOCKET || DEFAULT_SOCKET;
  if (typeof value !== 'string' || value.length < 2 || value.length > 200 || !isAbsolute(value)) {
    throw new Error('AGENTCALL_RPC_SOCKET must be an absolute bounded path');
  }
  return value;
}

let nextId = 1;

function rpcCall(method, args, { timeoutMs = REQUEST_TIMEOUT_MS, socketPath } = {}) {
  return new Promise((resolveCall, rejectCall) => {
    if (!METHODS.has(method)) return rejectCall(new Error('method not allowed'));
    const id = nextId++;
    const socket = net.createConnection(socketPath);
    let pending = '';
    let settled = false;
    let timer;
    const settle = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        socket.destroy();
        rejectCall(error);
        return;
      }
      socket.end();
      resolveCall(result);
    };
    timer = setTimeout(() => settle(new Error('gateway request timed out')), timeoutMs);
    socket.setEncoding('utf8');
    socket.once('error', settle);
    socket.once('end', () => settle(new Error('gateway response ended incomplete')));
    socket.once('close', () => settle(new Error('gateway response closed incomplete')));
    socket.on('data', (chunk) => {
      pending += chunk;
      if (Buffer.byteLength(pending) > MAX_LINE_BYTES) return settle(new Error('gateway response too large'));
      const newline = pending.indexOf('\n');
      if (newline < 0) return;
      try {
        const response = JSON.parse(pending.slice(0, newline));
        if (response.id !== id) throw new Error('gateway response correlation mismatch');
        if (response.error) throw new Error(String(response.error).slice(0, 160));
        settle(null, response.result);
      } catch (error) {
        settle(error);
      }
    });
    socket.once('connect', () => socket.write(`${JSON.stringify({ id, method, args })}\n`));
  });
}

function gatewayReachable(socketPath) {
  return new Promise((resolveReach) => {
    const socket = net.createConnection(socketPath);
    const done = (value) => {
      socket.destroy();
      resolveReach(value);
    };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.once('timeout', () => done(false));
    socket.setTimeout(2_000);
  });
}

class EventFanout {
  constructor({ socketPath }) {
    this.socketPath = socketPath;
    this.clients = new Set();
    this.daemonSocket = null;
    this.pending = '';
  }

  add(client) {
    this.clients.add(client);
    this.#ensureDaemon();
  }

  remove(client) {
    this.clients.delete(client);
    if (this.clients.size === 0) this.#closeDaemon();
  }

  #ensureDaemon() {
    if (this.daemonSocket) return;
    const socket = net.createConnection(this.socketPath);
    this.daemonSocket = socket;
    socket.setEncoding('utf8');
    socket.on('error', () => this.#closeDaemon());
    socket.on('close', () => this.#closeDaemon());
    socket.on('data', (chunk) => {
      this.pending += chunk;
      if (Buffer.byteLength(this.pending) > MAX_LINE_BYTES) return this.#closeDaemon();
      for (;;) {
        const newline = this.pending.indexOf('\n');
        if (newline < 0) break;
        const line = this.pending.slice(0, newline);
        this.pending = this.pending.slice(newline + 1);
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message?.event && typeof message.event === 'object') {
          for (const client of this.clients) client.write(`data: ${JSON.stringify({ event: message.event })}\n\n`);
        }
      }
    });
    socket.once('connect', () => socket.write(`${JSON.stringify({ id: nextId++, method: 'events', args: {} })}\n`));
  }

  #closeDaemon() {
    const socket = this.daemonSocket;
    this.daemonSocket = null;
    this.pending = '';
    if (socket) {
      socket.removeAllListeners();
      socket.destroy();
    }
  }
}

const WEB_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "media-src 'self' blob:",
  "object-src 'none'",
  "frame-src 'none'",
  "base-uri 'none'",
].join('; ');

function renderIndex(html) {
  const withCsp = html.replace(
    /<meta http-equiv="Content-Security-Policy" content="[^"]*">/,
    `<meta http-equiv="Content-Security-Policy" content="${WEB_CSP}">`,
  );
  const withBridge = withCsp.replace(
    /<script type="module" src="app\.js"><\/script>/,
    '<script type="module" src="web-bridge.js"></script>\n  <script type="module" src="app.js"></script>',
  );
  if (withBridge === html) throw new Error('index.html web bridge injection failed');
  return withBridge;
}

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  response.end(body);
}

function sendText(response, status, text) {
  const body = Buffer.from(text, 'utf8');
  response.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
  });
  response.end(body);
}

function readBody(request) {
  return new Promise((resolveBody, rejectBody) => {
    let size = 0;
    const chunks = [];
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        rejectBody(new Error('request body is too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')));
    request.on('error', rejectBody);
  });
}

function validateRpcPayload(payload) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('invalid rpc payload');
  }
  const method = payload.method;
  const args = payload.args;
  if (typeof method !== 'string' || !METHODS.has(method)) throw new Error('method not allowed');
  if (args === null || typeof args !== 'object' || Array.isArray(args)) throw new Error('invalid rpc arguments');
  return { method, args };
}

function serveStatic(request, response, pathname, socketPath) {
  let relative = decodeURIComponent(pathname);
  if (relative.endsWith('/') || relative === '') relative = '/index.html';
  if (relative.includes('\0')) return sendText(response, 400, 'bad request');
  const filePath = resolve(RENDERER_ROOT, `.${relative}`);
  if (filePath !== RENDERER_ROOT && !filePath.startsWith(`${RENDERER_ROOT}${process.platform === 'win32' ? '\\' : '/'}`)) {
    return sendText(response, 403, 'forbidden');
  }
  void (async () => {
    let info;
    try {
      info = await stat(filePath);
    } catch {
      return sendText(response, 404, 'not found');
    }
    if (!info.isFile()) return sendText(response, 404, 'not found');
    const mime = MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream';
    if (relative === '/index.html') {
      let html;
      try {
        const handle = await open(filePath, 'r');
        try {
          html = await handle.readFile('utf8');
        } finally {
          await handle.close();
        }
      } catch {
        return sendText(response, 500, 'index unavailable');
      }
      let transformed;
      try {
        transformed = renderIndex(html);
      } catch {
        return sendText(response, 500, 'index injection failed');
      }
      response.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-length': Buffer.byteLength(transformed),
        'cache-control': 'no-store',
      });
      response.end(transformed);
      return;
    }
    response.writeHead(200, {
      'content-type': mime,
      'content-length': info.size,
      'cache-control': 'no-store',
    });
    const stream = createReadStream(filePath);
    stream.on('error', () => response.destroy());
    stream.pipe(response);
  })();
}

async function serveRecordingArtifact(request, response, url, socketPath) {
  const callId = url.searchParams.get('callId') ?? '';
  const artifact = url.searchParams.get('artifact') === 'conversation.mkv' ? 'conversation.mkv' : 'conversation.wav';
  if (!CALL_ID_RE.test(callId)) return sendJson(response, 400, { ok: false, error: 'callId is invalid' });
  let artifactPath;
  try {
    artifactPath = await rpcCall('exportRecordingArtifact', { callId, artifact }, { socketPath });
  } catch (error) {
    return sendJson(response, 404, { ok: false, error: String(error?.message ?? 'recording artifact unavailable').slice(0, 160) });
  }
  if (typeof artifactPath !== 'string' || !isAbsolute(artifactPath)) {
    return sendJson(response, 404, { ok: false, error: 'recording artifact unavailable' });
  }
  let info;
  try {
    info = await stat(artifactPath);
  } catch {
    return sendJson(response, 404, { ok: false, error: 'recording artifact unavailable' });
  }
  if (!info.isFile()) return sendJson(response, 404, { ok: false, error: 'recording artifact unavailable' });
  response.writeHead(200, {
    'content-type': artifact === 'conversation.wav' ? 'audio/wav' : 'video/x-matroska',
    'content-length': info.size,
    'cache-control': 'no-store',
    'content-disposition': `inline; filename="Arynox-${callId}.${artifact.endsWith('.wav') ? 'wav' : 'mkv'}"`,
  });
  const stream = createReadStream(artifactPath);
  stream.on('error', () => response.destroy());
  stream.pipe(response);
}

async function main() {
  const socketPath = socketPathFromEnv();
  const port = Number(process.env.ARYNOX_WEB_PORT || String(DEFAULT_PORT));
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error('ARYNOX_WEB_PORT must be a numeric port 1024..65535');
  }
  const events = new EventFanout({ socketPath });
  const server = createHttpServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    try {
      if (request.method === 'GET' && url.pathname === '/health') {
        const gateway = await gatewayReachable(socketPath);
        return sendJson(response, 200, { ok: true, gateway });
      }
      if (request.method === 'GET' && url.pathname === '/events') {
        response.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-store',
          'connection': 'keep-alive',
        });
        response.write(': connected\n\n');
        events.add(response);
        request.on('close', () => events.remove(response));
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/recording') {
        return await serveRecordingArtifact(request, response, url, socketPath);
      }
      if (request.method === 'POST' && url.pathname === '/rpc') {
        const contentType = String(request.headers['content-type'] ?? '');
        if (!contentType.includes('application/json')) return sendJson(response, 415, { ok: false, error: 'content-type must be application/json' });
        let payload;
        try {
          payload = JSON.parse(await readBody(request));
        } catch {
          return sendJson(response, 400, { ok: false, error: 'request body is invalid' });
        }
        let method;
        let args;
        try {
          ({ method, args } = validateRpcPayload(payload));
        } catch (error) {
          return sendJson(response, 400, { ok: false, error: String(error?.message ?? 'invalid request').slice(0, 160) });
        }
        try {
          const result = await rpcCall(method, args, { socketPath });
          return sendJson(response, 200, { ok: true, result });
        } catch (error) {
          return sendJson(response, 200, { ok: false, error: String(error?.message ?? 'gateway request failed').slice(0, 160) });
        }
      }
      if (request.method === 'GET' || request.method === 'HEAD') {
        return serveStatic(request, response, url.pathname, socketPath);
      }
      return sendText(response, 405, 'method not allowed');
    } catch (error) {
      return sendJson(response, 500, { ok: false, error: String(error?.message ?? 'internal error').slice(0, 160) });
    }
  });
  server.listen(port, '127.0.0.1', () => {
    process.stdout.write(`Arynox AI Call Assistant web host listening on http://localhost:${port}\n`);
    process.stdout.write(`Gateway RPC socket: ${socketPath}\n`);
  });
}

main().catch((error) => {
  process.stderr.write(`web-host start failed: ${String(error?.message ?? error)}\n`);
  process.exitCode = 1;
});