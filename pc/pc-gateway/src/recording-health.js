#!/usr/bin/env node

import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

import { RecordingManager } from './recording.js';

function optionsFromEnv(env) {
  const root = env.AGENTCALL_RECORDING_ROOT || '/var/lib/agentcall/recordings';
  const rawMinFree = env.AGENTCALL_RECORDING_MIN_FREE_BYTES || '1073741824';
  if (!isAbsolute(root) || !/^\d+$/.test(rawMinFree)) throw new Error('invalid recording health configuration');
  const minFreeBytes = Number(rawMinFree);
  if (!Number.isSafeInteger(minFreeBytes) || minFreeBytes < 1) throw new Error('invalid recording health configuration');
  return { root, minFreeBytes, ffmpegPath: env.AGENTCALL_FFMPEG_PATH || 'ffmpeg' };
}

export async function runRecordingHealth({
  env = process.env,
  stdout = process.stdout,
  createRecordingManager = (options) => new RecordingManager(options),
} = {}) {
  let health;
  try {
    health = await createRecordingManager(optionsFromEnv(env)).health();
  } catch {
    health = { healthy: false, reason: 'recording health failed' };
  }
  stdout.write(`${JSON.stringify(health)}\n`);
  return health.healthy === true ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await runRecordingHealth();
}
