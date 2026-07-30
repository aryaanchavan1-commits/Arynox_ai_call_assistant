import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { CallRecorder, RecordingManager, WavTrack } from '../src/recording.js';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const unixTest = process.platform === 'win32' ? test.skip : test;

test('WAV track completes legal partial filesystem writes before advancing counters', async () => {
  const writes = [];
  const handle = {
    write: async (_buffer, _offset, length, position) => {
      const bytesWritten = Math.min(320, length);
      writes.push({ length, position, bytesWritten });
      return { bytesWritten };
    },
  };
  const track = new WavTrack('/tmp/not-created.wav', handle);

  await track.write(Buffer.alloc(640));
  assert.deepEqual(writes, [
    { length: 640, position: 44, bytesWritten: 320 },
    { length: 320, position: 364, bytesWritten: 320 },
  ]);
  assert.equal(track.frames, 1);
  assert.equal(track.bytes, 640);
});

test('WAV track rejects zero-progress writes without advancing completeness counters', async () => {
  const track = new WavTrack('/tmp/not-created.wav', {
    write: async () => ({ bytesWritten: 0 }),
  });

  await assert.rejects(() => track.write(Buffer.alloc(640)), /no progress/i);
  assert.equal(track.frames, 0);
  assert.equal(track.bytes, 0);
});

test('agent recording preserves the remote call timeline before speech begins', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agentcall-recording-alignment-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const recorder = await new RecordingManager({ root, minFreeBytes: 1 }).start({
    callId: 'call-alignment', consent: { recorded: true },
  });
  const remote = Buffer.alloc(640, 0x11);
  const agent = Buffer.alloc(640, 0x22);
  await recorder.writeRemote(remote);
  await recorder.writeRemote(remote);
  await recorder.writeRemote(remote);
  await recorder.writeAgent(agent);
  const result = await recorder.finalize({ outcome: 'ended' });

  const agentWav = await readFile(join(result.directory, 'agent.wav'));
  assert.equal(agentWav.length, 44 + (3 * 640));
  assert.deepEqual(agentWav.subarray(44, 44 + (2 * 640)), Buffer.alloc(2 * 640));
  assert.deepEqual(agentWav.subarray(44 + (2 * 640)), agent);
});

test('WAV track completes a partial final header write before syncing and closing', async () => {
  let closed = 0;
  let synced = 0;
  const writes = [];
  const track = new WavTrack('/tmp/not-created.wav', {
    write: async (_buffer, offset, length, position) => {
      const bytesWritten = Math.min(20, length);
      writes.push({ offset, length, position, bytesWritten });
      return { bytesWritten };
    },
    sync: async () => { synced++; },
    close: async () => { closed++; },
  });

  await track.finalize();
  assert.deepEqual(writes, [
    { offset: 0, length: 44, position: 0, bytesWritten: 20 },
    { offset: 20, length: 24, position: 20, bytesWritten: 20 },
    { offset: 40, length: 4, position: 40, bytesWritten: 4 },
  ]);
  assert.equal(synced, 1);
  assert.equal(closed, 1);
  assert.equal(track.closed, true);
});

