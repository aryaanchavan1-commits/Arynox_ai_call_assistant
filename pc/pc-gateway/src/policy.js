import { createHash } from 'node:crypto';

const HARD_EMERGENCY_NUMBERS = new Set(['+112', '+911', '+999', '+000', '+110', '+118', '+119']);

export const DEFAULT_POLICY = Object.freeze({
  dialEnabled: false,
  allowNumbers: [],
  denyNumbers: [],
  emergencyNumbers: [],
  premiumPrefixes: [],
  homeCountryCode: '',
  allowPremium: false,
  allowInternational: false,
  requireManualApproval: true,
  destinationCooldownMs: 60_000,
  globalRateLimit: 5,
  globalRateWindowMs: 60_000,
  maxCallDurationMs: 60 * 60_000,
});

function decision(allow, reason, destination, salt) {
  const value = { allow, reason };
  if (destination) value.destination = redactPhoneNumber(destination, salt);
  return value;
}

export function redactPhoneNumber(number, salt = '') {
  const text = String(number ?? '');
  return {
    hash: createHash('sha256').update(`${salt}:${text}`).digest('hex'),
    last4: text.slice(-4),
  };
}

export class Policy {
  constructor(options = {}) {
    this.options = { ...DEFAULT_POLICY, ...options };
    this.allowNumbers = new Set(this.options.allowNumbers);
    this.denyNumbers = new Set(this.options.denyNumbers);
    this.emergencyNumbers = new Set([...HARD_EMERGENCY_NUMBERS, ...this.options.emergencyNumbers]);
    this.lastDialByDestination = new Map();
    this.globalDials = [];
    this.salt = options.redactionSalt ?? '';
  }

  decideDial({ destination, approved = false, nowMs = Date.now() }) {
    const deny = (reason) => decision(false, reason, destination, this.salt);
    if (!this.options.dialEnabled) return deny('dial disabled by default');
    if (this.emergencyNumbers.has(destination)) return deny('emergency destination blocked');
    if (this.denyNumbers.has(destination)) return deny('destination denied');
    if (this.allowNumbers.size > 0 && !this.allowNumbers.has(destination)) return deny('destination not explicitly allowed');
    if (!this.options.allowPremium && this.options.premiumPrefixes.some((prefix) => destination.startsWith(prefix))) {
      return deny('premium destination blocked');
    }
    if (!this.options.allowInternational && this.options.homeCountryCode && !destination.startsWith(this.options.homeCountryCode)) {
      return deny('international destination blocked');
    }
    if (this.options.requireManualApproval && !approved) return deny('manual approval required');

    const lastDialMs = this.lastDialByDestination.get(destination);
    if (lastDialMs !== undefined && nowMs - lastDialMs < this.options.destinationCooldownMs) {
      return deny('destination cooldown active');
    }
    const windowStart = nowMs - this.options.globalRateWindowMs;
    this.globalDials = this.globalDials.filter((timestamp) => timestamp > windowStart);
    if (this.globalDials.length >= this.options.globalRateLimit) return deny('global dial rate exceeded');

    this.lastDialByDestination.set(destination, nowMs);
    this.globalDials = [...this.globalDials, nowMs];
    return decision(true, 'allowed', destination, this.salt);
  }

  decideDuration({ activeDurationMs }) {
    if (!Number.isFinite(activeDurationMs) || activeDurationMs < 0) {
      return decision(false, 'invalid active call duration');
    }
    if (activeDurationMs > this.options.maxCallDurationMs) {
      return decision(false, 'maximum call duration exceeded');
    }
    return decision(true, 'within maximum call duration');
  }
}
