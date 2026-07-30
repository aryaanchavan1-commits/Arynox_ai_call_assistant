import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  frameManualPcm,
  MANUAL_PCM_FRAME_BYTES,
  MAX_MANUAL_AUDIO_QUEUED_FRAMES,
} from '../lib/audio.js';

test('manual microphone chunks become exact 20 ms PCM frames without losing bytes', () => {
  const first = Uint8Array.from({ length: 2_730 }, (_, index) => index % 251);
  const framedFirst = frameManualPcm(new Uint8Array(), first);
  assert.equal(framedFirst.frames.length, 4);
  assert.equal(framedFirst.remainder.byteLength, 170);
  assert.ok(framedFirst.frames.every((frame) => frame.byteLength === MANUAL_PCM_FRAME_BYTES));

  const second = Uint8Array.from({ length: 470 }, (_, index) => (index + 17) % 251);
  const framedSecond = frameManualPcm(framedFirst.remainder, second);
  assert.equal(framedSecond.frames.length, 1);
  assert.equal(framedSecond.remainder.byteLength, 0);

  const rebuilt = Buffer.concat([
    ...framedFirst.frames.map((frame) => Buffer.from(frame)),
    Buffer.from(framedSecond.frames[0]),
  ]);
  assert.deepEqual(rebuilt, Buffer.concat([Buffer.from(first), Buffer.from(second)]));
  assert.equal(MAX_MANUAL_AUDIO_QUEUED_FRAMES, 50);
});

test('manual microphone framing rejects odd-byte and invalid remainder input', () => {
  assert.throws(() => frameManualPcm(new Uint8Array(), new Uint8Array(3)), /16-bit/i);
  assert.throws(
    () => frameManualPcm(new Uint8Array(MANUAL_PCM_FRAME_BYTES), new Uint8Array(2)),
    /16-bit/i,
  );
});
