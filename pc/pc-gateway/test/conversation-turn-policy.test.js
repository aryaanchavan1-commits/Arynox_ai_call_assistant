import assert from 'node:assert/strict';
import test from 'node:test';

import { isHangupIntent } from '../src/conversation-turn-policy.js';

test('explicit spoken goodbyes and end-call requests request hangup', () => {
  for (const phrase of [
    'Goodbye.',
    'Okay, bye.',
    'Bye bye, thank you.',
    'Please hang up the call.',
    'No, no, okay, we just hang up this call.',
    'Well, we should end this call.',
    'End the call.',
    "I'm done.",
    'Talk to you later.',
  ]) {
    assert.equal(isHangupIntent(phrase), true, phrase);
  }
});

test('incidental goodbye words and ordinary conversation do not request hangup', () => {
  for (const phrase of [
    'I said goodbye to my friend yesterday.',
    'What does goodbye mean?',
    'Tell me about the movie Bye Bye Birdie.',
    'I am done with my homework.',
    'Do not hang up this call.',
    'We should not end this call.',
    'Can you explain how to hang up this call?',
    'How are you?',
    '',
  ]) {
    assert.equal(isHangupIntent(phrase), false, phrase);
  }
});
