import { PCM_FRAME_BYTES, PCM_SAMPLE_RATE, FRAME_SAMPLES } from './framing.js';

const TELEPHONE_TTS_GAIN = 1.8;
const TELEPHONE_FRAME_MS = FRAME_SAMPLES * 1_000 / PCM_SAMPLE_RATE;
const DEFAULT_TTS_CHUNK_TIMEOUT_MS = 3_000;
const DEFAULT_TTS_RETRY_LIMIT = 1;

function waitForPlayback(delayMs, signal) {
  if (delayMs <= 0 || signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, delayMs);
    signal.addEventListener('abort', done, { once: true });
  });
}

function pcmBufferToInt16(payload) {
  if (!Buffer.isBuffer(payload) || payload.length !== PCM_FRAME_BYTES) {
    throw new RangeError(`remote PCM must be exactly ${PCM_FRAME_BYTES} bytes`);
  }
  const samples = new Int16Array(FRAME_SAMPLES);
  for (let index = 0; index < FRAME_SAMPLES; index++) samples[index] = payload.readInt16LE(index * 2);
  return samples;
}

function resampleMono(samples, inputRate) {
  if (!(samples instanceof Int16Array)) throw new TypeError('TTS pcm16 must be an Int16Array');
  if (!Number.isInteger(inputRate) || inputRate <= 0) throw new RangeError('invalid TTS sample rate');
  if (inputRate === PCM_SAMPLE_RATE) return Int16Array.from(samples);
  if (samples.length === 0) return new Int16Array();
  const outputLength = Math.max(1, Math.round(samples.length * PCM_SAMPLE_RATE / inputRate));
  const output = new Int16Array(outputLength);
  const scale = inputRate / PCM_SAMPLE_RATE;
  for (let index = 0; index < outputLength; index++) {
    const source = index * scale;
    const left = Math.min(samples.length - 1, Math.floor(source));
    const right = Math.min(samples.length - 1, left + 1);
    const fraction = source - left;
    output[index] = Math.round(samples[left] + (samples[right] - samples[left]) * fraction);
  }
  return output;
}

export function applyTelephoneGain(samples, gain = TELEPHONE_TTS_GAIN) {
  if (!(samples instanceof Int16Array)) throw new TypeError('TTS pcm16 must be an Int16Array');
  if (!Number.isFinite(gain) || gain < 1 || gain > 4) throw new RangeError('invalid TTS gain');
  const output = new Int16Array(samples.length);
  for (let index = 0; index < samples.length; index++) {
    output[index] = Math.max(-32_768, Math.min(32_767, Math.round(samples[index] * gain)));
  }
  return output;
}

function samplesToFrame(samples, offset) {
  const frame = Buffer.allocUnsafe(PCM_FRAME_BYTES);
  for (let index = 0; index < FRAME_SAMPLES; index++) frame.writeInt16LE(samples[offset + index], index * 2);
  return frame;
}

function nextTtsChunk(iterator, timeoutMs, controller) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (problem, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (problem) reject(problem);
      else resolve(value);
    };
    const timer = setTimeout(() => {
      controller.abort();
      finish(new Error('TTS provider timed out'));
    }, timeoutMs);
    Promise.resolve(iterator.next()).then(
      (value) => finish(null, value),
      (problem) => finish(problem),
    );
  });
}

