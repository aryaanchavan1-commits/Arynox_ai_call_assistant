import { chmod, rm } from 'node:fs/promises';
import net from 'node:net';
import { EventEmitter } from 'node:events';

const MAX_LINE_BYTES = 64 * 1024;
const MAX_EVENT_DEPTH = 8;
const MAX_RPC_TIMEOUT_MS = 120_000;
const SPEECH_RPC_TIMEOUT_MS = 60_000;
const RPC_ERROR_CODE_RE = /^[A-Z][A-Z0-9_]{2,63}$/;
const CALL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const RECORDING_ARTIFACTS = new Set(['remote.wav', 'agent.wav', 'conversation.wav', 'conversation.mkv']);
const PROVIDER_MODELS = Object.freeze({
  stt: Object.freeze({
    openai: Object.freeze([
      'gpt-4o-transcribe',
      'gpt-4o-mini-transcribe',
      'gpt-4o-mini-transcribe-2025-12-15',
      'whisper-1',
    ]),
    elevenlabs: Object.freeze(['scribe_v2_realtime']),
  }),
  tts: Object.freeze({
    supertonic: Object.freeze(['supertonic-3']),
    elevenlabs: Object.freeze(['eleven_flash_v2_5', 'eleven_multilingual_v2', 'eleven_v3']),
    openai: Object.freeze(['gpt-4o-mini-tts-2025-12-15', 'gpt-4o-mini-tts', 'tts-1', 'tts-1-hd']),
  }),
});
const LANGUAGE_RE = /^[a-z]{2,3}$/;
const TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SENSITIVE_EVENT_KEY = /^(?:api[_-]?key|token|secret|authorization|phone|destination|number|pcm|payload|base64|blob|audio)$/i;
const METHODS = Object.freeze({
  status: [],
  capabilities: [],
  dial: ['approved', 'consent', 'destination', 'idempotencyKey'],
  answer: ['callId', 'idempotencyKey'],
  reject: ['callId', 'idempotencyKey'],
  hangup: ['callId', 'idempotencyKey'],
  sendDtmf: ['callId', 'digits', 'idempotencyKey'],
  speak: ['callId', 'text', 'idempotencyKey', 'interruptible'],
  listRecordings: ['limit'],
  listContacts: ['limit'],
  listCallLog: ['limit'],
  phoneDataStatus: [],
  recordingArtifact: ['artifact', 'callId'],
  exportRecordingArtifact: ['artifact', 'callId'],
  syncRecording: ['callId'],
  deleteRecording: ['callId', 'consent', 'operatorRole', 'reason'],
  providerStatus: [],
  providerCatalog: ['kind', 'model', 'provider'],
  providerHealth: ['kind'],
  testProviders: [],
  prewarmSpeech: ['text'],
  configureProvider: ['apiKey', 'kind', 'language', 'model', 'provider', 'voice', 'zeroRetention'],
  agentAnsweringStatus: [],
  configureAgentAnswering: ['enabled', 'instructions'],
  provisionDeviceEvidence: ['attestedOn', 'attestedSystemDescription', 'idempotencyKey', 'observedSystemFingerprint', 'observedVendorFingerprint'],
});

const REQUIRED_METHOD_KEYS = Object.freeze({
  dial: Object.freeze(['destination', 'idempotencyKey']),
  providerCatalog: Object.freeze(['kind', 'provider']),
  configureProvider: Object.freeze(['apiKey', 'kind', 'language', 'model', 'provider']),
  speak: Object.freeze(['callId', 'text', 'idempotencyKey']),
});

function exactKeys(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.keys(value).every((key) => allowed.includes(key));
}

function validRpcId(id) {
  return (typeof id === 'string' && id.length > 0 && id.length <= 128)
    || (typeof id === 'number' && Number.isSafeInteger(id));
}

