import { FRAME_SAMPLES } from './framing.js';

export class EnergyVad {
  constructor({ threshold = 1200, speechFrames = 3, silenceFrames = 25 } = {}) {
    for (const [name, value] of Object.entries({ threshold, speechFrames, silenceFrames })) {
      if (!Number.isInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive integer`);
    }
    this.threshold = threshold;
    this.speechFrames = speechFrames;
    this.silenceFrames = silenceFrames;
    this.reset();
  }

  reset() {
    this.speaking = false;
    this.speechCount = 0;
    this.silenceCount = 0;
  }

  push(samples) {
    if (!(samples instanceof Int16Array) || samples.length !== FRAME_SAMPLES) {
      throw new RangeError(`VAD frame must contain exactly ${FRAME_SAMPLES} samples`);
    }
    let sumSquares = 0;
    for (const sample of samples) sumSquares += sample * sample;
    const active = Math.sqrt(sumSquares / samples.length) >= this.threshold;

    if (!this.speaking) {
      this.speechCount = active ? this.speechCount + 1 : 0;
      if (this.speechCount >= this.speechFrames) {
        this.speaking = true;
        this.speechCount = 0;
        this.silenceCount = 0;
        return { type: 'speech_started' };
      }
      return null;
    }

    this.silenceCount = active ? 0 : this.silenceCount + 1;
    if (this.silenceCount >= this.silenceFrames) {
      this.speaking = false;
      this.speechCount = 0;
      this.silenceCount = 0;
      return { type: 'speech_stopped' };
    }
    return null;
  }
}

export default EnergyVad;
