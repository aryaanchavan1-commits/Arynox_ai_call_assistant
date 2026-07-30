// Redaction helpers. Secrets are write-only: callers may persist them, but they
// must never be echoed back in any API/UI surface. Phone numbers are redacted to
// a privacy-safe prefix/tail form (redacted audit records, per design doc §"Agent
// call-control safety gates").

// Field names that denote provider secrets. Match is case-insensitive on the
// lowercased key.
export const SECRET_KEYS = [
  'apiKey',
  'token',
  'secret',
  'password',
  'accessToken',
  'refreshToken',
  'authorization',
];

// Lowercased set so casing variants (apikey/apiKey/APIKEY) all match.
const SECRET_SET = new Set(SECRET_KEYS.map((k) => k.toLowerCase()));

function isSecretKey(key) {
  return SECRET_SET.has(String(key).toLowerCase());
}

// Masks all but country prefix and last 3 digits of an E.164-ish number.
// Local (no +) numbers keep only the last 2 digits. Short numbers are fully
// masked. Non-strings pass through unchanged.
export function redactPhone(value) {
  if (value === null || value === undefined) return value;
  const s = String(value);
  if (s === '') return '';
  const digits = s.replace(/[^\d]/g, '');
  if (digits.length < 4) return '•'.repeat(s.length || 1);
  const hasPlus = s.startsWith('+');
  if (hasPlus) {
    const tail = digits.slice(-3);
    const country = digits.slice(0, digits.length - 10).slice(0, 3);
    const masked = '•'.repeat(Math.max(1, digits.length - country.length - tail.length));
    return `+${country}${masked}${tail}`;
  }
  const tail = digits.slice(-2);
  const masked = '•'.repeat(Math.max(1, digits.length - tail.length));
  return `${masked}${tail}`;
}

const PHONE_KEYS = new Set(['number', 'from', 'to', 'callerId', 'destination']);

// Recursively replaces secret fields with 'REDACTED' and phone-like fields with
// redacted phone form. Returns a new structure; never mutates input.
export function redactObject(input, _seen = new WeakSet()) {
  if (input === null || typeof input !== 'object') return input;
  if (_seen.has(input)) return null; // ponytail: cycle guard, shallow break
  _seen.add(input);

  if (Array.isArray(input)) {
    return input.map((v) => redactObject(v, _seen));
  }

  const out = {};
  for (const [key, value] of Object.entries(input)) {
    if (isSecretKey(key)) {
      out[key] = 'REDACTED';
    } else if (PHONE_KEYS.has(key)) {
      out[key] = redactPhone(value);
    } else {
      out[key] = redactObject(value, _seen);
    }
  }
  return out;
}

// True when no raw secret value survives in the object. Absent secrets count as
// redacted (write-only: not present = not leaked).
export function isSecretRedacted(obj) {
  if (obj === null || typeof obj !== 'object') return true;
  for (const [key, value] of Object.entries(obj)) {
    if (isSecretKey(key)) {
      if (value !== 'REDACTED' && value !== null && value !== undefined && value !== '') return false;
    } else if (typeof value === 'object' && value !== null) {
      if (!isSecretRedacted(value)) return false;
    }
  }
  return true;
}