function validate(method, args) {
  if (!Object.hasOwn(METHODS, method)) throw new Error('method not allowed');
  const text = JSON.stringify({ method, args });
  if (Buffer.byteLength(text) > MAX_LINE_BYTES) throw new Error('request too large');
  const allowed = METHODS[method];
  const required = REQUIRED_METHOD_KEYS[method] ?? allowed;
  if (!exactKeys(args, allowed) || required.some((key) => !Object.hasOwn(args, key))) {
    throw new Error('arguments not allowed');
  }
  if (method === 'listRecordings' && (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 200)) {
    throw new Error('recording limit is invalid');
  }
  if (method === 'listContacts' && (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 500)) {
    throw new Error('contact limit is invalid');
  }
  if (method === 'listCallLog' && (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 200)) {
    throw new Error('call-log limit is invalid');
  }
  if (method === 'dial'
      && (args.approved !== true || !exactKeys(args.consent, ['recorded', 'policy'])
        || args.consent.recorded !== true || typeof args.consent.policy !== 'string'
        || args.consent.policy.length < 1 || args.consent.policy.length > 256)) {
    throw new Error('recorded dial consent is invalid');
  }
  if ((method === 'recordingArtifact' || method === 'exportRecordingArtifact')
      && (!CALL_ID_RE.test(args.callId ?? '') || !RECORDING_ARTIFACTS.has(args.artifact))) {
    throw new Error('recording artifact arguments are invalid');
  }
  if (method === 'syncRecording' && !CALL_ID_RE.test(args.callId ?? '')) {
    throw new Error('recording sync arguments are invalid');
  }
  if (method === 'deleteRecording'
      && (!CALL_ID_RE.test(args.callId ?? '')
        || !exactKeys(args.consent, ['recorded']) || args.consent.recorded !== true
        || args.operatorRole !== 'operator'
        || typeof args.reason !== 'string' || args.reason.length < 1 || args.reason.length > 256)) {
    throw new Error('recording deletion arguments are invalid');
  }
  if (method === 'providerHealth' && args.kind !== 'stt' && args.kind !== 'tts') {
    throw new Error('provider kind is invalid');
  }
  if (method === 'prewarmSpeech'
      && (typeof args.text !== 'string' || args.text.length < 1 || args.text.length > 1_200
        || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(args.text))) {
    throw new Error('speech prewarm text is invalid');
  }
  if (method === 'speak'
      && (args.interruptible !== undefined && typeof args.interruptible !== 'boolean')) {
    throw new Error('speech interruption mode is invalid');
  }
  if (method === 'providerCatalog'
      && ((args.kind !== 'stt' && args.kind !== 'tts')
        || !PROVIDER_MODELS[args.kind]?.[args.provider]
        || (args.model !== undefined && !PROVIDER_MODELS[args.kind][args.provider].includes(args.model)))) {
    throw new Error('provider catalog arguments are invalid');
  }
  if (method === 'provisionDeviceEvidence') {
    const textFields = METHODS.provisionDeviceEvidence;
    if (textFields.some((key) => typeof args[key] !== 'string' || args[key].length < 1)
        || args.attestedOn.length !== 10 || args.attestedSystemDescription.length > 512
        || args.idempotencyKey.length > 128 || args.observedSystemFingerprint.length > 1024
        || args.observedVendorFingerprint.length > 1024) {
      throw new Error('device evidence arguments are invalid');
    }
  }
  if (method === 'configureProvider') {
    const models = PROVIDER_MODELS[args.kind]?.[args.provider];
    const voiceValid = args.kind === 'tts' ? TOKEN_RE.test(args.voice ?? '') : args.voice === undefined;
    const languageValid = LANGUAGE_RE.test(args.language ?? '');
    const retentionValid = args.provider === 'elevenlabs'
      ? typeof args.zeroRetention === 'boolean'
      : args.zeroRetention === undefined;
    if (!models?.includes(args.model) || !languageValid || !voiceValid || !retentionValid
        || typeof args.apiKey !== 'string' || args.apiKey.length > 4096) {
      throw new Error('provider configuration arguments are invalid');
    }
  }
  if (method === 'configureAgentAnswering'
      && (typeof args.enabled !== 'boolean'
        || typeof args.instructions !== 'string'
        || args.instructions.length > 2_000
        || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(args.instructions))) {
    throw new Error('agent answering configuration arguments are invalid');
  }
}

