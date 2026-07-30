export function createPcmMetrics() {
  return {
    frames: 0,
    samples: 0,
    sum: 0,
    sumSquares: 0,
    peak: 0,
  };
}

export function updatePcmMetrics(metrics, frame, expectedFrameBytes) {
  if (!Buffer.isBuffer(frame) || frame.length !== expectedFrameBytes) return false;
  for (let i = 0; i < frame.length; i += 2) {
    const sample = frame.readInt16LE(i);
    metrics.sum += sample;
    metrics.sumSquares += sample * sample;
    metrics.peak = Math.max(metrics.peak, Math.abs(sample));
    metrics.samples++;
  }
  metrics.frames++;
  return true;
}

export function summarizePcmMetrics(metrics) {
  if (metrics.samples === 0) {
    return { frames: metrics.frames, samples: 0, mean: 0, rms: 0, acRms: 0, peak: metrics.peak };
  }
  const mean = metrics.sum / metrics.samples;
  const rms = Math.sqrt(metrics.sumSquares / metrics.samples);
  const variance = Math.max(0, (metrics.sumSquares / metrics.samples) - (mean * mean));
  return {
    frames: metrics.frames,
    samples: metrics.samples,
    mean,
    rms,
    acRms: Math.sqrt(variance),
    peak: metrics.peak,
  };
}
