import { test } from 'node:test';
import assert from 'node:assert/strict';

import { GroqConversationResponder } from '../src/groq-conversation-responder.js';

function chatResponse(reply) {
  return new Response(JSON.stringify({
    choices: [{ message: { role: 'assistant', content: reply } }],
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

test('Groq conversation responder posts a bounded chat request and remembers the exchange', async () => {
  let captured;
  const responder = new GroqConversationResponder({
    apiKey: 'gsk_test_only_key_0123456789',
    fetchImpl: async (url, options) => {
      captured = { url, options, body: JSON.parse(options.body) };
      return chatResponse('Hello! How can I help you today?');
    },
  });
  responder.remember('user', 'Hi there');
  responder.remember('assistant', 'Hello!');
  const reply = await responder.respond({ text: 'Who is calling?', callerName: 'Riya', callerContext: 'She called last week about a delivery.' });

  assert.equal(reply, 'Hello! How can I help you today?');
  assert.equal(captured.url, 'https://api.groq.com/openai/v1/chat/completions');
  assert.equal(captured.options.method, 'POST');
  assert.equal(captured.options.headers.authorization, 'Bearer gsk_test_only_key_0123456789');
  assert.equal(captured.options.headers['content-type'], 'application/json');
  assert.equal(captured.body.model, 'llama-3.3-70b-versatile');
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

test('Groq conversation responder bounds history to the configured limit', async () => {
  const responder = new GroqConversationResponder({
    apiKey: 'gsk_test_only_key_0123456789',
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

test('Groq conversation responder validates configuration and transcript bounds', () => {
  assert.throws(() => new GroqConversationResponder({ apiKey: 'short' }), /API key/i);
  assert.throws(() => new GroqConversationResponder({ apiKey: 'gsk_test_only_key_0123456789', model: 'gpt-4o' }), /model/i);
  assert.throws(() => new GroqConversationResponder({ apiKey: 'gsk_test_only_key_0123456789', timeoutMs: 100 }), /timeout/i);
  assert.throws(() => new GroqConversationResponder({ apiKey: 'gsk_test_only_key_0123456789', maxHistoryMessages: 1 }), /history/i);
  assert.throws(() => new GroqConversationResponder({ apiKey: 'gsk_test_only_key_0123456789' }).remember('system', 'x'), /role/i);
});

test('Groq conversation responder maps bounded failures and rejects invalid replies', async () => {
  const failing = new GroqConversationResponder({
    apiKey: 'gsk_test_only_key_0123456789',
    fetchImpl: async () => new Response(JSON.stringify({ error: { code: 'rate_limit_exceeded' } }), { status: 429 }),
  });
  await assert.rejects(failing.respond({ text: 'Hello' }), /429.*rate_limit_exceeded/);

  const invalid = new GroqConversationResponder({
    apiKey: 'gsk_test_only_key_0123456789',
    fetchImpl: async () => chatResponse('   '),
  });
  await assert.rejects(invalid.respond({ text: 'Hello' }), /response is invalid/);

  const empty = new GroqConversationResponder({
    apiKey: 'gsk_test_only_key_0123456789',
    fetchImpl: async () => chatResponse(''),
  });
  await assert.rejects(empty.respond({ text: 'Hello' }), /response is invalid/);
});

test('Groq conversation responder forwards abort and never records failed turns', async () => {
  let forwarded;
  const controller = new AbortController();
  const aborting = new GroqConversationResponder({
    apiKey: 'gsk_test_only_key_0123456789',
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