function sanitizeEvent(value, depth = 0, field = '') {
  if (depth > MAX_EVENT_DEPTH) return undefined;
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') {
    const maximum = field === 'instructions' ? 2_000 : 512;
    return value.length <= maximum ? value : `${value.slice(0, maximum - 3)}...`;
  }
  if (Buffer.isBuffer(value) || ArrayBuffer.isView(value)) return undefined;
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => sanitizeEvent(item, depth + 1, field)).filter((item) => item !== undefined);
  if (!value || typeof value !== 'object') return undefined;
  const clean = {};
  for (const [key, item] of Object.entries(value).slice(0, 64)) {
    if (SENSITIVE_EVENT_KEY.test(key)) continue;
    const sanitized = sanitizeEvent(item, depth + 1, key);
    if (sanitized !== undefined) clean[key] = sanitized;
  }
  return clean;
}

function write(socket, value) {
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text) > MAX_LINE_BYTES) throw new Error('response too large');
  return socket.write(`${text}\n`);
}

function safeWrite(socket, value) {
  if (socket.destroyed || !socket.writable) return false;
  try {
    write(socket, value);
    return true;
  } catch {
    socket.destroy();
    return false;
  }
}

const SAFE_RPC_ERRORS = Object.freeze({
  'method not allowed': Object.freeze({ code: 'METHOD_NOT_ALLOWED', message: 'method not allowed' }),
  'invalid request': Object.freeze({ code: 'INVALID_REQUEST', message: 'invalid request' }),
  'request too large': Object.freeze({ code: 'REQUEST_TOO_LARGE', message: 'request too large' }),
  'arguments not allowed': Object.freeze({ code: 'INVALID_ARGUMENTS', message: 'arguments not allowed' }),
  'invalid request id': Object.freeze({ code: 'INVALID_REQUEST', message: 'invalid request' }),
  'audio frame is invalid': Object.freeze({ code: 'INVALID_AUDIO_FRAME', message: 'audio frame is invalid' }),
  'recording limit is invalid': Object.freeze({ code: 'INVALID_ARGUMENTS', message: 'recording limit is invalid' }),
  'contact limit is invalid': Object.freeze({ code: 'INVALID_ARGUMENTS', message: 'contact limit is invalid' }),
  'call-log limit is invalid': Object.freeze({ code: 'INVALID_ARGUMENTS', message: 'call-log limit is invalid' }),
  'recorded dial consent is invalid': Object.freeze({ code: 'INVALID_ARGUMENTS', message: 'recorded dial consent is invalid' }),
  'recording artifact arguments are invalid': Object.freeze({ code: 'INVALID_ARGUMENTS', message: 'recording artifact arguments are invalid' }),
  'recording sync arguments are invalid': Object.freeze({ code: 'INVALID_ARGUMENTS', message: 'recording sync arguments are invalid' }),
  'recording deletion arguments are invalid': Object.freeze({ code: 'INVALID_ARGUMENTS', message: 'recording deletion arguments are invalid' }),
  'provider kind is invalid': Object.freeze({ code: 'INVALID_ARGUMENTS', message: 'provider kind is invalid' }),
  'speech prewarm text is invalid': Object.freeze({ code: 'INVALID_ARGUMENTS', message: 'speech prewarm text is invalid' }),
  'speech interruption mode is invalid': Object.freeze({ code: 'INVALID_ARGUMENTS', message: 'speech interruption mode is invalid' }),
  'provider catalog arguments are invalid': Object.freeze({ code: 'INVALID_ARGUMENTS', message: 'provider catalog arguments are invalid' }),
  'device evidence arguments are invalid': Object.freeze({ code: 'INVALID_ARGUMENTS', message: 'device evidence arguments are invalid' }),
  'provider configuration arguments are invalid': Object.freeze({ code: 'INVALID_ARGUMENTS', message: 'provider configuration arguments are invalid' }),
  'agent answering configuration arguments are invalid': Object.freeze({ code: 'INVALID_ARGUMENTS', message: 'agent answering configuration arguments are invalid' }),
});

function safeRpcError(problem) {
  const message = String(problem?.message ?? '').toLowerCase();
  return SAFE_RPC_ERRORS[message]
    ?? Object.freeze({ code: 'GATEWAY_OPERATION_FAILED', message: 'gateway operation failed' });
}

