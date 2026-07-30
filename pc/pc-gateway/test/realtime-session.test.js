import { test } from 'node:test';
import assert from 'node:assert/strict';

import { applyTelephoneGain, RealtimeSession } from '../src/realtime-session.js';

class EventChannel {
  constructor() { this.values = []; this.waiters = []; this.closed = false; }
  push(value) {
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value, done: false }); else this.values.push(value);
  }
  end() {
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter({ done: true });
  }
  [Symbol.asyncIterator]() { return this; }
  next() {
    if (this.values.length) return Promise.resolve({ value: this.values.shift(), done: false });
    if (this.closed) return Promise.resolve({ done: true });
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}

test('simulated realtime turn pins providers and routes authoritative transcript and agent PCM', async () => {
  const events = new EventChannel();
  const pushed = [];
  const transcript = [];
  const agent = [];
  const sttSession = {
    pushPcm16: async (pcm, timestampMicros) => pushed.push([Int16Array.from(pcm), timestampMicros]),
    commitTurn: async () => {},
    events: () => events,
    close: async () => events.end(),
  };
  let opened = 0;
  const sttProvider = { open: async () => { opened++; return sttSession; } };
  const ttsProvider = {
    async *synthesize(request, signal) {
      assert.equal(request.text, 'Hello');
      assert.equal(signal.aborted, false);
      yield { pcm16: new Int16Array(320).fill(0x1234), sampleRate: 16_000, channels: 1, sequence: 0 };
    },
  };
  const gateway = {
    appendTranscript: async (value) => transcript.push(value),
    sendAgentPcm: async (frame) => agent.push(Buffer.from(frame)),
  };
  const session = new RealtimeSession({ gateway, sttProvider, ttsProvider, callId: 'call-1' });
  await session.start();
  await session.pushRemotePcm(Buffer.alloc(640, 1), 1_000n);
  events.push({ type: 'final', text: 'Namaste', language: 'hi', confidence: 0.9 });
  await session.flushEvents();
  await session.speak({ text: 'Hello', language: 'en' });

  assert.equal(opened, 1);
  assert.equal(pushed.length, 1);
  assert.equal(pushed[0][0].length, 320);
  assert.equal(pushed[0][1], 1_000n);
  assert.deepEqual(transcript, [{
    speaker: 'remote', text: 'Namaste', language: 'hi', confidence: 0.9,
    final: true, complete: true, callId: 'call-1',
  }]);
  assert.equal(agent.length, 1);
  assert.equal(agent[0].length, 640);
  assert.equal(agent[0].readInt16LE(0), Math.round(0x1234 * 1.8));
  await session.close();
});

test('final partial TTS audio is silence-padded into one exact transport frame', async () => {
  const events = new EventChannel();
  const agent = [];
  const session = new RealtimeSession({
    callId: 'call-partial-tts',
    gateway: {
      appendTranscript: async () => {},
      sendAgentPcm: async (frame) => agent.push(Buffer.from(frame)),
    },
    sttProvider: {
      open: async () => ({
        pushPcm16: async () => {},
        commitTurn: async () => {},
        events: () => events,
        close: async () => events.end(),
      }),
    },
    ttsProvider: {
      async *synthesize() {
        yield {
          pcm16: new Int16Array(123).fill(0x2345),
          sampleRate: 16_000,
          channels: 1,
          sequence: 0,
        };
      },
    },
  });

  await session.start();
  await session.speak({ text: 'Short response', language: 'en' });

  assert.equal(agent.length, 1);
  assert.equal(agent[0].length, 640);
  assert.equal(agent[0].readInt16LE(0), Math.round(0x2345 * 1.8));
  assert.equal(agent[0].readInt16LE((123 - 1) * 2), Math.round(0x2345 * 1.8));
  assert.equal(agent[0].readInt16LE(123 * 2), 0);
  assert.equal(agent[0].readInt16LE(638), 0);
  await session.close();
});

test('TTS frames are paced at the telephone clock instead of overflowing the phone queue', async () => {
  const events = new EventChannel();
  const sentAt = [];
  const waits = [];
  let now = 0;
  const session = new RealtimeSession({
    callId: 'call-paced-tts',
    gateway: {
      appendTranscript: async () => {},
      sendAgentPcm: async () => sentAt.push(now),
    },
    sttProvider: {
      open: async () => ({
        pushPcm16: async () => {},
        commitTurn: async () => {},
        events: () => events,
        close: async () => events.end(),
      }),
    },
    ttsProvider: {
      async *synthesize() {
        yield {
          pcm16: new Int16Array(960).fill(1),
          sampleRate: 16_000,
          channels: 1,
          sequence: 0,
        };
      },
    },
    playbackClock: {
      now: () => now,
      wait: async (delayMs) => {
        waits.push(delayMs);
        now += delayMs;
      },
    },
  });

  await session.start();
  await session.speak({ text: 'Three correctly paced frames', language: 'en' });

  assert.deepEqual(sentAt, [0, 20, 40]);
  assert.deepEqual(waits, [0, 20, 20]);
  await session.close();
});

