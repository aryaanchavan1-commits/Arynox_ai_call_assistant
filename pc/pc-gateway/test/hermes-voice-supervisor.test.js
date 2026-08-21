import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import test from 'node:test';

import {
  HermesGatewayClient,
  VoiceTurnQueue,
  callMediaStabilizationDelay,
  createPreparedOutgoingResponder,
  createPreparedIncomingResponder,
  fallbackOutgoingPlan,
  firstNaturalResponse,
  fallbackOpeningDraft,
  hermesGatewayEnvironment,
  hermesSessionOptions,
  incomingOpening,
  incomingGreetingPrompt,
  normalizeVoiceReply,
  normalizeOpeningDraft,
  normalizeOutgoingPlan,
  openingDraftPrompt,
  ownerNameFromInstructions,
  outgoingContactName,
  outgoingPlanPrompt,
  prepareOutgoingPlan,
  preparedIncomingOpeningForTime,
  preparedIncomingOpenings,
  preparedIncomingResponses,
  naturalGreeting,
  nextTurnPrompt,
  selectWarmedHermesSession,
  superviseHermesTurns,
  waitForIncomingAnswerWindow,
  waitForStableCallMedia,
} from '../scripts/hermes-voice-supervisor.js';
import { standardGreetingOptions } from '../src/conversation-phrases.js';

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.writes = [];
  child.stdin = new Writable({
    write(chunk, _encoding, done) {
      child.writes.push(String(chunk));
      done();
    },
  });
  child.kill = () => true;
  return child;
}

test('Hermes gateway client correlates RPC and persistent completion events', async () => {
  const child = fakeChild();
  const client = new HermesGatewayClient({ child, timeoutMs: 1_000 });
  child.stdout.write(`${JSON.stringify({
    jsonrpc: '2.0',
    method: 'event',
    params: { type: 'gateway.ready', payload: {} },
  })}\n`);
  await client.ready;

  const creating = client.createSession({ title: 'voice' });
  const createRequest = JSON.parse(child.writes.shift());
  assert.equal(createRequest.method, 'session.create');
  child.stdout.write(`${JSON.stringify({
    jsonrpc: '2.0',
    id: createRequest.id,
    result: { session_id: 'session-1' },
  })}\n`);
  assert.equal((await creating).session_id, 'session-1');

  const deltas = [];
  const submitting = client.submitAndWait('session-1', 'next', {
    onDelta: (value) => deltas.push(value),
  });
  const promptRequest = JSON.parse(child.writes.shift());
  child.stdout.write(`${JSON.stringify({
    jsonrpc: '2.0',
    id: promptRequest.id,
    result: { status: 'started' },
  })}\n`);
  child.stdout.write(`${JSON.stringify({
    jsonrpc: '2.0',
    method: 'event',
    params: { type: 'message.start', session_id: 'session-1', payload: {} },
  })}\n`);
  child.stdout.write(`${JSON.stringify({
    jsonrpc: '2.0',
    method: 'event',
    params: {
      type: 'message.delta',
      session_id: 'session-1',
      payload: { text: 'That makes sense. ' },
    },
  })}\n`);
  child.stdout.write(`${JSON.stringify({
    jsonrpc: '2.0',
    method: 'event',
    params: {
      type: 'message.complete',
      session_id: 'session-1',
      payload: { text: 'TURN_HANDLED:1', status: 'complete' },
    },
  })}\n`);
  assert.equal((await submitting).payload.text, 'TURN_HANDLED:1');
  assert.deepEqual(deltas, ['That makes sense. ']);
});

test('voice turn queue settles final transcript events without the MCP tool-selection round', async () => {
  const gateway = new EventEmitter();
  const queue = new VoiceTurnQueue(gateway, {
    completeSettleMs: 0,
    incompleteSettleMs: 0,
  });
  const waiting = queue.waitForTurn({ callId: 'call-1', timeoutMs: 1_000 });
  gateway.emit('event', {
    event: 'transcript_final',
    speaker: 'remote',
    callId: 'call-1',
    text: 'Can you explain that properly?',
    complete: true,
  });
  const turn = await waiting;
  assert.equal(turn.status, 'turn');
  assert.equal(turn.text, 'Can you explain that properly?');
  assert.equal(turn.sequence, 1);
  gateway.emit('event', {
    event: 'transcript_final',
    speaker: 'agent',
    callId: 'call-1',
    text: 'The first reason is that',
    complete: false,
  });
  const nextWaiting = queue.waitForTurn({
    callId: 'call-1',
    afterSequence: turn.sequence,
    timeoutMs: 1_000,
  });
  gateway.emit('event', {
    event: 'transcript_final',
    speaker: 'remote',
    callId: 'call-1',
    text: 'Wait, connect that with the earlier topic.',
    complete: true,
  });
  const next = await nextWaiting;
  assert.equal(next.previousCallerText, 'Can you explain that properly?');
  assert.equal(next.interruptedAgentText, 'The first reason is that');
  queue.close();
});

test('voice turn queue coalesces rapid short fragments into one caller thought', async () => {
  const gateway = new EventEmitter();
  const queue = new VoiceTurnQueue(gateway, {
    completeSettleMs: 0,
    incompleteSettleMs: 0,
    shortSettleMs: 20,
  });
  const waiting = queue.waitForTurn({ callId: 'call-short', timeoutMs: 1_000 });
  gateway.emit('event', {
    event: 'transcript_final',
    speaker: 'remote',
    callId: 'call-short',
    text: 'Yeah,',
    complete: true,
  });
  gateway.emit('event', {
    event: 'transcript_final',
    speaker: 'remote',
    callId: 'call-short',
    text: 'this is Siddharth speaking.',
    complete: true,
  });
  const turn = await waiting;
  assert.equal(turn.status, 'turn');
  assert.match(turn.text, /Yeah/);
  assert.match(turn.text, /Siddharth speaking/);
  assert.equal(turn.sequence, 1);
  queue.close();
});