export class RealtimeSession {
  constructor({
    gateway,
    sttProvider,
    ttsProvider,
    callId,
    sttConfig = {},
    ttsDefaults = {},
    maxSttPending = 8,
    vad = null,
    playbackClock = null,
    ttsChunkTimeoutMs = DEFAULT_TTS_CHUNK_TIMEOUT_MS,
    ttsRetryLimit = DEFAULT_TTS_RETRY_LIMIT,
  } = {}) {
    if (!gateway?.appendTranscript || !gateway?.sendAgentPcm) throw new TypeError('gateway media boundary is required');
    if (!sttProvider?.open || !ttsProvider?.synthesize) throw new TypeError('STT and TTS providers are required');
    if (typeof callId !== 'string' || callId.length === 0) throw new TypeError('callId is required');
    if (playbackClock !== null
        && (typeof playbackClock?.now !== 'function'
          || typeof playbackClock?.wait !== 'function')) {
      throw new TypeError('playback clock is invalid');
    }
    if (!Number.isInteger(ttsChunkTimeoutMs) || ttsChunkTimeoutMs < 10 || ttsChunkTimeoutMs > 30_000) {
      throw new TypeError('TTS chunk timeout is invalid');
    }
    if (!Number.isInteger(ttsRetryLimit) || ttsRetryLimit < 0 || ttsRetryLimit > 2) {
      throw new TypeError('TTS retry limit is invalid');
    }
    this.gateway = gateway;
    this.sttProvider = sttProvider;
    this.ttsProvider = ttsProvider;
    this.callId = callId;
    this.sttConfig = Object.freeze({ ...sttConfig });
    this.ttsDefaults = Object.freeze({ ...ttsDefaults });
    this.maxSttPending = maxSttPending;
    this.vad = vad;
    this.playbackClock = playbackClock ?? Object.freeze({
      now: Date.now,
      wait: waitForPlayback,
    });
    this.ttsChunkTimeoutMs = ttsChunkTimeoutMs;
    this.ttsRetryLimit = ttsRetryLimit;
    this.sttAbort = new AbortController();
    this.speechAbort = null;
    this.speechInterruptible = true;
    this.sttSession = null;
    this.eventWork = Promise.resolve();
    this.eventLoop = null;
    this.sttWork = Promise.resolve();
    this.sttPending = 0;
    this.transcriptComplete = true;
    this.sttError = null;
    this.bargeIns = 0;
    this.closed = false;
  }

  async start() {
    if (this.sttSession) throw new Error('realtime session already started');
    this.sttSession = await this.sttProvider.open(this.sttConfig, this.sttAbort.signal);
    this.eventLoop = this.#consumeSttEvents();
  }

  async pushRemotePcm(payload, timestampMicros) {
    if (!this.sttSession || this.closed) throw new Error('realtime session is not running');
    if (this.sttError) throw new Error(`STT unavailable: ${this.sttError}`);
    if (typeof timestampMicros !== 'bigint' || timestampMicros < 0n) throw new TypeError('timestampMicros must be non-negative bigint');
    if (this.sttPending >= this.maxSttPending) {
      this.transcriptComplete = false;
      throw new Error('STT ingress queue overflow');
    }
    const samples = pcmBufferToInt16(payload);
    const vadEvent = this.vad?.push(samples) ?? null;
    if (vadEvent?.type === 'speech_started') this.bargeIn();
    this.sttPending++;
    this.sttWork = this.sttWork.then(async () => {
      try {
        await this.sttSession.pushPcm16(samples, timestampMicros);
        if (vadEvent?.type === 'speech_stopped') await this.sttSession.commitTurn();
      } catch {
        this.transcriptComplete = false;
      } finally {
        samples.fill(0);
        this.sttPending--;
      }
    });
  }

  async #consumeSttEvents() {
    try {
      for await (const event of this.sttSession.events()) {
        this.eventWork = this.eventWork.then(() => this.#handleSttEvent(event));
      }
    } catch {
      this.transcriptComplete = false;
    }
  }

