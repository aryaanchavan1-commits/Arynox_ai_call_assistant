import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CallerMemoryStore } from '../src/caller-memory.js';

const NUMBER = '+15551234567';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'agentcall-memory-'));
  return { root, store: new CallerMemoryStore({ root, secret: 'deployment-memory-secret' }) };
}

test('caller memory stores no raw number and returns bounded context only with valid consent', async () => {
  const { root, store } = await fixture();
  const expiresAt = new Date(Date.now() + 86_400_000).toISOString();
  const updated = await store.update({
    phoneNumber: NUMBER,
    consent: { memory: true, expiresAt },
    operatorRole: 'operator',
    context: {
      summary: 'Prefers short appointment confirmations.',
      language: 'en', voice: 'calm', facts: ['Name is Alex'], followUps: ['Confirm Tuesday slot'],
    },
  });
  assert.match(updated.callerId, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(updated).includes(NUMBER), false);
  assert.deepEqual((await store.resolve({ phoneNumber: NUMBER })).context, {
    summary: 'Prefers short appointment confirmations.', language: 'en', voice: 'calm',
    facts: ['Name is Alex'], followUps: ['Confirm Tuesday slot'], history: [],
  });
  const record = await readFile(join(root, 'callers', `${updated.callerId}.json`), 'utf8');
  const audit = await readFile(join(root, 'audit.jsonl'), 'utf8');
  assert.equal(record.includes(NUMBER), false);
  assert.equal(audit.includes(NUMBER), false);
  if (process.platform !== 'win32') {
    assert.equal((await stat(join(root, 'callers'))).mode & 0o777, 0o700);
    assert.equal((await stat(join(root, 'callers', `${updated.callerId}.json`))).mode & 0o777, 0o600);
  }
});

test('consented caller history keeps bounded call dates and transcripts without raw numbers', async () => {
  const { root, store } = await fixture();
  const expiresAt = new Date(Date.now() + 86_400_000).toISOString();
  await store.update({
    phoneNumber: NUMBER,
    consent: { memory: true, expiresAt },
    operatorRole: 'operator',
    context: { summary: 'Returning support caller' },
  });
  const appended = await store.appendCall({
    phoneNumber: NUMBER,
    call: {
      callId: 'call-history-1',
      startedAt: '2026-07-23T08:00:00.000Z',
      endedAt: '2026-07-23T08:04:00.000Z',
      direction: 'incoming',
      outcome: 'ended',
      transcript: 'remote: Please follow up tomorrow.\nagent: I will.',
      recordingId: 'call-history-1',
    },
  });
  assert.equal(appended.appended, true);
  const resolved = await store.resolve({ phoneNumber: NUMBER });
  assert.deepEqual(resolved.context.history, [{
    callId: 'call-history-1',
    startedAt: '2026-07-23T08:00:00.000Z',
    endedAt: '2026-07-23T08:04:00.000Z',
    direction: 'incoming', outcome: 'ended', summary: '',
    transcript: 'remote: Please follow up tomorrow.\nagent: I will.',
    recordingId: 'call-history-1',
  }]);
  assert.equal((await readFile(join(root, 'callers', `${resolved.callerId}.json`), 'utf8')).includes(NUMBER), false);

  const unknown = await fixture();
  assert.deepEqual(await unknown.store.appendCall({
    phoneNumber: NUMBER,
    call: { callId: 'call-without-consent' },
  }), { appended: false, reason: 'memory consent unavailable' });
});

test('caller memory is consent-bound, operator-controlled, bounded, expiring and deletable', async () => {
  const { store } = await fixture();
  await assert.rejects(() => store.update({ phoneNumber: NUMBER, consent: { memory: true }, operatorRole: 'agent', context: {} }), /operator/);
  await assert.rejects(() => store.update({ phoneNumber: NUMBER, consent: { memory: false }, operatorRole: 'operator', context: {} }), /consent/);
  await assert.rejects(() => store.update({
    phoneNumber: NUMBER, operatorRole: 'operator',
    consent: { memory: true, expiresAt: new Date(Date.now() + 1_000).toISOString() },
    context: { facts: Array(9).fill('too many') },
  }), /facts/);

  await store.update({
    phoneNumber: NUMBER, operatorRole: 'operator',
    consent: { memory: true, expiresAt: new Date(Date.now() - 1_000).toISOString() }, context: { summary: 'expired' },
  });
  assert.deepEqual(await store.resolve({ phoneNumber: NUMBER }), { found: false });
  assert.deepEqual(await store.delete({ phoneNumber: NUMBER, operatorRole: 'operator', reason: 'caller request' }), { deleted: true });
  assert.deepEqual(await store.resolve({ phoneNumber: NUMBER }), { found: false });
});

test('caller identifiers are deployment-keyed and reject malformed phone numbers', async () => {
  const one = new CallerMemoryStore({ root: '/tmp/a', secret: 'secret-one' });
  const two = new CallerMemoryStore({ root: '/tmp/b', secret: 'secret-two' });
  assert.notEqual(one.callerId(NUMBER), two.callerId(NUMBER));
  for (const value of ['5551234', '+1 555 123', '+', '']) assert.throws(() => one.callerId(value), /E\.164/);
});