test('recording manager preflight and recorder finalize authoritative call artifacts', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agentcall-recording-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manager = new RecordingManager({ root, minFreeBytes: 1024 });
  const health = await manager.health();
  assert.deepEqual(health, { healthy: true, reason: 'ok' });
  await assert.rejects(() => manager.start({ callId: '../escape', consent: { recorded: true } }), /callId/i);

  const recorder = await manager.start({
    callId: 'call-001',
    sessionId: 'session-001',
    consent: { recorded: true, policy: 'test-consent' },
    provider: { stt: 'fixture', tts: 'fixture', voice: 'fixture' },
  });
  assert.equal(recorder instanceof CallRecorder, true);
  assert.equal(recorder.ready, true);

  const remote = Buffer.alloc(640, 0x11);
  const agent = Buffer.alloc(640, 0x22);
  await recorder.writeRemote(remote, { sequence: 1, timestampMicros: 1_000n });
  await recorder.writeAgent(agent, { sequence: 1, timestampMicros: 1_000n });
  await assert.rejects(() => recorder.writeRemote(Buffer.alloc(639)), /640/);
  await recorder.appendTranscript({ speaker: 'remote', text: 'consented fixture', timestampMicros: 1_000n, final: true });
  await recorder.appendEvent({ type: 'media_started', timestampMicros: 1_000n });
  const result = await recorder.finalize({ outcome: 'ended' });

  assert.equal(result.complete, true);
  assert.deepEqual(result.files.sort(), [
    'agent.wav', 'checksums.sha256', 'conversation.mkv', 'conversation.wav', 'events.jsonl', 'manifest.json', 'remote.wav', 'transcript.jsonl',
  ]);
  const remoteWav = await readFile(join(result.directory, 'remote.wav'));
  const agentWav = await readFile(join(result.directory, 'agent.wav'));
  assert.equal(remoteWav.subarray(0, 4).toString(), 'RIFF');
  assert.equal(remoteWav.subarray(8, 12).toString(), 'WAVE');
  assert.equal(remoteWav.readUInt32LE(24), 16_000);
  assert.equal(remoteWav.readUInt16LE(22), 1);
  assert.equal(remoteWav.readUInt16LE(34), 16);
  assert.equal(remoteWav.readUInt32LE(40), 640);
  assert.deepEqual(remoteWav.subarray(44), remote);
  assert.deepEqual(agentWav.subarray(44), agent);

  const manifest = JSON.parse(await readFile(join(result.directory, 'manifest.json'), 'utf8'));
  assert.equal(manifest.complete, true);
  assert.equal(manifest.callId, 'call-001');
  assert.equal(manifest.tracks.remote.frames, 1);
  assert.equal(manifest.tracks.agent.frames, 1);
  assert.equal(JSON.stringify(manifest).includes('consented fixture'), false);
  assert.equal(/pcm|payload|base64/i.test(JSON.stringify(manifest)), false);

  const checksumLines = (await readFile(join(result.directory, 'checksums.sha256'), 'utf8')).trim().split('\n');
  for (const line of checksumLines) {
    const [digest, name] = line.split('  ');
    assert.equal(digest, sha256(await readFile(join(result.directory, name))));
  }
});

