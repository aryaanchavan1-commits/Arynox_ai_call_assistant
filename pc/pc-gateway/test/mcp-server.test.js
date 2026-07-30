import { test } from 'node:test';
import assert from 'node:assert/strict';

import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { PassThrough, Readable, Writable } from 'node:stream';

import {
  contextualAcknowledgement,
  contextualAcknowledgementFollowUp,
  isMcpServerEntrypoint,
  mergeTranscriptFragments,
  McpHandler,
  JSONRPC_ERROR,
  runStdio,
} from '../src/mcp-server.js';

const TOOL_NAMES = [
  'status', 'capabilities', 'wait_for_incoming_call', 'wait_for_turn',
  'dial', 'prepare_speech', 'answer', 'reject', 'hangup', 'send_dtmf', 'speak',
];

test('MCP entrypoint detection accepts the native absolute path on every platform', () => {
  const moduleUrl = new URL('../src/mcp-server.js', import.meta.url).href;
  assert.equal(isMcpServerEntrypoint(['node', fileURLToPath(moduleUrl)], moduleUrl), true);
  assert.equal(isMcpServerEntrypoint(['node', fileURLToPath(import.meta.url)], moduleUrl), false);
});

function fakeGateway() {
  const calls = [];
  const gateway = new EventEmitter();
  Object.assign(gateway, {
    calls,
    status: () => ({ state: 'running', metrics: { commandsSent: 0 } }),
    capabilities: () => ({ tools: TOOL_NAMES }),
    agentAnsweringStatus: async () => ({ enabled: false, instructions: '' }),
    dial: async (args) => { calls.push(['dial', args]); return { accepted: true, callId: 'call-1' }; },
    answer: async (args) => { calls.push(['answer', args]); return { accepted: true }; },
    reject: async (args) => { calls.push(['reject', args]); return { accepted: true }; },
    hangup: async (args) => { calls.push(['hangup', args]); return { accepted: true }; },
    sendDtmf: async (args) => { calls.push(['sendDtmf', args]); return { accepted: true }; },
    speak: async (args) => { calls.push(['speak', args]); return { accepted: true }; },
    prewarmSpeech: async (args) => { calls.push(['prewarmSpeech', args]); return { ready: true }; },
  });
  return gateway;
}

function call(name, args, id = 1) {
  return { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } };
}

function approvedDial(overrides = {}) {
  return {
    destination: '+15551234567',
    openingText: 'Good afternoon. May I speak with Siddharth, please?',
    preparedReplies: [
      'Hello, I am calling on behalf of the person who requested this call.',
      'No problem. What time would be more convenient for a brief call?',
    ],
    approved: true,
    consent: { recorded: true, policy: 'explicit test recording consent' },
    idempotencyKey: 'approved-dial',
    ...overrides,
  };
}

function toolPayload(response) {
  assert.deepEqual(Object.keys(response.result).sort(), ['content', 'isError']);
  assert.equal(response.result.isError, false);
  assert.equal(response.result.content.length, 1);
  assert.equal(response.result.content[0].type, 'text');
  return JSON.parse(response.result.content[0].text);
}

function failedToolPayload(response) {
  assert.deepEqual(Object.keys(response.result).sort(), ['content', 'isError']);
  assert.equal(response.result.isError, true);
  assert.equal(response.result.content.length, 1);
  assert.equal(response.result.content[0].type, 'text');
  return JSON.parse(response.result.content[0].text);
}

