import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { createHmac, randomBytes } from 'node:crypto';

import {
  DeviceClient,
  FrameAccumulator,
  encodePcmFrame,
  encodeControlFrame,
  encodeEventFrame,
  KIND_CONTROL,
  KIND_EVENT,
  KIND_PCM,
  KIND_ARTIFACT,
  DIR_HOST_TO_DEVICE,
  DIR_DEVICE_TO_HOST,
  PCM_FRAME_BYTES,
} from '../src/device-client.js';

// Loopback framed server: speaks the canonical G2 wire.
function startLoopbackServer({ onControl, onPcm, onEvent, onArtifact } = {}) {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => {
      const acc = new FrameAccumulator();
      socket.on('data', (chunk) => {
        for (const frame of acc.push(chunk)) {
          if (frame.kind === KIND_CONTROL && onControl) onControl(frame, socket);
          if (frame.kind === KIND_PCM && onPcm) onPcm(frame, socket);
          if (frame.kind === KIND_EVENT && onEvent) onEvent(frame, socket);
          if (frame.kind === KIND_ARTIFACT && onArtifact) onArtifact(frame, socket);
        }
      });
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function getPort(server) {
  return server.address().port;
}

test('DeviceClient connects only to 127.0.0.1 and refuses a non-loopback host', async () => {
  const dc = new DeviceClient();
  await assert.rejects(() => dc.connect({ host: '10.0.0.1', port: 12345 }), /loopback|127\.0\.0\.1/i);
  await assert.rejects(() => dc.connect({ host: '192.168.1.5', port: 12345 }), /loopback|127\.0\.0\.1/i);
  await assert.rejects(() => dc.connect({ host: '8.8.8.8', port: 12345 }), /loopback|127\.0\.0\.1/i);
});

test('DeviceClient connects to the loopback server and emits connected state', async () => {
  const server = await startLoopbackServer();
  const port = getPort(server);
  try {
    const dc = new DeviceClient();
    const states = [];
    dc.on('state', (s) => states.push(s));
    await dc.connect({ host: '127.0.0.1', port });
    assert.equal(dc.state, 'connected');
    assert.ok(states.includes('connected'));
    await dc.disconnect();
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('DeviceClient refuses a server that cannot prove the enrollment secret', async () => {
  const secret = randomBytes(32);
  const serverNonce = randomBytes(32);
  const server = net.createServer((socket) => {
    socket.on('error', () => {});
    socket.write(Buffer.concat([Buffer.from('G2A1'), serverNonce]));
    socket.once('data', () => socket.write(Buffer.concat([Buffer.from('G2S1'), Buffer.alloc(32)])));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const dc = new DeviceClient({ enrollmentSecret: secret, authTimeoutMs: 500 });
  try {
    await assert.rejects(
      () => dc.connect({ host: '127.0.0.1', port: getPort(server) }),
      /authentication|proof/i,
    );
    assert.equal(dc.state, 'disconnected');
  } finally {
    await dc.disconnect();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('DeviceClient authenticates mutually before sending G2 traffic', async () => {
  const secret = Buffer.alloc(32, 0x5a);
  const serverNonce = Buffer.alloc(32, 0x22);
  const received = [];
  let serverClientNonce = null;
  const server = net.createServer((socket) => {
    const chunks = [];
    let length = 0;
    socket.on('data', (chunk) => {
      chunks.push(chunk);
      length += chunk.length;
      const data = Buffer.concat(chunks, length);
      if (received.length === 0 && data.length >= 68) {
        assert.deepEqual(data.subarray(0, 4), Buffer.from('G2C1'));
        const clientNonce = data.subarray(4, 36);
        serverClientNonce = Buffer.from(clientNonce);
        const clientProof = data.subarray(36, 68);
        const expectedClient = createHmac('sha256', secret)
          .update('agentcall-controller-client-v1\0', 'ascii')
          .update(serverNonce)
          .update(clientNonce)
          .digest();
        assert.deepEqual(clientProof, expectedClient);
        const serverProof = createHmac('sha256', secret)
          .update('agentcall-controller-server-v1\0', 'ascii')
          .update(serverNonce)
          .update(clientNonce)
          .digest();
        socket.write(Buffer.concat([Buffer.from('G2S1'), serverProof]));
        received.push('authenticated');
      }
    });
    socket.write(Buffer.concat([Buffer.from('G2A1'), serverNonce]));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const dc = new DeviceClient({ enrollmentSecret: secret, authTimeoutMs: 500 });
  try {
    const states = [];
    dc.on('state', (state) => states.push(state));
    await dc.connect({ host: '127.0.0.1', port: getPort(server) });
    assert.deepEqual(states, ['authenticating', 'connected']);
    assert.deepEqual(received, ['authenticated']);
    const clientNonce = serverClientNonce;
    const expectedSessionId = createHmac('sha256', secret)
      .update('agentcall-controller-session-v1\0', 'ascii')
      .update(serverNonce)
      .update(clientNonce)
      .digest()
      .readUInt32BE(0);
    assert.equal(dc.sessionId, expectedSessionId);
  } finally {
    await dc.disconnect();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('DeviceClient rejects a concurrent connect without opening a second socket', async () => {
  const serverNonce = Buffer.alloc(32, 0x44);
  let acceptedSockets = 0;
  const sockets = new Set();
  const server = net.createServer((socket) => {
    acceptedSockets++;
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    socket.write(Buffer.concat([Buffer.from('G2A1'), serverNonce]));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const dc = new DeviceClient({ enrollmentSecret: Buffer.alloc(32, 0x33), authTimeoutMs: 200 });
  const first = dc.connect({ host: '127.0.0.1', port: getPort(server) });
  try {
    for (let i = 0; i < 50 && dc.state !== 'authenticating'; i++) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    await assert.rejects(
      () => dc.connect({ host: '127.0.0.1', port: getPort(server) }),
      /already authenticating/i,
    );
    assert.equal(acceptedSockets, 1);
  } finally {
    await dc.disconnect();
    await assert.rejects(first, /authentication|socket/i);
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('DeviceClient authentication times out without exposing connected state', async () => {
  const server = net.createServer((socket) => socket.on('error', () => {}));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const dc = new DeviceClient({ enrollmentSecret: Buffer.alloc(32, 0x33), authTimeoutMs: 100 });
  try {
    const states = [];
    dc.on('state', (state) => states.push(state));
    await assert.rejects(
      () => dc.connect({ host: '127.0.0.1', port: getPort(server) }),
      /authentication timed out/i,
    );
    assert.deepEqual(states, ['authenticating', 'disconnected']);
  } finally {
    await dc.disconnect();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('DeviceClient sends an uplink PCM frame the server can decode', async () => {
  const received = [];
  const server = await startLoopbackServer({
    onPcm: (frame) => { received.push(frame); },
  });
  const port = getPort(server);
  try {
    const dc = new DeviceClient({ sessionId: 2 });
    await dc.connect({ host: '127.0.0.1', port });
    const pcm = Buffer.alloc(PCM_FRAME_BYTES, 0x42);
    await dc.sendPcm({ direction: DIR_HOST_TO_DEVICE, sequence: 1, timestampMicros: 0n, payload: pcm });
    for (let i = 0; i < 100 && received.length < 1; i++) await new Promise((r) => setTimeout(r, 5));
    assert.equal(received.length, 1);
    assert.equal(received[0].kind, KIND_PCM);
    assert.equal(received[0].direction, DIR_HOST_TO_DEVICE);
    assert.equal(received[0].sessionId, 2);
    assert.equal(received[0].sequence, 1);
    assert.deepEqual(received[0].payload, pcm);
    await dc.disconnect();
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('DeviceClient rejects an uplink PCM payload that is not exactly 640 bytes', async () => {
  const server = await startLoopbackServer();
  const port = getPort(server);
  try {
    const dc = new DeviceClient();
    await dc.connect({ host: '127.0.0.1', port });
    await assert.rejects(
      () => dc.sendPcm({ direction: DIR_HOST_TO_DEVICE, sequence: 1, timestampMicros: 0n, payload: Buffer.alloc(PCM_FRAME_BYTES - 1) }),
      /frame|640|size/i,
    );
    await dc.disconnect();
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('DeviceClient sends bounded artifact chunks through the ordered writer', async () => {
  const received = [];
  const server = await startLoopbackServer({ onArtifact: (frame) => received.push(frame) });
  try {
    const dc = new DeviceClient({ sessionId: 8 });
    await dc.connect({ host: '127.0.0.1', port: getPort(server) });
    await dc.sendArtifact({ payload: Buffer.alloc(4096, 0x5a) });
    for (let i = 0; i < 100 && received.length < 1; i++) await new Promise((r) => setTimeout(r, 5));
    assert.equal(received.length, 1);
    assert.equal(received[0].kind, KIND_ARTIFACT);
    assert.equal(received[0].payload.length, 4096);
    await assert.rejects(() => dc.sendArtifact({ payload: Buffer.alloc(4097) }), /4096|chunk/i);
    await dc.disconnect();
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('DeviceClient emits decoded downlink control/event/pcm frames via events', async () => {
  const server = await startLoopbackServer();
  const port = getPort(server);
  let serverSocket = null;
  server.on('connection', (s) => { serverSocket = s; });
  try {
    const dc = new DeviceClient({ sessionId: 3 });
    const controlFrames = [];
    const eventFrames = [];
    const pcmFrames = [];
    dc.on('control', (f) => controlFrames.push(f));
    dc.on('event', (f) => eventFrames.push(f));
    dc.on('pcm', (f) => pcmFrames.push(f));
    await dc.connect({ host: '127.0.0.1', port });
    for (let i = 0; i < 50 && !serverSocket; i++) await new Promise((r) => setTimeout(r, 5));

    const ctrl = encodeControlFrame({
      direction: DIR_DEVICE_TO_HOST,
      sessionId: 3,
      sequence: 1,
      timestampMicros: 0n,
      payload: Buffer.from(JSON.stringify({ event: 'ringing', callId: 'c9' }), 'utf8'),
    });
    serverSocket.write(ctrl);
    const evt = encodeEventFrame({
      direction: DIR_DEVICE_TO_HOST,
      sessionId: 3,
      sequence: 2,
      timestampMicros: 10n,
      payload: Buffer.from(JSON.stringify({ event: 'hangup', callId: 'c9' }), 'utf8'),
    });
    serverSocket.write(evt);
    const media = encodePcmFrame({
      direction: DIR_DEVICE_TO_HOST,
      sessionId: 3,
      sequence: 3,
      timestampMicros: 20n,
      payload: Buffer.alloc(PCM_FRAME_BYTES, 0x33),
    });
    serverSocket.write(media);

    for (let i = 0; i < 100 && (controlFrames.length < 1 || eventFrames.length < 1 || pcmFrames.length < 1); i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    assert.equal(controlFrames.length, 1);
    assert.equal(eventFrames.length, 1);
    assert.equal(pcmFrames.length, 1);
    assert.deepEqual(JSON.parse(controlFrames[0].payload.toString('utf8')), { event: 'ringing', callId: 'c9' });
    assert.deepEqual(JSON.parse(eventFrames[0].payload.toString('utf8')), { event: 'hangup', callId: 'c9' });
    assert.equal(pcmFrames[0].payload.length, PCM_FRAME_BYTES);
    await dc.disconnect();
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('DeviceClient drops duplicate downlink PCM before metrics or emission', async () => {
  const server = await startLoopbackServer();
  const port = getPort(server);
  let serverSocket = null;
  const dc = new DeviceClient({ sessionId: 4 });
  server.on('connection', (socket) => { serverSocket = socket; });
  try {
    const pcmFrames = [];
    dc.on('pcm', (frame) => pcmFrames.push(frame));
    await dc.connect({ host: '127.0.0.1', port });
    for (let i = 0; i < 50 && !serverSocket; i++) await new Promise((resolve) => setTimeout(resolve, 5));

    serverSocket.write(encodePcmFrame({
      direction: DIR_DEVICE_TO_HOST,
      sessionId: 4,
      sequence: 7,
      timestampMicros: 20n,
      payload: Buffer.alloc(PCM_FRAME_BYTES, 0x11),
    }));
    serverSocket.write(encodePcmFrame({
      direction: DIR_DEVICE_TO_HOST,
      sessionId: 4,
      sequence: 7,
      timestampMicros: 40n,
      payload: Buffer.alloc(PCM_FRAME_BYTES, 0x22),
    }));

    for (let i = 0; i < 100 && pcmFrames.length < 2; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(pcmFrames.length, 1);
    assert.equal(dc.metrics.receivedPcm, 1);
    assert.equal(pcmFrames[0].payload[0], 0x11);
  } finally {
    await dc.disconnect();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('DeviceClient tracks sequence gaps and lost frames on the downlink PCM stream', async () => {
  const server = await startLoopbackServer();
  const port = getPort(server);
  let serverSocket = null;
  server.on('connection', (s) => { serverSocket = s; });
  try {
    const dc = new DeviceClient({ sessionId: 4 });
    await dc.connect({ host: '127.0.0.1', port });
    for (let i = 0; i < 50 && !serverSocket; i++) await new Promise((r) => setTimeout(r, 5));

    const base = 1_000_000n; // microseconds
    serverSocket.write(encodePcmFrame({ direction: DIR_DEVICE_TO_HOST, sessionId: 4, sequence: 1, timestampMicros: base, payload: Buffer.alloc(PCM_FRAME_BYTES) }));
    serverSocket.write(encodePcmFrame({ direction: DIR_DEVICE_TO_HOST, sessionId: 4, sequence: 2, timestampMicros: base + 20_000n, payload: Buffer.alloc(PCM_FRAME_BYTES) }));
    serverSocket.write(encodePcmFrame({ direction: DIR_DEVICE_TO_HOST, sessionId: 4, sequence: 5, timestampMicros: base + 80_000n, payload: Buffer.alloc(PCM_FRAME_BYTES) }));

    for (let i = 0; i < 100 && dc.metrics.receivedPcm < 3; i++) await new Promise((r) => setTimeout(r, 5));

    const m = dc.metrics;
    assert.equal(m.receivedPcm, 3);
    assert.equal(m.gaps, 1, 'one gap (2 -> 5)');
    assert.equal(m.lostFrames, 2, 'two lost frames (3,4)');
    assert.ok(m.maxLatencyMs >= 0, 'latency tracked');
    await dc.disconnect();
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('DeviceClient uses a bounded send queue and reports overflow (backpressure)', async () => {
  const dc = new DeviceClient({ sessionId: 5, sendQueueLimit: 4 });
  // Inject a fake, always-backpressured socket so the queue cannot drain.
  // This exercises the _enqueue overflow path deterministically (no TCP buffering luck).
  dc._socket = {
    destroyed: false,
    write: () => false, // kernel "full": every write backpressures
    once: () => {}, // never drains
    removeAllListeners: () => {},
    destroy: () => { dc._socket.destroyed = true; },
  };
  dc._setState('connected');

  let overflow = 0;
  dc.on('overflow', () => { overflow++; });
  const pcm = Buffer.alloc(PCM_FRAME_BYTES, 0x01);
  const pending = [];
  for (let i = 0; i < 200; i++) {
    pending.push(dc.sendPcm({ direction: DIR_HOST_TO_DEVICE, sequence: i, timestampMicros: BigInt(i), payload: pcm }).then(() => 'ok', () => 'dropped'));
  }
  await new Promise((r) => setImmediate(r));
  assert.ok(overflow > 0, 'overflow reported when queue limit exceeded');
  assert.ok(dc.metrics.droppedSends > 0, 'droppedSends incremented');
  await dc.disconnect();
  const settled = await Promise.allSettled(pending);
  // .then(()=>'ok', ()=>'dropped') maps dropped sends to a fulfilled 'dropped' value.
  assert.ok(settled.filter((s) => s.value === 'dropped').length > 0, 'some sends dropped under backpressure');
});

test('DeviceClient cleans up on remote disconnect (no leak, state -> disconnected)', async () => {
  const server = await startLoopbackServer();
  const port = getPort(server);
  let serverSocket = null;
  server.on('connection', (s) => { serverSocket = s; });
  try {
    const dc = new DeviceClient({ sessionId: 6 });
    const states = [];
    dc.on('state', (s) => states.push(s));
    await dc.connect({ host: '127.0.0.1', port });
    for (let i = 0; i < 50 && !serverSocket; i++) await new Promise((r) => setTimeout(r, 5));
    serverSocket.destroy();
    for (let i = 0; i < 100 && dc.state !== 'disconnected'; i++) await new Promise((r) => setTimeout(r, 5));
    assert.equal(dc.state, 'disconnected');
    assert.ok(states.includes('disconnected'));
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('DeviceClient sendPcm after disconnect is a rejected no-op (no throw)', async () => {
  const dc = new DeviceClient({ sessionId: 7 });
  await assert.rejects(
    () => dc.sendPcm({ direction: DIR_HOST_TO_DEVICE, sequence: 1, timestampMicros: 0n, payload: Buffer.alloc(PCM_FRAME_BYTES) }),
    /not connected|disconnected/i,
  );
});
