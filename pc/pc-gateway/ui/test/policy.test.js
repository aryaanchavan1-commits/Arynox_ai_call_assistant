import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideDownload, decideDelete, decideDial, normalizeE164, isAllowedDestination } from '../lib/policy.js';

const basePolicy = {
  recordingEnabled: true,
  consentRecorded: true,
  completeness: 1.0,
  retentionDays: 30,
  retentionExpired: false,
  allowlist: ['+15551234567'],
  denylist: ['+19001234567'],
  blockPremium: true,
  blockInternational: false,
  blockEmergency: true,
  autoDialEnabled: false,
};

test('decideDownload allows when recording+consent+complete+not-expired', () => {
  const r = decideDownload(basePolicy, { role: 'operator' });
  assert.equal(r.allowed, true);
});

test('decideDownload blocks when recording disabled', () => {
  const r = decideDownload({ ...basePolicy, recordingEnabled: false }, { role: 'operator' });
  assert.equal(r.allowed, false);
  assert.match(r.reason, /recording/i);
});

test('decideDownload blocks when consent not recorded', () => {
  const r = decideDownload({ ...basePolicy, consentRecorded: false }, { role: 'operator' });
  assert.equal(r.allowed, false);
  assert.match(r.reason, /consent/i);
});

test('decideDownload blocks incomplete capture', () => {
  const r = decideDownload({ ...basePolicy, completeness: 0.4 }, { role: 'operator' });
  assert.equal(r.allowed, false);
  assert.match(r.reason, /complete/i);
});

test('decideDownload blocks expired retention', () => {
  const r = decideDownload({ ...basePolicy, retentionExpired: true }, { role: 'operator' });
  assert.equal(r.allowed, false);
  assert.match(r.reason, /retention/i);
});

test('decideDelete requires consent and operator role', () => {
  assert.equal(decideDelete(basePolicy, { role: 'operator' }).allowed, true);
  assert.equal(decideDelete(basePolicy, { role: 'viewer' }).allowed, false);
  assert.equal(decideDelete({ ...basePolicy, consentRecorded: false }, { role: 'operator' }).allowed, false);
});

test('decideDial blocks when autoDial disabled and no manual confirm', () => {
  const r = decideDial(basePolicy, '+15551234567', { manualConfirm: false });
  assert.equal(r.allowed, false);
});

test('decideDial allows allowlisted number with manual confirm', () => {
  const r = decideDial(basePolicy, '+15551234567', { manualConfirm: true });
  assert.equal(r.allowed, true);
});

test('decideDial blocks denied number even with confirm', () => {
  const r = decideDial(basePolicy, '+19001234567', { manualConfirm: true });
  assert.equal(r.allowed, false);
  assert.match(r.reason, /deny/i);
});

test('decideDial blocks premium when blockPremium set', () => {
  const r = decideDial({ ...basePolicy, denylist: [] }, '+19009999999', { manualConfirm: true });
  assert.equal(r.allowed, false);
  assert.match(r.reason, /premium/i);
});

test('decideDial blocks emergency always', () => {
  const r = decideDial(basePolicy, '+1911', { manualConfirm: true });
  assert.equal(r.allowed, false);
});

test('decideDial blocks non-allowlisted when allowlist present and not auto-dial', () => {
  const r = decideDial(basePolicy, '+15550000000', { manualConfirm: true });
  assert.equal(r.allowed, false);
  assert.match(r.reason, /allow/i);
});

test('normalizeE164 strips non-digits and adds leading +', () => {
  assert.equal(normalizeE164(' (555) 123-4567 '), '+5551234567');
  assert.equal(normalizeE164('+44 20 7946 0958'), '+442079460958');
});

test('normalizeE164 returns null for empty/garbage', () => {
  assert.equal(normalizeE164(''), null);
  assert.equal(normalizeE164('   '), null);
});

test('isAllowedDestination true for allowlisted, false for denylisted/unknown', () => {
  assert.equal(isAllowedDestination(basePolicy, '+15551234567'), true);
  assert.equal(isAllowedDestination(basePolicy, '+19001234567'), false);
  assert.equal(isAllowedDestination(basePolicy, '+15550000000'), false);
});
