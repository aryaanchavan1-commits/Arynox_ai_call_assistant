import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Policy, DEFAULT_POLICY } from '../src/policy.js';

const DESTINATION = '+15551234567';

function context(overrides = {}) {
  return {
    destination: DESTINATION,
    approved: true,
    nowMs: 1_700_000_000_000,
    activeDurationMs: 0,
    ...overrides,
  };
}

test('dial is denied by default', () => {
  const decision = new Policy().decideDial(context());
  assert.equal(DEFAULT_POLICY.dialEnabled, false);
  assert.equal(decision.allow, false);
});

test('allow and deny lists use exact E.164 matches and deny wins', () => {
  const policy = new Policy({
    dialEnabled: true,
    allowNumbers: [DESTINATION],
    denyNumbers: [DESTINATION],
    requireManualApproval: false,
  });
  assert.equal(policy.decideDial(context()).allow, false);

  const exact = new Policy({
    dialEnabled: true,
    allowNumbers: [DESTINATION],
    requireManualApproval: false,
  });
  assert.equal(exact.decideDial(context()).allow, true);
  assert.equal(exact.decideDial(context({ destination: '+1555123456' })).allow, false);
});

test('emergency destinations are always blocked', () => {
  const policy = new Policy({
    dialEnabled: true,
    allowNumbers: ['+112'],
    emergencyNumbers: [],
    allowPremium: true,
    allowInternational: true,
    requireManualApproval: false,
  });
  assert.equal(policy.decideDial(context({ destination: '+112' })).allow, false);
  assert.match(policy.decideDial(context({ destination: '+112' })).reason, /emergency/i);
});

test('premium and international calls require explicit gates', () => {
  const base = {
    dialEnabled: true,
    allowNumbers: ['+19005551234', '+442071234567'],
    premiumPrefixes: ['+1900'],
    homeCountryCode: '+1',
    requireManualApproval: false,
  };
  assert.equal(new Policy(base).decideDial(context({ destination: '+19005551234' })).allow, false);
  assert.equal(new Policy({ ...base, allowPremium: true }).decideDial(context({ destination: '+19005551234' })).allow, true);
  assert.equal(new Policy(base).decideDial(context({ destination: '+442071234567' })).allow, false);
  assert.equal(new Policy({ ...base, allowInternational: true }).decideDial(context({ destination: '+442071234567' })).allow, true);
});

test('manual approval is required unless explicitly disabled', () => {
  const policy = new Policy({ dialEnabled: true, allowNumbers: [DESTINATION] });
  assert.equal(policy.decideDial(context({ approved: false })).allow, false);
  assert.equal(policy.decideDial(context({ approved: true })).allow, true);
  const automated = new Policy({ dialEnabled: true, allowNumbers: [DESTINATION], requireManualApproval: false });
  assert.equal(automated.decideDial(context({ approved: false })).allow, true);
});

test('per-destination cooldown and global rate are enforced', () => {
  const policy = new Policy({
    dialEnabled: true,
    allowNumbers: [DESTINATION, '+15557654321', '+15559876543'],
    requireManualApproval: false,
    destinationCooldownMs: 1000,
    globalRateLimit: 2,
    globalRateWindowMs: 10_000,
  });
  assert.equal(policy.decideDial(context()).allow, true);
  assert.equal(policy.decideDial(context({ nowMs: 1_700_000_000_500 })).allow, false);
  assert.equal(policy.decideDial(context({ destination: '+15557654321', nowMs: 1_700_000_001_000 })).allow, true);
  assert.equal(policy.decideDial(context({ destination: '+15559876543', nowMs: 1_700_000_002_000 })).allow, false);
});

test('maximum call duration is enforced', () => {
  const policy = new Policy({ maxCallDurationMs: 60_000 });
  assert.equal(policy.decideDuration({ activeDurationMs: 60_000 }).allow, true);
  assert.equal(policy.decideDuration({ activeDurationMs: 60_001 }).allow, false);
});

test('policy reasons never contain raw phone numbers', () => {
  const policy = new Policy({ dialEnabled: true, allowNumbers: [] });
  const decision = policy.decideDial(context({ approved: false }));
  assert.equal(decision.reason.includes(DESTINATION), false);
  assert.match(JSON.stringify(decision), /last4|4567/);
});