  async #handleSttEvent(event) {
    if (event?.type === 'error') {
      this.transcriptComplete = false;
      this.sttError = typeof event.code === 'string' && event.code.length <= 64 ? event.code : 'provider_error';
      return;
    }
    if (!event || event.type !== 'final' || typeof event.text !== 'string') return;
    await this.gateway.appendTranscript({
      speaker: 'remote',
      text: event.text,
      ...(event.language === undefined ? {} : { language: event.language }),
      ...(event.confidence === undefined ? {} : { confidence: event.confidence }),
      final: true,
      complete: this.transcriptComplete,
      callId: this.callId,
    });
  }

  async flushEvents() {
    await new Promise((resolve) => setImmediate(resolve));
    await this.eventWork;
  }

  async flushStt() {
    await this.sttWork;
  }

  async speak(request) {
    if (this.closed) throw new Error('realtime session is closed');
    if (this.speechAbort) throw new Error('speech is already active');
    const abort = new AbortController();
    this.speechAbort = abort;
    this.speechInterruptible = request.interruptible !== false;
    let pending = new Int16Array();
    let interrupted = false;
    let sentFrames = 0;
    let nextFrameAt = this.playbackClock.now();
    const sendFrame = async (frame) => {
      const waitMs = Math.max(0, nextFrameAt - this.playbackClock.now());
      await this.playbackClock.wait(waitMs, abort.signal);
      if (abort.signal.aborted) return false;
      await this.gateway.sendAgentPcm(frame);
      sentFrames += 1;
      nextFrameAt = this.playbackClock.now() + TELEPHONE_FRAME_MS;
      return true;
    };
    try {
      let completed = false;
      for (let attempt = 0; attempt <= this.ttsRetryLimit && !completed; attempt++) {
        const providerAbort = new AbortController();
        const forwardAbort = () => providerAbort.abort();
        abort.signal.addEventListener('abort', forwardAbort, { once: true });
        const stream = this.ttsProvider.synthesize(
          { ...this.ttsDefaults, ...request },
          providerAbort.signal,
        );
        const iterator = stream[Symbol.asyncIterator]();
        try {
          while (!abort.signal.aborted) {
            const { value: chunk, done } = await nextTtsChunk(
              iterator,
              this.ttsChunkTimeoutMs,
              providerAbort,
            );
            if (done) {
              completed = true;
              break;
            }
            if (chunk?.channels !== 1) throw new Error('TTS output must be mono');
            const resampled = resampleMono(chunk.pcm16, chunk.sampleRate);
            const converted = applyTelephoneGain(resampled);
            resampled.fill(0);
            const combined = new Int16Array(pending.length + converted.length);
            combined.set(pending);
            combined.set(converted, pending.length);
            pending.fill(0);
            converted.fill(0);
            let offset = 0;
            while (!abort.signal.aborted && combined.length - offset >= FRAME_SAMPLES) {
              const frame = samplesToFrame(combined, offset);
              await sendFrame(frame);
              frame.fill(0);
              offset += FRAME_SAMPLES;
            }
            pending = Int16Array.from(combined.subarray(offset));
            combined.fill(0);
          }
        } catch (error) {
          providerAbort.abort();
          if (abort.signal.aborted) break;
          if (sentFrames > 0 || attempt >= this.ttsRetryLimit) throw error;
          pending.fill(0);
          pending = new Int16Array();
        } finally {
          abort.signal.removeEventListener('abort', forwardAbort);
          if (!completed) {
            Promise.resolve(iterator.return?.()).catch(() => {});
          }
        }
      }
      if (!abort.signal.aborted && pending.length !== 0) {
        const padded = new Int16Array(FRAME_SAMPLES);
        padded.set(pending);
        const frame = samplesToFrame(padded, 0);
        await sendFrame(frame);
        frame.fill(0);
        padded.fill(0);
      }
    } catch (error) {
      if (!abort.signal.aborted) throw error;
    } finally {
      interrupted = abort.signal.aborted;
      pending.fill(0);
      if (this.speechAbort === abort) {
        this.speechAbort = null;
        this.speechInterruptible = true;
      }
    }
    return { interrupted };
  }

  bargeIn() {
    if (!this.speechAbort || !this.speechInterruptible) return false;
    this.bargeIns++;
    this.speechAbort.abort();
    return true;
  }

  status() {
    return {
      speaking: this.speechAbort !== null,
      transcriptComplete: this.transcriptComplete,
      bargeIns: this.bargeIns,
      sttPending: this.sttPending,
      sttError: this.sttError,
    };
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.bargeIn();
    this.sttAbort.abort();
    await this.sttWork;
    if (this.sttSession?.close) await this.sttSession.close();
    if (this.eventLoop) await this.eventLoop;
    await this.eventWork;
    this.sttSession = null;
  }
}

export default RealtimeSession;
