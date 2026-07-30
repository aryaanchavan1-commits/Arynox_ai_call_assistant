import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redactPhone, redactObject, isSecretRedacted, SECRET_KEYS } from '../lib/redact.js';

test('redactPhone masks middle of E.164 number, keeps country prefix', () => {
  assert.equal(redactPhone('+15551234567'), '+1•••••••567');
});

test('redactPhone handles local format without plus', () => {
  // 10 digits, no +: keep last 2, mask the rest.
  assert.equal(redactPhone('0201234567'), '••••••••67');
});

test('redactPhone leaves too-short numbers fully masked', () => {
  assert.equal(redactPhone('123'), '•••');
});

test('redactPhone redacts empty/undefined/null unchanged-safe', () => {
  assert.equal(redactPhone(''), '');
  assert.equal(redactPhone(undefined), undefined);
  assert.equal(redactPhone(null), null);
});

test('redactObject replaces known secret fields with REDACTED marker', () => {
  const out = redactObject({ apiKey: 'sk-live-12345', token: 'tok_abc', number: '+15551234567' });
  assert.equal(out.apiKey, 'REDACTED');
  assert.equal(out.token, 'REDACTED');
  assert.equal(out.number, '+1•••••••567');
});

test('redactObject never echoes a raw secret value back', () => {
  const raw = 'sk-live-SUPERSECRET';
  const out = redactObject({ apiKey: raw });
  assert.equal(JSON.stringify(out).includes(raw), false);
});

test('redactObject recurses into nested objects and arrays', () => {
  const out = redactObject({ stt: { apiKey: 'secret1' }, calls: [{ from: '+15551234567' }] });
  assert.equal(out.stt.apiKey, 'REDACTED');
  assert.equal(out.calls[0].from, '+1•••••••567');
});

test('isSecretRedacted true when secret fields are REDACTED or absent', () => {
  assert.equal(isSecretRedacted({ apiKey: 'REDACTED' }), true);
  assert.equal(isSecretRedacted({}), true);
});

test('isSecretRedacted false when a raw secret survives', () => {
  assert.equal(isSecretRedacted({ apiKey: 'sk-live-12345' }), false);
});

test('SECRET_KEYS covers provider secret field names', () => {
  assert.ok(SECRET_KEYS.includes('apiKey'));
  assert.ok(SECRET_KEYS.includes('token'));
  assert.ok(SECRET_KEYS.includes('secret'));
});