test('operator deletion requires consent and appends a redacted audit record', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agentcall-recording-delete-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manager = new RecordingManager({ root, minFreeBytes: 1 });
  const recorder = await manager.start({ callId: 'call-delete', consent: { recorded: true } });
  await recorder.writeRemote(Buffer.alloc(640));
  await recorder.writeAgent(Buffer.alloc(640));
  await recorder.finalize({ outcome: 'ended' });

  await assert.rejects(
    () => manager.delete({ callId: 'call-delete', consent: { recorded: false }, operatorRole: 'operator' }),
    /consent/i,
  );
  await assert.rejects(
    () => manager.delete({ callId: 'call-delete', consent: { recorded: true }, operatorRole: 'viewer' }),
    /operator/i,
  );
  const result = await manager.delete({
    callId: 'call-delete', consent: { recorded: true }, operatorRole: 'operator', reason: 'retention request',
  });
  assert.deepEqual(result, { deleted: true, callId: 'call-delete' });
  await assert.rejects(() => readFile(join(root, 'call-delete', 'manifest.json')));
  const audit = (await readFile(join(root, 'audit.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(audit.length, 1);
  assert.deepEqual(audit[0], {
    action: 'delete', callId: 'call-delete', operatorRole: 'operator', reason: 'retention request',
  });
});

test('retention sweep deletes only explicitly expired finalized manifests and audits it', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agentcall-recording-retention-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manager = new RecordingManager({ root, minFreeBytes: 1 });
  for (const [callId, deleteAfter] of [
    ['call-expired', '2026-01-01T00:00:00.000Z'],
    ['call-retained', '2027-01-01T00:00:00.000Z'],
  ]) {
    const recorder = await manager.start({
      callId,
      consent: { recorded: true },
      retention: { deleteAfter },
    });
    await recorder.writeRemote(Buffer.alloc(640));
    await recorder.writeAgent(Buffer.alloc(640));
    await recorder.finalize({ outcome: 'ended' });
  }

  const result = await manager.sweepRetention({ now: new Date('2026-07-20T00:00:00.000Z') });
  assert.deepEqual(result, { deleted: ['call-expired'] });
  await assert.rejects(() => readFile(join(root, 'call-expired', 'manifest.json')));
  assert.equal(JSON.parse(await readFile(join(root, 'call-retained', 'manifest.json'), 'utf8')).callId, 'call-retained');
  const audit = (await readFile(join(root, 'audit.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(audit, [{ action: 'retention_delete', callId: 'call-expired' }]);
});

test('recorder marks artifacts incomplete when a required track has no frames', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agentcall-recording-partial-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const recorder = await new RecordingManager({ root, minFreeBytes: 1 }).start({
    callId: 'call-partial', consent: { recorded: true },
  });
  await recorder.writeRemote(Buffer.alloc(640));
  const result = await recorder.finalize({ outcome: 'media_failure' });
  assert.equal(result.complete, false);
  const manifest = JSON.parse(await readFile(join(result.directory, 'manifest.json'), 'utf8'));
  assert.equal(manifest.complete, false);
  assert.match(manifest.failureReasons.join(' '), /agent/i);
});

test('zero-frame calls never invoke FFmpeg or retain review artifacts', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agentcall-recording-empty-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const ffmpegCalls = [];
  const recorder = await new RecordingManager({
    root,
    minFreeBytes: 1,
    execFileImpl: async (_path, args) => {
      ffmpegCalls.push(args);
      return { stdout: '', stderr: '' };
    },
  }).start({
    callId: 'call-empty',
    consent: { recorded: true },
  });

  const result = await recorder.finalize({ outcome: 'error' });
  assert.equal(result.complete, false);
  assert.deepEqual(result.files.sort(), [
    'agent.wav', 'checksums.sha256', 'events.jsonl', 'manifest.json', 'remote.wav', 'transcript.jsonl',
  ]);
  const manifest = JSON.parse(await readFile(join(result.directory, 'manifest.json'), 'utf8'));
  assert.match(manifest.failureReasons.join(' '), /remote track has no frames/i);
  assert.match(manifest.failureReasons.join(' '), /agent track has no frames/i);
  assert.doesNotMatch(manifest.failureReasons.join(' '), /review artifact rendering failed/i);
  assert.deepEqual(ffmpegCalls, [['-version']]);
});

test('interrupted and failed outcomes remain incomplete with both tracks present', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agentcall-recording-interrupted-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const outcomes = [
    'transport_lost',
    'gateway_stopped',
    'error',
    'completed',
    'realtime_start_failed',
    'session_ack_failed',
    'media_failure',
    'unknown',
  ];

  for (const outcome of outcomes) {
    const recorder = await new RecordingManager({ root, minFreeBytes: 1 }).start({
      callId: `call-${outcome}`, consent: { recorded: true },
    });
    await recorder.writeRemote(Buffer.alloc(640, 1));
    await recorder.writeAgent(Buffer.alloc(640, 2));
    const result = await recorder.finalize({ outcome });
    const manifest = JSON.parse(await readFile(join(result.directory, 'manifest.json'), 'utf8'));

    assert.equal(result.complete, false, `${outcome} result must be incomplete`);
    assert.equal(manifest.complete, false, `${outcome} manifest must be incomplete`);
    assert.match(manifest.failureReasons.join(' '), new RegExp(outcome));
  }
});

test('recording catalog returns bounded finalized metadata and isolates corrupt entries', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agentcall-recording-catalog-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manager = new RecordingManager({ root, minFreeBytes: 1 });
  const recorder = await manager.start({
    callId: 'call-catalog',
    sessionId: 'session-private',
    consent: { recorded: true },
    retention: { deleteAfter: '2027-01-01T00:00:00.000Z' },
  });
  await recorder.writeRemote(Buffer.alloc(640, 1));
  await recorder.writeAgent(Buffer.alloc(640, 2));
  await recorder.finalize({ outcome: 'ended' });
  await mkdir(join(root, 'call-corrupt'));
  await writeFile(join(root, 'call-corrupt', 'manifest.json'), '{bad json', { mode: 0o600 });

  const catalog = await manager.list({ limit: 10 });
  assert.equal(catalog.length, 1);
  assert.deepEqual(catalog[0], {
    callId: 'call-catalog',
    complete: true,
    outcome: 'ended',
    durationMillis: 20,
    retention: { deleteAfter: '2027-01-01T00:00:00.000Z' },
    artifacts: ['agent.wav', 'conversation.mkv', 'conversation.wav', 'remote.wav'],
  });
  assert.doesNotMatch(JSON.stringify(catalog), /session-private|phone|transcript|payload|pcm/i);
});

test('recording artifact resolution accepts only fixed artifacts under a validated call directory', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agentcall-recording-artifact-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manager = new RecordingManager({ root, minFreeBytes: 1 });
  const recorder = await manager.start({ callId: 'call-artifact', consent: { recorded: true } });
  await recorder.writeRemote(Buffer.alloc(640));
  await recorder.writeAgent(Buffer.alloc(640));
  await recorder.finalize({ outcome: 'ended' });

  assert.equal(await manager.artifact({ callId: 'call-artifact', artifact: 'conversation.mkv' }), join(root, 'call-artifact', 'conversation.mkv'));
  await assert.rejects(() => manager.artifact({ callId: '../escape', artifact: 'conversation.mkv' }), /callId/i);
  await assert.rejects(() => manager.artifact({ callId: 'call-artifact', artifact: '../manifest.json' }), /artifact/i);
  await assert.rejects(() => manager.artifact({ callId: 'call-artifact', artifact: 'manifest.json' }), /artifact/i);
});

