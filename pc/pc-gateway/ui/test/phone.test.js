import assert from 'node:assert/strict';
import test from 'node:test';

import { comparablePhone, contactForNumber, incomingCallIdentity } from '../lib/phone.js';

test('phone comparison accepts formatted dialable numbers and rejects unsafe values', () => {
  assert.equal(comparablePhone('+1 (555) 123-4567'), '15551234567');
  assert.equal(comparablePhone('unknown'), '');
  assert.equal(comparablePhone('1'.repeat(16)), '');
});

test('contact matching prefers exact duplicates and only accepts unambiguous suffix matches', () => {
  const rows = [
    { name: 'Saved caller', number: '+15551234567' },
    { name: 'Linked copy', number: '+15551234567' },
    { name: 'Another contact', number: '+915551234567' },
  ];
  assert.deepEqual(contactForNumber(rows, '+15551234567'), {
    name: 'Saved caller', number: '+15551234567',
  });
  assert.equal(contactForNumber(rows, '5551234567'), null);
  assert.deepEqual(contactForNumber([
    { name: 'Saved caller', number: '+15551234567' },
    { name: 'Saved caller', number: '555 123 4567' },
  ], '5551234567'), {
    name: 'Saved caller', number: '555 123 4567',
  });
});

test('incoming identity uses synchronized contacts when the live call lacks a name', () => {
  assert.deepEqual(incomingCallIdentity(
    { displayNumber: '+15551234567' },
    [{ name: 'Saved caller', number: '+1 555 123 4567' }],
  ), { name: 'Saved caller', number: '+15551234567' });
});
