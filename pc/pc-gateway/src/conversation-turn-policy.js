const HANGUP_PHRASES = new Set([
  'bye',
  'bye bye',
  'good bye',
  'goodbye',
  'hang up',
  'hang up this call',
  'hang up the call',
  'hangup',
  'end call',
  'end this call',
  'end the call',
  'disconnect',
  'disconnect this call',
  'disconnect the call',
  'i am done',
  'im done',
  'see you later',
  'talk to you later',
  'that is all',
  'thats all',
]);

function normalizeSpokenText(value) {
  return value
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function isHangupIntent(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 160) return false;
  let normalized = normalizeSpokenText(value);
  if (/\b(?:do not|dont|never|not)\s+(?:hang up|end|disconnect)\b/u.test(normalized)) {
    return false;
  }
  normalized = normalized.replace(/^(?:(?:no|yeah|yes|well)\s+){1,4}/u, '');
  normalized = normalized.replace(/^(?:okay|ok|alright)\s+/, '');
  normalized = normalized.replace(/^we\s+(?:can|should|will|just)\s+/, '');
  normalized = normalized.replace(/^please\s+/, '');
  normalized = normalized.replace(/^just\s+/, '');
  normalized = normalized.replace(/\s+(?:thank you|thanks)$/, '');
  return HANGUP_PHRASES.has(normalized);
}
