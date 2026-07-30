// PC-side client for the ADB-forwarded localhost framed socket.
// Invariants enforced here, not at a separate layer:
//  - connect() only ever dials 127.0.0.1 (loopback). No LAN/Wi-Fi.
//  - uplink PCM payloads must be exactly PCM_FRAME_BYTES (approved 16k/mono/20ms PCM16).
//  - send queue is bounded; overflow drops the new send and reports backpressure.
//  - remote disconnect zeroes buffers and moves to 'disconnected'.

import net from 'node:net';
import { EventEmitter } from 'node:events';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  FrameAccumulator,
  encodeFrame,
  encodePcmFrame,
  encodeControlFrame,
  encodeEventFrame,
  encodeArtifactFrame,
  KIND_CONTROL,
  KIND_EVENT,
  KIND_PCM,
  KIND_ARTIFACT,
  DIR_HOST_TO_DEVICE,
  DIR_DEVICE_TO_HOST,
  PCM_FRAME_BYTES,
} from './framing.js';

const LOOPBACK_HOST = '127.0.0.1';
const AUTH_MAGIC_SERVER_HELLO = Buffer.from('G2A1');
const AUTH_MAGIC_CLIENT_PROOF = Buffer.from('G2C1');
const AUTH_MAGIC_SERVER_PROOF = Buffer.from('G2S1');
const AUTH_NONCE_BYTES = 32;
const AUTH_PROOF_BYTES = 32;
const AUTH_SERVER_HELLO_BYTES = 4 + AUTH_NONCE_BYTES;
const AUTH_SERVER_PROOF_BYTES = 4 + AUTH_PROOF_BYTES;

function authProof(secret, domain, serverNonce, clientNonce) {
  return createHmac('sha256', secret)
    .update(domain, 'ascii')
    .update(serverNonce)
    .update(clientNonce)
    .digest();
}

export {
  // re-export so callers import framing constants from one place
  FrameAccumulator,
  encodePcmFrame,
  encodeControlFrame,
  encodeEventFrame,
  encodeArtifactFrame,
  KIND_CONTROL,
  KIND_EVENT,
  KIND_PCM,
  KIND_ARTIFACT,
  DIR_HOST_TO_DEVICE,
  DIR_DEVICE_TO_HOST,
  PCM_FRAME_BYTES,
};