test('recording export creates a verified operator-readable runtime copy and deletion removes it', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agentcall-recording-export-source-'));
  const exportRoot = await mkdtemp(join(tmpdir(), 'agentcall-recording-export-runtime-'));
  t.after(() => Promise.all([
    rm(root, { recursive: true, force: true }),
    rm(exportRoot, { recursive: true, force: true }),
  ]));
  const manager = new RecordingManager({ root, exportRoot, minFreeBytes: 1 });
  const recorder = await manager.start({ callId: 'call-export', consent: { recorded: true } });
  await recorder.writeRemote(Buffer.alloc(640, 1));
  await recorder.writeAgent(Buffer.alloc(640, 2));
  await recorder.finalize({ outcome: 'ended' });

  const exported = await manager.exportArtifact({ callId: 'call-export', artifact: 'conversation.wav' });
  assert.equal(exported, join(await realpath(exportRoot), 'call-export', 'conversation.wav'));
  assert.deepEqual(
    await readFile(exported),
    await readFile(join(root, 'call-export', 'conversation.wav')),
  );
  assert.equal(
    await manager.exportArtifact({ callId: 'call-export', artifact: 'conversation.wav' }),
    exported,
  );
  if (process.platform !== 'win32') {
    assert.equal((await stat(exportRoot)).mode & 0o777, 0o750);
    assert.equal((await stat(join(exportRoot, 'call-export'))).mode & 0o777, 0o750);
    assert.equal((await stat(exported)).mode & 0o777, 0o640);
  }

  await manager.delete({
    callId: 'call-export', consent: { recorded: true }, operatorRole: 'operator', reason: 'test cleanup',
  });
  await assert.rejects(() => stat(exported));
});

unixTest('recording artifact resolution rejects a symlinked call directory within its root', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agentcall-recording-directory-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manager = new RecordingManager({ root, minFreeBytes: 1 });
  const recorder = await manager.start({ callId: 'call-owned', consent: { recorded: true } });
  await recorder.writeRemote(Buffer.alloc(640));
  await recorder.writeAgent(Buffer.alloc(640));
  await recorder.finalize();
  const manifestPath = join(root, 'call-owned', 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.callId = 'call-symlink';
  await writeFile(manifestPath, JSON.stringify(manifest));
  await symlink(join(root, 'call-owned'), join(root, 'call-symlink'));

  await assert.rejects(
    () => manager.artifact({ callId: 'call-symlink', artifact: 'conversation.mkv' }),
    /canonical|directory|symlink/i,
  );
});

unixTest('recording artifact resolution rejects a symlinked recording-root ancestor', async (t) => {
  const parent = await mkdtemp(join(tmpdir(), 'agentcall-recording-ancestor-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const realParent = join(parent, 'real-parent');
  const linkedParent = join(parent, 'linked-parent');
  const realRoot = join(realParent, 'recordings');
  await mkdir(realRoot, { recursive: true });
  await symlink(realParent, linkedParent);
  const manager = new RecordingManager({ root: join(linkedParent, 'recordings'), minFreeBytes: 1 });
  const recorder = await manager.start({ callId: 'call-ancestor', consent: { recorded: true } });
  await recorder.writeRemote(Buffer.alloc(640));
  await recorder.writeAgent(Buffer.alloc(640));
  await recorder.finalize();

  await assert.rejects(
    () => manager.artifact({ callId: 'call-ancestor', artifact: 'conversation.mkv' }),
    /canonical|directory|symlink/i,
  );
});

test('recording artifact resolution rejects changed bytes and symlink replacements', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agentcall-recording-integrity-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manager = new RecordingManager({ root, minFreeBytes: 1 });
  const recorder = await manager.start({ callId: 'call-integrity', consent: { recorded: true } });
  await recorder.writeRemote(Buffer.alloc(640));
  await recorder.writeAgent(Buffer.alloc(640));
  await recorder.finalize({ outcome: 'ended' });
  const artifact = join(root, 'call-integrity', 'conversation.mkv');

  await writeFile(artifact, 'changed after finalization');
  await assert.rejects(
    () => manager.artifact({ callId: 'call-integrity', artifact: 'conversation.mkv' }),
    /integrity|digest/i,
  );

  if (process.platform === 'win32') return;

  await rm(artifact);
  const outside = join(root, 'outside.mkv');
  await writeFile(outside, 'changed after finalization');
  await symlink(outside, artifact);
  await assert.rejects(
    () => manager.artifact({ callId: 'call-integrity', artifact: 'conversation.mkv' }),
    /regular|canonical|symlink/i,
  );
});
