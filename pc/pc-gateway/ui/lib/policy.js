// Policy gates for the operator dashboard. Pure functions: take a policy snapshot
// and a request, return { allowed, reason }. Mirrors the safety gates in the
// design doc §"Agent call-control safety gates": recording off by default,
// consent/retention required for audio access, allowlist/denylist + premium/
// emergency/international restrictions, manual confirm unless auto-dial enabled.

const COMPLETE_THRESHOLD = 0.9;

// US premium-rate prefixes. ponytail: hardcoded list; move to config if regions grow.
const PREMIUM_PREFIXES = ['+1900', '+1976', '+1901'];
const EMERGENCY_NUMBERS = new Set(['911', '112', '999', '000', '110', '119', '120']);

export function normalizeE164(input) {
  if (input === null || input === undefined) return null;
  const digits = String(input).replace(/[^\d]/g, '');
  if (digits.length < 3) return null;
  return '+' + digits;
}

function deny(reason) {
  return { allowed: false, reason };
}
function allow(reason) {
  return { allowed: true, reason };
}

export function isAllowedDestination(policy, rawNumber) {
  const n = normalizeE164(rawNumber);
  if (!n) return false;
  if (policy.denylist?.some((d) => normalizeE164(d) === n)) return false;
  if (policy.allowlist && policy.allowlist.length > 0) {
    return policy.allowlist.some((a) => normalizeE164(a) === n);
  }
  return true; // no allowlist = open (still subject to deny/premium/emergency)
}

export function decideDownload(policy, _actor) {
  if (!policy.recordingEnabled) return deny('recording is disabled for this call');
  if (!policy.consentRecorded) return deny('consent was not recorded');
  if ((policy.completeness ?? 0) < COMPLETE_THRESHOLD) return deny('capture is incomplete');
  if (policy.retentionExpired) return deny('retention period has expired');
  return allow('ok');
}

export function decideDelete(policy, actor) {
  if (actor?.role !== 'operator') return deny('operator role required');
  if (!policy.consentRecorded) return deny('consent not recorded; cannot delete');
  return allow('ok');
}

export function decideDial(policy, rawNumber, opts = {}) {
  const n = normalizeE164(rawNumber);
  if (!n) return deny('invalid destination number');

  const bare = n.slice(1);
  if (EMERGENCY_NUMBERS.has(bare) || (policy.blockEmergency && bare.length <= 3)) {
    return deny('emergency numbers are blocked');
  }
  if (policy.denylist?.some((d) => normalizeE164(d) === n)) {
    return deny('destination is on the denylist');
  }
  if (policy.blockPremium && PREMIUM_PREFIXES.some((p) => n.startsWith(p))) {
    return deny('premium-rate destination blocked');
  }

  const autoOk = policy.autoDialEnabled === true;
  if (!autoOk && !opts.manualConfirm) {
    return deny('auto-dial disabled; manual confirmation required');
  }

  if (policy.allowlist && policy.allowlist.length > 0) {
    const ok = policy.allowlist.some((a) => normalizeE164(a) === n);
    if (!ok) return deny('destination not on allowlist');
  }

  return allow('ok');
}