function parseRpcError(value) {
  if (typeof value === 'string') {
    return safeRpcError({ message: value });
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).length !== 2
      || !Object.hasOwn(value, 'code') || !Object.hasOwn(value, 'message')
      || !RPC_ERROR_CODE_RE.test(value.code ?? '')
      || typeof value.message !== 'string' || value.message.length < 1 || value.message.length > 160) {
    return { code: 'INVALID_RPC_RESPONSE', message: 'invalid RPC response' };
  }
  const known = Object.values(SAFE_RPC_ERRORS).find(
    ({ code, message }) => code === value.code && message === value.message,
  );
  if (known) return known;
  if (value.code === 'GATEWAY_OPERATION_FAILED' && value.message === 'gateway operation failed') {
    return value;
  }
  return { code: 'GATEWAY_OPERATION_FAILED', message: 'gateway operation failed' };
}

export class GatewayRpcError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'GatewayRpcError';
    this.code = code;
  }
}

export class GatewayRpcServer {
  constructor(gateway, { socketPath, platform = process.platform }) {
    if (!socketPath) throw new Error('socketPath is required');
    this.gateway = gateway;
    this.socketPath = socketPath;
    this.platform = platform;
    this.server = null;
    this.sockets = new Set();
    this.eventSockets = new Set();
    this.audioSockets = new Map();
    this._forwardIncoming = (value) => this.#broadcastEvent(value);
    this._forwardEvent = (value) => this.#broadcastEvent(value);
    this._forwardMonitorPcm = (value) => this.#broadcastAudio(value);
  }

  async start() {
    if (this.platform !== 'win32') await rm(this.socketPath, { force: true });
    this.server = net.createServer((socket) => this.#accept(socket));
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.socketPath, resolve);
    });
    if (this.platform !== 'win32') await chmod(this.socketPath, 0o660);
    this.gateway.on?.('incoming', this._forwardIncoming);
    this.gateway.on?.('event', this._forwardEvent);
    this.gateway.on?.('monitorPcm', this._forwardMonitorPcm);
  }

  #broadcastEvent(value) {
    const event = sanitizeEvent(value);
    if (!event || Object.keys(event).length === 0) return;
    for (const socket of this.eventSockets) {
      safeWrite(socket, { event });
    }
  }
  #broadcastAudio(value) {
    if (!value || !CALL_ID_RE.test(value.callId ?? '') || !Buffer.isBuffer(value.payload)
        || value.payload.length < 2 || value.payload.length > 6_400) return;
    for (const [socket, callId] of this.audioSockets) {
      if (callId !== value.callId) continue;
      safeWrite(socket, { audio: { callId, pcm: value.payload.toString('base64') } });
    }
  }

  #accept(socket) {
    this.sockets.add(socket);
    let pending = '';
    socket.setEncoding('utf8');
    socket.on('error', () => socket.destroy());
    socket.on('data', async (chunk) => {
      pending += chunk;
      if (Buffer.byteLength(pending) > MAX_LINE_BYTES) return socket.destroy();
      for (;;) {
        const newline = pending.indexOf('\n');
        if (newline < 0) break;
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        let request;
        try {
          request = JSON.parse(line);
          const audioCallId = this.audioSockets.get(socket);
          if (audioCallId) {
            const frame = request?.audio;
            if (!exactKeys(request, ['audio']) || !exactKeys(frame, ['callId', 'pcm'])
                || frame.callId !== audioCallId || typeof frame.pcm !== 'string'
                || frame.pcm.length < 4 || frame.pcm.length > 8_536
                || !/^[A-Za-z0-9+/]+={0,2}$/.test(frame.pcm)) throw new Error('audio frame is invalid');
            const payload = Buffer.from(frame.pcm, 'base64');
            await this.gateway.sendManualPcm({ callId: audioCallId, payload });
            continue;
          }
          if (!request || !validRpcId(request.id)) throw new Error('invalid request id');
          if (!exactKeys(request, ['id', 'method', 'args'])) throw new Error('invalid request');
          if (request.method === 'events' && exactKeys(request.args, [])) {
            this.eventSockets.add(socket);
            if (!safeWrite(socket, { id: request.id, result: { subscribed: true } })) return;
            continue;
          }
          if (request.method === 'audio' && exactKeys(request.args, ['callId'])
              && CALL_ID_RE.test(request.args.callId ?? '')
              && this.gateway.manualAudioAvailable?.({ callId: request.args.callId })) {
            this.audioSockets.set(socket, request.args.callId);
            if (!safeWrite(socket, { id: request.id, result: { connected: true, callId: request.args.callId } })) return;
            continue;
          }
          validate(request.method, request.args);
          const result = await this.gateway[request.method](request.args);
          if (!safeWrite(socket, { id: request.id, result })) return;
        } catch (error) {
          const publicError = safeRpcError(error);
          if (!safeWrite(socket, {
            id: validRpcId(request?.id) ? request.id : null,
            error: publicError,
          })) return;
        }
      }
    });
    socket.on('close', () => {
      this.sockets.delete(socket);
      this.eventSockets.delete(socket);
      this.audioSockets.delete(socket);
    });
  }

  async stop() {
    this.gateway.off?.('incoming', this._forwardIncoming);
    this.gateway.off?.('event', this._forwardEvent);
    this.gateway.off?.('monitorPcm', this._forwardMonitorPcm);
    for (const socket of this.sockets) socket.destroy();
    if (this.server) await new Promise((resolve) => this.server.close(resolve));
    this.server = null;
    this.eventSockets.clear();
    this.audioSockets.clear();
    if (this.platform !== 'win32') await rm(this.socketPath, { force: true });
  }
}

