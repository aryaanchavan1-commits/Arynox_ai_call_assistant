import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { PhoneDataStore } from '../src/phone-data-sync.js';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'agentcall-phone-data-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let next = 0;
  return { root, store: new PhoneDataStore({ root, now: () => 1_721_664_000_000, randomId: () => `request-${++next}` }) };
}

function request(store, capability, command) {
  store.setCapabilities([capability]);
  return store.syncRequests().find((item) => item.command === command).requestId;
}

test('contacts snapshot commits atomically only after one valid final page and survives restart', async (t) => {
  const { root, store } = await fixture(t);
  const requestId = request(store, 'contacts_sync_v1', 'sync_contacts');
  assert.deepEqual(await store.listContacts({ limit: 20 }), { rows: [], sync: { state: 'syncing', count: 0 } });
  assert.equal(await store.consume({
    event: 'contacts_snapshot_v1', requestId, page: 0, final: false,
    rows: [{ id: '10', name: 'Ada', number: '+10000000000' }],
  }), true);
  assert.deepEqual((await store.listContacts({ limit: 20 })).rows, []);
  assert.equal(await store.consume({
    event: 'contacts_snapshot_v1', requestId, page: 1, final: true,
    rows: [{ id: '11', name: 'Grace', number: '+10000000001' }],
  }), true);
  const expected = {
    rows: [
      { id: '10', name: 'Ada', number: '+10000000000' },
      { id: '11', name: 'Grace', number: '+10000000001' },
    ],
    sync: { state: 'ready', count: 2, syncedAt: '2024-07-22T16:00:00.000Z' },
  };
  assert.deepEqual(await store.listContacts({ limit: 20 }), expected);
  assert.deepEqual(await new PhoneDataStore({ root }).listContacts({ limit: 20 }), expected);
  assert.deepEqual(await store.findContact({ number: '+1 (000) 000-0001' }), {
    name: 'Grace', number: '+10000000001',
  });
  assert.equal(await store.findContact({ number: 'invalid' }), null);
  if (process.platform !== 'win32') assert.equal((await stat(join(root, 'contacts.json'))).mode & 0o777, 0o600);
});

test('contact lookup tolerates linked exact duplicates while keeping ambiguous suffixes unnamed', async (t) => {
  const { store } = await fixture(t);
  const requestId = request(store, 'contacts_sync_v1', 'sync_contacts');
  await store.consume({
    event: 'contacts_snapshot_v1', requestId, page: 0, final: true,
    rows: [
      { id: '1', name: 'Saved caller', number: '+15551234567' },
      { id: '2', name: 'Linked copy', number: '+15551234567' },
      { id: '3', name: 'Different caller', number: '+915551234567' },
    ],
  });
  assert.deepEqual(await store.findContact({ number: '+15551234567' }), {
    name: 'Saved caller', number: '+15551234567',
  });
  assert.equal(await store.findContact({ number: '5551234567' }), null);
});

test('contact lookup falls back to the bounded Android call-log name when the contact is outside the mirror cap', async (t) => {
  const { store } = await fixture(t);
  const requestId = request(store, 'call_log_sync_v1', 'sync_call_log');
  await store.consume({
    event: 'call_log_snapshot_v1', requestId, page: 0, final: true,
    rows: [{
      id: '1',
      name: 'Saved caller',
      number: '+15551234567',
      kind: 'incoming',
      timestampMillis: '1721664000000',
      durationSeconds: '12',
    }],
  });
  assert.deepEqual(await store.findContact({ number: '5551234567' }), {
    name: 'Saved caller', number: '+15551234567',
  });
});

test('malformed, out-of-order, duplicate, and oversized pages never replace last good data', async (t) => {
  const { root, store } = await fixture(t);
  const goodRequest = request(store, 'contacts_sync_v1', 'sync_contacts');
  await store.consume({
    event: 'contacts_snapshot_v1', requestId: goodRequest, page: 0, final: true,
    rows: [{ id: '1', name: 'Good', number: '+10000000000' }],
  });
  const before = await readFile(join(root, 'contacts.json'), 'utf8');
  for (const value of [
    { event: 'contacts_snapshot_v1', requestId: 'bad', page: 1, final: true, rows: [] },
    { event: 'contacts_snapshot_v1', requestId: 'bad', page: 0, final: true, rows: [{ id: '1', name: '', number: 'bad' }] },
    { event: 'contacts_snapshot_v1', requestId: 'bad', page: 0, final: true, rows: Array.from({ length: 101 }, (_, i) => ({ id: String(i), name: 'x', number: '+10000000000' })) },
  ]) assert.equal(await store.consume(value), false);
  assert.equal(await readFile(join(root, 'contacts.json'), 'utf8'), before);
  assert.deepEqual((await store.listContacts({ limit: 20 })).rows, [{ id: '1', name: 'Good', number: '+10000000000' }]);
});

