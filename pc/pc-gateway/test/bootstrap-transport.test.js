import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { BootstrapTransport } from '../src/bootstrap-transport.js';

class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.writes = [];
    this.destroyed = false;
  }

  write(value) { this.writes.push(Buffer.from(value)); return true; }
  destroy() { this.destroyed = true; this.emit('close'); }
}

function frame(body) {
  const output = Buffer.alloc(4 + body.length);
  output.writeUInt32BE(body.length, 0);
  body.copy(output, 4);
  return output;
}

const identity = Object.freeze({
  serial: '0123456789ABCDEF', product: 'gram', device: 'atoll', api: 35,
  systemFingerprint: 'system/fingerprint', vendorFingerprint: 'vendor/fingerprint',
  packageName: 'com.callagent.gateway', versionCode: 42,
  signingCertSha256: 'a'.repeat(64), artifactManifestSha256: 'b'.repeat(64),
  desktopBootstrapVersion: 1,
});

async function tick() { await new Promise((resolve) => setImmediate(resolve)); }

test('bootstrap transport exchanges exact bounded Android v1 binary frames and sends one-way confirm', async () => {
  const socket = new FakeSocket();
  const transport = new BootstrapTransport({
    host: '127.0.0.1', port: 54321, timeoutMs: 1000,
    connect: ({ host, port }) => {
      assert.deepEqual({ host, port }, { host: '127.0.0.1', port: 54321 });
      queueMicrotask(() => socket.emit('connect'));
      return socket;
    },
  });
  const request = {
    desktopNonce: Buffer.alloc(32, 1), desktopPublicKey: Buffer.alloc(32, 2), identity,
  };
  const exchange = transport.exchange(request);
  await tick();
  assert.equal(socket.writes.length, 1);
  const hello = socket.writes[0];
  assert.equal(hello.readUInt32BE(0), hello.length - 4);
  assert.deepEqual(hello.subarray(4, 12), Buffer.from('4732423101010000', 'hex'));
  assert.equal(hello.includes(Buffer.from('{"type"')), false, 'wire format must not be JSON');

  const phoneNonce = Buffer.alloc(32, 3);
  const phonePublicKey = Buffer.alloc(32, 4);
  const ciphertext = Buffer.alloc(Buffer.byteLength('agentcall-bootstrap-proof-v1'), 5);
  const tag = Buffer.alloc(16, 6);
  socket.emit('data', frame(Buffer.concat([
    Buffer.from('4732425301', 'hex'), phoneNonce, phonePublicKey, ciphertext, tag,
  ])));
  const response = await exchange;
  assert.deepEqual(response.phoneNonce, phoneNonce);
  assert.deepEqual(response.phonePublicKey, phonePublicKey);
  assert.deepEqual(response.proof, {
    nonce: Buffer.from('000000000000000000000001', 'hex'), ciphertext, tag,
  });

  await transport.confirm({
    proof: {
      nonce: Buffer.from('000000000000000000000002', 'hex'),
      ciphertext: Buffer.alloc(Buffer.byteLength('agentcall-bootstrap-proof-v1'), 7),
      tag: Buffer.alloc(16, 8),
    },
  });
  assert.equal(socket.writes.length, 2);
  const confirm = socket.writes[1];
  assert.equal(confirm.readUInt32BE(0), confirm.length - 4);
  assert.deepEqual(confirm.subarray(4, 9), Buffer.from('4732424301', 'hex'));
  assert.equal(confirm.length, 4 + 5 + Buffer.byteLength('agentcall-bootstrap-proof-v1') + 16);
  assert.equal(typeof transport.commit, 'undefined', 'Android v1 has no bootstrap commit request');

  await transport.close();
  assert.equal(socket.destroyed, true);
  assert.equal(typeof transport.commit, 'undefined', 'bootstrap namespace is not reopened after operational G2');
});

test('bootstrap transport accepts fragmented Android response frames', async () => {
  const socket = new FakeSocket();
  const transport = new BootstrapTransport({
    host: '127.0.0.1', port: 54321, timeoutMs: 1000,
    connect: () => { queueMicrotask(() => socket.emit('connect')); return socket; },
  });
  const pending = transport.exchange({ desktopNonce: Buffer.alloc(32, 1), desktopPublicKey: Buffer.alloc(32, 2), identity });
  await tick();
  const response = frame(Buffer.concat([
    Buffer.from('4732425301', 'hex'), Buffer.alloc(32, 3), Buffer.alloc(32, 4),
    Buffer.alloc(Buffer.byteLength('agentcall-bootstrap-proof-v1'), 5), Buffer.alloc(16, 6),
  ]));
  socket.emit('data', response.subarray(0, 3));
  socket.emit('data', response.subarray(3, 19));
  socket.emit('data', response.subarray(19));
  assert.equal((await pending).phoneNonce.length, 32);
  await transport.close();
});

test('bootstrap transport rejects oversized or malformed response frames and closes', async () => {
  for (const body of [Buffer.alloc(4097), Buffer.from('not-an-android-frame')]) {
    const socket = new FakeSocket();
    const transport = new BootstrapTransport({
      host: '127.0.0.1', port: 54321, timeoutMs: 1000,
      connect: () => { queueMicrotask(() => socket.emit('connect')); return socket; },
    });
    const pending = transport.exchange({ desktopNonce: Buffer.alloc(32, 1), desktopPublicKey: Buffer.alloc(32, 2), identity });
    await tick();
    socket.emit('data', frame(body));
    await assert.rejects(pending, /bootstrap|4096|frame|response/i);
    assert.equal(socket.destroyed, true);
  }
});
