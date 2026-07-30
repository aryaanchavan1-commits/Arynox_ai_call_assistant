import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

const CALL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const ARTIFACT = 'conversation.wav';
const CHUNK_BYTES = 4096;
const MAX_RECORDING_BYTES = 512 * 1024 * 1024;

function parseEvent(frame) {
  try {
    const value = JSON.parse(frame.payload.toString('utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch { return null; }
}

async function digest(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

function receiptPromise(device, callId, timeoutMs) {
  let timer;
  let settled = false;
  let cleanup = () => {};
  const promise = new Promise((resolve, reject) => {
    const onEvent = (frame) => {
      const value = parseEvent(frame);
      if (!value || value.callId !== callId) return;
      if (value.event === 'recording_artifact_stored') { cleanup(); resolve(value); }
      else if (value.event === 'recording_artifact_failed') { cleanup(); reject(new Error('phone recording storage failed')); }
    };
    cleanup = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      device.removeListener('event', onEvent);
    };
    device.on('event', onEvent);
    timer = setTimeout(() => { cleanup(); reject(new Error('phone recording sync timed out')); }, timeoutMs);
  });
  return { promise, cleanup };
}

export async function syncFinalizedRecording({ device, directory, callId, timeoutMs = 120_000 } = {}) {
  if (!device?.sendControl || !device?.sendArtifact) throw new Error('recording sync device unavailable');
  if (!CALL_ID_RE.test(callId ?? '')) throw new Error('invalid recording callId');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) throw new Error('invalid recording sync timeout');
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
  if (manifest.callId !== callId || manifest.complete !== true) throw new Error('recording is not complete');
  const expectedSha256 = manifest.hashes?.[ARTIFACT];
  if (!SHA256_RE.test(expectedSha256 ?? '')) throw new Error('recording hash unavailable');
  const path = join(directory, ARTIFACT);
  const info = await stat(path);
  if (!info.isFile() || info.size < 1 || info.size > MAX_RECORDING_BYTES) throw new Error('recording size out of bounds');
  const actualSha256 = await digest(path);
  if (actualSha256 !== expectedSha256) throw new Error('recording hash mismatch');
  const frames = Math.max(manifest.tracks?.remote?.frames ?? 0, manifest.tracks?.agent?.frames ?? 0);
  if (!Number.isSafeInteger(frames) || frames < 1) throw new Error('recording duration unavailable');
  const durationMillis = frames * 20;
  const receipt = receiptPromise(device, callId, timeoutMs);
  try {
    await device.sendControl({
      payload: Buffer.from(JSON.stringify({
        command: 'recording_artifact_begin', callId, artifact: ARTIFACT,
        size: String(info.size), sha256: actualSha256, durationMillis: String(durationMillis),
      }), 'utf8'),
    });
    for await (const chunk of createReadStream(path, { highWaterMark: CHUNK_BYTES })) {
      await device.sendArtifact({ payload: chunk });
    }
    await device.sendControl({
      payload: Buffer.from(JSON.stringify({ command: 'recording_artifact_commit', callId }), 'utf8'),
    });
    await receipt.promise;
    return { stored: true, callId, bytes: info.size };
  } finally {
    receipt.cleanup();
  }
}
