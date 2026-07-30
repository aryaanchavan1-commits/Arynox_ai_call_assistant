export const MANUAL_PCM_FRAME_BYTES = 640;
export const MAX_MANUAL_AUDIO_QUEUED_FRAMES = 50;

export function frameManualPcm(remainder, input) {
  if (!(remainder instanceof Uint8Array) || !(input instanceof Uint8Array)
      || remainder.byteLength >= MANUAL_PCM_FRAME_BYTES
      || remainder.byteLength % 2 !== 0 || input.byteLength % 2 !== 0) {
    throw new TypeError('manual PCM must be bounded 16-bit audio');
  }
  const merged = new Uint8Array(remainder.byteLength + input.byteLength);
  merged.set(remainder);
  merged.set(input, remainder.byteLength);
  const frames = [];
  let offset = 0;
  while (merged.byteLength - offset >= MANUAL_PCM_FRAME_BYTES) {
    frames.push(merged.slice(offset, offset + MANUAL_PCM_FRAME_BYTES));
    offset += MANUAL_PCM_FRAME_BYTES;
  }
  return { frames, remainder: merged.slice(offset) };
}
