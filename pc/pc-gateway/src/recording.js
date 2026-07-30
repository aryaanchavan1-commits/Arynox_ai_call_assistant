import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  access, chmod, copyFile, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, statfs,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { PCM_FRAME_BYTES, PCM_SAMPLE_RATE } from './framing.js';

const execFileAsync = promisify(execFile);
const CALL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const REQUIRED_ARTIFACTS = Object.freeze([
  'remote.wav', 'agent.wav', 'conversation.wav', 'conversation.mkv',
  'transcript.jsonl', 'events.jsonl', 'manifest.json',
]);
const PLAYABLE_ARTIFACTS = Object.freeze(['remote.wav', 'agent.wav', 'conversation.wav', 'conversation.mkv']);
const COMPLETE_OUTCOMES = new Set(['ended']);
const SILENCE_PAD_FRAMES = 50;
const SILENCE_PAD = Buffer.alloc(PCM_FRAME_BYTES * SILENCE_PAD_FRAMES);
const sameCanonicalPath = (left, right) => process.platform === 'win32'
  ? left.toLowerCase() === right.toLowerCase()
  : left === right;

async function assertNoSymlinkAncestors(path) {
  let current = resolve(path);
  for (;;) {
    if ((await lstat(current)).isSymbolicLink()) {
      throw new Error('recording root must be a canonical non-symlink directory');
    }
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

function wavHeader(dataBytes) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(PCM_SAMPLE_RATE, 24);
  header.writeUInt32LE(PCM_SAMPLE_RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataBytes, 40);
  return header;
}

function safeJson(value) {
  return `${JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item)}\n`;
}

async function atomicWrite(path, content) {
  const temporary = `${path}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
}

async function digest(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

async function writeExact(handle, buffer, offset, length, position) {
  let completed = 0;
  while (completed < length) {
    const remaining = length - completed;
    const { bytesWritten } = await handle.write(
      buffer,
      offset + completed,
      remaining,
      position + completed,
    );
    if (!Number.isInteger(bytesWritten) || bytesWritten < 1 || bytesWritten > remaining) {
      throw new Error('recording write made no progress');
    }
    completed += bytesWritten;
  }
}

export class WavTrack {
  constructor(path, handle) {
    this.path = path;
    this.handle = handle;
    this.frames = 0;
    this.bytes = 0;
    this.closed = false;
  }

  static async open(path) {
    const handle = await open(path, 'wx', 0o600);
    try {
      await writeExact(handle, wavHeader(0), 0, 44, 0);
      return new WavTrack(path, handle);
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  async write(frame) {
    if (this.closed) throw new Error('track is closed');
    if (!Buffer.isBuffer(frame) || frame.length !== PCM_FRAME_BYTES) {
      throw new RangeError(`audio frame must be exactly ${PCM_FRAME_BYTES} bytes`);
    }
    await writeExact(this.handle, frame, 0, frame.length, 44 + this.bytes);
    this.frames++;
    this.bytes += frame.length;
  }

  async padTo(targetFrames) {
    if (this.closed) throw new Error('track is closed');
    if (!Number.isSafeInteger(targetFrames) || targetFrames < 0) {
      throw new RangeError('target frame count must be a nonnegative safe integer');
    }
    while (this.frames < targetFrames) {
      const frames = Math.min(targetFrames - this.frames, SILENCE_PAD_FRAMES);
      const bytes = frames * PCM_FRAME_BYTES;
      await writeExact(this.handle, SILENCE_PAD, 0, bytes, 44 + this.bytes);
      this.frames += frames;
      this.bytes += bytes;
    }
  }

  async finalize() {
    if (this.closed) return;
    try {
      await writeExact(this.handle, wavHeader(this.bytes), 0, 44, 0);
      await this.handle.sync();
    } finally {
      await this.handle.close();
      this.closed = true;
    }
  }
}

function validateCallId(callId) {
  if (typeof callId !== 'string' || !CALL_ID_RE.test(callId)) throw new Error('invalid callId');
  return callId;
}

export class RecordingManager {
  constructor({
    root,
    exportRoot = null,
    minFreeBytes = 1024 * 1024 * 1024,
    ffmpegPath = 'ffmpeg',
    execFileImpl = execFileAsync,
  } = {}) {
    if (typeof root !== 'string' || root.length === 0) throw new Error('recording root is required');
    if (exportRoot !== null
        && (typeof exportRoot !== 'string' || exportRoot.length < 2
          || exportRoot.length > 300 || !isAbsolute(exportRoot))) {
      throw new Error('recording export root must be an absolute bounded path');
    }
    if (typeof execFileImpl !== 'function') throw new TypeError('recording execFile implementation is required');
    this.root = root;
    this.exportRoot = exportRoot;
    this.minFreeBytes = minFreeBytes;
    this.ffmpegPath = ffmpegPath;
    this.execFileImpl = execFileImpl;
    this.auditWork = Promise.resolve();
  }

  async #appendAudit(value) {
    this.auditWork = this.auditWork.then(async () => {
      const handle = await open(join(this.root, 'audit.jsonl'), 'a', 0o600);
      try {
        await handle.writeFile(safeJson(value));
        await handle.sync();
      } finally {
        await handle.close();
      }
    });
    await this.auditWork;
  }

  async list({ limit = 100 } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error('recording limit must be 1..200');
    const entries = await readdir(this.root, { withFileTypes: true });
    const recordings = [];
    for (const entry of entries) {
      if (recordings.length >= limit) break;
      if (!entry.isDirectory() || !CALL_ID_RE.test(entry.name)) continue;
      try {
        const manifest = JSON.parse(await readFile(join(this.root, entry.name, 'manifest.json'), 'utf8'));
        if (manifest?.callId !== entry.name || manifest?.complete !== true) continue;
        const remoteFrames = Number(manifest?.tracks?.remote?.frames);
        const agentFrames = Number(manifest?.tracks?.agent?.frames);
        if (!Number.isSafeInteger(remoteFrames) || remoteFrames < 0 || !Number.isSafeInteger(agentFrames) || agentFrames < 0) continue;
        const artifacts = PLAYABLE_ARTIFACTS.filter((name) => typeof manifest?.hashes?.[name] === 'string').sort();
        recordings.push({
          callId: entry.name,
          complete: true,
          outcome: typeof manifest.outcome === 'string' ? manifest.outcome.slice(0, 64) : 'unknown',
          durationMillis: Math.max(remoteFrames, agentFrames) * 20,
          retention: manifest.retention && typeof manifest.retention === 'object'
            ? { deleteAfter: typeof manifest.retention.deleteAfter === 'string' ? manifest.retention.deleteAfter.slice(0, 64) : null }
            : null,
          artifacts,
        });
      } catch {
        // Corrupt or partially-written entries are excluded from the finalized catalog.
      }
    }
    return recordings;
  }

  async artifact({ callId, artifact } = {}) {
    const safeCallId = validateCallId(callId);
    if (!PLAYABLE_ARTIFACTS.includes(artifact)) throw new Error('recording artifact is not allowed');
    const callDirectory = join(this.root, safeCallId);
    const canonicalRoot = await realpath(this.root);
    if (process.platform === 'win32') await assertNoSymlinkAncestors(this.root);
    else if (!sameCanonicalPath(canonicalRoot, this.root)) throw new Error('recording root must be a canonical non-symlink directory');
    const callDirectoryStats = await lstat(callDirectory);
    const canonicalCallDirectory = await realpath(callDirectory);
    if (!callDirectoryStats.isDirectory() || !sameCanonicalPath(canonicalCallDirectory, join(canonicalRoot, safeCallId))) {
      throw new Error('recording call directory must be canonical and non-symlink');
    }
    const manifest = JSON.parse(await readFile(join(callDirectory, 'manifest.json'), 'utf8'));
    const expectedDigest = manifest?.hashes?.[artifact];
    if (manifest?.callId !== safeCallId || manifest?.complete !== true
        || typeof expectedDigest !== 'string' || !/^[a-f0-9]{64}$/.test(expectedDigest)) {
      throw new Error('recording artifact is unavailable');
    }
    const path = join(callDirectory, artifact);
    const stats = await lstat(path);
    if (!stats.isFile()) throw new Error('recording artifact must be a regular file');
    const canonicalPath = await realpath(path);
    const containment = relative(canonicalRoot, canonicalPath);
    if (containment.startsWith('..') || containment === '' || !sameCanonicalPath(dirname(canonicalPath), canonicalCallDirectory)) {
      throw new Error('recording artifact is outside the canonical recording path');
    }
    await access(path, constants.R_OK);
    if (await digest(path) !== expectedDigest) throw new Error('recording artifact digest integrity check failed');
    return path;
  }

  async exportArtifact({ callId, artifact } = {}) {
    if (!this.exportRoot) throw new Error('recording export is unavailable');
    const safeCallId = validateCallId(callId);
    const source = await this.artifact({ callId: safeCallId, artifact });
    await mkdir(this.exportRoot, { recursive: true, mode: 0o750 });
    if (process.platform !== 'win32') await chmod(this.exportRoot, 0o750);
    const canonicalExportRoot = await realpath(this.exportRoot);
    if (process.platform === 'win32') await assertNoSymlinkAncestors(this.exportRoot);
    else if (!sameCanonicalPath(canonicalExportRoot, this.exportRoot)) {
      throw new Error('recording export root must be a canonical non-symlink directory');
    }

    const callDirectory = join(canonicalExportRoot, safeCallId);
    await mkdir(callDirectory, { recursive: true, mode: 0o750 });
    if (process.platform !== 'win32') await chmod(callDirectory, 0o750);
    const callDirectoryStats = await lstat(callDirectory);
    const canonicalCallDirectory = await realpath(callDirectory);
    if (!callDirectoryStats.isDirectory()
        || !sameCanonicalPath(canonicalCallDirectory, join(canonicalExportRoot, safeCallId))) {
      throw new Error('recording export directory must be canonical and non-symlink');
    }

    const destination = join(canonicalCallDirectory, artifact);
    const temporary = join(canonicalCallDirectory, `.${artifact}.${randomUUID()}.tmp`);
    try {
      await copyFile(source, temporary, constants.COPYFILE_EXCL);
      if (process.platform !== 'win32') await chmod(temporary, 0o640);
      const [sourceDigest, exportedDigest] = await Promise.all([digest(source), digest(temporary)]);
      if (sourceDigest !== exportedDigest) throw new Error('recording export digest integrity check failed');
      await rm(destination, { force: true });
      await rename(temporary, destination);
      if (process.platform !== 'win32') await chmod(destination, 0o640);
      return destination;
    } finally {
      await rm(temporary, { force: true });
    }
  }

  async delete({ callId, consent, operatorRole, reason = 'operator request' } = {}) {
    const safeCallId = validateCallId(callId);
    if (consent?.recorded !== true) throw new Error('deletion consent is required');
    if (operatorRole !== 'operator') throw new Error('operator role is required');
    if (typeof reason !== 'string' || reason.length === 0 || reason.length > 256) {
      throw new Error('deletion reason must be between 1 and 256 characters');
    }
    await rm(join(this.root, safeCallId), { recursive: true, force: false });
    if (this.exportRoot) await rm(join(this.exportRoot, safeCallId), { recursive: true, force: true });
    await this.#appendAudit({ action: 'delete', callId: safeCallId, operatorRole, reason });
    return { deleted: true, callId: safeCallId };
  }

  async sweepRetention({ now = new Date() } = {}) {
    const nowMillis = now instanceof Date ? now.getTime() : Number.NaN;
    if (!Number.isFinite(nowMillis)) throw new Error('retention sweep requires a valid date');
    const deleted = [];
    const entries = await readdir(this.root, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || !CALL_ID_RE.test(entry.name)) continue;
      let manifest;
      try {
        manifest = JSON.parse(await readFile(join(this.root, entry.name, 'manifest.json'), 'utf8'));
      } catch {
        continue;
      }
      if (manifest?.callId !== entry.name || manifest?.complete !== true) continue;
      const deleteAfter = Date.parse(manifest?.retention?.deleteAfter ?? '');
      if (!Number.isFinite(deleteAfter) || deleteAfter > nowMillis) continue;
      await rm(join(this.root, entry.name), { recursive: true, force: false });
      if (this.exportRoot) await rm(join(this.exportRoot, entry.name), { recursive: true, force: true });
      await this.#appendAudit({ action: 'retention_delete', callId: entry.name });
      deleted.push(entry.name);
    }
    return { deleted };
  }

  async health() {
    try {
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      await access(this.root, constants.R_OK | constants.W_OK | constants.X_OK);
      const stats = await statfs(this.root);
      const freeBytes = Number(stats.bavail) * Number(stats.bsize);
      if (!Number.isSafeInteger(freeBytes) || freeBytes < this.minFreeBytes) {
        return { healthy: false, reason: 'insufficient recording storage' };
      }
      await this.execFileImpl(this.ffmpegPath, ['-version'], { timeout: 5_000, maxBuffer: 64 * 1024 });
      return { healthy: true, reason: 'ok' };
    } catch {
      return { healthy: false, reason: 'recording preflight failed' };
    }
  }

  async start(metadata) {
    const callId = validateCallId(metadata?.callId);
    if (metadata?.consent?.recorded !== true) throw new Error('recording consent is required');
    const health = await this.health();
    if (!health.healthy) throw new Error(health.reason);
    const directory = join(this.root, callId);
    await mkdir(directory, { mode: 0o700 });
    const remote = await WavTrack.open(join(directory, 'remote.wav'));
    let agent;
    try {
      agent = await WavTrack.open(join(directory, 'agent.wav'));
      await atomicWrite(join(directory, 'transcript.jsonl'), '');
      await atomicWrite(join(directory, 'events.jsonl'), '');
    } catch (error) {
      await remote.finalize();
      throw error;
    }
    return new CallRecorder({
      directory,
      metadata: { ...metadata, callId },
      remote,
      agent,
      ffmpegPath: this.ffmpegPath,
      execFileImpl: this.execFileImpl,
    });
  }
}

export class CallRecorder {
  constructor({ directory, metadata, remote, agent, ffmpegPath, execFileImpl = execFileAsync }) {
    this.directory = directory;
    this.metadata = metadata;
    this.remote = remote;
    this.agent = agent;
    this.ffmpegPath = ffmpegPath;
    this.execFileImpl = execFileImpl;
    this.ready = true;
    this.finalized = false;
  }

  async writeRemote(frame) { await this.remote.write(frame); }
  async writeAgent(frame) {
    await this.agent.padTo(Math.max(0, this.remote.frames - 1));
    await this.agent.write(frame);
  }

  async #append(name, value) {
    if (this.finalized) throw new Error('recorder is finalized');
    const handle = await open(join(this.directory, name), 'a', 0o600);
    try { await handle.writeFile(safeJson(value)); } finally { await handle.close(); }
  }

  async appendTranscript(value) { await this.#append('transcript.jsonl', value); }
  async appendEvent(value) { await this.#append('events.jsonl', value); }

  async finalize({ outcome = 'unknown' } = {}) {
    if (this.finalized) throw new Error('recorder is already finalized');
    this.finalized = true;
    this.ready = false;
    const failureReasons = [];
    if (!COMPLETE_OUTCOMES.has(outcome)) {
      const reason = typeof outcome === 'string' && outcome.length <= 64 ? outcome : 'invalid';
      failureReasons.push(`recording outcome ${reason} is incomplete`);
    }
    await Promise.all([this.remote.finalize(), this.agent.finalize()]);
    if (this.remote.frames === 0) failureReasons.push('remote track has no frames');
    if (this.agent.frames === 0) failureReasons.push('agent track has no frames');

    const reviewPaths = [
      join(this.directory, 'conversation.mkv'),
      join(this.directory, 'conversation.wav'),
    ];
    const removeReviewArtifacts = () =>
      Promise.all(reviewPaths.map((path) => rm(path, { force: true }).catch(() => undefined)));
    const durationFrames = Math.max(this.remote.frames, this.agent.frames);
    if (durationFrames > 0) {
      try {
        const durationSeconds = (durationFrames * 0.02).toFixed(3);
        await this.execFileImpl(this.ffmpegPath, [
          '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
          '-i', join(this.directory, 'remote.wav'), '-i', join(this.directory, 'agent.wav'),
          '-filter_complex',
          `[0:a]apad[remote];[1:a]apad[agent];[remote][agent]amerge=inputs=2,atrim=duration=${durationSeconds},asplit=2[review_mkv][review_wav]`,
          '-map', '[review_mkv]', '-c:a', 'pcm_s16le', reviewPaths[0],
          '-map', '[review_wav]', '-c:a', 'pcm_s16le', reviewPaths[1],
        ], { timeout: 30_000, maxBuffer: 1024 * 1024 });
      } catch {
        await removeReviewArtifacts();
        failureReasons.push('review artifact rendering failed');
      }
    } else {
      await removeReviewArtifacts();
    }

    const immutableNames = ['remote.wav', 'agent.wav', 'transcript.jsonl', 'events.jsonl'];
    try {
      await access(join(this.directory, 'conversation.mkv'));
      immutableNames.push('conversation.mkv');
    } catch { /* recorded above */ }
    try {
      await access(join(this.directory, 'conversation.wav'));
      immutableNames.push('conversation.wav');
    } catch { /* recorded above */ }
    const hashes = {};
    for (const name of immutableNames) hashes[name] = await digest(join(this.directory, name));
    const complete = failureReasons.length === 0;
    const manifest = {
      schemaVersion: 1,
      callId: this.metadata.callId,
      sessionId: this.metadata.sessionId ?? null,
      consent: this.metadata.consent,
      provider: this.metadata.provider ?? null,
      retention: this.metadata.retention ?? null,
      outcome,
      complete,
      failureReasons,
      format: { sampleRate: PCM_SAMPLE_RATE, channelsPerTrack: 1, sampleBits: 16, frameBytes: PCM_FRAME_BYTES },
      tracks: {
        remote: { frames: this.remote.frames, bytes: this.remote.bytes },
        agent: { frames: this.agent.frames, bytes: this.agent.bytes },
      },
      hashes,
    };
    await atomicWrite(join(this.directory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    const checksumNames = [...immutableNames, 'manifest.json'].sort();
    const checksumText = `${(await Promise.all(checksumNames.map(async (name) => `${await digest(join(this.directory, name))}  ${name}`))).join('\n')}\n`;
    await atomicWrite(join(this.directory, 'checksums.sha256'), checksumText);
    const files = [...REQUIRED_ARTIFACTS.filter((name) => checksumNames.includes(name)), 'checksums.sha256'];
    return { complete, directory: this.directory, files };
  }
}
