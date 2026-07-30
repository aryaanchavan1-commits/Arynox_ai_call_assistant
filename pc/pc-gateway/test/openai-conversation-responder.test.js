import assert from 'node:assert/strict';
import test from 'node:test';

import {
  extractResponseText,
  OpenAiConversationResponder,
} from '../src/openai-conversation-responder.js';

test('extractResponseText joins output text blocks and ignores other content', () => {
  assert.equal(extractResponseText({
    output: [
      { content: [{ type: 'output_text', text: 'Hello' }, { type: 'refusal', refusal: 'no' }] },
      { content: [{ type: 'output_text', text: ' there.' }] },
    ],
  }), 'Hello there.');
  assert.equal(extractResponseText({ output: [] }), '');
});

test('responder sends bounded conversational history and remembers the reply', async () => {
  const requests = [];
  const responder = new OpenAiConversationResponder({
    apiKey: `sk-${'x'.repeat(30)}`,
    maxHistoryMessages: 4,
    fetchImpl: async (_url, options) => {
      requests.push(JSON.parse(options.body));
      return {
        ok: true,
        status: 200,
        json: async () => ({
          output: [{ content: [{ type: 'output_text', text: 'I am doing well. How are you?' }] }],
        }),
      };
    },
  });
  responder.remember('assistant', 'Hello.');
  const reply = await responder.respond({ text: 'How are you?', callerName: 'Siddharth' });
  assert.equal(reply, 'I am doing well. How are you?');
  assert.deepEqual(requests[0].input, [
    { role: 'assistant', content: 'Hello.' },
    { role: 'user', content: 'How are you?' },
  ]);
  assert.match(requests[0].instructions, /Siddharth/);
  assert.deepEqual(responder.history, [
    { role: 'assistant', content: 'Hello.' },
    { role: 'user', content: 'How are you?' },
    { role: 'assistant', content: 'I am doing well. How are you?' },
  ]);
});

test('responder rejects provider errors without exposing provider response text', async () => {
  const responder = new OpenAiConversationResponder({
    apiKey: `sk-${'x'.repeat(30)}`,
    fetchImpl: async () => ({
      ok: false,
      status: 429,
      json: async () => ({ error: { code: 'rate_limit_exceeded', message: 'sensitive detail' } }),
    }),
  });
  await assert.rejects(
    responder.respond({ text: 'Hello' }),
    /OpenAI conversation request failed \(429, rate_limit_exceeded\)/,
  );
});