test('call-log snapshot validates bounded rows, caps reads, and reports sync health without PII', async (t) => {
  const { store } = await fixture(t);
  const requestId = request(store, 'call_log_sync_v1', 'sync_call_log');
  assert.equal(await store.consume({
    event: 'call_log_snapshot_v1', requestId, page: 0, final: true,
    rows: [{
      id: '77', number: '+10000000000', name: 'Ada', kind: 'incoming',
      timestampMillis: '1721663900000', durationSeconds: '42',
    }],
  }), true);
  assert.deepEqual(await store.listCallLog({ limit: 1 }), {
    rows: [{
      id: '77', number: '+10000000000', name: 'Ada', kind: 'incoming',
      timestampMillis: '1721663900000', durationSeconds: '42',
    }],
    sync: { state: 'ready', count: 1, syncedAt: '2024-07-22T16:00:00.000Z' },
  });
  assert.deepEqual(await store.publicStatus(), {
    contacts: { state: 'unsupported', count: 0 },
    callLog: { state: 'ready', count: 1, syncedAt: '2024-07-22T16:00:00.000Z' },
  });
  assert.equal(JSON.stringify(await store.publicStatus()).includes('+10000000000'), false);
});

test('each phone-data collection reports its own sync progress independently', async (t) => {
  const { store } = await fixture(t);
  store.setCapabilities(['contacts_sync_v1', 'call_log_sync_v1']);
  const requests = store.syncRequests();
  const contactsRequest = requests.find((item) => item.command === 'sync_contacts').requestId;

  assert.equal(await store.consume({
    event: 'contacts_snapshot_v1', requestId: contactsRequest, page: 0, final: true,
    rows: [{ id: '1', name: 'Ready Contact', number: '+10000000000' }],
  }), true);

  const status = await store.publicStatus();
  assert.equal(status.contacts.state, 'ready');
  assert.equal(status.callLog.state, 'syncing');
});

test('unsupported/disconnected capability state preserves the last committed mirrors', async (t) => {
  const { store } = await fixture(t);
  const requestId = request(store, 'contacts_sync_v1', 'sync_contacts');
  await store.consume({ event: 'contacts_snapshot_v1', requestId, page: 0, final: true, rows: [] });
  store.setCapabilities([]);
  assert.deepEqual(await store.publicStatus(), {
    contacts: { state: 'unsupported', count: 0, syncedAt: '2024-07-22T16:00:00.000Z' },
    callLog: { state: 'unsupported', count: 0 },
  });
  store.setDisconnected();
  assert.equal((await store.publicStatus()).contacts.state, 'offline');
});

test('sync request plan is capability-negotiated and uses opaque request IDs', () => {
  const ids = ['contacts-request', 'calls-request'];
  const store = new PhoneDataStore({ root: '/tmp/not-used', randomId: () => ids.shift() });
  store.setCapabilities(['contacts_sync_v1', 'call_log_sync_v1']);
  assert.deepEqual(store.syncRequests(), [
    { command: 'sync_contacts', requestId: 'contacts-request' },
    { command: 'sync_call_log', requestId: 'calls-request' },
  ]);
  store.setCapabilities(['recording_sync_v1']);
  assert.deepEqual(store.syncRequests(), []);
});


test('phone snapshot events are recognized privately and unrelated events are ignored', async (t) => {
  const { store } = await fixture(t);
  assert.equal(await store.consume({ event: 'active', callId: 'call-1' }), false);
  assert.equal(await store.consume({ event: 'contacts_snapshot_v1', requestId: 'unsolicited', page: 0, final: true, rows: [] }), false);
  const requestId = request(store, 'contacts_sync_v1', 'sync_contacts');
  assert.equal(await store.consume({ event: 'contacts_snapshot_v1', requestId, page: 0, final: true, rows: [] }), true);
});