export class GatewayRpcClient extends EventEmitter {
  constructor({ socketPath, timeoutMs = 5_000 }) {
    super();
    if (!socketPath) throw new Error('socketPath is required');
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_RPC_TIMEOUT_MS) {
      throw new Error('timeoutMs is invalid');
    }
    this.socketPath = socketPath;
    this.timeoutMs = timeoutMs;
    this.nextId = 1;
    this.eventSocket = null;
  }

  _id() {
    const id = this.nextId;
    this.nextId = id >= Number.MAX_SAFE_INTEGER ? 1 : id + 1;
    return id;
  }

  status(options) { return this.call('status', {}, options); }
  capabilities(options) { return this.call('capabilities', {}, options); }
  dial(args, options) { return this.call('dial', args, options); }
  answer(args, options) { return this.call('answer', args, options); }
  reject(args, options) { return this.call('reject', args, options); }
  hangup(args, options) { return this.call('hangup', args, options); }
  sendDtmf(args, options) { return this.call('sendDtmf', args, options); }
  speak(args, options) {
    return this.call('speak', args, { timeoutMs: SPEECH_RPC_TIMEOUT_MS, ...options });
  }
  listRecordings(args) { return this.call('listRecordings', args); }
  listContacts(args) { return this.call('listContacts', args); }
  listCallLog(args) { return this.call('listCallLog', args); }
  phoneDataStatus() { return this.call('phoneDataStatus', {}); }
  recordingArtifact(args) { return this.call('recordingArtifact', args); }
  exportRecordingArtifact(args) { return this.call('exportRecordingArtifact', args); }
  syncRecording(args) { return this.call('syncRecording', args); }
  deleteRecording(args) { return this.call('deleteRecording', args); }
  providerStatus() { return this.call('providerStatus', {}); }
  providerCatalog(args) { return this.call('providerCatalog', args); }
  providerHealth(args) { return this.call('providerHealth', args); }
  testProviders() { return this.call('testProviders', {}); }
  prewarmSpeech(args, options) {
    return this.call('prewarmSpeech', args, { timeoutMs: SPEECH_RPC_TIMEOUT_MS, ...options });
  }
  configureProvider(args) { return this.call('configureProvider', args); }
  agentAnsweringStatus() { return this.call('agentAnsweringStatus', {}); }
  configureAgentAnswering(args) { return this.call('configureAgentAnswering', args); }
  provisionDeviceEvidence(args) { return this.call('provisionDeviceEvidence', args); }

  async startEvents() {
    if (this.eventSocket) return;
    const socket = net.createConnection(this.socketPath);
    const id = this._id();
    this.eventSocket = socket;
    socket.setEncoding('utf8');
    let pending = '';
    let acknowledged = false;
    await new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => fail(new Error('event subscription timed out')), this.timeoutMs);
      timer.unref?.();
      const cleanupHandshake = () => {
        clearTimeout(timer);
        socket.removeListener('error', fail);
        socket.removeListener('end', onEnd);
        socket.removeListener('close', onCloseBeforeAck);
      };
      const fail = (problem) => {
        if (settled) return;
        settled = true;
        cleanupHandshake();
        if (this.eventSocket === socket) this.eventSocket = null;
        socket.destroy();
        reject(problem);
      };
      const onEnd = () => fail(new Error('event connection closed before subscription response'));
      const onCloseBeforeAck = () => fail(new Error('event connection closed before subscription response'));
      socket.once('error', fail);
      socket.once('end', onEnd);
      socket.once('close', onCloseBeforeAck);
      socket.on('data', (chunk) => {
        pending += chunk;
        if (Buffer.byteLength(pending) > MAX_LINE_BYTES) {
          fail(new Error('event frame too large'));
          return;
        }
        for (;;) {
          const newline = pending.indexOf('\n');
          if (newline < 0) break;
          const line = pending.slice(0, newline);
          pending = pending.slice(newline + 1);
          try {
            const message = JSON.parse(line);
            if (!acknowledged) {
              if (message.id !== id) throw new Error('RPC response id mismatch');
              if (!exactKeys(message, ['id', 'result'])
                  || !exactKeys(message.result, ['subscribed'])
                  || message.result.subscribed !== true) {
                throw new Error('event subscription refused');
              }
              acknowledged = true;
              settled = true;
              cleanupHandshake();
              socket.on('error', (problem) => this.emit('eventError', problem));
              socket.once('close', () => {
                if (this.eventSocket === socket) this.eventSocket = null;
              });
              resolve();
            } else if (exactKeys(message, ['event'])
                && message.event && typeof message.event === 'object' && !Array.isArray(message.event)) {
              this.emit('event', message.event);
            } else {
              throw new Error('invalid event frame');
            }
          } catch (problem) {
            if (!acknowledged) fail(problem);
            else {
              socket.destroy();
              this.emit('eventError', problem);
            }
          }
        }
      });
      socket.once('connect', () => {
        try {
          write(socket, { id, method: 'events', args: {} });
        } catch (problem) {
          fail(problem);
        }
      });
    });
  }

  stopEvents() {
    this.eventSocket?.destroy();
    this.eventSocket = null;
  }

  async call(method, args, { signal, timeoutMs = this.timeoutMs } = {}) {
    validate(method, args);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_RPC_TIMEOUT_MS) {
      throw new Error('RPC timeout is invalid');
    }
    if (signal?.aborted) throw new Error('RPC call aborted');
    const id = this._id();
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(this.socketPath);
      let pending = '';
      let settled = false;
      const finish = (problem, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        socket.removeAllListeners();
        socket.destroy();
        if (problem) reject(problem);
        else resolve(result);
      };
      const onAbort = () => finish(new Error('RPC call aborted'));
      const timer = setTimeout(() => finish(new Error('RPC call timed out')), timeoutMs);
      timer.unref?.();
      signal?.addEventListener('abort', onAbort, { once: true });
      socket.setEncoding('utf8');
      socket.once('error', (problem) => finish(problem));
      socket.once('end', () => finish(new Error('RPC connection closed before response')));
      socket.once('close', () => finish(new Error('RPC connection closed before response')));
      socket.on('data', (chunk) => {
        pending += chunk;
        if (Buffer.byteLength(pending) > MAX_LINE_BYTES) {
          finish(new Error('response too large'));
          return;
        }
        const newline = pending.indexOf('\n');
        if (newline < 0) return;
        try {
          const response = JSON.parse(pending.slice(0, newline));
          if (!response || response.id !== id) throw new Error('RPC response id mismatch');
          const hasResult = Object.hasOwn(response, 'result');
          const hasError = Object.hasOwn(response, 'error');
          if (typeof response !== 'object' || Array.isArray(response)
              || Object.keys(response).length !== 2 || hasResult === hasError) {
            throw new Error('invalid RPC response');
          }
          if (hasError) {
            const problem = parseRpcError(response.error);
            finish(new GatewayRpcError(problem.code, problem.message));
          }
          else finish(null, response.result);
        } catch (problem) {
          finish(problem?.message === 'RPC response id mismatch'
            ? problem
            : new Error('invalid RPC response'));
        }
      });
      socket.once('connect', () => {
        try {
          write(socket, { id, method, args });
        } catch (problem) {
          finish(problem);
        }
      });
    });
  }
}

export { MAX_LINE_BYTES, METHODS };
