import { test } from 'node:test';
import assert from 'node:assert/strict';

import { EnergyVad } from '../src/energy-vad.js';

function frame(amplitude) {
  const value = new Int16Array(320);
  value.fill(amplitude);
  return value;
}

test('energy VAD requires consecutive speech and silence frames for stable turn boundaries', () => {
  const vad = new EnergyVad({ threshold: 1000, speechFrames: 2, silenceFrames: 3 });
  assert.equal(vad.push(frame(1200)), null);
  assert.deepEqual(vad.push(frame(1200)), { type: 'speech_started' });
  assert.equal(vad.push(frame(0)), null);
  assert.equal(vad.push(frame(1200)), null);
  assert.equal(vad.push(frame(0)), null);
  assert.equal(vad.push(frame(0)), null);
  assert.deepEqual(vad.push(frame(0)), { type: 'speech_stopped' });
});

test('energy VAD rejects malformed frames and resets without leaking state', () => {
  const vad = new EnergyVad();
  assert.throws(() => vad.push(new Int16Array(319)), /320/);
  vad.push(frame(4000));
  vad.reset();
  assert.equal(vad.speaking, false);
  assert.equal(vad.push(frame(0)), null);
});

test('default VAD keeps natural short pauses inside one caller turn', () => {
  const vad = new EnergyVad();
  for (let index = 0; index < 2; index++) assert.equal(vad.push(frame(4000)), null);
  assert.deepEqual(vad.push(frame(4000)), { type: 'speech_started' });
  for (let index = 0; index < 24; index++) assert.equal(vad.push(frame(0)), null);
  assert.equal(vad.speaking, true);
  assert.equal(vad.push(frame(4000)), null);
  for (let index = 0; index < 24; index++) assert.equal(vad.push(frame(0)), null);
  assert.deepEqual(vad.push(frame(0)), { type: 'speech_stopped' });
});


test('realtime local VAD barges in on caller speech and commits on stable silence', async () => {
  const { RealtimeSession } = await import('../src/realtime-session.js');
  let commits = 0;
  let aborted = false;
  let release;
  const sttEvents = { async *[Symbol.asyncIterator]() {} };
  const sttProvider = { open: async () => ({
    pushPcm16: async () => {}, commitTurn: async () => { commits++; }, events: () => sttEvents, close: async () => {},
  }) };
  const ttsProvider = {
    async *synthesize(_request, signal) {
      await new Promise((resolve) => { release = resolve; });
      aborted = signal.aborted;
    },
  };
  const session = new RealtimeSession({
    gateway: { appendTranscript: async () => {}, sendAgentPcm: async () => {} },
    sttProvider, ttsProvider, callId: 'call-vad',
    vad: new EnergyVad({ threshold: 1000, speechFrames: 2, silenceFrames: 2 }),
  });
  await session.start();
  const speaking = session.speak({ text: 'response' });
  await session.pushRemotePcm(Buffer.alloc(640, 0), 1n);
  const loud = Buffer.alloc(640);
  for (let offset = 0; offset < loud.length; offset += 2) loud.writeInt16LE(4000, offset);
  await session.pushRemotePcm(loud, 2n);
  await session.pushRemotePcm(loud, 3n);
  release();
  await speaking;
  assert.equal(aborted, true);
  await session.pushRemotePcm(Buffer.alloc(640), 4n);
  await session.pushRemotePcm(Buffer.alloc(640), 5n);
  await session.flushStt();
  assert.equal(commits, 1);
  assert.equal(session.status().bargeIns, 1);
  await session.close();
});
