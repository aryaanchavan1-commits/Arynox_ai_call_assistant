import net from 'node:net';
import { isAbsolute } from 'node:path';
import { EventEmitter } from 'node:events';

const DEFAULT_SOCKET = '/run/agentcall/gatewayd.sock';
const DEFAULT_REQUEST_TIMEOUT_MS = 65_000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const READ_METHODS = new Set([
  'status', 'capabilities', 'dial', 'answer', 'reject', 'hangup', 'sendDtmf',
  'listRecordings', 'exportRecordingArtifact', 'syncRecording', 'deleteRecording',
  'listContacts', 'listCallLog', 'phoneDataStatus',
    'providerStatus', 'providerHealth', 'testProviders', 'configureProvider',
    'providerCatalog', 'agentAnsweringStatus', 'configureAgentAnswering',
]);

export function desktopSocketFromEnv(env = process.env) {
  const socketPath = env.AGENTCALL_RPC_SOCKET || DEFAULT_SOCKET;
  if (typeof socketPath !== 'string' || socketPath.length < 2 || socketPath.length > 240 || !isAbsolute(socketPath)) {
    throw new Error('AGENTCALL_RPC_SOCKET must be an absolute bounded path');
  }
  return socketPath;
}

export class DesktopDaemonClient extends EventEmitter {
  constructor({ socketPath, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS }) {
    super();
    if (!socketPath) throw new Error('socketPath is required');
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
      throw new Error('timeoutMs must be a bounded positive integer');
    }
    this.socketPath = socketPath;
    this.timeoutMs = timeoutMs;
    this.nextId = 1;
    this.eventSocket = null;
    this.audioSocket = null;
    this.audioCallId = null;
  }

  status() { return this.#call('status'); }
  capabilities() { return this.#call('capabilities'); }
  dial(args) { return this.#call('dial', args); }
  answer(args) { return this.#call('answer', args); }
  reject(args) { return this.#call('reject', args); }
  hangup(args) { return this.#call('hangup', args); }
  sendDtmf(args) { return this.#call('sendDtmf', args); }
  listRecordings(args) { return this.#call('listRecordings', args); }
  exportRecordingArtifact(args) { return this.#call('exportRecordingArtifact', args); }
  syncRecording(args) { return this.#call('syncRecording', args); }
  deleteRecording(args) { return this.#call('deleteRecording', args); }
  listContacts(args) { return this.#call('listContacts', args); }
  listCallLog(args) { return this.#call('listCallLog', args); }
  phoneDataStatus() { return this.#call('phoneDataStatus'); }
  providerStatus() { return this.#call('providerStatus'); }
  providerCatalog(args) { return this.#call('providerCatalog', args); }
  providerHealth(args) { return this.#call('providerHealth', args); }
  testProviders() { return this.#call('testProviders'); }
  configureProvider(args) { return this.#call('configureProvider', args); }
  agentAnsweringStatus() { return this.#call('agentAnsweringStatus'); }
  configureAgentAnswering(args) { return this.#call('configureAgentAnswering', args); }

  async startEvents() {
    if (this.eventSocket) return;
    const socket = await this.#openStream('events', {}, (message) => {
      if (message?.event && typeof message.event === 'object') this.emit('event', message.event);
    });
    this.eventSocket = socket;
    socket.once('close', () => {
      if (this.eventSocket === socket) {
        this.eventSocket = null;
        this.emit('eventsClosed');
      }
    });
  }

  stopEvents() {
    this.eventSocket?.destroy();
    this.eventSocket = null;
  }

  async startAudio(callId) {
    if (typeof callId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(callId)) {
      throw new Error('callId is invalid');
    }
    this.stopAudio();
    const socket = await this.#openStream('audio', { callId }, (message) => {
      if (message?.audio?.callId !== callId || typeof message.audio.pcm !== 'string') return;
      const payload = Buffer.from(message.audio.pcm, 'base64');
      if (payload.length === 640) {
        this.emit('audio', { callId, payload });
      }
    });
    this.audioSocket = socket;
    this.audioCallId = callId;
    socket.once('close', () => {
      if (this.audioSocket === socket) {
        this.audioSocket = null;
        this.audioCallId = null;
        this.emit('audioClosed', { callId });
      }
    });
    return { connected: true, callId };
  }

  sendAudioPcm(callId, payload) {
    if (!this.audioSocket || this.audioCallId !== callId) throw new Error('manual audio is not connected');
    if (!Buffer.isBuffer(payload) || payload.length !== 640) {
      throw new Error('manual PCM frame must be exactly 640 bytes');
    }
    const line = `${JSON.stringify({ audio: { callId, pcm: payload.toString('base64') } })}\n`;
    if (Buffer.byteLength(line) > MAX_RESPONSE_BYTES || !this.audioSocket.write(line)) {
      throw new Error('manual audio transport is congested');
    }
  }

  stopAudio() {
    this.audioSocket?.destroy();
    this.audioSocket = null;
    this.audioCallId = null;
  }

  #openStream(method, args, onMessage) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(this.socketPath);
      socket.setEncoding('utf8');
      let pending = '';
      let acknowledged = false;
      let settled = false;
      const timer = setTimeout(() => fail(new Error(`daemon ${method} stream timed out`)), this.timeoutMs);
      const fail = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        reject(error);
      };
      socket.once('error', fail);
      socket.once('end', () => fail(new Error(`daemon ${method} stream ended incomplete`)));
      socket.on('data', (chunk) => {
        pending += chunk;
        if (Buffer.byteLength(pending) > MAX_RESPONSE_BYTES) return fail(new Error(`daemon ${method} frame is too large`));
        for (;;) {
          const newline = pending.indexOf('\n');
          if (newline < 0) break;
          const line = pending.slice(0, newline);
          pending = pending.slice(newline + 1);
          try {
            const message = JSON.parse(line);
            if (!acknowledged) {
              if (message.id !== id || message.error) throw new Error(String(message.error || 'daemon stream correlation mismatch'));
              acknowledged = true;
              settled = true;
              clearTimeout(timer);
              socket.removeListener('error', fail);
              socket.on('error', (error) => this.emit(`${method}Error`, error));
              resolve(socket);
            } else onMessage(message);
          } catch (error) {
            if (!acknowledged) fail(error);
            else {
              socket.destroy();
              this.emit(`${method}Error`, error);
            }
          }
        }
      });
      socket.once('connect', () => socket.write(`${JSON.stringify({ id, method, args })}\n`));
    });
  }

  #call(method, args = {}) {
    if (!READ_METHODS.has(method)) return Promise.reject(new Error('method not allowed'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(this.socketPath);
      let pending = '';
      let settled = false;
      let timer;
      const settle = (error, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) {
          socket.destroy();
          reject(error);
          return;
        }
        socket.end();
        resolve(result);
      };
      const fail = (error) => settle(error);
      timer = setTimeout(() => fail(new Error('daemon request timed out')), this.timeoutMs);
      socket.setEncoding('utf8');
      socket.once('error', fail);
      socket.once('end', () => fail(new Error('daemon response ended incomplete')));
      socket.once('close', () => fail(new Error('daemon response closed incomplete')));
      socket.on('data', (chunk) => {
        pending += chunk;
        if (Buffer.byteLength(pending) > MAX_RESPONSE_BYTES) {
          fail(new Error('daemon response too large'));
          return;
        }
        const newline = pending.indexOf('\n');
        if (newline < 0) return;
        try {
          const response = JSON.parse(pending.slice(0, newline));
          if (response.id !== id) throw new Error('daemon response correlation mismatch');
          if (response.error) throw new Error(String(response.error).slice(0, 160));
          settle(null, response.result);
        } catch (error) {
          fail(error);
        }
      });
      socket.once('connect', () => {
        socket.write(`${JSON.stringify({ id, method, args })}\n`);
      });
    });
  }
}

export { MAX_RESPONSE_BYTES, READ_METHODS };