export class DeviceClient extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.sessionId = opts.sessionId ?? 1;
    if (opts.enrollmentSecret !== undefined
      && (!Buffer.isBuffer(opts.enrollmentSecret) || opts.enrollmentSecret.length !== 32)) {
      throw new TypeError('enrollmentSecret must be exactly 32 bytes');
    }
    this._enrollmentSecret = opts.enrollmentSecret ? Buffer.from(opts.enrollmentSecret) : null;
    this.authTimeoutMs = opts.authTimeoutMs ?? 3000;
    this.sendQueueLimit = opts.sendQueueLimit ?? 256; // bounded; never unbounded
    this._socket = null;
    this._acc = new FrameAccumulator();
    this._sendQueue = [];
    this._flushing = false;
    this._txSeq = 0;
    this._rxLastSeq = new Map(); // per-direction last seen sequence
    this._state = 'disconnected';
    this._metrics = {
      receivedPcm: 0,
      receivedControl: 0,
      receivedEvent: 0,
      gaps: 0,
      lostFrames: 0,
      maxLatencyMs: 0,
      sentPcm: 0,
      droppedSends: 0,
    };
  }

  get state() {
    return this._state;
  }

  get metrics() {
    return this._metrics;
  }

  _setState(s) {
    if (this._state === s) return;
    this._state = s;
    this.emit('state', s);
  }

  connect({ host, port }) {
    // ponytail: hard loopback gate. No option overrides this. No LAN/Wi-Fi dial.
    if (host !== LOOPBACK_HOST && host !== 'localhost') {
      return Promise.reject(new Error(`refused non-loopback host: ${host}; only 127.0.0.1 is permitted`));
    }
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      return Promise.reject(new Error('invalid port'));
    }
    if (this._socket || this._state !== 'disconnected') {
      const phase = this._state === 'disconnected' ? 'connecting' : this._state;
      return Promise.reject(new Error(`already ${phase}`));
    }
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: LOOPBACK_HOST, port });
      this._socket = socket;
      let settled = false;
      let authTimer = null;
      let authBuffer = Buffer.alloc(0);
      let serverNonce = null;
      let clientNonce = null;
      let authStage = 'server-hello';
      const finishError = (err) => {
        if (settled) return;
        settled = true;
        if (authTimer) clearTimeout(authTimer);
        if (serverNonce) serverNonce.fill(0);
        if (clientNonce) clientNonce.fill(0);
        authBuffer.fill(0);
        this._teardown(`authentication failed: ${err.message}`);
        reject(err);
      };
      const finishConnected = (remainder = Buffer.alloc(0)) => {
        if (settled) return;
        settled = true;
        if (authTimer) clearTimeout(authTimer);
        socket.removeListener('error', onError);
        socket.removeListener('data', onAuthData);
        if (serverNonce) serverNonce.fill(0);
        if (clientNonce) clientNonce.fill(0);
        authBuffer.fill(0);
        socket.on('data', (chunk) => this._onData(chunk));
        this._setState('connected');
        resolve();
        if (remainder.length > 0) this._onData(remainder);
      };
      const onError = (err) => {
        socket.removeListener('connect', onConnect);
        finishError(err);
      };
      const onAuthData = (chunk) => {
        authBuffer = Buffer.concat([authBuffer, chunk]);
        if (authStage === 'server-hello' && authBuffer.length >= AUTH_SERVER_HELLO_BYTES) {
          const hello = authBuffer.subarray(0, AUTH_SERVER_HELLO_BYTES);
          authBuffer = Buffer.from(authBuffer.subarray(AUTH_SERVER_HELLO_BYTES));
          if (!hello.subarray(0, 4).equals(AUTH_MAGIC_SERVER_HELLO)) {
            finishError(new Error('controller authentication server hello is invalid'));
            return;
          }
          serverNonce = Buffer.from(hello.subarray(4));
          clientNonce = randomBytes(AUTH_NONCE_BYTES);
          const proof = authProof(
            this._enrollmentSecret,
            'agentcall-controller-client-v1\0',
            serverNonce,
            clientNonce,
          );
          socket.write(Buffer.concat([AUTH_MAGIC_CLIENT_PROOF, clientNonce, proof]));
          proof.fill(0);
          authStage = 'server-proof';
        }
        if (authStage === 'server-proof' && authBuffer.length >= AUTH_SERVER_PROOF_BYTES) {
          const response = authBuffer.subarray(0, AUTH_SERVER_PROOF_BYTES);
          const remainder = Buffer.from(authBuffer.subarray(AUTH_SERVER_PROOF_BYTES));
          if (!response.subarray(0, 4).equals(AUTH_MAGIC_SERVER_PROOF)) {
            finishError(new Error('controller authentication server proof header is invalid'));
            return;
          }
          const expected = authProof(
            this._enrollmentSecret,
            'agentcall-controller-server-v1\0',
            serverNonce,
            clientNonce,
          );
          const valid = timingSafeEqual(expected, response.subarray(4));
          expected.fill(0);
          if (!valid) {
            finishError(new Error('controller authentication server proof mismatch'));
            return;
          }
          const sessionDigest = authProof(
            this._enrollmentSecret,
            'agentcall-controller-session-v1\0',
            serverNonce,
            clientNonce,
          );
          this.sessionId = sessionDigest.readUInt32BE(0);
          sessionDigest.fill(0);
          finishConnected(remainder);
        }
      };
      const onConnect = () => {
        if (!this._enrollmentSecret) {
          finishConnected();
          return;
        }
        this._setState('authenticating');
        authTimer = setTimeout(
          () => finishError(new Error('controller authentication timed out')),
          this.authTimeoutMs,
        );
        socket.on('data', onAuthData);
      };
      socket.once('error', onError);
      socket.once('connect', onConnect);
      socket.on('error', (err) => this._teardown(`socket error: ${err.message}`));
      socket.on('close', () => this._teardown('socket closed'));
      socket.on('end', () => this._teardown('socket ended'));
    });
  }

  _onData(chunk) {
    for (const frame of this._acc.push(chunk)) {
      if (!this._admitRx(frame)) continue;
      if (frame.kind === KIND_PCM) {
        this._metrics.receivedPcm++;
        this._trackLatency(frame);
        this.emit('pcm', frame);
      } else if (frame.kind === KIND_CONTROL) {
        this._metrics.receivedControl++;
        this.emit('control', frame);
      } else if (frame.kind === KIND_EVENT) {
        this._metrics.receivedEvent++;
        this.emit('event', frame);
      }
    }
  }

  _admitRx(frame) {
    const last = this._rxLastSeq.get(frame.direction);
    if (last === undefined) {
      this._rxLastSeq.set(frame.direction, frame.sequence);
      return true;
    }
    const distance = (frame.sequence - last) >>> 0;
    if (distance === 0 || distance > 0x7fffffff) return false;
    this._rxLastSeq.set(frame.direction, frame.sequence);
    if (distance > 1) {
      this._metrics.gaps++;
      this._metrics.lostFrames += distance - 1;
    }
    return true;
  }

  _trackLatency(frame) {
    // Latency: socket arrives ~now vs frame timestampMicros. Wall clock ms.
    // ponytail: monotonic-ish via Date in ms; sufficient for gap/overrun accounting.
    const nowMs = Date.now();
    const frameMs = Number(frame.timestampMicros / 1000n);
    let delta = nowMs - frameMs;
    if (delta < 0) delta = 0; // clock skew: clamp rather than report nonsense
    if (delta > this._metrics.maxLatencyMs) this._metrics.maxLatencyMs = delta;
  }

  /**
   * Send a PCM frame uplink (PC -> phone). payload must be exactly PCM_FRAME_BYTES.
   * Sequence/timestamp assigned if omitted.
   */
  sendPcm({ direction = DIR_HOST_TO_DEVICE, sequence, timestampMicros, payload, flags = 0 } = {}) {
    if (this._state !== 'connected' || !this._socket || this._socket.destroyed) {
      return Promise.reject(new Error('not connected'));
    }
    if (!Buffer.isBuffer(payload)) return Promise.reject(new TypeError('payload must be a Buffer'));
    if (payload.length !== PCM_FRAME_BYTES) {
      return Promise.reject(new RangeError(`PCM frame must be exactly ${PCM_FRAME_BYTES} bytes, got ${payload.length}`));
    }
    if (sequence === undefined) sequence = this._txSeq++;
    if (timestampMicros === undefined) timestampMicros = BigInt(Date.now()) * 1000n;
    const buf = encodePcmFrame({ direction, sessionId: this.sessionId, sequence, timestampMicros, payload, flags });
    return this._enqueue(buf);
  }

  sendControl({ direction = DIR_HOST_TO_DEVICE, sequence, timestampMicros, payload, flags = 0 } = {}) {
    if (this._state !== 'connected' || !this._socket || this._socket.destroyed) {
      return Promise.reject(new Error('not connected'));
    }
    if (!Buffer.isBuffer(payload)) return Promise.reject(new TypeError('payload must be a Buffer'));
    if (sequence === undefined) sequence = this._txSeq++;
    if (timestampMicros === undefined) timestampMicros = BigInt(Date.now()) * 1000n;
    const buf = encodeControlFrame({ direction, sessionId: this.sessionId, sequence, timestampMicros, payload, flags });
    return this._enqueue(buf);
  }

  sendArtifact({ direction = DIR_HOST_TO_DEVICE, sequence, timestampMicros, payload, flags = 0 } = {}) {
    if (this._state !== 'connected' || !this._socket || this._socket.destroyed) {
      return Promise.reject(new Error('not connected'));
    }
    if (!Buffer.isBuffer(payload)) return Promise.reject(new TypeError('payload must be a Buffer'));
    if (payload.length < 1 || payload.length > 4096) return Promise.reject(new RangeError('artifact chunk must be 1..4096 bytes'));
    if (sequence === undefined) sequence = this._txSeq++;
    if (timestampMicros === undefined) timestampMicros = BigInt(Date.now()) * 1000n;
    const buf = encodeArtifactFrame({ direction, sessionId: this.sessionId, sequence, timestampMicros, payload, flags });
    return this._enqueue(buf);
  }

  _enqueue(buf) {
    if (this._sendQueue.length >= this.sendQueueLimit) {
      this._metrics.droppedSends++;
      this.emit('overflow', { queueLen: this._sendQueue.length, limit: this.sendQueueLimit });
      // Drop this new send: backpressure prevents unbounded growth.
      return Promise.reject(new Error('send queue overflow'));
    }
    const p = new Promise((resolve, reject) => {
      this._sendQueue.push({ buf, resolve, reject });
    });
    this._flush();
    return p;
  }

  _flush() {
    if (this._flushing) return;
    if (this._sendQueue.length === 0) return;
    if (!this._socket || this._socket.destroyed) return;
    this._flushing = true;
    const drain = () => {
      while (this._sendQueue.length) {
        if (!this._socket || this._socket.destroyed) {
          const err = new Error('socket closed during flush');
          while (this._sendQueue.length) this._sendQueue.shift().reject(err);
          this._flushing = false;
          return;
        }
        const { buf, resolve } = this._sendQueue[0];
        const ok = this._socket.write(buf);
        // Hand the frame to the kernel; resolve once accepted into the write buffer.
        this._sendQueue.shift();
        resolve();
        if (!ok) {
          // Kernel write buffer is full: wait for drain before touching the queue again.
          // New sendPcm() calls can still enqueue; _enqueue enforces the bound.
          this._socket.once('drain', drain);
          return;
        }
      }
      this._flushing = false;
    };
    drain();
  }

  async disconnect() {
    this._teardown('client disconnect');
  }

  _teardown(reason) {
    if (this._state === 'disconnected' && !this._socket) return;
    this._setState('disconnected');
    // zeroize pending buffers: do not leak PCM.
    for (const item of this._sendQueue) {
      item.buf.fill(0);
      item.reject(new Error(`disconnected: ${reason}`));
    }
    this._sendQueue.length = 0;
    this._acc = new FrameAccumulator();
    if (this._socket) {
      this._socket.removeAllListeners();
      try { this._socket.destroy(); } catch { /* already destroyed */ }
      this._socket = null;
    }
    this._rxLastSeq.clear();
  }
}
