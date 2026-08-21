import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createProviderSpeechTest } from '../src/provider-speech-test.js';

function providers({ stall = false } = {}) {
  const calls = [];
  let closeCalls = 0;
  const events = async function* () {
    if (stall) await new Promise(() => {});
    yield { type: 'final', text: 'Arynox speech test.' };
  };
  const stt = {
    open: async ({ language }, signal) => {
      calls.push(['open', language, signal.aborted]);
      return {
        pushPcm16: async (frame, timestampMicros) => calls.push(['frame', frame.length, timestampMicros]),
        commitTurn: async () => calls.push(['commit']),
        events,
        close: async () => { closeCalls++; },
      };
    },
  };
  const tts = {
    synthesize: async function* ({ text, voice, language }, signal) {
      calls.push(['synthesize', text, voice, language, signal.aborted]);
      yield { pcm16: Int16Array.from({ length: 640 }, (_, index) => index - 320), sampleRate: 16_000, channels: 1 };
    },
  };
  return { stt, tts, calls, closeCalls: () => closeCalls };
}

test('active provider speech test synthesizes, transcribes, and atomically writes a bounded group-readable WAV', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'agentcall-provider-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const artifactPath = join(directory, 'provider-test.wav');
  const f = providers();
  const run = createProviderSpeechTest({
    sttProvider: f.stt,
    ttsProvider: f.tts,
    config: {
      sttProvider: 'openai', ttsProvider: 'supertonic', voice: 'F1',
      sttLanguage: 'en', ttsLanguage: 'fr',
    },
    artifactPath,
    timeoutMs: 1_000,
  });

  assert.deepEqual(await run(), {
    healthy: true,
    phrase: 'Arynox speech test.',
    transcript: 'Arynox speech test.',
    sttProvider: 'openai',
    ttsProvider: 'supertonic',
    sampleRate: 16_000,
    samples: 640,
    playbackPath: artifactPath,
  });
  assert.deepEqual(f.calls, [
    ['synthesize', 'Arynox speech test.', 'F1', 'fr', false],
    ['open', 'en', false],
    ['frame', 320, 0n], ['frame', 320, 20_000n], ['commit'],
  ]);
  assert.equal(f.closeCalls(), 1);
  if (process.platform !== 'win32') assert.equal((await stat(artifactPath)).mode & 0o777, 0o640);
  const wav = await readFile(artifactPath);
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.readUInt32LE(24), 16_000);
  assert.equal(wav.length, 44 + 640 * 2);
});

test('provider speech test rejects concurrent runs and times out stalled transcription', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'agentcall-provider-timeout-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const f = providers({ stall: true });
  const artifactPath = join(directory, 'provider-test.wav');
  const run = createProviderSpeechTest({
    sttProvider: f.stt,
    ttsProvider: f.tts,
    config: {
      sttProvider: 'openai', ttsProvider: 'supertonic', voice: 'F1',
      sttLanguage: 'en', ttsLanguage: 'en',
    },
    artifactPath,
    timeoutMs: 20,
  });

  const first = run();
  await assert.rejects(run(), /already running/i);
  await assert.rejects(first, /timed out/i);
  assert.equal(f.closeCalls(), 1);
  await assert.rejects(access(artifactPath));
});
