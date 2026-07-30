import { chmod, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';

const PHRASE = 'AgentCall speech test.';
const OUTPUT_RATE = 16_000;
const FRAME_SAMPLES = 320;
const MAX_SAMPLES = OUTPUT_RATE * 10;

function resample(samples, inputRate) {
  if (!(samples instanceof Int16Array) || !Number.isInteger(inputRate) || inputRate < 8_000 || inputRate > 192_000) {
    throw new Error('provider returned invalid PCM');
  }
  if (inputRate === OUTPUT_RATE) return Int16Array.from(samples);
  const length = Math.round(samples.length * OUTPUT_RATE / inputRate);
  const output = new Int16Array(length);
  const scale = inputRate / OUTPUT_RATE;
  for (let index = 0; index < length; index++) {
    const source = index * scale;
    const left = Math.min(samples.length - 1, Math.floor(source));
    const right = Math.min(samples.length - 1, left + 1);
    const fraction = source - left;
    output[index] = Math.round(samples[left] + (samples[right] - samples[left]) * fraction);
  }
  return output;
}

function wav(samples) {
  const output = Buffer.alloc(44 + samples.length * 2);
  output.write('RIFF', 0); output.writeUInt32LE(36 + samples.length * 2, 4); output.write('WAVE', 8);
  output.write('fmt ', 12); output.writeUInt32LE(16, 16); output.writeUInt16LE(1, 20);
  output.writeUInt16LE(1, 22); output.writeUInt32LE(OUTPUT_RATE, 24);
  output.writeUInt32LE(OUTPUT_RATE * 2, 28); output.writeUInt16LE(2, 32); output.writeUInt16LE(16, 34);
  output.write('data', 36); output.writeUInt32LE(samples.length * 2, 40);
  for (let index = 0; index < samples.length; index++) output.writeInt16LE(samples[index], 44 + index * 2);
  return output;
}

async function atomicWav(path, samples) {
  const temporary = join(dirname(path), `.provider-test.${randomUUID()}.tmp`);
  const data = wav(samples);
  try {
    await writeFile(temporary, data, { mode: 0o640, flag: 'wx' });
    await chmod(temporary, 0o640);
    await rename(temporary, path);
  } finally {
    data.fill(0);
    await rm(temporary, { force: true }).catch(() => {});
  }
}

export function createProviderSpeechTest({ sttProvider, ttsProvider, config, artifactPath, timeoutMs = 30_000 }) {
  if (!sttProvider?.open || !ttsProvider?.synthesize) throw new Error('active speech providers are required');
  if (typeof artifactPath !== 'string' || !isAbsolute(artifactPath)
      || (process.platform === 'win32' && artifactPath.startsWith('\\\\.\\pipe\\'))) {
    throw new Error('speech test artifact path is invalid');
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw new Error('speech test timeout is invalid');
  let running = false;
  return async () => {
    if (running) throw new Error('provider speech test is already running');
    running = true;
    const abort = new AbortController();
    let timer;
    let expired = false;
    let session;
    let pcm = new Int16Array();
    try {
      const work = (async () => {
        const chunks = [];
        let count = 0;
        for await (const chunk of ttsProvider.synthesize({
          text: PHRASE, voice: config.voice, language: config.ttsLanguage,
        }, abort.signal)) {
          if (chunk?.channels !== 1) throw new Error('provider test TTS must be mono');
          const converted = resample(chunk.pcm16, chunk.sampleRate);
          count += converted.length;
          if (count > MAX_SAMPLES) { converted.fill(0); throw new Error('provider test audio is too long'); }
          chunks.push(converted);
        }
        if (count < FRAME_SAMPLES) throw new Error('provider test audio is empty');
        pcm = new Int16Array(count);
        let cursor = 0;
        for (const chunk of chunks) { pcm.set(chunk, cursor); cursor += chunk.length; chunk.fill(0); }
        if (expired) throw new Error('provider speech test timed out');
        session = await sttProvider.open({ language: config.sttLanguage }, abort.signal);
        const result = (async () => {
          for await (const event of session.events()) {
            if (event?.type === 'final' && typeof event.text === 'string' && event.text.length <= 1_000) return event.text;
            if (event?.type === 'error') {
              const code = typeof event.code === 'string' && /^[a-z0-9_.-]{1,128}$/i.test(event.code)
                ? event.code
                : 'provider_error';
              throw new Error(`provider transcription failed (${code})`);
            }
          }
          throw new Error('provider transcription ended without a result');
        })();
        for (let offset = 0; offset < pcm.length; offset += FRAME_SAMPLES) {
          const frame = new Int16Array(FRAME_SAMPLES);
          frame.set(pcm.subarray(offset, Math.min(offset + FRAME_SAMPLES, pcm.length)));
          try { await session.pushPcm16(frame, BigInt(offset) * 1_000_000n / BigInt(OUTPUT_RATE)); } finally { frame.fill(0); }
        }
        await session.commitTurn();
        const transcript = await result;
        if (expired) throw new Error('provider speech test timed out');
        await atomicWav(artifactPath, pcm);
        if (expired) throw new Error('provider speech test timed out');
        return {
          healthy: true, phrase: PHRASE, transcript,
          sttProvider: config.sttProvider, ttsProvider: config.ttsProvider,
          sampleRate: OUTPUT_RATE, samples: pcm.length, playbackPath: artifactPath,
        };
      })();
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
          expired = true;
          abort.abort();
          reject(new Error('provider speech test timed out'));
        }, timeoutMs);
      });
      return await Promise.race([work, timeout]);
    } finally {
      clearTimeout(timer);
      abort.abort();
      await session?.close().catch(() => {});
      pcm.fill(0);
      running = false;
    }
  };
}

export { PHRASE };
