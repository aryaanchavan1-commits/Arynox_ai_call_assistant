import assert from 'node:assert/strict';
import { test } from 'node:test';

import { runRecordingHealth } from '../src/recording-health.js';

const BASE_ENV = Object.freeze({
  AGENTCALL_RECORDING_ROOT: '/var/lib/agentcall/recordings',
  AGENTCALL_RECORDING_MIN_FREE_BYTES: '1024',
  AGENTCALL_FFMPEG_PATH: 'ffmpeg',
});

test('recording health command reports only bounded semantic health', async () => {
  const lines = [];
  const code = await runRecordingHealth({
    env: BASE_ENV,
    createRecordingManager: (options) => ({
      health: async () => {
        assert.deepEqual(options, { root: BASE_ENV.AGENTCALL_RECORDING_ROOT, minFreeBytes: 1024, ffmpegPath: 'ffmpeg' });
        return { healthy: true, reason: 'ok' };
      },
    }),
    stdout: { write: (line) => lines.push(line) },
  });
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(lines.join('')), { healthy: true, reason: 'ok' });
});

test('recording health command exits nonzero without leaking exception details', async () => {
  const lines = [];
  const code = await runRecordingHealth({
    env: BASE_ENV,
    createRecordingManager: () => ({ health: async () => { throw new Error('/secret/path failed'); } }),
    stdout: { write: (line) => lines.push(line) },
  });
  assert.equal(code, 1);
  assert.deepEqual(JSON.parse(lines.join('')), { healthy: false, reason: 'recording health failed' });
  assert.equal(lines.join('').includes('/secret/path'), false);
});
