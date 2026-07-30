import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';

import { syncFinalizedRecording } from '../src/recording-artifact-sync.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'agentcall-sync-'));
  const callId = 'call-sync-1';
  const directory = join(root, callId);
  await mkdir(directory);
  const bytes = Buffer.alloc(9_000, 0x5a);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  await writeFile(join(directory, 'conversation.wav'), bytes);
  await writeFile(join(directory, 'manifest.json'), JSON.stringify({
    callId, complete: true, hashes: { 'conversation.wav': sha256 },
    tracks: { remote: { frames: 500 }, agent: { frames: 500 } },
  }));
  return { root, directory, callId, bytes, sha256 };
}

class FakeDevice extends EventEmitter {
  constructor() { super(); this.controls = []; this.chunks = []; }
  async sendControl({ payload }) {
    const value = JSON.parse(payload.toString('utf8'));
    this.controls.push(value);
    if (value.command === 'recording_artifact_commit') {
      queueMicrotask(() => this.emit('event', { payload: Buffer.from(JSON.stringify({ event: 'recording_artifact_stored', callId: value.callId })) }));
    }
  }
  async sendArtifact({ payload }) { this.chunks.push(Buffer.from(payload)); }
}

test('sync sends strict metadata ordered bounded chunks commit and waits for receipt', async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const device = new FakeDevice();
  const result = await syncFinalizedRecording({ device, directory: f.directory, callId: f.callId, timeoutMs: 1_000 });
  assert.deepEqual(result, { stored: true, callId: f.callId, bytes: f.bytes.length });
  assert.deepEqual(device.controls, [
    { command: 'recording_artifact_begin', callId: f.callId, artifact: 'conversation.wav', size: '9000', sha256: f.sha256, durationMillis: '10000' },
    { command: 'recording_artifact_commit', callId: f.callId },
  ]);
  assert.deepEqual(device.chunks.map((chunk) => chunk.length), [4096, 4096, 808]);
  assert.deepEqual(Buffer.concat(device.chunks), f.bytes);
});

test('sync rejects incomplete or mismatched finalized manifests before sending', async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const device = new FakeDevice();
  await writeFile(join(f.directory, 'manifest.json'), JSON.stringify({ callId: f.callId, complete: false }));
  await assert.rejects(() => syncFinalizedRecording({ device, directory: f.directory, callId: f.callId }), /complete/i);
  assert.equal(device.controls.length, 0);
});

test('sync fails honestly on phone failure receipt or timeout', async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const failed = new FakeDevice();
  failed.sendControl = async ({ payload }) => {
    const value = JSON.parse(payload.toString('utf8'));
    failed.controls.push(value);
    if (value.command === 'recording_artifact_commit') queueMicrotask(() => failed.emit('event', { payload: Buffer.from(JSON.stringify({ event: 'recording_artifact_failed', callId: f.callId })) }));
  };
  await assert.rejects(() => syncFinalizedRecording({ device: failed, directory: f.directory, callId: f.callId, timeoutMs: 100 }), /phone.*failed/i);

  const silent = new FakeDevice();
  silent.sendControl = async ({ payload }) => { silent.controls.push(JSON.parse(payload.toString('utf8'))); };
  await assert.rejects(() => syncFinalizedRecording({ device: silent, directory: f.directory, callId: f.callId, timeoutMs: 20 }), /timed out/i);
});