test('stdio does not lose initialize received while event stream starts', async () => {
  const gateway = fakeGateway();
  const input = new PassThrough();
  const output = new PassThrough();
  let text = '';
  output.setEncoding('utf8');
  output.on('data', (chunk) => { text += chunk; });
  let releaseEvents;
  gateway.startEvents = () => new Promise((resolve) => { releaseEvents = resolve; });
  gateway.stopEvents = () => {};

  const running = runStdio(gateway, input, output);
  input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 91, method: 'initialize', params: {} })}\n`);
  await new Promise((resolve) => setImmediate(resolve));
  releaseEvents();
  input.end();
  await running;

  const response = JSON.parse(text.trim());
  assert.equal(response.id, 91);
  assert.equal(response.result.protocolVersion, '2024-11-05');
});

test('stdio runner starts and stops daemon event stream with its lifecycle', async () => {
  const gateway = fakeGateway();
  const lifecycle = [];
  gateway.startEvents = async () => { lifecycle.push('start'); };
  gateway.stopEvents = () => { lifecycle.push('stop'); };
  const output = new PassThrough();
  output.resume();
  await runStdio(gateway, Readable.from([]), output);
  assert.deepEqual(lifecycle, ['start', 'stop']);
});

test('stdio drains bounded in-flight requests before treating input EOF as shutdown', async () => {
  const gateway = fakeGateway();
  gateway.status = ({ signal } = {}) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve({ state: 'running' }), 15);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new Error('status aborted'));
    }, { once: true });
  });
  const output = new PassThrough();
  let text = '';
  output.setEncoding('utf8');
  output.on('data', (chunk) => { text += chunk; });
  const input = Readable.from([
    `${JSON.stringify(call('status', {}, 93))}\n`,
  ]);

  await runStdio(gateway, input, output);
  const response = JSON.parse(text.trim());
  assert.equal(response.id, 93);
  assert.equal(response.result.isError, false);
  assert.equal(JSON.parse(response.result.content[0].text).state, 'running');
});

test('stdio treats an output EPIPE as a closed client without crashing', async () => {
  const output = new Writable({
    write(_chunk, _encoding, _callback) {
      queueMicrotask(() => {
        const problem = Object.assign(new Error('client closed'), { code: 'EPIPE' });
        this.emit('error', problem);
      });
    },
  });
  const input = Readable.from([
    `${JSON.stringify({ jsonrpc: '2.0', id: 92, method: 'initialize', params: {} })}\n`,
  ]);

  await runStdio(fakeGateway(), input, output);
  assert.equal(output.listenerCount('error'), 0);
});

test('initialize negotiates MCP protocolVersion 2024-11-05', async () => {
  const response = await new McpHandler(fakeGateway()).handle({ jsonrpc: '2.0', id: 1, method: 'initialize' });
  assert.equal(response.result.protocolVersion, '2024-11-05');
  assert.deepEqual(response.result.serverInfo, { name: 'agentcall-mcp', version: '1.0.0' });
});

test('tools/list exposes exactly required strict schemas with no PCM surface', async () => {
  const response = await new McpHandler(fakeGateway()).handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  assert.deepEqual(response.result.tools.map(({ name }) => name), TOOL_NAMES);
  for (const tool of response.result.tools) assert.equal(tool.inputSchema.additionalProperties, false);
  assert.deepEqual(response.result.tools[0].inputSchema, { type: 'object', properties: {}, additionalProperties: false });
  assert.deepEqual(response.result.tools[1].inputSchema, { type: 'object', properties: {}, additionalProperties: false });
  assert.equal(/pcm|base64|payload|send_uplink|request_downlink_probe/i.test(JSON.stringify(response.result.tools)), false);
});

test('mutation tools derive bounded downstream idempotency when an agent omits its key', async () => {
  const gateway = fakeGateway();
  const handler = new McpHandler(gateway);
  const cases = [
    ['dial', approvedDial({ idempotencyKey: undefined })],
    ['answer', { callId: 'call-1' }],
    ['reject', { callId: 'call-1' }],
    ['hangup', { callId: 'call-1' }],
    ['send_dtmf', { callId: 'call-1', digits: '1' }],
  ];
  for (const [name, args] of cases) {
    const response = await handler.handle(call(name, args));
    assert.equal(toolPayload(response).accepted, true, name);
  }
  const keys = gateway.calls
    .filter(([name]) => ['dial', 'answer', 'reject', 'hangup', 'sendDtmf'].includes(name))
    .map(([, args]) => args.idempotencyKey);
  assert.equal(keys.length, 5);
  assert.equal(keys.every((key) => /^mcp-[a-z-]+-[a-f0-9]{48}$/.test(key)), true);
});

test('unknown fields are rejected for every tool', async () => {
  const gateway = fakeGateway();
  const handler = new McpHandler(gateway);
  for (const [name, args] of [
    ['status', { extra: true }],
    ['capabilities', { extra: true }],
    ['wait_for_incoming_call', { afterSequence: 0, extra: true }],
    ['wait_for_turn', { callId: 'call-1', afterSequence: 0, extra: true }],
    ['dial', { destination: '+15551234567', idempotencyKey: 'key', extra: true }],
    ['prepare_speech', { callId: 'call-1', texts: ['Hello.'], extra: true }],
    ['answer', { callId: 'call-1', idempotencyKey: 'key', extra: true }],
    ['reject', { callId: 'call-1', idempotencyKey: 'key', extra: true }],
    ['hangup', { callId: 'call-1', idempotencyKey: 'key', extra: true }],
    ['send_dtmf', { callId: 'call-1', digits: '1', idempotencyKey: 'key', extra: true }],
  ]) {
    assert.equal((await handler.handle(call(name, args))).error.code, JSONRPC_ERROR.INVALID_PARAMS, name);
  }
  assert.equal(gateway.calls.length, 0);
});

test('dial requires manual approval, strict recording consent, and E.164 before routing', async () => {
  const gateway = fakeGateway();
  const handler = new McpHandler(gateway);
  const consent = { recorded: true, policy: 'explicit test recording consent' };
  assert.equal((await handler.handle(call('dial', {
    ...approvedDial(), destination: '5551234', consent, idempotencyKey: 'key-1',
  }))).error.code, JSONRPC_ERROR.INVALID_PARAMS);
  assert.equal((await handler.handle(call('dial', {
    ...approvedDial(), consent: undefined, idempotencyKey: 'key-missing-consent',
  }))).error.code, JSONRPC_ERROR.INVALID_PARAMS);
  assert.equal((await handler.handle(call('dial', {
    ...approvedDial(), approved: false, consent, idempotencyKey: 'key-unapproved',
  }))).error.code, JSONRPC_ERROR.INVALID_PARAMS);
  const args = approvedDial({ consent, idempotencyKey: 'key-2' });
  const response = await handler.handle(call('dial', args));
  assert.equal(toolPayload(response).accepted, true);
  assert.deepEqual(gateway.calls[0], ['prewarmSpeech', { text: args.openingText }]);
  assert.deepEqual({
    ...gateway.calls[1][1],
    idempotencyKey: '[derived]',
  }, {
    destination: args.destination,
    approved: true,
    consent,
    idempotencyKey: '[derived]',
  });
  assert.match(gateway.calls[1][1].idempotencyKey, /^mcp-dial-[a-f0-9]{48}$/);
});

test('dial fails closed before touching the phone when its opening is not ready', async () => {
  const gateway = fakeGateway();
  gateway.prewarmSpeech = async ({ text }) => {
    gateway.calls.push(['prewarmSpeech', { text }]);
    return { ready: false };
  };
  const payload = toolPayload(await new McpHandler(gateway).handle(call('dial', approvedDial())));
  assert.deepEqual(payload, { accepted: false, reason: 'opening speech unavailable' });
  assert.deepEqual(gateway.calls, [[
    'prewarmSpeech',
    { text: approvedDial().openingText },
  ]]);
});

test('gateway failures return a bounded MCP tool error without leaking exception details', async () => {
  const gateway = fakeGateway();
  gateway.dial = async () => {
    throw Object.assign(new Error('token=private-value at /etc/agentcall/gateway.env'), {
      code: 'GATEWAY_OPERATION_FAILED',
    });
  };
  const response = await new McpHandler(gateway).handle(call('dial', approvedDial()));
  assert.deepEqual(failedToolPayload(response), {
    accepted: false,
    reason: 'gateway request failed',
  });
  assert.doesNotMatch(JSON.stringify(response), /private-value|\/etc\/agentcall|token=/i);
});

test('gateway transport failures are classified into actionable MCP tool errors', async () => {
  const cases = [
    [Object.assign(new Error('connect ENOENT /run/private.sock'), { code: 'ENOENT' }), 'gateway unavailable'],
    [new Error('RPC call timed out'), 'gateway timed out'],
    [Object.assign(new Error('RPC call aborted'), { code: 'ABORT_ERR' }), 'operation aborted'],
    [Object.assign(new Error('invalid RPC response'), { code: 'INVALID_RPC_RESPONSE' }), 'invalid gateway response'],
  ];
  for (const [problem, reason] of cases) {
    const gateway = fakeGateway();
    gateway.status = async () => { throw problem; };
    assert.deepEqual(
      failedToolPayload(await new McpHandler(gateway).handle(call('status', {}))),
      { accepted: false, reason },
    );
  }
});

test('malformed successful gateway data fails closed as an MCP tool error', async () => {
  const gateway = fakeGateway();
  gateway.answer = async () => 'not a receipt';
  assert.deepEqual(
    failedToolPayload(await new McpHandler(gateway).handle(call('answer', {
      callId: 'call-1',
      idempotencyKey: 'malformed-receipt',
    }))),
    { accepted: false, reason: 'invalid gateway response' },
  );
});

test('dial automatically plays its prepared opening once when outgoing media becomes active', async () => {
  const gateway = fakeGateway();
  gateway.status = async () => ({
    state: 'running',
    currentCall: { callId: 'call-1', direction: 'outgoing', phase: 'active' },
    recording: { active: true },
    realtime: { active: true },
  });
  const handler = new McpHandler(gateway, { openingMediaStabilizationMs: 1 });
  const args = approvedDial({ idempotencyKey: 'opening-once' });
  const payload = toolPayload(await handler.handle(call('dial', args)));
  assert.equal(payload.callId, 'call-1');
  assert.equal(payload.nextAction, 'wait_for_turn');
  assert.equal(payload.afterSequence, 0);
  const duplicate = toolPayload(await handler.handle(call('speak', {
    callId: 'call-1',
    text: `  ${args.openingText}  `,
  })));
  assert.deepEqual(duplicate, { accepted: true, callId: 'call-1' });
  assert.equal(gateway.calls.filter(([name]) => name === 'speak').length, 0);
  gateway.emit('event', {
    event: 'active', callId: 'call-1', direction: 'outgoing', phase: 'active',
  });
  gateway.emit('event', {
    event: 'active', callId: 'call-1', direction: 'outgoing', phase: 'active',
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const spoken = gateway.calls.filter(([name]) => name === 'speak');
  assert.equal(spoken.length, 1);
  assert.deepEqual({
    ...spoken[0][1],
    idempotencyKey: '[derived]',
  }, {
    callId: 'call-1',
    text: args.openingText,
    interruptible: false,
    idempotencyKey: '[derived]',
  });
  assert.match(spoken[0][1].idempotencyKey, /^mcp-protected-opening-[a-f0-9]{48}-1$/);
  assert.deepEqual(
    gateway.calls.filter(([name]) => name === 'prewarmSpeech').map(([, value]) => value.text),
    [args.openingText, ...args.preparedReplies],
  );
  handler.close();
});

test('dial ignores a previously ended outgoing call when correlating the new opening', async () => {
  const gateway = fakeGateway();
  gateway.dial = async (args) => {
    gateway.calls.push(['dial', args]);
    gateway.emit('event', {
      event: 'dialing', callId: 'new-call', direction: 'outgoing', phase: 'dialing',
    });
    return { accepted: true };
  };
  gateway.status = async () => ({
    state: 'running',
    currentCall: { callId: 'new-call', direction: 'outgoing', phase: 'dialing' },
  });
  const handler = new McpHandler(gateway, {
    dialCorrelationTimeoutMs: 100,
    dialCorrelationPollMs: 1,
  });
  gateway.emit('event', {
    event: 'active', callId: 'old-call', direction: 'outgoing', phase: 'active',
  });
  gateway.emit('event', {
    event: 'ended', callId: 'old-call', direction: 'outgoing', phase: 'ended',
  });

  const payload = toolPayload(await handler.handle(call('dial', approvedDial({
    idempotencyKey: 'new-call-after-ended-call',
  }))));

  assert.equal(payload.callId, 'new-call');
  assert.equal(payload.nextAction, 'wait_for_turn');
  handler.close();
});

test('prepared opening waits for recording and realtime readiness before speaking', async () => {
  const gateway = fakeGateway();
  let mediaReady = false;
  gateway.status = async () => ({
    state: 'running',
    currentCall: { callId: 'call-1', direction: 'outgoing', phase: 'active' },
    recording: { active: mediaReady },
    realtime: { active: mediaReady },
  });
  const handler = new McpHandler(gateway, {
    openingMediaStabilizationMs: 0,
    openingReadyTimeoutMs: 100,
    openingReadyPollMs: 1,
  });
  await handler.handle(call('dial', approvedDial({ idempotencyKey: 'wait-for-media' })));
  gateway.emit('event', {
    event: 'active', callId: 'call-1', direction: 'outgoing', phase: 'active',
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(gateway.calls.some(([name]) => name === 'speak'), false);

  mediaReady = true;
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(gateway.calls.filter(([name]) => name === 'speak').length, 1);
  handler.close();
});

test('speech candidates queue in the active voice without delaying the live agent', async () => {
  const gateway = fakeGateway();
  let releaseFirst;
  gateway.status = async () => ({
    state: 'running',
    currentCall: { callId: 'call-1', direction: 'outgoing', phase: 'dialing' },
  });
  gateway.prewarmSpeech = async ({ text }) => {
    gateway.calls.push(['prewarmSpeech', { text }]);
    if (text === 'Good morning, Siddharth.') {
      await new Promise((resolve) => { releaseFirst = resolve; });
    }
    return { ready: true };
  };
  const handler = new McpHandler(gateway);
  const response = await handler.handle(call('prepare_speech', {
    callId: 'call-1',
    texts: ['Good morning, Siddharth.', 'May I ask you one quick question?'],
  }));
  assert.deepEqual(toolPayload(response), {
    accepted: true,
    callId: 'call-1',
    queued: 2,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(gateway.calls, [
    ['prewarmSpeech', { text: 'Good morning, Siddharth.' }],
  ]);
  releaseFirst();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(gateway.calls, [
    ['prewarmSpeech', { text: 'Good morning, Siddharth.' }],
    ['prewarmSpeech', { text: 'May I ask you one quick question?' }],
  ]);
});

test('speech preparation is bounded and requires the correlated call', async () => {
  const gateway = fakeGateway();
  const handler = new McpHandler(gateway);
  const invalid = await handler.handle(call('prepare_speech', {
    callId: 'call-1',
    texts: [],
  }));
  assert.equal(invalid.error.code, JSONRPC_ERROR.INVALID_PARAMS);
  assert.deepEqual(toolPayload(await handler.handle(call('prepare_speech', {
    callId: 'call-1',
    texts: ['Hello there.'],
  }))), {
    accepted: false,
    callId: 'call-1',
    queued: 0,
    reason: 'call not available for speech preparation',
  });
});

test('accepted dial receipt includes the correlated outgoing callId for the agent loop', async () => {
  const gateway = fakeGateway();
  gateway.dial = async (args) => {
    gateway.calls.push(['dial', args]);
    return { accepted: true };
  };
  let statusCalls = 0;
  gateway.status = async () => {
    statusCalls++;
    return statusCalls === 1
      ? { state: 'running', currentCall: null }
      : {
        state: 'running',
        currentCall: { callId: 'outgoing-call-42', direction: 'outgoing', phase: 'dialing' },
      };
  };
  const handler = new McpHandler(gateway, {
    dialCorrelationTimeoutMs: 100,
    dialCorrelationPollMs: 1,
  });

  const payload = toolPayload(await handler.handle(call('dial', {
    ...approvedDial(),
    idempotencyKey: 'dial-correlates-call',
  })));

  assert.equal(payload.accepted, true);
  assert.equal(payload.callId, 'outgoing-call-42');
  assert.equal(statusCalls, 2);
});

test('answer/reject/hangup require bounded callId', async () => {
  const handler = new McpHandler(fakeGateway());
  for (const name of ['answer', 'reject', 'hangup']) {
    assert.equal((await handler.handle(call(name, { idempotencyKey: 'key' }))).error.code, JSONRPC_ERROR.INVALID_PARAMS);
    assert.equal((await handler.handle(call(name, { callId: '', idempotencyKey: 'key' }))).error.code, JSONRPC_ERROR.INVALID_PARAMS);
  }
});

test('send_dtmf validates bounded digits [0-9*#A-D]', async () => {
  const handler = new McpHandler(fakeGateway());
  for (const digits of ['', '12E', '1 2']) {
    assert.equal((await handler.handle(call('send_dtmf', { callId: 'call-1', digits, idempotencyKey: 'key' }))).error.code, JSONRPC_ERROR.INVALID_PARAMS);
  }
  assert.equal(toolPayload(await handler.handle(call('send_dtmf', {
    callId: 'call-1', digits: '09*#ABCD', idempotencyKey: 'key',
  }))).accepted, true);
});

test('speak routes bounded response text to the active call', async () => {
  const gateway = fakeGateway();
  const handler = new McpHandler(gateway);
  const response = await handler.handle(call('speak', {
    callId: 'call-1', text: 'I can help.', idempotencyKey: 'speak-1',
  }));
  assert.equal(toolPayload(response).accepted, true);
  assert.deepEqual({
    ...gateway.calls.at(-1)[1],
    idempotencyKey: '[derived]',
  }, {
    callId: 'call-1', text: 'I can help.', idempotencyKey: '[derived]',
  });
  assert.match(gateway.calls.at(-1)[1].idempotencyKey, /^mcp-speak-[a-f0-9]{48}$/);
  assert.equal((await handler.handle(call('speak', {
    callId: 'call-1', text: '', idempotencyKey: 'speak-2',
  }))).error.code, JSONRPC_ERROR.INVALID_PARAMS);
});

test('reused agent idempotency keys cannot collide across operations or different replies', async () => {
  const gateway = fakeGateway();
  const handler = new McpHandler(gateway);
  const reused = 'agent-reused-one-key';
  await handler.handle(call('dial', approvedDial({ idempotencyKey: reused })));
  await handler.handle(call('speak', {
    callId: 'call-1', text: 'The first complete reply.', respondingToSequence: 1,
    idempotencyKey: reused,
  }));
  await handler.handle(call('speak', {
    callId: 'call-1', text: 'The second complete reply.', respondingToSequence: 2,
    idempotencyKey: reused,
  }));
  await handler.handle(call('hangup', { callId: 'call-1', idempotencyKey: reused }));

  const keys = gateway.calls
    .filter(([name]) => ['dial', 'speak', 'hangup'].includes(name))
    .map(([, args]) => args.idempotencyKey);
  assert.equal(keys.length, 4);
  assert.equal(new Set(keys).size, 4);
  assert.equal(keys.every((key) => /^mcp-[a-z-]+-[a-f0-9]{48}$/.test(key)), true);
});

test('Hermes field aliases and omitted cursors do not add repair turns or repeat caller turns', async () => {
  const gateway = fakeGateway();
  const handler = new McpHandler(gateway, {
    completeTurnSettleMs: 5,
    incompleteTurnSettleMs: 10,
  });
  const dialArgs = approvedDial();
  const dial = toolPayload(await handler.handle(call('dial', {
    number: dialArgs.destination,
    opening: dialArgs.openingText,
    responses: dialArgs.preparedReplies,
    approved: true,
    consent: dialArgs.consent,
    idempotency_key: 'hermes-compatible-dial',
  })));
  assert.equal(dial.accepted, true);

  const firstWait = handler.handle(call('wait_for_turn', {
    call_id: 'call-1',
    timeout_ms: 500,
  }));
  gateway.emit('event', {
    event: 'transcript_final',
    callId: 'call-1',
    speaker: 'remote',
    complete: true,
    text: 'There is a noticeable delay.',
  });
  const first = toolPayload(await firstWait);
  assert.equal(first.sequence, 1);

  const spoken = toolPayload(await handler.handle(call('speak', {
    call_id: 'call-1',
    speechText: 'Thanks for telling me. I am checking that delay now.',
    sequence: first.sequence,
  })));
  assert.equal(spoken.accepted, true);
  assert.match(gateway.calls.at(-1)[1].idempotencyKey, /^mcp-speak-[a-f0-9]{48}$/);

  const nextWait = handler.handle(call('wait_for_turn', {
    call_id: 'call-1',
    timeout_ms: 500,
  }));
  gateway.emit('event', {
    event: 'transcript_final',
    callId: 'call-1',
    speaker: 'remote',
    complete: true,
    text: 'Are you still there?',
  });
  const next = toolPayload(await nextWait);
  assert.equal(next.sequence > first.sequence, true);
  assert.equal(next.text, 'Are you still there?');
  handler.close();
});

test('an explicit end-call turn gets one protected farewell despite trailing STT fragments', async () => {
  const gateway = fakeGateway();
  const handler = new McpHandler(gateway, {
    completeTurnSettleMs: 5,
    incompleteTurnSettleMs: 100,
  });
  const waiting = handler.handle(call('wait_for_turn', {
    callId: 'call-closing',
    afterSequence: 0,
    timeoutMs: 500,
  }));
  gateway.emit('event', {
    event: 'transcript_final',
    callId: 'call-closing',
    speaker: 'remote',
    complete: true,
    text: 'No, no, okay, we just hang up this call.',
  });
  const closing = toolPayload(await waiting);
  gateway.emit('event', {
    event: 'transcript_final',
    callId: 'call-closing',
    speaker: 'remote',
    complete: false,
    text: 'please',
  });

  const farewell = toolPayload(await handler.handle(call('speak', {
    call_id: 'call-closing',
    speech_text: 'Alright, thank you for your time. Goodbye.',
    sequence: closing.sequence,
  })));
  assert.equal(farewell.accepted, true);
  assert.deepEqual({
    ...gateway.calls.at(-1)[1],
    idempotencyKey: '[derived]',
  }, {
    callId: 'call-closing',
    text: 'Alright, thank you for your time. Goodbye.',
    interruptible: false,
    idempotencyKey: '[derived]',
  });
  handler.close();
});

test('status and capabilities route with empty arguments', async () => {
  const handler = new McpHandler(fakeGateway());
  assert.equal(toolPayload(await handler.handle(call('status', {}))).state, 'running');
  assert.deepEqual(toolPayload(await handler.handle(call('capabilities', {}))).tools, TOOL_NAMES);
});

test('wait_for_turn returns each complete caller turn once and reports call end', async () => {
  const gateway = fakeGateway();
  const handler = new McpHandler(gateway, { completeTurnSettleMs: 5, incompleteTurnSettleMs: 10 });
  const waiting = handler.handle(call('wait_for_turn', {
    callId: 'call-turn-1', afterSequence: 0, timeoutMs: 500,
  }));
  gateway.emit('event', {
    event: 'transcript_final', callId: 'call-turn-1', speaker: 'remote',
    complete: true, language: 'en', text: 'How should we approach this?',
  });
  const first = toolPayload(await waiting);
  assert.deepEqual(first, {
    status: 'turn', callId: 'call-turn-1', sequence: 1, speaker: 'remote',
    text: 'How should we approach this?', complete: true, language: 'en',
  });

  gateway.emit('event', { event: 'ended', callId: 'call-turn-1', phase: 'ended', state: 'ended' });
  assert.deepEqual(toolPayload(await handler.handle(call('wait_for_turn', {
    callId: 'call-turn-1', afterSequence: first.sequence, timeoutMs: 500,
  }))), { status: 'ended', callId: 'call-turn-1', sequence: 2 });
  handler.close();
});

test('wait_for_turn immediately plays one exact warmed reply for a strong expected intent match', async () => {
  const gateway = fakeGateway();
  const handler = new McpHandler(gateway, {
    completeTurnSettleMs: 5,
    incompleteTurnSettleMs: 10,
  });
  const preparedReplies = [
    'Great, please tell me the exact place name, area, and a nearby landmark, and send the map pin to Siddharth if possible.',
    'No problem. Please look for the exact location and call Siddharth back on his personal number as soon as you find it.',
    'Could you please repeat the exact place name and area slowly?',
    'Thank you, I will pass that along. Goodbye.',
  ];
  await handler.handle(call('dial', approvedDial({
    preparedReplies,
    idempotencyKey: 'prepared-intent-call',
  })));
  await new Promise((resolve) => setImmediate(resolve));
  gateway.calls.length = 0;

  const firstWait = handler.handle(call('wait_for_turn', {
    callId: 'call-1', afterSequence: 0, timeoutMs: 500,
  }));
  gateway.emit('event', {
    event: 'transcript_final', callId: 'call-1', speaker: 'remote',
    complete: true, language: 'en', text: 'Yes, I found the exact location.',
  });
  const first = toolPayload(await firstWait);
  assert.deepEqual(first, {
    status: 'turn',
    callId: 'call-1',
    sequence: 1,
    speaker: 'remote',
    text: 'Yes, I found the exact location.',
    complete: true,
    language: 'en',
    preparedReplySpoken: true,
    preparedReplyText: preparedReplies[0],
    preparedReplyInterrupted: false,
  });
  assert.deepEqual(gateway.calls, [['speak', {
    callId: 'call-1',
    text: preparedReplies[0],
    idempotencyKey: 'mcp-prepared-1-0',
  }]]);

  const negativeWait = handler.handle(call('wait_for_turn', {
    callId: 'call-1', afterSequence: first.sequence, timeoutMs: 500,
  }));
  gateway.emit('event', {
    event: 'transcript_final', callId: 'call-1', speaker: 'remote',
    complete: true, language: 'en', text: 'I have not found the location yet.',
  });
  const negative = toolPayload(await negativeWait);
  assert.equal(negative.preparedReplySpoken, true);
  assert.equal(negative.preparedReplyText, preparedReplies[1]);

  const repeatWait = handler.handle(call('wait_for_turn', {
    callId: 'call-1', afterSequence: negative.sequence, timeoutMs: 500,
  }));
  gateway.emit('event', {
    event: 'transcript_final', callId: 'call-1', speaker: 'remote',
    complete: true, language: 'en', text: 'Could you repeat that slowly?',
  });
  const repeat = toolPayload(await repeatWait);
  assert.equal(repeat.preparedReplySpoken, true);
  assert.equal(repeat.preparedReplyText, preparedReplies[2]);

  const closingWait = handler.handle(call('wait_for_turn', {
    callId: 'call-1', afterSequence: repeat.sequence, timeoutMs: 500,
  }));
  gateway.emit('event', {
    event: 'transcript_final', callId: 'call-1', speaker: 'remote',
    complete: true, language: 'en', text: 'Okay, I will call back. Goodbye.',
  });
  const closing = toolPayload(await closingWait);
  assert.equal(closing.preparedReplySpoken, undefined);
  assert.equal(closing.preparedReplyText, undefined);
  assert.notEqual(gateway.calls.at(-1)?.[1]?.text, preparedReplies[3]);
  handler.close();
});

test('wait_for_turn can disable automatic prepared replies and recovers when prepared speech fails', async () => {
  const gateway = fakeGateway();
  const handler = new McpHandler(gateway, {
    completeTurnSettleMs: 5,
    incompleteTurnSettleMs: 10,
  });
  await handler.handle(call('dial', approvedDial({
    preparedReplies: [
      'Great, please tell me the exact location details.',
      'No problem. Please look for it and call back.',
    ],
    idempotencyKey: 'prepared-control-call',
  })));
  await new Promise((resolve) => setImmediate(resolve));
  gateway.calls.length = 0;

  gateway.emit('event', {
    event: 'transcript_final', callId: 'call-1', speaker: 'remote',
    complete: true, text: 'I found the exact location.',
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const disabled = toolPayload(await handler.handle(call('wait_for_turn', {
    callId: 'call-1', afterSequence: 0, autoPreparedReply: false,
  })));
  assert.equal(disabled.preparedReplySpoken, undefined);
  assert.equal(gateway.calls.length, 0);

  gateway.speak = async (args) => {
    gateway.calls.push(['speak', args]);
    return { accepted: false, reason: 'speech provider unavailable' };
  };
  gateway.emit('event', {
    event: 'transcript_final', callId: 'call-1', speaker: 'remote',
    complete: true, text: 'Yes, I found the location details.',
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const failed = toolPayload(await handler.handle(call('wait_for_turn', {
    callId: 'call-1', afterSequence: disabled.sequence, autoAcknowledge: false,
  })));
  assert.equal(failed.preparedReplySpoken, undefined);
  assert.equal(failed.text, 'Yes, I found the location details.');
  assert.equal(gateway.calls.length, 1);
  handler.close();
});

test('wait_for_incoming_call is opt-in and returns saved instructions with caller context', async () => {
  const gateway = fakeGateway();
  const handler = new McpHandler(gateway);
  assert.deepEqual(toolPayload(await handler.handle(call('wait_for_incoming_call', {
    afterSequence: 0,
  }))), { status: 'disabled', sequence: 0 });

  gateway.agentAnsweringStatus = async () => ({
    enabled: true,
    instructions: 'I am in a meeting. Ask why they called and promise a callback after 4 PM.',
  });
  const waiting = handler.handle(call('wait_for_incoming_call', {
    afterSequence: 0,
    timeoutMs: 500,
  }));
  gateway.emit('incoming', {
    event: 'incoming',
    callId: 'incoming-call-1',
    direction: 'incoming',
    phase: 'ringing',
    state: 'ringing',
    contactName: 'Siddharth',
    caller: {
      found: true,
      callerId: 'a'.repeat(64),
      consent: { memory: true, expiresAt: '2027-07-24T00:00:00.000Z' },
      context: {
        summary: 'Asked about a project update.',
        language: 'en',
        facts: ['Prefers afternoon calls'],
        followUps: ['Share the revised date'],
        history: [],
      },
    },
    agentAnswering: {
      enabled: true,
      instructions: 'I am in a meeting. Ask why they called and promise a callback after 4 PM.',
    },
  });
  assert.deepEqual(toolPayload(await waiting), {
    status: 'incoming',
    sequence: 1,
    callId: 'incoming-call-1',
    contactName: 'Siddharth',
    caller: {
      found: true,
      callerId: 'a'.repeat(64),
      consent: { memory: true, expiresAt: '2027-07-24T00:00:00.000Z' },
      context: {
        summary: 'Asked about a project update.',
        language: 'en',
        facts: ['Prefers afternoon calls'],
        followUps: ['Share the revised date'],
        history: [],
      },
    },
    instructions: 'I am in a meeting. Ask why they called and promise a callback after 4 PM.',
  });
  handler.close();
});

test('wait_for_incoming_call ignores incoming calls while AI answering is disabled', async () => {
  const gateway = fakeGateway();
  gateway.agentAnsweringStatus = async () => ({ enabled: true, instructions: '' });
  const handler = new McpHandler(gateway);
  const waiting = handler.handle(call('wait_for_incoming_call', {
    afterSequence: 0,
    timeoutMs: 250,
  }));
  gateway.emit('incoming', {
    event: 'incoming',
    callId: 'manual-call-1',
    direction: 'incoming',
    phase: 'ringing',
    state: 'ringing',
    agentAnswering: { enabled: false, instructions: '' },
  });
  assert.deepEqual(toolPayload(await waiting), { status: 'timeout', sequence: 0 });
  handler.close();
});

test('wait_for_turn merges incomplete STT fragments and coalesces backlog into the latest thought', async () => {
  assert.equal(mergeTranscriptFragments([
    'The conversation is', 'natural conversation', 'What do you think?', 'What do you think?',
  ]), 'The conversation is natural conversation What do you think?');
  assert.equal(mergeTranscriptFragments(['What kind of talk', 'What kind of talk?']), 'What kind of talk?');
  assert.equal(
    mergeTranscriptFragments(['Hello.', 'Hello please speak.', 'Hello']),
    'Hello please speak.',
  );
  assert.equal(
    mergeTranscriptFragments(['Hello hello hello.', 'Hi hello.', 'Yes hello.']),
    'Hello hello hello.',
  );

  const gateway = fakeGateway();
  const handler = new McpHandler(gateway, { completeTurnSettleMs: 5, incompleteTurnSettleMs: 20 });
  const waiting = handler.handle(call('wait_for_turn', {
    callId: 'call-merge', afterSequence: 0, timeoutMs: 500,
  }));
  gateway.emit('event', {
    event: 'transcript_final', callId: 'call-merge', speaker: 'remote',
    complete: true, text: 'The conversation is',
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  gateway.emit('event', {
    event: 'transcript_final', callId: 'call-merge', speaker: 'remote',
    complete: true, text: 'natural conversation',
  });
  assert.equal(toolPayload(await waiting).text, 'The conversation is natural conversation');

  gateway.emit('event', {
    event: 'transcript_final', callId: 'call-merge', speaker: 'remote',
    complete: true, text: 'The audio is clear.',
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  gateway.emit('event', {
    event: 'transcript_final', callId: 'call-merge', speaker: 'remote',
    complete: true, text: 'How should we continue?',
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const latest = toolPayload(await handler.handle(call('wait_for_turn', {
    callId: 'call-merge', afterSequence: 1, timeoutMs: 500,
  })));
  assert.equal(latest.text, 'The audio is clear. How should we continue?');
  assert.equal(latest.sequence, 3);
  handler.close();
});

test('wait_for_turn holds dangling single-word fragments but releases standalone replies promptly', async () => {
  const gateway = fakeGateway();
  const handler = new McpHandler(gateway, {
    completeTurnSettleMs: 5,
    incompleteTurnSettleMs: 15,
    fragmentTurnSettleMs: 80,
  });
  const waiting = handler.handle(call('wait_for_turn', {
    callId: 'call-fragment',
    afterSequence: 0,
    timeoutMs: 500,
  }));
  gateway.emit('event', {
    event: 'transcript_final', callId: 'call-fragment', speaker: 'remote',
    complete: true, text: 'Like',
  });
  assert.equal(await Promise.race([
    waiting.then(() => 'released'),
    new Promise((resolve) => setTimeout(() => resolve('held'), 30)),
  ]), 'held');
  gateway.emit('event', {
    event: 'transcript_final', callId: 'call-fragment', speaker: 'remote',
    complete: true, text: 'the replies should feel more human.',
  });
  assert.equal(toolPayload(await waiting).text, 'Like the replies should feel more human.');

  const next = handler.handle(call('wait_for_turn', {
    callId: 'call-fragment',
    afterSequence: 1,
    timeoutMs: 500,
  }));
  gateway.emit('event', {
    event: 'transcript_final', callId: 'call-fragment', speaker: 'remote',
    complete: true, text: 'Hello',
  });
  assert.equal(toolPayload(await next).text, 'Hello');
  handler.close();
});

test('wait_for_turn carries the earlier question and interrupted agent answer into the next turn', async () => {
  const gateway = fakeGateway();
  const handler = new McpHandler(gateway, {
    completeTurnSettleMs: 5,
    incompleteTurnSettleMs: 10,
  });

  gateway.emit('event', {
    event: 'transcript_final',
    callId: 'call-context',
    speaker: 'remote',
    final: true,
    complete: true,
    text: 'Tell me about African wildlife.',
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const first = toolPayload(await handler.handle(call('wait_for_turn', {
    callId: 'call-context',
    afterSequence: 0,
  })));

  gateway.emit('event', {
    event: 'transcript_final',
    callId: 'call-context',
    speaker: 'agent',
    final: true,
    complete: false,
    text: 'Africa has an incredible range of wildlife, including',
  });
  gateway.emit('event', {
    event: 'transcript_final',
    callId: 'call-context',
    speaker: 'remote',
    final: true,
    complete: true,
    text: 'Sorry, I meant Indian wildlife.',
  });
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.deepEqual(toolPayload(await handler.handle(call('wait_for_turn', {
    callId: 'call-context',
    afterSequence: first.sequence,
  }))), {
    status: 'turn',
    callId: 'call-context',
    sequence: first.sequence + 1,
    speaker: 'remote',
    text: 'Sorry, I meant Indian wildlife.',
    previousCallerText: 'Tell me about African wildlife.',
    interruptedAgentText: 'Africa has an incredible range of wildlife, including',
    complete: true,
  });
  handler.close();
});

test('wait_for_turn validates its bounded cursor and timeout and times out without polling', async () => {
  const handler = new McpHandler(fakeGateway());
  for (const args of [
    { callId: 'call-1', afterSequence: -1 },
    { callId: 'call-1', afterSequence: 0.5 },
    { callId: 'call-1', afterSequence: 0, timeoutMs: 100 },
    { callId: 'call-1', afterSequence: 0, autoAcknowledge: 'yes' },
    { callId: 'call-1', afterSequence: 0, autoPreparedReply: 'yes' },
  ]) {
    assert.equal((await handler.handle(call('wait_for_turn', args))).error.code, JSONRPC_ERROR.INVALID_PARAMS);
  }
  assert.deepEqual(toolPayload(await handler.handle(call('wait_for_turn', {
    callId: 'call-1', afterSequence: 7, timeoutMs: 250,
  }))), { status: 'timeout', callId: 'call-1', sequence: 7 });
  handler.close();
});

test('contextual acknowledgements are selective, delayed, rate-limited, and cancelled by a quick answer', async () => {
  assert.equal(contextualAcknowledgement('Can you check the latest weather for me?'), 'Sure, let me check that.');
  assert.equal(contextualAcknowledgement('Why do you think that happened?'), 'Hmm, that is a good question. Let me think.');
  assert.equal(contextualAcknowledgement('This recording is not working properly.'), 'I see. Let me look into that.');
  assert.equal(contextualAcknowledgement('Which approach should we choose for this project?'), 'Okay, let me work through that.');
  assert.equal(
    contextualAcknowledgement('Could you tell me whether the previous topic connects to this new question?'),
    'Yes, let me connect that with what we discussed earlier.',
  );
  assert.equal(contextualAcknowledgement('What are you doing?'), 'Hmm, let me think about that.');
  assert.equal(contextualAcknowledgement('Who are you?'), null);
  assert.equal(contextualAcknowledgement("Yeah, I'm fine."), 'I am glad to hear that.');
  assert.equal(contextualAcknowledgement('I want to discuss this automation.'), 'I understand. Give me a moment.');
  assert.equal(contextualAcknowledgement('How are you speaking?'), 'Hmm, let me think about that.');
  assert.equal(contextualAcknowledgement('Actually, I am asking about'), null);
  assert.equal(contextualAcknowledgement('The conversation is not.'), null);
  assert.equal(
    contextualAcknowledgement('You are taking too much time I think'),
    "You're right. I'm responding now.",
  );
  assert.equal(contextualAcknowledgement('Yeah, that is late'), 'I understand. Give me a moment.');
  assert.equal(
    contextualAcknowledgementFollowUp('Can you check the latest weather for me?'),
    "I'm checking that now.",
  );
  assert.equal(
    contextualAcknowledgementFollowUp('Why do you think that happened?'),
    "I'm putting the answer together now.",
  );
  assert.equal(contextualAcknowledgementFollowUp('You are taking too much time I think'), null);
  assert.equal(contextualAcknowledgement('Hello'), null);
  assert.equal(contextualAcknowledgement('Okay goodbye and hang up.'), null);
  assert.equal(contextualAcknowledgement('Okay, I will send it to him. Thanks for calling.'), null);
  assert.equal(contextualAcknowledgement('Thank you for the call. That is all.'), null);
  assert.equal(contextualAcknowledgement('Tell me your name please.'), null);

  const gateway = fakeGateway();
  const handler = new McpHandler(gateway, {
    acknowledgementDelayMs: 20,
    acknowledgementIntervalMs: 10_000,
  });
  gateway.emit('event', {
    event: 'transcript_final', callId: 'call-ack', speaker: 'remote',
    final: true, complete: true, text: 'Why do you think that happened?',
  });
  const turn = toolPayload(await handler.handle(call('wait_for_turn', {
    callId: 'call-ack', afterSequence: 0,
  })));
  await handler.handle(call('speak', {
    callId: 'call-ack', text: 'Here is my answer.', idempotencyKey: 'answer-fast',
  }));
  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.equal(gateway.calls.length, 1);
  assert.deepEqual({
    ...gateway.calls[0][1],
    idempotencyKey: '[derived]',
  }, {
    callId: 'call-ack', text: 'Here is my answer.', idempotencyKey: '[derived]',
  });
  assert.match(gateway.calls[0][1].idempotencyKey, /^mcp-speak-[a-f0-9]{48}$/);

  gateway.emit('event', {
    event: 'transcript_final', callId: 'call-ack', speaker: 'remote',
    final: true, complete: true, text: 'Can you check the latest weather for me?',
  });
  await handler.handle(call('wait_for_turn', {
    callId: 'call-ack', afterSequence: turn.sequence,
  }));
  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.equal(gateway.calls.at(-1)[0], 'speak');
  assert.equal(gateway.calls.at(-1)[1].text, 'Sure, let me check that.');
  handler.close();
});

test('contextual acknowledgement follow-up fills a slow model gap and stops before the answer', async () => {
  const gateway = fakeGateway();
  const handler = new McpHandler(gateway, {
    acknowledgementDelayMs: 5,
    acknowledgementFollowUpDelayMs: 20,
    acknowledgementIntervalMs: 10_000,
  });
  gateway.emit('event', {
    event: 'transcript_final', callId: 'call-bridge', speaker: 'remote',
    final: true, complete: true, text: 'Can you check the latest weather for me?',
  });
  const turn = toolPayload(await handler.handle(call('wait_for_turn', {
    callId: 'call-bridge', afterSequence: 0,
  })));
  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.deepEqual(gateway.calls.map((entry) => entry[1].text), [
    'Sure, let me check that.',
    "I'm checking that now.",
  ]);
  await handler.handle(call('speak', {
    callId: 'call-bridge',
    text: 'The weather is clear this evening.',
    respondingToSequence: turn.sequence,
    idempotencyKey: 'bridge-answer',
  }));
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.deepEqual(gateway.calls.map((entry) => entry[1].text), [
    'Sure, let me check that.',
    "I'm checking that now.",
    'The weather is clear this evening.',
  ]);
  handler.close();
});

test('speak tolerates pending and attention noise but rejects a completed substantive newer turn', async () => {
  const gateway = fakeGateway();
  const handler = new McpHandler(gateway, { completeTurnSettleMs: 5, incompleteTurnSettleMs: 20 });
  gateway.emit('event', {
    event: 'transcript_final', callId: 'call-stale', speaker: 'remote',
    complete: true, text: 'I am browsing Chrome.',
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const first = toolPayload(await handler.handle(call('wait_for_turn', {
    callId: 'call-stale', afterSequence: 0, timeoutMs: 500,
  })));

  gateway.emit('event', {
    event: 'transcript_final', callId: 'call-stale', speaker: 'remote',
    complete: false, text: 'background',
  });
  const pendingAccepted = toolPayload(await handler.handle(call('speak', {
    callId: 'call-stale',
    text: 'Anything interesting catching your attention?',
    respondingToSequence: first.sequence,
    idempotencyKey: 'stale-answer-1',
  })));
  assert.equal(pendingAccepted.accepted, true);

  gateway.emit('event', {
    event: 'transcript_final', callId: 'call-stale', speaker: 'remote',
    complete: true, text: 'Hello, are you there?',
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const attentionAccepted = toolPayload(await handler.handle(call('speak', {
    callId: 'call-stale',
    text: 'Yes, I am here and listening.',
    respondingToSequence: first.sequence,
    idempotencyKey: 'stale-answer-2',
  })));
  assert.equal(attentionAccepted.accepted, true);

  const attention = toolPayload(await handler.handle(call('wait_for_turn', {
    callId: 'call-stale', afterSequence: first.sequence, timeoutMs: 500,
  })));
  gateway.emit('event', {
    event: 'transcript_final', callId: 'call-stale', speaker: 'remote',
    complete: true, text: 'What are you doing?',
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const stale = toolPayload(await handler.handle(call('speak', {
    callId: 'call-stale',
    text: 'I am still answering the earlier topic.',
    respondingToSequence: attention.sequence,
    idempotencyKey: 'stale-answer-3',
  })));
  assert.deepEqual(stale, {
    accepted: false, callId: 'call-stale', reason: 'stale caller turn',
  });

  const latest = toolPayload(await handler.handle(call('wait_for_turn', {
    callId: 'call-stale', afterSequence: attention.sequence, timeoutMs: 500,
  })));
  const accepted = toolPayload(await handler.handle(call('speak', {
    callId: 'call-stale',
    text: 'I am enjoying our conversation.',
    respondingToSequence: latest.sequence,
    idempotencyKey: 'fresh-answer-1',
  })));
  assert.equal(accepted.accepted, true);
  assert.equal(gateway.calls.length, 3);
  assert.deepEqual({
    ...gateway.calls.at(-1)[1],
    idempotencyKey: '[derived]',
  }, {
    callId: 'call-stale',
    text: 'I am enjoying our conversation.',
    idempotencyKey: '[derived]',
  });
  assert.match(gateway.calls.at(-1)[1].idempotencyKey, /^mcp-speak-[a-f0-9]{48}$/);
  handler.close();
});

test('obsolete tools are absent and rejected', async () => {
  const handler = new McpHandler(fakeGateway());
  for (const name of ['send_uplink', 'request_downlink_probe']) {
    assert.equal((await handler.handle(call(name, {}))).error.code, JSONRPC_ERROR.INVALID_PARAMS);
  }
});

test('initialize declares subscribable text resources without binary content', async () => {
  const response = await new McpHandler(fakeGateway()).handle({ jsonrpc: '2.0', id: 1, method: 'initialize' });
  assert.deepEqual(response.result.capabilities.resources, { subscribe: true, listChanged: false });
});

test('resources/list exposes bounded semantic gateway resources only', async () => {
  const handler = new McpHandler(fakeGateway());
  const response = await handler.handle({ jsonrpc: '2.0', id: 1, method: 'resources/list' });
  assert.deepEqual(response.result.resources.map(({ uri }) => uri), [
    'agentcall://gateway/status',
    'agentcall://gateway/capabilities',
    'agentcall://calls/current',
    'agentcall://events/recent',
    'agentcall://phone-data/status',
  ]);
  assert.equal(/pcm|base64|blob|payload/i.test(JSON.stringify(response.result)), false);
});

test('unrecognized resource schemes are rejected and never advertised', async () => {
  const handler = new McpHandler(fakeGateway());
  const response = await handler.handle({
    jsonrpc: '2.0', id: 1, method: 'resources/read',
    params: { uri: 'legacy-agent-call://gateway/status' },
  });
  assert.equal(response.error.code, JSONRPC_ERROR.INVALID_PARAMS);
  const listed = await handler.handle({ jsonrpc: '2.0', id: 2, method: 'resources/list' });
  assert.equal(listed.result.resources.some(({ uri }) => uri.startsWith('legacy-agent-call://')), false);
});

test('phone-data resource exposes counts and timestamps but never private rows', async () => {
  const gateway = fakeGateway();
  gateway.phoneDataStatus = async () => ({
    contacts: {
      state: 'ready', count: 2, syncedAt: '2026-07-22T00:00:00.000Z',
      rows: [{ name: 'Private Name', number: '+10000000001' }], path: '/var/lib/private.json',
    },
    callLog: {
      state: 'offline', count: 1, syncedAt: '2026-07-21T00:00:00.000Z',
      rows: [{ name: 'Private Name', number: '+10000000001' }], token: 'secret-token',
    },
  });
  const response = await new McpHandler(gateway).handle({
    jsonrpc: '2.0', id: 7, method: 'resources/read',
    params: { uri: 'agentcall://phone-data/status' },
  });

  assert.deepEqual(JSON.parse(response.result.contents[0].text), {
    contacts: { state: 'ready', count: 2, syncedAt: '2026-07-22T00:00:00.000Z' },
    callLog: { state: 'offline', count: 1, syncedAt: '2026-07-21T00:00:00.000Z' },
  });
  assert.equal(/Private Name|10000000001|private\.json|secret-token/.test(JSON.stringify(response)), false);
});

test('resources/read applies an explicit bounded schema for every resource', async () => {
  const gateway = fakeGateway();
  gateway.status = async () => ({
    identity: 'HARDWARE', simulator: false, state: 'running',
    device: { connected: true, authenticated: true, transport: 'usb', phase: 'ready', socketPath: '/run/private.sock' },
    recording: { healthy: false, active: false, reason: 'unavailable', lastError: 'token=test-token at /var/lib/private.wav' },
    phoneRecordingCopy: { state: 'ready', reason: 'negotiated', metadata: { token: 'test-token' } },
    realtime: { healthy: true, active: false, provider: 'openai', model: 'gpt-4o-transcribe', language: 'en', credentials: { opaque: 'drop-me' } },
    currentCall: {
      callId: 'call-1', phase: 'ringing', direction: 'incoming',
      contactName: 'Siddharth', caller: { phone: '+15551234567' },
    },
    metrics: { commandsSent: 1, arbitrary: { path: '/etc/shadow' } },
    credentials: { token: 'test-token' }, pcm: Buffer.alloc(10), rawDaemon: { nested: { value: 'drop-me' } },
  });
  gateway.capabilities = async () => ({
    identity: 'HARDWARE', simulator: false, tools: TOOL_NAMES, transport: 'stdio', protocolVersion: '2024-11-05',
    framing: { kinds: ['CONTROL', 'EVENT'], directions: ['HOST_TO_DEVICE'], raw: { path: '/tmp/private' } },
    policy: { dialEnabled: false, manualApprovalRequired: true, maxCallDurationMs: 60_000, token: 'test-token' },
    credentials: { opaque: 'drop-me' },
  });
  const handler = new McpHandler(gateway);
  gateway.emit('event', {
    event: 'active', callId: 'call-2', phase: 'active', direction: 'incoming', speaker: 'remote',
    complete: true, language: 'en', text: 'private transcript', audio: Buffer.alloc(10),
    path: '/var/lib/private.wav', credentials: { token: 'test-token' }, metadata: { nested: { value: 'drop-me' } },
  });

  const expected = {
    'agentcall://gateway/status': {
      identity: 'HARDWARE', simulator: false, state: 'running',
      device: { connected: true, authenticated: true, transport: 'usb', phase: 'ready' },
      recording: { healthy: false, active: false, reason: 'unavailable' },
      phoneRecordingCopy: { state: 'ready', reason: 'negotiated' },
      realtime: { healthy: true, active: false, provider: 'openai', model: 'gpt-4o-transcribe', language: 'en' },
      currentCall: {
        callId: 'call-1', phase: 'ringing', direction: 'incoming', contactName: 'Siddharth',
      },
      metrics: { commandsSent: 1 },
    },
    'agentcall://gateway/capabilities': {
      identity: 'HARDWARE', simulator: false, tools: TOOL_NAMES, transport: 'stdio', protocolVersion: '2024-11-05',
      framing: { kinds: ['CONTROL', 'EVENT'], directions: ['HOST_TO_DEVICE'] },
      policy: { dialEnabled: false, manualApprovalRequired: true, maxCallDurationMs: 60_000 },
    },
    'agentcall://calls/current': {
      event: 'active', callId: 'call-2', phase: 'active', direction: 'incoming', speaker: 'remote', complete: true, language: 'en', text: 'private transcript',
    },
    'agentcall://events/recent': {
      events: [{ event: 'active', callId: 'call-2', phase: 'active', direction: 'incoming', speaker: 'remote', complete: true, language: 'en', text: 'private transcript' }],
    },
  };

  for (const [uri, receipt] of Object.entries(expected)) {
    const response = await handler.handle({ jsonrpc: '2.0', id: uri, method: 'resources/read', params: { uri } });
    assert.equal(response.result.contents[0].mimeType, 'application/json');
    assert.deepEqual(JSON.parse(response.result.contents[0].text), receipt, uri);
    assert(Buffer.byteLength(response.result.contents[0].text) < 16 * 1024, uri);
  }
});

test('current call and recent events expose bounded transcripts and consented returning-caller context', async () => {
  const gateway = fakeGateway();
  const handler = new McpHandler(gateway);
  gateway.emit('incoming', {
    event: 'incoming', callId: 'call-context-1', direction: 'incoming', callerNumber: '+15551234567',
    contactName: 'Siddharth',
    caller: {
      found: true,
      callerId: 'a'.repeat(64),
      consent: { memory: true, expiresAt: '2026-08-23T08:00:00.000Z' },
      context: {
        summary: 'Returning appointment caller', language: 'en', voice: 'coral',
        facts: ['Prefers mornings'], followUps: ['Confirm Tuesday'],
        history: [{
          callId: 'call-prior-1', startedAt: '2026-07-20T08:00:00.000Z',
          endedAt: '2026-07-20T08:03:00.000Z', direction: 'incoming', outcome: 'ended',
          transcript: 'remote: Tuesday morning works.', recordingId: 'call-prior-1',
          privatePath: '/var/lib/agentcall/recordings/call-prior-1.wav',
        }],
      },
    },
  });
  gateway.emit('event', {
    event: 'transcript_final', callId: 'call-context-1', speaker: 'remote', final: true,
    complete: true, language: 'en', text: 'Can we keep the same Tuesday time?', rawAudio: Buffer.alloc(32),
  });

  const current = JSON.parse((await handler.handle({
    jsonrpc: '2.0', id: 20, method: 'resources/read', params: { uri: 'agentcall://calls/current' },
  })).result.contents[0].text);
  const recent = JSON.parse((await handler.handle({
    jsonrpc: '2.0', id: 21, method: 'resources/read', params: { uri: 'agentcall://events/recent' },
  })).result.contents[0].text);
  assert.equal(current.text, 'Can we keep the same Tuesday time?');
  assert.equal(current.contactName, 'Siddharth');
  assert.equal(recent.events[0].contactName, 'Siddharth');
  assert.equal(recent.events[0].caller.context.history[0].transcript, 'remote: Tuesday morning works.');
  assert.equal(/15551234567|privatePath|var\/lib|rawAudio/.test(JSON.stringify([current, recent])), false);
});

test('MCP receipts never publish arbitrary lastError text', async () => {
  const gateway = fakeGateway();
  gateway.status = async () => ({
    state: 'running',
    recording: { healthy: false, lastError: 'Bearer test-token failed at /var/lib/agentcall/private.wav' },
    metrics: { commandsSent: 1, lastError: '/etc/shadow' },
  });
  const handler = new McpHandler(gateway);
  const tool = await handler.handle(call('status', {}));
  const resource = await handler.handle({
    jsonrpc: '2.0', id: 2, method: 'resources/read', params: { uri: 'agentcall://gateway/status' },
  });
  assert.equal(/lastError|test-token|\/var\/lib|\/etc\/shadow/.test(JSON.stringify([tool, resource])), false);
});

test('every allowlisted receipt string field rejects path and credential-shaped daemon values', async () => {
  const hostileValues = ['/var/lib/private', '/run/private.sock', '/etc/shadow', 'Bearer abc.def', 'token=secret', 'clientCredential'];
  for (const hostile of hostileValues) {
    const gateway = fakeGateway();
    gateway.status = () => ({
      identity: hostile, state: hostile,
      device: { transport: hostile, phase: hostile },
      recording: { reason: hostile }, phoneRecordingCopy: { state: hostile, reason: hostile },
      realtime: { reason: hostile, provider: hostile, model: hostile, language: hostile },
      currentCall: { callId: hostile, phase: hostile, state: hostile, direction: hostile },
    });
    gateway.capabilities = () => ({
      identity: hostile, tools: [hostile], transport: hostile, protocolVersion: hostile,
      framing: { kinds: [hostile], directions: [hostile] },
    });
    for (const name of ['dial', 'answer', 'reject', 'hangup', 'send_dtmf', 'speak']) {
      gateway[name === 'send_dtmf' ? 'sendDtmf' : name] = async () => ({
        accepted: false, callId: hostile, destination: hostile, reason: hostile,
      });
    }
    const handler = new McpHandler(gateway);
    gateway.emit('event', {
      event: hostile, callId: hostile, phase: hostile, state: hostile,
      direction: hostile, speaker: hostile, language: hostile,
    });
    const receipts = [
      await handler.handle(call('status', {})),
      await handler.handle(call('capabilities', {})),
      await handler.handle(call('answer', { callId: 'call-1', idempotencyKey: 'probe-1' })),
    ];
    for (const uri of [
      'agentcall://gateway/status', 'agentcall://gateway/capabilities',
      'agentcall://calls/current', 'agentcall://events/recent',
    ]) receipts.push(await handler.handle({ jsonrpc: '2.0', id: uri, method: 'resources/read', params: { uri } }));
    assert.equal(JSON.stringify(receipts).includes(hostile), false, hostile);
  }
});

test('credential shapes are omitted from every identifier-like tool and resource receipt field', async () => {
  const credentialShapes = [
    `sk-${'A1b'.repeat(16)}`,
    `sk-proj-${'Z9y'.repeat(16)}`,
    ...['p', 'o', 'u', 's', 'r'].map((kind) => `gh${kind}_${'aB3'.repeat(14)}`),
    ...['b', 'a', 'p', 'r', 's'].map((kind) => `xox${kind}-${'1-aB'.repeat(12)}`),
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
    'aB3dE5fG7hJ9kL2mN4pQ6rS8tV0wX1yZ3aC5eF7gH9jK',
    'qjvmzpkxwodnfyhrbaltseucigqjvmzpkxwodnfyhrbaltse',
  ];
  const mutationArgs = {
    dial: {
      destination: ['+1', '555', '123', '4567'].join(''), idempotencyKey: 'dial-receipt', approved: true,
      openingText: 'Good afternoon. May I confirm who I am speaking with, please?',
      preparedReplies: ['Hello. I am calling on behalf of the person who requested this call.'],
      consent: { recorded: true, policy: 'receipt sanitization test consent' },
    },
    answer: { callId: 'ordinary-call-1', idempotencyKey: 'answer-receipt' },
    reject: { callId: 'ordinary-call-1', idempotencyKey: 'reject-receipt' },
    hangup: { callId: 'ordinary-call-1', idempotencyKey: 'hangup-receipt' },
    send_dtmf: { callId: 'ordinary-call-1', digits: '1', idempotencyKey: 'dtmf-receipt' },
    speak: { callId: 'ordinary-call-1', text: 'Safe response.', idempotencyKey: 'speak-receipt' },
  };

  for (const hostile of credentialShapes) {
    const gateway = fakeGateway();
    gateway.status = () => ({
      realtime: { provider: hostile, model: hostile },
      currentCall: { callId: hostile, phase: 'active' },
    });
    for (const name of Object.keys(mutationArgs)) {
      gateway[name === 'send_dtmf' ? 'sendDtmf' : name] = async () => ({ accepted: true, callId: hostile });
    }
    const handler = new McpHandler(gateway);
    gateway.emit('event', { event: 'active', callId: hostile, phase: 'active' });

    const receipts = [await handler.handle(call('status', {}))];
    for (const [name, args] of Object.entries(mutationArgs)) receipts.push(await handler.handle(call(name, args)));
    for (const uri of ['agentcall://gateway/status', 'agentcall://calls/current', 'agentcall://events/recent']) {
      receipts.push(await handler.handle({ jsonrpc: '2.0', id: uri, method: 'resources/read', params: { uri } }));
    }

    assert.equal(JSON.stringify(receipts).includes(hostile), false, hostile);
    for (const [index, receipt] of receipts.slice(1, 7).entries()) {
      const expected = index === 0
        ? { accepted: true, nextAction: 'wait_for_turn', afterSequence: 0 }
        : { accepted: true };
      assert.deepEqual(toolPayload(receipt), expected, `${hostile}: ${JSON.stringify(receipt)}`);
    }
  }
});

test('receipt allowlists preserve configured providers and models plus ordinary call IDs', async () => {
  const publicPairs = [
    ['openai', 'gpt-4o-transcribe'],
    ['elevenlabs', 'scribe_v2_realtime'],
    ['supertonic', 'supertonic-3'],
    ['elevenlabs', 'eleven_flash_v2_5'],
    ['elevenlabs', 'eleven_multilingual_v2'],
    ['elevenlabs', 'eleven_v3'],
    ['openai', 'gpt-4o-mini-tts-2025-12-15'],
    ['openai', 'gpt-4o-mini-tts'],
    ['openai', 'tts-1'],
    ['openai', 'tts-1-hd'],
  ];
  for (const [provider, model] of publicPairs) {
    const gateway = fakeGateway();
    gateway.status = () => ({
      realtime: { provider, model },
      currentCall: { callId: 'ordinary-call_01:leg-a', phase: 'active' },
    });
    gateway.answer = async () => ({ accepted: true, callId: 'ordinary-call_01:leg-a' });
    const handler = new McpHandler(gateway);
    gateway.emit('event', { event: 'active', callId: 'ordinary-call_01:leg-a', phase: 'active' });
    assert.deepEqual(toolPayload(await handler.handle(call('status', {}))), {
      realtime: { provider, model },
      currentCall: { callId: 'ordinary-call_01:leg-a', phase: 'active' },
    });
    assert.deepEqual(toolPayload(await handler.handle(call('answer', {
      callId: 'ordinary-call_01:leg-a', idempotencyKey: 'ordinary-receipt',
    }))), { accepted: true, callId: 'ordinary-call_01:leg-a' });
    const current = await handler.handle({
      jsonrpc: '2.0', id: 8, method: 'resources/read', params: { uri: 'agentcall://calls/current' },
    });
    assert.equal(JSON.parse(current.result.contents[0].text).callId, 'ordinary-call_01:leg-a');
  }
});

test('tools/call notifications never invoke mutations', async () => {
  const gateway = fakeGateway();
  const handler = new McpHandler(gateway);
  for (const request of [
    call('hangup', { callId: 'call-1', idempotencyKey: 'null-id' }, null),
    { jsonrpc: '2.0', method: 'tools/call', params: { name: 'hangup', arguments: { callId: 'call-1', idempotencyKey: 'missing-id' } } },
  ]) {
    const response = await handler.handle(request);
    assert.equal(response.error.code, JSONRPC_ERROR.INVALID_REQUEST);
    assert.equal(response.id, null);
  }
  assert.deepEqual(gateway.calls, []);
});

test('resource subscriptions emit only valid updated notifications for subscribed URIs', async () => {
  const gateway = fakeGateway();
  const notifications = [];
  const handler = new McpHandler(gateway, { notify: (message) => notifications.push(message) });
  const subscribed = await handler.handle({ jsonrpc: '2.0', id: 1, method: 'resources/subscribe', params: { uri: 'agentcall://events/recent' } });
  assert.deepEqual(subscribed.result, {});
  gateway.emit('event', { callId: 'call-1', state: 'ringing', phone: '+15551234567', payload: 'raw' });
  assert.deepEqual(notifications, [{ jsonrpc: '2.0', method: 'notifications/resources/updated', params: { uri: 'agentcall://events/recent' } }]);
  const read = await handler.handle({ jsonrpc: '2.0', id: 2, method: 'resources/read', params: { uri: 'agentcall://events/recent' } });
  assert.equal(/\+155|payload|pcm|base64/i.test(read.result.contents[0].text), false);
});

test('resource methods reject unknown fields and URIs', async () => {
  const handler = new McpHandler(fakeGateway());
  for (const request of [
    { jsonrpc: '2.0', id: 1, method: 'resources/read', params: { uri: 'file:///etc/passwd' } },
    { jsonrpc: '2.0', id: 2, method: 'resources/read', params: { uri: 'agentcall://gateway/status', extra: true } },
    { jsonrpc: '2.0', id: 3, method: 'resources/subscribe', params: { uri: 'agentcall://unknown' } },
  ]) assert.equal((await handler.handle(request)).error.code, JSONRPC_ERROR.INVALID_PARAMS);
});

test('unknown JSON-RPC method is rejected', async () => {
  const response = await new McpHandler(fakeGateway()).handle({ jsonrpc: '2.0', id: 1, method: 'unknown' });
  assert.equal(response.error.code, JSONRPC_ERROR.METHOD_NOT_FOUND);
});

test('MCP rejects non-scalar and oversized request ids without reflecting them', async () => {
  const handler = new McpHandler(fakeGateway());
  for (const id of [{ nested: true }, ['array'], 'x'.repeat(129), Number.MAX_SAFE_INTEGER + 1]) {
    const response = await handler.handle({ jsonrpc: '2.0', id, method: 'tools/list' });
    assert.equal(response.id, null);
    assert.equal(response.error.code, JSONRPC_ERROR.INVALID_REQUEST);
    assert(Buffer.byteLength(JSON.stringify(response)) < 1_024);
  }
});

test('stdio rejects a frame over 64 KiB and continues with the next bounded request', async () => {
  const oversized = `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'unknown', pad: 'x'.repeat(70_000) })}\n`;
  const valid = `${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`;
  const output = new PassThrough();
  let text = '';
  output.setEncoding('utf8');
  output.on('data', (chunk) => { text += chunk; });
  await runStdio(fakeGateway(), Readable.from([oversized, valid]), output);
  const responses = text.trim().split('\n').map(JSON.parse);
  assert.equal(responses[0].id, null);
  assert.equal(responses[0].error.code, JSONRPC_ERROR.PARSE_ERROR);
  assert.equal(responses[1].id, 2);
  assert(responses.every((response) => Buffer.byteLength(JSON.stringify(response)) <= 64 * 1024));
});

test('a hanging MCP tool call does not head-of-line block independent requests', async () => {
  const gateway = fakeGateway();
  gateway.status = () => new Promise(() => {});
  const input = new PassThrough();
  const output = new PassThrough();
  let text = '';
  output.setEncoding('utf8');
  output.on('data', (chunk) => { text += chunk; });
  runStdio(gateway, input, output);
  input.write(`${JSON.stringify(call('status', {}, 1))}\n`);
  input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('independent response remained wedged')), 250);
    output.on('data', () => {
      if (text.split('\n').some((line) => line && JSON.parse(line).id === 2)) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  input.end();
});

test('tool receipts publish only allowlisted bounded public fields', async () => {
  const gateway = fakeGateway();
  gateway.status = () => ({
    state: 'running', metrics: { commandsSent: 1, arbitrary: 'drop-me' },
    playbackPath: '/run/agentcall/private.wav', token: 'secret', payload: 'raw',
  });
  const response = await new McpHandler(gateway).handle(call('status', {}));
  assert.deepEqual(toolPayload(response), { state: 'running', metrics: { commandsSent: 1 } });
  assert.equal(/private|secret|payload|arbitrary/.test(JSON.stringify(response)), false);
});

test('capability receipts replace oversized daemon collections with the exact MCP tool set', async () => {
  const gateway = fakeGateway();
  gateway.capabilities = () => ({ tools: Array.from({ length: 20_000 }, (_, index) => TOOL_NAMES[index % TOOL_NAMES.length]) });
  const output = new PassThrough();
  let text = '';
  output.setEncoding('utf8');
  output.on('data', (chunk) => { text += chunk; });
  await runStdio(gateway, Readable.from([`${JSON.stringify(call('capabilities', {}, 7))}\n`]), output);
  const response = JSON.parse(text.trim());
  assert.equal(response.id, 7);
  assert.deepEqual(toolPayload(response).tools, TOOL_NAMES);
  assert(Buffer.byteLength(text) <= 64 * 1024);
});