test('fatal STT events mark transcript incomplete and stop accepting audio', async () => {
  const events = new EventChannel();
  const session = new RealtimeSession({
    callId: 'call-error',
    gateway: { appendTranscript: async () => {}, sendAgentPcm: async () => {} },
    sttProvider: { open: async () => ({
      pushPcm16: async () => {}, commitTurn: async () => {}, events: () => events, close: async () => events.end(),
    }) },
    ttsProvider: { synthesize: async function* () {} },
  });
  await session.start();
  events.push({ type: 'error', code: 'quota_exceeded' });
  await session.flushEvents();
  assert.equal(session.status().transcriptComplete, false);
  assert.equal(session.status().sttError, 'quota_exceeded');
  await assert.rejects(() => session.pushRemotePcm(Buffer.alloc(640), 1n), /STT unavailable/);
  events.end();
  await session.close();
});

test('STT ingress is bounded and does not block authoritative recording on a stalled provider', async () => {
  const events = new EventChannel();
  let releaseFirst;
  const firstBlocked = new Promise((resolve) => { releaseFirst = resolve; });
  let pushes = 0;
  const sttProvider = { open: async () => ({
    pushPcm16: async () => { pushes++; if (pushes === 1) await firstBlocked; },
    commitTurn: async () => {}, events: () => events, close: async () => events.end(),
  }) };
  const session = new RealtimeSession({
    gateway: { appendTranscript: async () => {}, sendAgentPcm: async () => {} },
    sttProvider,
    ttsProvider: { async *synthesize() {} },
    callId: 'call-bounded',
    maxSttPending: 2,
  });
  await session.start();
  const firstPush = session.pushRemotePcm(Buffer.alloc(640, 1), 1n);
  const firstResult = await Promise.race([
    firstPush.then(() => 'returned'),
    new Promise((resolve) => setTimeout(() => resolve('blocked'), 25)),
  ]);
  try {
    assert.equal(firstResult, 'returned');
    await session.pushRemotePcm(Buffer.alloc(640, 2), 2n);
    await assert.rejects(() => session.pushRemotePcm(Buffer.alloc(640, 3), 3n), /overflow/i);
    assert.equal(session.status().sttPending, 2);
    assert.equal(session.status().transcriptComplete, false);
  } finally {
    releaseFirst();
    await firstPush;
  }
  await session.flushStt();
  assert.equal(pushes, 2);
  assert.equal(session.status().sttPending, 0);
  await session.close();
});

test('barge in aborts synthesis locally and prevents post-cancel PCM injection', async () => {
  const gate = new EventChannel();
  const sttEvents = new EventChannel();
  const agent = [];
  const sttProvider = { open: async () => ({
    pushPcm16: async () => {}, commitTurn: async () => {}, events: () => sttEvents, close: async () => sttEvents.end(),
  }) };
  const ttsProvider = {
    async *synthesize(_request, signal) {
      yield { pcm16: new Int16Array(320).fill(1), sampleRate: 16_000, channels: 1, sequence: 0 };
      await gate.next();
      if (!signal.aborted) yield { pcm16: new Int16Array(320).fill(2), sampleRate: 16_000, channels: 1, sequence: 1 };
    },
  };
  const session = new RealtimeSession({
    gateway: { appendTranscript: async () => {}, sendAgentPcm: async (frame) => agent.push(Buffer.from(frame)) },
    sttProvider, ttsProvider, callId: 'call-1',
  });
  await session.start();
  const speaking = session.speak({ text: 'long response', language: 'en' });
  while (agent.length === 0) await new Promise((resolve) => setImmediate(resolve));
  session.bargeIn();
  gate.push(true);
  assert.deepEqual(await speaking, { interrupted: true });
  assert.equal(agent.length, 1);
  assert.equal(session.status().speaking, false);
  assert.equal(session.status().bargeIns, 1);
  await session.close();
});

test('protected opening ignores barge-in and plays as one continuous segment', async () => {
  const gate = new EventChannel();
  const sttEvents = new EventChannel();
  const agent = [];
  const session = new RealtimeSession({
    gateway: {
      appendTranscript: async () => {},
      sendAgentPcm: async (frame) => agent.push(Buffer.from(frame)),
    },
    sttProvider: { open: async () => ({
      pushPcm16: async () => {}, commitTurn: async () => {},
      events: () => sttEvents, close: async () => sttEvents.end(),
    }) },
    ttsProvider: {
      async *synthesize() {
        yield { pcm16: new Int16Array(320).fill(1), sampleRate: 16_000, channels: 1, sequence: 0 };
        await gate.next();
        yield { pcm16: new Int16Array(320).fill(2), sampleRate: 16_000, channels: 1, sequence: 1 };
      },
    },
    callId: 'call-protected-opening',
  });
  await session.start();
  const speaking = session.speak({ text: 'Complete greeting', interruptible: false });
  while (agent.length === 0) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(session.bargeIn(), false);
  gate.push(true);
  assert.deepEqual(await speaking, { interrupted: false });
  assert.equal(agent.length, 2);
  assert.equal(session.status().bargeIns, 0);
  await session.close();
});

