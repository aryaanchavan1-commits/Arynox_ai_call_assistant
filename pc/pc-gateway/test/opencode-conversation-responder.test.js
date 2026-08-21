import { test } from 'node:test';
import assert from 'node:assert/strict';

import { OpenCodeConversationResponder, FREE_MODELS } from '../src/opencode-conversation-responder.js';

function chatResponse(reply) {
  return new Response(JSON.stringify({
    choices: [{ message: { role: 'assistant', content: reply } }],
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

test('OpenCode Zen responder posts a bounded chat request to the zen endpoint and remembers the exchange', async () => {
  let captured;
  const responder = new OpenCodeConversationResponder({
    apiKey: 'opencode_test_key_0123456789',
    fetchImpl: async (url, options) => {
      captured = { url, options, body: JSON.parse(options.body) };
      return chatResponse('Hello! How can I help you today?');
    },
  });
  responder.remember('user', 'Hi there');
  responder.remember('assistant', 'Hello!');
  const reply = await responder.respond({ text: 'Who is calling?', callerName: 'Riya', callerContext: 'She called last week about a delivery.' });

  assert.equal(reply, 'Hello! How can I help you today?');
  assert.equal(captured.url, 'https://opencode.ai/zen/v1/chat/completions');
  assert.equal(captured.options.method, 'POST');
  assert.equal(captured.options.headers.authorization, 'Bearer opencode_test_key_0123456789');
  assert.equal(captured.options.headers['content-type'], 'application/json');
  assert.equal(captured.body.model, 'big-pickle');
  assert.equal(captured.body.max_tokens, 80);
  assert.equal(captured.body.messages[0].role, 'system');
  assert.ok(captured.body.messages[0].content.includes("caller's name is Riya"));
  assert.ok(captured.body.messages[0].content.includes('last week about a delivery'));
  assert.deepEqual(captured.body.messages.slice(1), [
    { role: 'user', content: 'Hi there' },
    { role: 'assistant', content: 'Hello!' },
    { role: 'user', content: 'Who is calling?' },
  ]);
  assert.equal(responder.history.length, 4);
  assert.deepEqual(responder.history[3], { role: 'assistant', content: 'Hello! How can I help you today?' });
});

test('OpenCode Zen responder accepts rotating catalog models and bounds history to the configured limit', async () => {
  const responder = new OpenCodeConversationResponder({
    apiKey: 'opencode_test_key_0123456789',
    model: 'mimo-v2.5-free',
    maxHistoryMessages: 4,
    fetchImpl: async () => chatResponse('OK'),
  });
  for (let index = 0; index < 6; index++) {
    responder.remember('user', `message ${index}`);
    await responder.respond({ text: `reply ${index}` });
  }
  assert.equal(responder.history.length, 4);
  assert.equal(responder.history[1].content, 'message 5');
});

test('OpenCode Zen responder validates configuration and transcript bounds', () => {
  assert.throws(() => new OpenCodeConversationResponder({ apiKey: 'short' }), /API key/i);
  assert.throws(() => new OpenCodeConversationResponder({ apiKey: 'opencode_test_key_0123456789', model: 'bad model!' }), /model/i);
  assert.throws(() => new OpenCodeConversationResponder({ apiKey: 'opencode_test_key_0123456789', timeoutMs: 100 }), /timeout/i);
  assert.throws(() => new OpenCodeConversationResponder({ apiKey: 'opencode_test_key_0123456789', maxHistoryMessages: 1 }), /history/i);
  assert.throws(() => new OpenCodeConversationResponder({ apiKey: 'opencode_test_key_0123456789' }).remember('system', 'x'), /role/i);
});

test('free model catalog includes the documented zero-cost models', () => {
  for (const model of ['big-pickle', 'deepseek-v4-flash-free', 'mimo-v2.5-free']) {
    assert.ok(FREE_MODELS.has(model), `${model} should be listed as free`);
  }
});

test('OpenCode Zen responder maps bounded failures and rejects invalid replies', async () => {
  const failing = new OpenCodeConversationResponder({
    apiKey: 'opencode_test_key_0123456789',
    fetchImpl: async () => new Response(JSON.stringify({ error: { code: 'rate_limit_exceeded' } }), { status: 429 }),
  });
  await assert.rejects(failing.respond({ text: 'Hello' }), /429.*rate_limit_exceeded/);

  const unauthorized = new OpenCodeConversationResponder({
    apiKey: 'opencode_test_key_0123456789',
    fetchImpl: async () => new Response(JSON.stringify({ error: { code: 'invalid_api_key' } }), { status: 401 }),
  });
  await assert.rejects(unauthorized.respond({ text: 'Hello' }), /401.*invalid_api_key/);

  const invalid = new OpenCodeConversationResponder({
    apiKey: 'opencode_test_key_0123456789',
    fetchImpl: async () => chatResponse('   '),
  });
  await assert.rejects(invalid.respond({ text: 'Hello' }), /response is invalid/);

  const empty = new OpenCodeConversationResponder({
    apiKey: 'opencode_test_key_0123456789',
    fetchImpl: async () => chatResponse(''),
  });
  await assert.rejects(empty.respond({ text: 'Hello' }), /response is invalid/);
});

test('OpenCode Zen responder forwards abort and never records failed turns', async () => {
  let forwarded;
  const controller = new AbortController();
  const aborting = new OpenCodeConversationResponder({
    apiKey: 'opencode_test_key_0123456789',
    fetchImpl: async (_url, options) => {
      forwarded = options.signal;
      return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
    },
  });
  const work = aborting.respond({ text: 'Hello', signal: controller.signal });
  while (!forwarded) await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  await assert.rejects(work, /aborted/);
  assert.equal(forwarded.aborted, true);
  assert.equal(aborting.history.length, 0);
});