import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as F from '../lib/fixtures.js';
import { ROUTES, VALIDATORS, validateAll, resolveFixture, writeReceipt } from '../lib/contract.js';
import { redactObject, isSecretRedacted } from '../lib/redact.js';

test('every fixture section labels itself fixture mode', () => {
  for (const section of [F.overview, F.mcp, F.android, F.stt, F.tts, F.liveCall, F.callHistory, F.storage]) {
    assert.equal(section.mode, 'fixture');
  }
});

test('validateAll passes against current fixtures', () => {
  assert.equal(validateAll(F), true);
});

test('provider fixtures never expose a raw secret', () => {
  assert.equal(isSecretRedacted(F.stt), true);
  assert.equal(isSecretRedacted(F.tts), true);
  assert.equal(F.stt.apiKey, 'REDACTED');
  assert.equal(F.tts.apiKey, 'REDACTED');
});

test('redactObject applied to overview never leaks a secret', () => {
  const r = redactObject(F.overview);
  assert.equal(isSecretRedacted(r), true);
});

test('callHistory phone numbers come out redacted through redactObject', () => {
  const r = redactObject(F.callHistory);
  assert.equal(r.calls[0].from, '+1•••••••567');
  assert.equal(JSON.stringify(r).includes('+15551234567'), false);
});

test('callDetail exposes remote/agent/mixed audio, consent, completeness, hash, retention', () => {
  const d = F.callDetail('call-fixture-000');
  assert.ok(d.audio.remote && d.audio.agent && d.audio.mixed);
  assert.equal(typeof d.consent.recorded, 'boolean');
  assert.equal(typeof d.completeness, 'number');
  assert.match(d.hash, /sha256:/);
  assert.equal(typeof d.retention.days, 'number');
});

test('android protocol matches design doc PCM framing (16kHz mono 20ms=640 bytes)', () => {
  assert.equal(F.android.protocol.pcm.frameBytes, 640);
  assert.equal(F.android.protocol.pcm.rate, 16000);
  assert.equal(F.android.protocol.pcm.channels, 1);
});

test('mcp tools include the design-doc control surface', () => {
  const names = F.mcp.tools.map((t) => t.name);
  for (const n of ['phone.status', 'phone.dial', 'phone.answer', 'phone.reject', 'phone.hangup', 'phone.send_dtmf', 'phone.speak']) {
    assert.ok(names.includes(n), `missing tool ${n}`);
  }
});

test('ROUTES covers every panel the UI needs', () => {
  const keys = Object.keys(ROUTES);
  for (const r of [
    'GET /api/overview', 'GET /api/mcp', 'GET /api/android', 'GET /api/stt', 'GET /api/tts',
    'GET /api/call/live', 'GET /api/calls', 'GET /api/calls/:id', 'GET /api/storage',
  ]) {
    assert.ok(keys.includes(r), `missing route ${r}`);
  }
});

test('gated routes are marked gated in contract', () => {
  assert.equal(ROUTES['POST /api/call/dial'].gated, true);
  assert.equal(ROUTES['POST /api/storage/download'].gated, true);
  assert.equal(ROUTES['POST /api/storage/delete'].gated, true);
});

test('resolveFixture returns the right section per route', () => {
  assert.equal(resolveFixture('GET /api/overview', F).mode, 'fixture');
  assert.equal(resolveFixture('GET /api/mcp/tools', F).length, F.mcp.tools.length);
  assert.equal(resolveFixture('GET /api/android/protocol', F).version, F.android.protocol.version);
});

test('resolveFixture returns callDetail by id', () => {
  const d = resolveFixture('GET /api/calls/:id', F, { id: 'call-fixture-000' });
  assert.equal(d.call.id, 'call-fixture-000');
});

test('resolveFixture null for unknown route', () => {
  assert.equal(resolveFixture('GET /api/nope', F), null);
});

test('writeReceipt never echoes a submitted secret', () => {
  const r = writeReceipt('stt', { provider: 'whisper', apiKey: 'sk-live-SUPERSECRET' });
  assert.equal(r.accepted, true);
  assert.equal(JSON.stringify(r).includes('sk-live-SUPERSECRET'), false);
  assert.equal(r.secretStored, 'never-returned');
});

test('contract rejects a fixture that leaks a real secret', () => {
  const bad = { ...F.stt, apiKey: 'sk-live-leaked' };
  assert.throws(() => VALIDATORS.provider(bad, 'stt'), /write-only/);
});

test('contract rejects callDetail missing retention', () => {
  const bad = { ...F.callDetail('call-fixture-000') };
  delete bad.retention;
  assert.throws(() => VALIDATORS.callDetail(bad), /retention/);
});
