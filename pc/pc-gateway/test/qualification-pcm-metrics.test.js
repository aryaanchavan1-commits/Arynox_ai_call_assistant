import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createPcmMetrics,
  summarizePcmMetrics,
  updatePcmMetrics,
} from '../scripts/qualification-pcm-metrics.js';

function pcm(samples) {
  const frame = Buffer.alloc(samples.length * 2);
  samples.forEach((sample, index) => frame.writeInt16LE(sample, index * 2));
  return frame;
}

test('centered RMS rejects silence and constant DC offsets', () => {
  for (const samples of [Array(320).fill(0), Array(320).fill(8), Array(320).fill(2_000)]) {
    const metrics = createPcmMetrics();
    assert.equal(updatePcmMetrics(metrics, pcm(samples), 640), true);
    assert.equal(summarizePcmMetrics(metrics).acRms, 0);
  }
});

test('centered RMS accepts a varying tone independently of DC offset', () => {
  const metrics = createPcmMetrics();
  const samples = Array.from({ length: 320 }, (_, i) => 500 + Math.round(1_000 * Math.sin(2 * Math.PI * i / 32)));
  updatePcmMetrics(metrics, pcm(samples), 640);
  const summary = summarizePcmMetrics(metrics);
  assert.ok(summary.acRms > 700);
  assert.ok(Math.abs(summary.mean - 500) < 1);
});

test('invalid frame sizes are ignored', () => {
  const metrics = createPcmMetrics();
  assert.equal(updatePcmMetrics(metrics, Buffer.alloc(638), 640), false);
  assert.deepEqual(summarizePcmMetrics(metrics), {
    frames: 0, samples: 0, mean: 0, rms: 0, acRms: 0, peak: 0,
  });
});
