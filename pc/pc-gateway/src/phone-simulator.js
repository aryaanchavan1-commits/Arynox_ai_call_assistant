import { EventEmitter } from 'node:events';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import net from 'node:net';

import {
  DIR_DEVICE_TO_HOST,
  FrameAccumulator,
  KIND_CONTROL,
  KIND_PCM,
  PCM_FRAME_BYTES,
  encodeControlFrame,
  encodeEventFrame,
  encodePcmFrame,
} from './framing.js';

const LOOPBACK = '127.0.0.1';
const AUTH_SERVER_HELLO = Buffer.from('G2A1');
const AUTH_CLIENT_PROOF = Buffer.from('G2C1');
const AUTH_SERVER_PROOF = Buffer.from('G2S1');
const AUTH_NONCE_BYTES = 32;
const AUTH_PROOF_BYTES = 32;
const AUTH_CLIENT_RECORD_BYTES = 4 + AUTH_NONCE_BYTES + AUTH_PROOF_BYTES;

function authProof(secret, domain, serverNonce, clientNonce) {
  return createHmac('sha256', secret)
    .update(domain, 'ascii')
    .update(serverNonce)
    .update(clientNonce)
    .digest();
}

function parseJson(payload) {
  try {
    const value = JSON.parse(payload.toString('utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

export class PhoneSimulator extends EventEmitter {
  constructor({ port = 0, enrollmentSecret, authTimeoutMs = 3_000, autoEnd = false } = {}) {
    super();
    if (!Buffer.isBuffer(enrollmentSecret) || enrollmentSecret.length !== 32) {
      throw new Error('simulator enrollment secret must be exactly 32 bytes');
    }
    if (!Number.isInteger(authTimeoutMs) || authTimeoutMs < 100 || authTimeoutMs > 30_000) {
      throw new Error('simulator auth timeout must be 100..30000 ms');
    }
    this.port = port;
    this.enrollmentSecret = Buffer.from(enrollmentSecret);
    this.authTimeoutMs = authTimeoutMs;
    this.autoEnd = autoEnd;
    this.server = null;
    this.leaseSocket = null;
    this.sockets = new Set();
    this.calls = new Map();
    this.sequence = 0;
    this.metrics = { connections: 0, controls: 0, receivedPcm: 0, sentPcm: 0, calls: 0 };
  }

  async start() {
    if (this.server) throw new Error('simulator already started');
    this.server = net.createServer((socket) => this.#accept(socket));
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.port, LOOPBACK, resolve);
    });
    this.port = this.server.address().port;
    return { identity: 'SIMULATOR', host: LOOPBACK, port: this.port, simulator: true };
  }

  #accept(socket) {
    if (this.leaseSocket) {
      socket.destroy();
      return;
    }
    this.leaseSocket = socket;
    const serverNonce = randomBytes(AUTH_NONCE_BYTES);
    let authBuffer = Buffer.alloc(0);
    const timer = setTimeout(() => socket.destroy(), this.authTimeoutMs);
    const onAuthData = (chunk) => {
      authBuffer = Buffer.concat([authBuffer, chunk]);
      if (authBuffer.length < AUTH_CLIENT_RECORD_BYTES) return;
      socket.off('data', onAuthData);
      clearTimeout(timer);
      const record = authBuffer.subarray(0, AUTH_CLIENT_RECORD_BYTES);
      const remainder = authBuffer.subarray(AUTH_CLIENT_RECORD_BYTES);
      authBuffer = Buffer.alloc(0);
      if (!record.subarray(0, 4).equals(AUTH_CLIENT_PROOF)) return socket.destroy();
      const clientNonce = record.subarray(4, 36);
      const expected = authProof(
        this.enrollmentSecret,
        'agentcall-controller-client-v1\0',
        serverNonce,
        clientNonce,
      );
      const valid = timingSafeEqual(expected, record.subarray(36, 68));
      expected.fill(0);
      if (!valid) return socket.destroy();
      const serverProof = authProof(
        this.enrollmentSecret,
        'agentcall-controller-server-v1\0',
        serverNonce,
        clientNonce,
      );
      const sessionDigest = authProof(
        this.enrollmentSecret,
        'agentcall-controller-session-v1\0',
        serverNonce,
        clientNonce,
      );
      const sessionId = sessionDigest.readUInt32BE(0);
      socket.sessionId = sessionId;
      socket.write(Buffer.concat([AUTH_SERVER_PROOF, serverProof]));
      serverProof.fill(0);
      sessionDigest.fill(0);
      this.#promote(socket, remainder);
    };
    socket.on('data', onAuthData);
    socket.write(Buffer.concat([AUTH_SERVER_HELLO, serverNonce]));
    socket.once('close', () => {
      clearTimeout(timer);
      serverNonce.fill(0);
      this.sockets.delete(socket);
      if (this.leaseSocket === socket) {
        this.leaseSocket = null;
        this.calls.clear();
      }
    });
    socket.on('error', () => {});
  }

  #promote(socket, initialData) {
    this.sockets.add(socket);
    this.metrics.connections++;
    const accumulator = new FrameAccumulator();
    const consume = (chunk) => {
      for (const frame of accumulator.push(chunk)) {
        if (frame.sessionId !== socket.sessionId) return socket.destroy();
        if (frame.kind === KIND_CONTROL) this.#control(socket, parseJson(frame.payload));
        else if (frame.kind === KIND_PCM) {
          this.metrics.receivedPcm++;
          this.emit('pcm', frame);
        }
      }
      if (accumulator.failed) socket.destroy();
    };
    socket.on('data', consume);
    this.#sendControl(socket, { event: 'identity', identity: 'SIMULATOR', simulator: true });
    if (initialData.length > 0) consume(initialData);
  }

  #control(socket, command) {
    if (!command || typeof command.command !== 'string') return socket.destroy();
    this.metrics.controls++;
    this.emit('control', command);
    const callId = command.callId || `sim-${this.metrics.calls + 1}`;
    if (command.command === 'dial') {
      this.metrics.calls++;
      this.calls.set(callId, 'active');
      this.#sendEvent(socket, { event: 'active', callId, direction: 'outgoing' });
      if (this.autoEnd) this.endCall(callId);
    } else if (command.command === 'answer') {
      this.calls.set(callId, 'active');
      this.#sendEvent(socket, { event: 'active', callId, direction: 'incoming' });
    } else if (command.command === 'reject' || command.command === 'hangup') {
      this.calls.delete(callId);
      this.#sendEvent(socket, { event: 'ended', callId, reason: command.command });
    } else if (command.command === 'send_dtmf') {
      this.#sendEvent(socket, { event: 'dtmf', callId, digits: command.digits });
    }
  }

  incoming(callId) {
    if (typeof callId !== 'string' || callId.length === 0) throw new Error('callId is required');
    this.calls.set(callId, 'ringing');
    this.#broadcastEvent({ event: 'ringing', callId, direction: 'incoming' });
  }

  endCall(callId, reason = 'simulator') {
    this.calls.delete(callId);
    this.#broadcastEvent({ event: 'ended', callId, reason });
  }

  errorCall(callId, reason = 'simulator_error') {
    this.calls.delete(callId);
    this.#broadcastEvent({ event: 'error', callId, reason });
  }

  sendRemotePcm(payload = Buffer.alloc(PCM_FRAME_BYTES)) {
    if (!Buffer.isBuffer(payload) || payload.length !== PCM_FRAME_BYTES) throw new Error('PCM must be exactly 640 bytes');
    const frame = encodePcmFrame({
      direction: DIR_DEVICE_TO_HOST, sessionId: 0, sequence: this.sequence++,
      timestampMicros: BigInt(Date.now()) * 1000n, payload,
    });
    for (const socket of this.sockets) {
      frame.writeUInt32BE(socket.sessionId, 6);
      socket.write(frame);
    }
    this.metrics.sentPcm += this.sockets.size;
  }

  dropConnections() {
    for (const socket of this.sockets) socket.destroy();
  }

  #sendControl(socket, value) {
    socket.write(encodeControlFrame({
      direction: DIR_DEVICE_TO_HOST, sessionId: socket.sessionId, sequence: this.sequence++,
      timestampMicros: BigInt(Date.now()) * 1000n, payload: Buffer.from(JSON.stringify(value)),
    }));
  }

  #sendEvent(socket, value) {
    socket.write(encodeEventFrame({
      direction: DIR_DEVICE_TO_HOST, sessionId: socket.sessionId, sequence: this.sequence++,
      timestampMicros: BigInt(Date.now()) * 1000n,
      payload: Buffer.from(JSON.stringify({ ...value, simulator: true })),
    }));
  }

  #broadcastEvent(value) {
    for (const socket of this.sockets) this.#sendEvent(socket, value);
  }

  async stop() {
    this.dropConnections();
    if (this.server) await new Promise((resolve) => this.server.close(resolve));
    this.server = null;
    this.calls.clear();
    this.enrollmentSecret.fill(0);
  }
}

export default PhoneSimulator;