test('telephone TTS gain raises quiet speech and saturates instead of wrapping', () => {
  assert.deepEqual(Array.from(applyTelephoneGain(Int16Array.from([-1_000, 1_000]))), [-1_800, 1_800]);
  assert.deepEqual(
    Array.from(applyTelephoneGain(Int16Array.from([-30_000, -1_000, 0, 1_000, 30_000]))),
    [-32_768, -1_800, 0, 1_800, 32_767],
  );
  assert.throws(() => applyTelephoneGain(new Int16Array(), 5), /gain/i);
});

test('provider abort errors become a clean interrupted speech receipt', async () => {
  const gate = new EventChannel();
  const sttEvents = new EventChannel();
  const sttProvider = { open: async () => ({
    pushPcm16: async () => {}, commitTurn: async () => {}, events: () => sttEvents, close: async () => sttEvents.end(),
  }) };
  const ttsProvider = {
    async *synthesize(_request, signal) {
      yield { pcm16: new Int16Array(320).fill(1), sampleRate: 16_000, channels: 1, sequence: 0 };
      await gate.next();
      if (signal.aborted) throw new Error('provider request aborted');
    },
  };
  const session = new RealtimeSession({
    gateway: { appendTranscript: async () => {}, sendAgentPcm: async () => {} },
    sttProvider, ttsProvider, callId: 'call-abort',
  });
  await session.start();
  const speaking = session.speak({ text: 'interrupt me', language: 'en' });
  await new Promise((resolve) => setImmediate(resolve));
  session.bargeIn();
  gate.push(true);
  assert.deepEqual(await speaking, { interrupted: true });
  assert.equal(session.status().speaking, false);
  await session.close();
});

test('TTS first-chunk timeout aborts a stalled request and retries before sending audio', async () => {
  const sttEvents = new EventChannel();
  const agent = [];
  const signals = [];
  let attempts = 0;
  const ttsProvider = {
    async *synthesize(_request, signal) {
      attempts += 1;
      signals.push(signal);
      if (attempts === 1) {
        await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
        throw new Error('provider request aborted');
      }
      yield {
        pcm16: new Int16Array(320).fill(100),
        sampleRate: 16_000,
        channels: 1,
        sequence: 0,
      };
    },
  };
  const session = new RealtimeSession({
    gateway: {
      appendTranscript: async () => {},
      sendAgentPcm: async (frame) => agent.push(Buffer.from(frame)),
    },
    sttProvider: { open: async () => ({
      pushPcm16: async () => {}, commitTurn: async () => {},
      events: () => sttEvents, close: async () => sttEvents.end(),
    }) },
    ttsProvider,
    callId: 'call-retry',
    ttsChunkTimeoutMs: 20,
    ttsRetryLimit: 1,
  });

  await session.start();
  assert.deepEqual(await session.speak({ text: 'Retry safely' }), { interrupted: false });
  assert.equal(attempts, 2);
  assert.equal(signals[0].aborted, true);
  assert.equal(agent.length, 1);
  assert.equal(session.status().speaking, false);
  await session.close();
});

test('repeated TTS timeout releases the speech slot for a later response', async () => {
  const sttEvents = new EventChannel();
  const session = new RealtimeSession({
    gateway: { appendTranscript: async () => {}, sendAgentPcm: async () => {} },
    sttProvider: { open: async () => ({
      pushPcm16: async () => {}, commitTurn: async () => {},
      events: () => sttEvents, close: async () => sttEvents.end(),
    }) },
    ttsProvider: {
      async *synthesize(_request, signal) {
        await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
        throw new Error('provider request aborted');
      },
    },
    callId: 'call-timeout-release',
    ttsChunkTimeoutMs: 20,
    ttsRetryLimit: 1,
  });

  await session.start();
  await assert.rejects(() => session.speak({ text: 'Stall' }), /TTS provider timed out/);
  assert.equal(session.status().speaking, false);
  session.ttsProvider = {
    async *synthesize() {
      yield { pcm16: new Int16Array(320), sampleRate: 16_000, channels: 1, sequence: 0 };
    },
  };
  assert.deepEqual(await session.speak({ text: 'Recovered' }), { interrupted: false });
  assert.equal(session.status().speaking, false);
  await session.close();
});