test('protected openings discard caller noise already captured before their turn boundary', async () => {
  const gateway = new EventEmitter();
  const queue = new VoiceTurnQueue(gateway, {
    completeSettleMs: 0,
    incompleteSettleMs: 5,
    shortSettleMs: 5,
  });
  gateway.emit('event', {
    event: 'transcript_final',
    speaker: 'remote',
    callId: 'call-opening',
    text: 'background television',
    complete: true,
  });
  assert.equal(queue.discardPending('call-opening'), 0);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(queue.latestSequence('call-opening'), 0);

  gateway.emit('event', {
    event: 'transcript_final',
    speaker: 'remote',
    callId: 'call-opening',
    text: 'Is Siddharth available tonight?',
    complete: true,
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  const turn = await queue.waitForTurn({ callId: 'call-opening', timeoutMs: 50 });
  assert.equal(turn.text, 'Is Siddharth available tonight?');
  assert.equal(turn.sequence, 1);
  queue.close();
});

test('supervisor sends one continuous response stream after Hermes completes', async () => {
  const prompts = [];
  const spoken = [];
  let waiting = 0;
  const gateway = {
    async status() { return { currentCall: { callId: 'call-1', phase: 'active' } }; },
    async speak({ text }) { spoken.push(text); return { accepted: true }; },
  };
  const hermes = {
    async submitAndWait(sessionId, prompt) {
      prompts.push({ sessionId, prompt });
      return {
        payload: {
          status: 'complete',
          text: 'That is a useful question, and the short answer is yes. The earlier point still matters, so I would keep both ideas together.',
        },
      };
    },
  };
  const turnQueue = {
    latestSequence() { return 1; },
    async waitForTurn() {
      waiting += 1;
      return waiting === 1
        ? { status: 'turn', callId: 'call-1', sequence: 1, text: 'Does the earlier idea still work?' }
        : { status: 'ended', callId: 'call-1', sequence: 2 };
    },
  };
  const result = await superviseHermesTurns({
    hermes,
    sessionId: 'session-1',
    callId: 'call-1',
    gateway,
    turnQueue,
    deadline: Date.now() + 30_000,
  });
  assert.deepEqual(result, { reason: 'call_ended', cycles: 1 });
  assert.equal(prompts.length, 1);
  assert.match(prompts[0].prompt, /Does the earlier idea still work/);
  assert.match(prompts[0].prompt, /Arynox may already say this acknowledgement/);
  assert.match(prompts[0].prompt, /Do not call\s+any tool/);
  assert.deepEqual(spoken, [
    'That is a useful question, and the short answer is yes. The earlier point still matters, so I would keep both ideas together.',
  ]);
});

test('supervisor starts after the protected-opening transcript boundary', async () => {
  let observedCursor = null;
  const result = await superviseHermesTurns({
    hermes: {
      async submitAndWait() {
        throw new Error('opening-era transcript must not reach Hermes');
      },
    },
    sessionId: 'session-opening',
    callId: 'call-opening',
    gateway: {
      async status() {
        return { currentCall: { callId: 'call-opening', phase: 'active' } };
      },
    },
    turnQueue: {
      latestSequence() { return 4; },
      async waitForTurn({ afterSequence }) {
        observedCursor = afterSequence;
        return { status: 'ended', callId: 'call-opening', sequence: 5 };
      },
    },
    initialAfterSequence: 4,
    deadline: Date.now() + 30_000,
  });
  assert.equal(observedCursor, 4);
  assert.deepEqual(result, { reason: 'call_ended', cycles: 0 });
});

test('supervisor checks once after silence and then closes the inactive call politely', async () => {
  const spoken = [];
  const hangups = [];
  const result = await superviseHermesTurns({
    hermes: {
      async submitAndWait() {
        throw new Error('silence must not be sent to Hermes');
      },
    },
    sessionId: 'session-silence',
    callId: 'call-silence',
    gateway: {
      async status() {
        return { currentCall: { callId: 'call-silence', phase: 'active' } };
      },
      async speak(value) {
        spoken.push(value);
        return { accepted: true };
      },
      async hangup(value) {
        hangups.push(value);
        return { accepted: true };
      },
    },
    turnQueue: {
      latestSequence() { return 0; },
      async waitForTurn() {
        return { status: 'timeout', callId: 'call-silence', sequence: 0 };
      },
    },
    deadline: Date.now() + 30_000,
  });
  assert.deepEqual(result, { reason: 'agent_hangup', cycles: 0 });
  assert.equal(spoken.length, 2);
  assert.equal(spoken[0].interruptible, true);
  assert.equal(spoken[1].interruptible, false);
  assert.match(spoken[0].text, /still there/u);
  assert.match(spoken[1].text, /end the call/u);
  assert.equal(hangups.length, 1);
});

test('supervisor waits for and speaks the complete Hermes response as one request', async () => {
  const spoken = [];
  const cycles = [];
  let waiting = 0;
  const result = await superviseHermesTurns({
    hermes: {
      async submitAndWait() {
        await new Promise((resolve) => setTimeout(resolve, 8));
        return {
          payload: {
            status: 'complete',
            text: 'Yes, we can make this conversation feel much more natural. I will also keep your previous topic in mind.',
          },
        };
      },
    },
    sessionId: 'session-1',
    callId: 'call-1',
    gateway: {
      async status() { return { currentCall: { callId: 'call-1', phase: 'active' } }; },
      async speak({ text }) { spoken.push(text); return { accepted: true }; },
    },
    turnQueue: {
      latestSequence() { return 1; },
      async waitForTurn() {
        waiting += 1;
        return waiting === 1
          ? { status: 'turn', callId: 'call-1', sequence: 1, text: 'Can this sound more natural?' }
          : { status: 'ended', callId: 'call-1', sequence: 2 };
      },
    },
    acknowledgementDelayMs: 100,
    deadline: Date.now() + 30_000,
    onCycle: (cycle) => cycles.push(cycle),
  });
  assert.deepEqual(result, { reason: 'call_ended', cycles: 1 });
  assert.deepEqual(spoken, [
    'Yes, we can make this conversation feel much more natural. I will also keep your previous topic in mind.',
  ]);
  assert.ok(cycles[0].responseStartMs >= cycles[0].responseReadyMs);
});

test('interrupted continuous reply does not trigger another speech request', async () => {
  const spoken = [];
  let waiting = 0;
  const result = await superviseHermesTurns({
    hermes: {
      async submitAndWait() {
        return {
          payload: {
            status: 'complete',
            text: 'I understand the point you are making, so let me answer it clearly. This second sentence must not resume after interruption.',
          },
        };
      },
    },
    sessionId: 'session-1',
    callId: 'call-1',
    gateway: {
      async status() { return { currentCall: { callId: 'call-1', phase: 'active' } }; },
      async speak({ text }) {
        spoken.push(text);
        return { accepted: true, interrupted: true };
      },
    },
    turnQueue: {
      latestSequence() { return 1; },
      async waitForTurn() {
        waiting += 1;
        return waiting === 1
          ? { status: 'turn', callId: 'call-1', sequence: 1, text: 'Can I interrupt you?' }
          : { status: 'ended', callId: 'call-1', sequence: 2 };
      },
    },
    deadline: Date.now() + 30_000,
  });
  assert.deepEqual(result, { reason: 'call_ended', cycles: 1 });
  assert.deepEqual(spoken, [
    'I understand the point you are making, so let me answer it clearly. This second sentence must not resume after interruption.',
  ]);
});

test('supervisor does not stack filler phrases across adjacent caller fragments', async () => {
  const spoken = [];
  let waiting = 0;
  const turns = [
    'Why does the live call sound interrupted?',
    'Can you also keep the previous topic in context?',
  ];
  const result = await superviseHermesTurns({
    hermes: {
      async submitAndWait() {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return {
          payload: {
            status: 'complete',
            text: 'I kept the complete thought and answered it as one response.',
          },
        };
      },
    },
    sessionId: 'session-1',
    callId: 'call-1',
    gateway: {
      async status() { return { currentCall: { callId: 'call-1', phase: 'active' } }; },
      async speak({ text }) { spoken.push(text); return { accepted: true }; },
    },
    turnQueue: {
      latestSequence() { return Math.min(waiting, turns.length); },
      async waitForTurn() {
        waiting += 1;
        return waiting <= turns.length
          ? { status: 'turn', callId: 'call-1', sequence: waiting, text: turns[waiting - 1] }
          : { status: 'ended', callId: 'call-1', sequence: waiting };
      },
    },
    acknowledgementDelayMs: 1,
    acknowledgementCooldownMs: 60_000,
    deadline: Date.now() + 30_000,
  });
  assert.deepEqual(result, { reason: 'call_ended', cycles: 2 });
  assert.deepEqual(spoken, [
    'Hmm, that is a good question. Let me think.',
    'I kept the complete thought and answered it as one response.',
    'I kept the complete thought and answered it as one response.',
  ]);
});

test('supervisor bridges a slow Hermes response with two non-overlapping acknowledgements', async () => {
  const spoken = [];
  let waiting = 0;
  const result = await superviseHermesTurns({
    hermes: {
      async submitAndWait() {
        await new Promise((resolve) => setTimeout(resolve, 45));
        return {
          payload: {
            status: 'complete',
            text: 'The weather should remain clear this evening, so your outdoor plan looks fine.',
          },
        };
      },
    },
    sessionId: 'session-latency-bridge',
    callId: 'call-latency-bridge',
    gateway: {
      async status() {
        return { currentCall: { callId: 'call-latency-bridge', phase: 'active' } };
      },
      async speak({ text }) {
        spoken.push(text);
        return { accepted: true };
      },
    },
    turnQueue: {
      latestSequence() { return 1; },
      async waitForTurn() {
        waiting += 1;
        return waiting === 1
          ? {
            status: 'turn',
            callId: 'call-latency-bridge',
            sequence: 1,
            text: 'Can you check the latest weather for me?',
          }
          : { status: 'ended', callId: 'call-latency-bridge', sequence: 2 };
      },
    },
    acknowledgementDelayMs: 2,
    acknowledgementFollowUpDelayMs: 15,
    deadline: Date.now() + 30_000,
  });
  assert.deepEqual(result, { reason: 'call_ended', cycles: 1 });
  assert.deepEqual(spoken, [
    'Sure, let me check that.',
    "I'm checking that now.",
    'The weather should remain clear this evening, so your outdoor plan looks fine.',
  ]);
});

test('supervisor carries the spoken opening into every Hermes turn without repeating it', async () => {
  const prompts = [];
  let waiting = 0;
  const result = await superviseHermesTurns({
    hermes: {
      async submitAndWait(_sessionId, prompt) {
        prompts.push(prompt);
        return {
          payload: {
            status: 'complete',
            text: 'Yes, I can take a message for Siddharth. Please tell me what you would like him to know.',
          },
        };
      },
    },
    sessionId: 'session-1',
    callId: 'call-1',
    gateway: {
      async status() { return { currentCall: { callId: 'call-1', phase: 'active' } }; },
      async speak() { return { accepted: true }; },
    },
    turnQueue: {
      latestSequence() { return 1; },
      async waitForTurn() {
        waiting += 1;
        return waiting === 1
          ? { status: 'turn', callId: 'call-1', sequence: 1, text: 'Can I leave a message?' }
          : { status: 'ended', callId: 'call-1', sequence: 2 };
      },
    },
    spokenOpening: 'Good evening, Aarav. Siddharth is currently in a meeting.',
    receptionist: {
      instructions: 'Siddharth is currently in a meeting. Take a message.',
      callerName: 'Aarav',
      callbackNumber: '+15551234567',
    },
    deadline: Date.now() + 30_000,
  });
  assert.deepEqual(result, { reason: 'call_ended', cycles: 1 });
  assert.match(prompts[0], /Arynox already spoke this opening/);
  assert.match(prompts[0], /Good evening, Aarav/);
  assert.match(prompts[0], /Do not repeat it unless the caller explicitly asks/);
  assert.match(prompts[0], /incoming receptionist call/);
  assert.match(prompts[0], /saved caller name is "Aarav"/);
  assert.match(prompts[0], /\+15551234567/);
  assert.match(prompts[0], /reason or message, urgency/);
  assert.match(prompts[0], /Do not ask a known caller for their name again/);
});

test('supervisor recovers once from a transient Hermes failure and keeps the call active', async () => {
  const spoken = [];
  let waiting = 0;
  let submissions = 0;
  const result = await superviseHermesTurns({
    hermes: {
      async submitAndWait() {
        submissions += 1;
        if (submissions === 1) throw new Error('temporary provider failure');
        return {
          payload: {
            status: 'complete',
            text: 'Thanks for repeating that; I understand you now. I can take the full message and pass it to Siddharth.',
          },
        };
      },
    },
    sessionId: 'session-1',
    callId: 'call-1',
    gateway: {
      async status() { return { currentCall: { callId: 'call-1', phase: 'active' } }; },
      async speak({ text }) { spoken.push(text); return { accepted: true }; },
    },
    turnQueue: {
      latestSequence() { return Math.min(waiting, 2); },
      async waitForTurn() {
        waiting += 1;
        if (waiting === 1) {
          return { status: 'turn', callId: 'call-1', sequence: 1, text: 'Please tell him I called.' };
        }
        if (waiting === 2) {
          return { status: 'turn', callId: 'call-1', sequence: 2, text: 'Please tell Siddharth I called.' };
        }
        return { status: 'ended', callId: 'call-1', sequence: 3 };
      },
    },
    acknowledgementDelayMs: 1_000,
    deadline: Date.now() + 30_000,
  });
  assert.deepEqual(result, { reason: 'call_ended', cycles: 2 });
  assert.deepEqual(spoken, [
    'Sorry, I didn’t catch that clearly. Could you please say that again?',
    'Thanks for repeating that; I understand you now. I can take the full message and pass it to Siddharth.',
  ]);
});

test('supervisor stays audible through repeated Hermes failures and closes naturally', async () => {
  const spoken = [];
  const hangups = [];
  let waiting = 0;
  const result = await superviseHermesTurns({
    hermes: {
      async submitAndWait() { throw new Error('provider unavailable'); },
    },
    sessionId: 'session-1',
    callId: 'call-1',
    gateway: {
      async status() { return { currentCall: { callId: 'call-1', phase: 'active' } }; },
      async speak({ text }) { spoken.push(text); return { accepted: true }; },
      async hangup(value) { hangups.push(value); return { accepted: true }; },
    },
    turnQueue: {
      latestSequence() { return waiting; },
      async waitForTurn() {
        waiting += 1;
        return {
          status: 'turn',
          callId: 'call-1',
          sequence: waiting,
          text: waiting === 1 ? 'Can you hear me?' : `I will repeat that for attempt ${waiting}.`,
        };
      },
    },
    acknowledgementDelayMs: 1_000,
    deadline: Date.now() + 30_000,
  });
  assert.deepEqual(result, { reason: 'agent_hangup', cycles: 4 });
  assert.deepEqual(spoken, [
    'Sorry, I didn’t catch that clearly. Could you please say that again?',
    'I’m still here, but I’m having trouble responding properly. Please give me a moment and ask that once more.',
    'Thanks for waiting. I still can’t answer that reliably, but I’m listening. Could you please try the question one final time?',
    'I’m sorry, I can’t continue reliably right now, and I don’t want to keep you waiting in silence. I’ll end the call here. Goodbye.',
  ]);
  assert.equal(hangups.length, 1);
});

test('turn prompt requires a complete natural reply and preserves interrupted context', () => {
  const prompt = nextTurnPrompt('call-9', 2, {
    text: 'Please continue the point you were making.',
    previousCallerText: 'Tell me about the release plan.',
    interruptedAgentText: 'The first release step is',
  });
  assert.match(prompt, /Never invent/);
  assert.match(prompt, /Preserve the full\s+conversation context/);
  assert.match(prompt, /one to three complete spoken sentences/);
  assert.match(prompt, /normally 10 to 45 words/);
  assert.match(prompt, /one-word, two-word, or\s+three-word fragment/);
  assert.match(prompt, /Do not call\s+any tool/);
  assert.match(prompt, /The first release step is/);
  assert.match(prompt, /<END_CALL>/);
  assert.match(prompt, /call-9/);
});

test('voice replies remove the hangup control marker before continuous speech', () => {
  assert.deepEqual(
    normalizeVoiceReply('Thanks for calling. Goodbye. <END_CALL>'),
    { text: 'Thanks for calling. Goodbye.', hangup: true },
  );
  assert.equal(
    firstNaturalResponse('Yes, this is one complete natural answer. A second thought can follow later.'),
    'Yes, this is one complete natural answer.',
  );
  assert.equal(firstNaturalResponse('Goodbye. <END_CALL>'), '');
});

test('opening media guard waits for the exact call to remain active', async () => {
  assert.equal(callMediaStabilizationDelay('incoming'), 250);
  assert.equal(callMediaStabilizationDelay('outgoing'), 250);
  assert.throws(() => callMediaStabilizationDelay('unknown'), /direction is invalid/);
  assert.equal(
    await waitForStableCallMedia({
      async status() { return { currentCall: { callId: 'call-1', phase: 'active' } }; },
    }, 'call-1', 0),
    true,
  );
  assert.equal(
    await waitForStableCallMedia({
      async status() { return { currentCall: { callId: 'call-2', phase: 'ended' } }; },
    }, 'call-1', 0),
    false,
  );
  await assert.rejects(
    waitForStableCallMedia({ status() {} }, 'call-1', 5_001),
    /media stabilization delay is invalid/,
  );
});

test('incoming answer window rechecks the same ringing call before pickup', async () => {
  const gateway = {
    async status() {
      return {
        currentCall: {
          callId: 'incoming-1',
          direction: 'incoming',
          phase: 'ringing',
        },
      };
    },
  };
  assert.equal(await waitForIncomingAnswerWindow(gateway, 'incoming-1', {
    detectedAt: Date.now() - 1,
    delayMs: 0,
  }), true);
  assert.equal(await waitForIncomingAnswerWindow(gateway, 'incoming-2', {
    detectedAt: Date.now() - 1,
    delayMs: 0,
  }), false);
  await assert.rejects(
    waitForIncomingAnswerWindow(gateway, 'incoming-1', { delayMs: 20_001 }),
    /delay is invalid/,
  );
});

test('Hermes model selection inherits the user default unless explicitly overridden', () => {
  assert.deepEqual(hermesSessionOptions({}, '/workspace'), {
    title: 'Arynox supervised voice call',
    cwd: '/workspace',
    source: 'agentcall-voice-supervisor',
    close_on_disconnect: true,
  });
  assert.deepEqual(hermesSessionOptions({
    HERMES_VOICE_MODEL: 'chosen-model',
    HERMES_VOICE_PROVIDER: 'chosen-provider',
  }, '/workspace'), {
    title: 'Arynox supervised voice call',
    cwd: '/workspace',
    source: 'agentcall-voice-supervisor',
    close_on_disconnect: true,
    model: 'chosen-model',
    provider: 'chosen-provider',
  });
});

test('managed Hermes voice runtime loads only Arynox tools without changing model choice', () => {
  assert.deepEqual(
    hermesGatewayEnvironment({
      HERMES_VOICE_MODEL: 'user-selected-model',
      HERMES_VOICE_PROVIDER: 'user-selected-provider',
      HERMES_VOICE_PROFILE_HOME: '/profiles/voice',
      HERMES_TUI_TOOLSETS: 'coding,web',
    }),
    {
      HERMES_VOICE_MODEL: 'user-selected-model',
      HERMES_VOICE_PROVIDER: 'user-selected-provider',
      HERMES_VOICE_PROFILE_HOME: '/profiles/voice',
      HERMES_TUI_TOOLSETS: 'agentcall',
      HERMES_IGNORE_RULES: '1',
      HERMES_HOME: '/profiles/voice',
    },
  );
  assert.equal('HERMES_VOICE_MODEL' in hermesGatewayEnvironment({}), false);
});

test('configured fast model is health checked and falls back to the user default', async () => {
  const sessions = [];
  const closed = [];
  const hermes = {
    async createSession(options) {
      sessions.push(options);
      return { session_id: `session-${sessions.length}`, info: { model: options.model || 'default' } };
    },
    async submitAndWait(sessionId) {
      return sessionId === 'session-1'
        ? { payload: { status: 'error', text: 'provider rejected tools' } }
        : { payload: { status: 'complete', text: 'READY' } };
    },
    async closeSession(sessionId) { closed.push(sessionId); },
  };
  const selected = await selectWarmedHermesSession({
    hermes,
    environment: {
      HERMES_VOICE_MODEL: 'configured-fast-model',
      HERMES_VOICE_PROVIDER: 'configured-provider',
    },
    cwd: '/workspace',
  });
  assert.equal(selected.session.session_id, 'session-2');
  assert.equal(selected.usedFallback, true);
  assert.deepEqual(closed, ['session-1']);
  assert.equal(sessions[0].model, 'configured-fast-model');
  assert.equal('model' in sessions[1], false);
  assert.equal('provider' in sessions[1], false);
});

test('natural greeting follows local time and uses a bounded saved caller name', () => {
  const atHour = (hour) => new Date(2026, 6, 24, hour, 0, 0);
  assert.equal(
    naturalGreeting({ callerName: 'Siddharth', now: atHour(8) }),
    'Good morning, Siddharth. How are you?',
  );
  assert.match(naturalGreeting({ now: atHour(14) }), /^Good afternoon\./);
  assert.match(naturalGreeting({ now: atHour(19) }), /^Good evening\./);
  assert.match(naturalGreeting({ callerName: 'Sid\u0000\n', now: atHour(23) }), /^Hello, Sid\./);
  assert.deepEqual(standardGreetingOptions(), [
    'Good morning. How are you?',
    'Good afternoon. How are you?',
    'Good evening. How are you?',
    'Hello. How are you?',
  ]);
});

test('outgoing greeting resolves one matching synced contact before dialing', async () => {
  const gateway = {
    async listContacts() {
      return {
        rows: [
          { name: 'Siddharth', number: '5551234567' },
          { name: 'Someone else', number: '+919999999999' },
        ],
      };
    },
  };
  assert.equal(await outgoingContactName(gateway, '+15551234567'), 'Siddharth');
  assert.equal(await outgoingContactName(gateway, '+918888888888'), '');
  assert.equal(await outgoingContactName({ async listContacts() { throw new Error('offline'); } }, '+15551234567'), '');
});

test('outgoing plan is dynamic, speech friendly, and rejects fragment responses', () => {
  const details = {
    recipientName: 'Rahul',
    callContext: 'Confirm tomorrow\'s interview time and how the meeting link will be shared.',
    callerConfiguration: 'The owner name is Aditi.',
    language: 'English',
    now: new Date(2026, 6, 24, 14, 0, 0),
  };
  const prompt = outgoingPlanPrompt(details);
  assert.match(prompt, /Rahul/);
  assert.match(prompt, /interview time/);
  assert.match(prompt, /Aditi/);
  assert.match(prompt, /one to three complete/);
  assert.match(prompt, /protected, uninterrupted segment/);
  assert.doesNotMatch(prompt, /Siddharth/);

  const fallback = fallbackOutgoingPlan(details);
  const normalized = normalizeOutgoingPlan(JSON.stringify(fallback));
  assert.match(normalized.opening, /^Good afternoon\. Rahul,/);
  assert.match(normalized.opening, /AI call(?:ing)? assistant/);
  assert.match(normalized.opening, /call is recorded/);
  assert.match(normalized.opening, /interview time/);
  assert.match(normalized.opening, /\?$/);
  assert.equal((normalized.opening.match(/\?/gu) || []).length, 1);
  assert.doesNotMatch(normalized.responses.recipient_confirmed, /AI calling assistant/);
  assert.match(normalized.responses.attention, /I am here/i);
  assert.match(normalized.responses.stop_calling, /<END_CALL>$/);
  const conciseFallback = fallbackOutgoingPlan({
    recipientName: 'Rahul',
    callContext: 'Test the outgoing audio path. Ask whether every word was clear, then discuss quality.',
    callerConfiguration: 'The owner name is Aditi.',
  });
  assert.match(conciseFallback.opening, /test the outgoing audio path/i);
  assert.doesNotMatch(conciseFallback.opening, /Ask whether/);
  assert.ok(conciseFallback.opening.split(/\s+/u).length <= 60);

  const broken = JSON.parse(JSON.stringify(fallback));
  broken.responses.callback = 'Call later?';
  assert.equal(normalizeOutgoingPlan(JSON.stringify(broken)), null);
  assert.equal(
    normalizeOutgoingPlan(JSON.stringify(broken), { fallback }).responses.callback,
    fallback.responses.callback,
  );
  const sparseOpening = JSON.parse(JSON.stringify(fallback));
  sparseOpening.opening = 'Good afternoon. May I speak with Rahul, please?';
  assert.equal(
    normalizeOutgoingPlan(JSON.stringify(sparseOpening), { fallback }).opening,
    fallback.opening,
  );
  assert.equal(normalizeOutgoingPlan('```json\n{}\n```'), null);
});

test('outgoing prepared replies use semantic intent and defer corrections to Hermes', () => {
  const plan = fallbackOutgoingPlan({
    recipientName: 'Rahul',
    callContext: 'Confirm the interview time.',
    callerConfiguration: 'The owner name is Aditi.',
  });
  for (const phrase of [
    'Who are you?',
    'Who is speaking?',
    'May I know who this is?',
  ]) {
    const reply = createPreparedOutgoingResponder(plan)({ text: phrase });
    assert.equal(reply.intent, 'identity');
    assert.match(reply.text, /AI calling assistant/);
  }

  const responder = createPreparedOutgoingResponder(plan);
  assert.equal(responder({ text: 'Yes, speaking.' }).intent, 'recipient_confirmed');
  assert.equal(responder({ text: 'Who is calling?' }).intent, 'identity');
  assert.equal(responder({ text: 'Who is calling again?' }), null);
  assert.equal(responder({ text: 'Actually, the interview is on Friday.' }), null);
  assert.equal(responder({ text: 'What exact time did she request?' }), null);

  const closingResponder = createPreparedOutgoingResponder(plan);
  const closing = closingResponder({ text: 'We can end this call now.' });
  assert.equal(closing.intent, 'closing');
  assert.equal(closing.hangup, true);
  assert.equal(closing.interruptible, false);
  assert.equal(closing.staleSafe, false);
  assert.match(closing.text, /goodbye/i);
});

test('outgoing prepared state survives hello and noisy yes without restarting the introduction', () => {
  const plan = fallbackOutgoingPlan({
    recipientName: 'Sahil',
    callContext: 'Give a brief Arynox demonstration.',
    callerConfiguration: 'The owner name is Siddharth.',
  });
  const responder = createPreparedOutgoingResponder(plan, { recipientName: 'Sahil' });

  const greetingRepair = responder({ text: 'Hello.' });
  assert.equal(greetingRepair.intent, 'verification_retry');
  assert.equal(greetingRepair.interruptible, false);
  assert.equal(greetingRepair.staleSafe, true);

  const confirmed = responder({ text: 'Yesus Kristus' });
  assert.equal(confirmed.intent, 'recipient_confirmed');
  assert.doesNotMatch(confirmed.text, /AI calling assistant/i);

  const attention = responder({ text: 'Hello, please speak.' });
  assert.equal(attention.intent, 'attention');
  assert.equal(attention.interruptible, false);
  assert.equal(attention.staleSafe, true);
  assert.doesNotMatch(attention.text, /recorded|calling assistant/i);
});

test('supervisor speaks a prepared outgoing reply once without waiting for Hermes', async () => {
  const spoken = [];
  let hermesRequests = 0;
  let waiting = 0;
  const gateway = {
    async status() { return { currentCall: { callId: 'call-out', phase: 'active' } }; },
    async speak({ text }) { spoken.push(text); return { accepted: true }; },
  };
  const hermes = {
    async submitAndWait() {
      hermesRequests += 1;
      throw new Error('Hermes should not be used for a strong prepared match');
    },
  };
  const turnQueue = {
    latestSequence() { return 1; },
    async waitForTurn() {
      waiting += 1;
      return waiting === 1
        ? { status: 'turn', callId: 'call-out', sequence: 1, text: 'Yes, speaking.' }
        : { status: 'ended', callId: 'call-out', sequence: 2 };
    },
  };
  const plan = fallbackOutgoingPlan({
    recipientName: 'Rahul',
    callContext: 'Confirm tomorrow\'s interview time.',
    callerConfiguration: 'The owner name is Aditi.',
  });
  const cycles = [];
  const result = await superviseHermesTurns({
    hermes,
    sessionId: 'session-out',
    callId: 'call-out',
    gateway,
    turnQueue,
    deadline: Date.now() + 30_000,
    outgoing: {
      recipientName: 'Rahul',
      callContext: 'Confirm tomorrow\'s interview time.',
      callerConfiguration: 'The owner name is Aditi.',
    },
    preparedResponder: createPreparedOutgoingResponder(plan),
    onCycle: (cycle) => cycles.push(cycle),
  });
  assert.deepEqual(result, { reason: 'call_ended', cycles: 1 });
  assert.equal(hermesRequests, 0);
  assert.equal(spoken.length, 1);
  assert.equal(spoken[0], plan.responses.recipient_confirmed);
  assert.equal(cycles[0].completion.payload.status, 'prepared');
  assert.equal(cycles[0].completion.payload.intent, 'recipient_confirmed');
});

test('supervisor protects one attention repair and suppresses its immediate duplicate', async () => {
  const spoken = [];
  let waiting = 0;
  let latestSequence = 2;
  const plan = fallbackOutgoingPlan({
    recipientName: 'Sahil',
    callContext: 'Give a brief Arynox demonstration.',
  });
  const result = await superviseHermesTurns({
    hermes: {
      async submitAndWait() {
        throw new Error('Hermes should not handle repeated attention checks');
      },
    },
    sessionId: 'session-attention',
    callId: 'call-attention',
    gateway: {
      async status() {
        return { currentCall: { callId: 'call-attention', phase: 'active' } };
      },
      async speak(value) {
        spoken.push(value);
        return { accepted: true, interrupted: false };
      },
    },
    turnQueue: {
      latestSequence() { return latestSequence; },
      async waitForTurn() {
        waiting += 1;
        if (waiting === 1) return {
          status: 'turn', callId: 'call-attention', sequence: 1, text: 'Hello.',
        };
        if (waiting === 2) {
          latestSequence = 2;
          return {
            status: 'turn', callId: 'call-attention', sequence: 2, text: 'Hello please speak.',
          };
        }
        return { status: 'ended', callId: 'call-attention', sequence: 3 };
      },
    },
    deadline: Date.now() + 30_000,
    preparedResponder: createPreparedOutgoingResponder(plan, { recipientName: 'Sahil' }),
  });

  assert.deepEqual(result, { reason: 'call_ended', cycles: 2 });
  assert.equal(spoken.length, 1);
  assert.equal(spoken[0].interruptible, false);
  assert.equal(spoken[0].text, plan.responses.verification_retry);
});

test('repeated substantive caller requests remain conversational instead of being dropped', async () => {
  let waiting = 0;
  let hermesRequests = 0;
  const spoken = [];
  const result = await superviseHermesTurns({
    hermes: {
      async submitAndWait(_sessionId, prompt) {
        hermesRequests += 1;
        if (hermesRequests === 2) assert.match(prompt, /Recent spoken conversation/);
        return {
          payload: {
            status: 'complete',
            text: hermesRequests === 1
              ? 'Siddharth is unavailable right now, but I can take a message for him.'
              : 'Yes, I heard you. Siddharth is still unavailable, and I can record your message now.',
          },
        };
      },
    },
    sessionId: 'session-repeat',
    callId: 'call-repeat',
    gateway: {
      async status() {
        return { currentCall: { callId: 'call-repeat', phase: 'active' } };
      },
      async speak({ text }) {
        spoken.push(text);
        return { accepted: true };
      },
    },
    turnQueue: {
      latestSequence() { return Math.min(waiting, 2); },
      async waitForTurn() {
        waiting += 1;
        if (waiting <= 2) {
          return {
            status: 'turn',
            callId: 'call-repeat',
            sequence: waiting,
            text: 'Is Siddharth available right now?',
          };
        }
        return { status: 'ended', callId: 'call-repeat', sequence: 3 };
      },
    },
    deadline: Date.now() + 30_000,
  });
  assert.deepEqual(result, { reason: 'call_ended', cycles: 2 });
  assert.equal(hermesRequests, 2);
  assert.equal(spoken.length, 2);
});

test('outgoing stop request uses the prepared full sentence and ends the call', async () => {
  const spoken = [];
  const hangups = [];
  const gateway = {
    async status() { return { currentCall: { callId: 'call-stop', phase: 'active' } }; },
    async speak({ text }) { spoken.push(text); return { accepted: true }; },
    async hangup(value) { hangups.push(value); return { accepted: true }; },
  };
  const plan = fallbackOutgoingPlan({
    callContext: 'Ask whether the requested information is available.',
  });
  const result = await superviseHermesTurns({
    hermes: { async submitAndWait() { throw new Error('not expected'); } },
    sessionId: 'session-stop',
    callId: 'call-stop',
    gateway,
    turnQueue: {
      latestSequence() { return 1; },
      async waitForTurn() {
        return { status: 'turn', callId: 'call-stop', sequence: 1, text: 'Do not call me again.' };
      },
    },
    deadline: Date.now() + 30_000,
    preparedResponder: createPreparedOutgoingResponder(plan),
  });
  assert.deepEqual(result, { reason: 'agent_hangup', cycles: 1 });
  assert.deepEqual(spoken, [normalizeVoiceReply(plan.responses.stop_calling).text]);
  assert.equal(hangups.length, 1);
});

test('outgoing live-agent prompt keeps the call objective and prepared conversation history', () => {
  const prompt = nextTurnPrompt('call-context', 3, {
    text: 'Actually, it will be at eleven in the morning.',
  }, {
    spokenOpening: 'Good afternoon. May I speak with Rahul, please?',
    outgoing: {
      recipientName: 'Rahul',
      callContext: 'Confirm the interview time and meeting-link delivery.',
      callerConfiguration: 'The owner name is Aditi.',
    },
    conversationHistory: [
      { speaker: 'receiver', text: 'Yes, speaking.' },
      { speaker: 'agent', text: 'I am calling on behalf of Aditi about the interview.' },
    ],
  });
  assert.match(prompt, /outgoing call/);
  assert.match(prompt, /Rahul/);
  assert.match(prompt, /meeting-link delivery/);
  assert.match(prompt, /Recent spoken conversation/);
  assert.match(prompt, /Treat corrections as authoritative/);
  assert.match(prompt, /incomplete or incoherent fragment/);
  assert.match(prompt, /Do not introduce a support ticket/);
  assert.match(prompt, /never return a one-word, two-word, or\s+three-word fragment/);
});

test('outgoing planning falls back safely when Hermes returns malformed content', async () => {
  const details = {
    recipientName: 'Rahul',
    callContext: 'Confirm the interview time.',
  };
  const plan = await prepareOutgoingPlan({
    async submitAndWait() {
      return { payload: { status: 'complete', text: '{"opening":"Hi."}' } };
    },
  }, 'session-out', details);
  assert.deepEqual(plan, fallbackOutgoingPlan(details));
});

test('incoming greeting prompt carries bounded owner context without inventing identity', () => {
  const prompt = incomingGreetingPrompt({
    callId: 'incoming-1',
    callerName: 'Siddharth',
    instructions: 'I am in a meeting. Ask for a short message.',
  });
  assert.match(prompt, /incoming-1/);
  assert.match(prompt, /Siddharth/);
  assert.match(prompt, /I am in a meeting/);
  assert.match(prompt, /one additional short, natural/);
  assert.doesNotMatch(prompt, /phone number/i);
});

test('receptionist opening is prepared before pickup and remains short and human', () => {
  const prompt = openingDraftPrompt('I am in a meeting. Ask for their name and reason.');
  assert.match(prompt, /14 to 22 ordinary/);
  assert.match(prompt, /exactly two short/);
  assert.match(prompt, /I am in a meeting/);
  assert.doesNotMatch(prompt, /callId/);
  assert.equal(
    normalizeOpeningDraft('  "They are in a meeting. May I take a message?"  '),
    'They are in a meeting. May I take a message?',
  );
  assert.equal(
    normalizeOpeningDraft('Hi, Siddharth is in a meeting. May I take a message?'),
    'Siddharth is in a meeting. May I take a message?',
  );
  assert.equal(normalizeOpeningDraft('unsafe\nsecond line'), '');
  const opening = incomingOpening({
    callerName: 'Siddharth',
    draft: 'They are in a meeting. May I take a message?',
    now: new Date(2026, 6, 24, 19, 0, 0),
  });
  assert.equal(
    opening,
    'Good evening, Siddharth. You’ve reached Arynox, the AI call assistant. They are in a meeting. May I take a message?',
  );
  assert.match(opening, /May I take a message/);
  assert.doesNotMatch(opening, /How are you/);
});

test('incoming opening has complete known and unknown caller scripts with safe context fallback', () => {
  const instructions = 'Siddharth is currently in a meeting and will call back when available.';
  assert.equal(ownerNameFromInstructions(instructions), 'Siddharth');
  assert.match(fallbackOpeningDraft(instructions), /in a meeting/);
  assert.equal(
    incomingOpening({
      callerName: 'Aarav',
      instructions,
      now: new Date(2026, 6, 24, 8, 0, 0),
    }),
    "Good morning, Aarav. You’ve reached Siddharth’s AI call assistant. Siddharth is in a meeting right now. I can take a message or arrange a callback.",
  );
  assert.equal(
    incomingOpening({
      instructions,
      now: new Date(2026, 6, 24, 8, 0, 0),
    }),
    "Good morning. You’ve reached Siddharth’s AI call assistant. Siddharth is in a meeting right now. May I take your name and a brief message?",
  );
  assert.doesNotMatch(
    fallbackOpeningDraft('Do not mention my private meeting. Just take a message.'),
    /meeting/u,
  );
});

test('incoming receptionist prepares reusable time-aware openings without caller-specific synthesis', () => {
  const openings = preparedIncomingOpenings({
    draft: 'Siddharth is in a meeting. I can take a message and arrange a callback.',
    instructions: 'Siddharth is currently in a meeting.',
  });
  assert.match(openings.morning, /^Good morning\./);
  assert.match(openings.afternoon, /^Good afternoon\./);
  assert.match(openings.evening, /^Good evening\./);
  assert.match(openings.night, /^Hello\./);
  for (const opening of Object.values(openings)) {
    assert.match(opening, /Siddharth/);
    assert.match(opening, /May I take your name and a brief message/);
    assert.ok(opening.split(/\s+/u).length <= 30);
  }
  assert.equal(
    preparedIncomingOpeningForTime(openings, new Date(2026, 6, 24, 19, 0, 0)),
    openings.evening,
  );
});

test('incoming receptionist pre-generated replies are complete and selected only for matching intent', () => {
  const responses = preparedIncomingResponses('Siddharth is in a meeting.');
  for (const value of Object.values(responses)) {
    assert.ok(value.replace(' <END_CALL>', '').split(/\s+/u).length >= 7);
  }
  const respond = createPreparedIncomingResponder(responses);
  const attention = respond({ text: 'Hello, please speak.' }, {
    conversationHistory: [
      { speaker: 'agent', text: 'Good afternoon. You reached the assistant.' },
    ],
  });
  assert.equal(attention.intent, 'attention');
  assert.equal(attention.interruptible, false);
  assert.equal(attention.staleSafe, true);
  const flowRespond = createPreparedIncomingResponder(responses);
  const openingHistory = [
    { speaker: 'agent', text: 'Good afternoon. May I know your name and reason for calling?' },
  ];
  assert.equal(
    flowRespond({ text: 'My name is Aarav.' }, { conversationHistory: openingHistory }).intent,
    'name_only',
  );
  assert.equal(
    flowRespond({ text: 'I am calling about tomorrow meeting.' }, {
      conversationHistory: [
        ...openingHistory,
        { speaker: 'receiver', text: 'My name is Aarav.' },
        { speaker: 'agent', text: responses.name_only },
      ],
    }).intent,
    'message_received',
  );
  assert.equal(
    flowRespond({ text: "No, it's just a casual thing." }, {
      conversationHistory: [
        ...openingHistory,
        { speaker: 'receiver', text: 'I am calling about tomorrow meeting.' },
        { speaker: 'agent', text: responses.message_received },
      ],
    }).intent,
    'not_urgent',
  );
  const specificQuestionResponder = createPreparedIncomingResponder(responses);
  assert.equal(
    specificQuestionResponder({ text: 'Is Siddharth available at 9 PM today.' }, {
      conversationHistory: openingHistory,
    }),
    null,
  );
  assert.equal(
    specificQuestionResponder({ text: 'Just he is available at 9 PM today.' }, {
      conversationHistory: openingHistory,
    }),
    null,
  );
  assert.deepEqual(respond({ text: 'My name is Aarav.' }), {
    intent: 'name_only',
    text: responses.name_only,
    hangup: false,
    interruptible: true,
    staleSafe: false,
  });
  assert.deepEqual(respond({ text: 'This is urgent, please let him know.' }), {
    intent: 'urgent',
    text: responses.urgent,
    hangup: false,
    interruptible: true,
    staleSafe: false,
  });
  assert.equal(respond({ text: 'What exact time will he return?' }), null);
  const closing = respond({ text: 'Okay, goodbye.' });
  assert.equal(closing.intent, 'closing');
  assert.equal(closing.hangup, true);
  assert.doesNotMatch(closing.text, /END_CALL/u);
});
