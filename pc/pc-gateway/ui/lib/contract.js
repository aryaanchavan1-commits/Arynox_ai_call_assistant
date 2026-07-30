// API contract: routes the operator dashboard exposes, and shape validators used
// by tests so a fixture change that breaks the contract fails loudly. All routes
// are read-only GETs of fixture data plus policy-gated POSTs that never touch a
// real device — they return the policy decision, not a backend action.

export const ROUTES = {
  'GET /api/overview': { fixture: 'overview' },
  'GET /api/mcp': { fixture: 'mcp' },
  'GET /api/mcp/tools': { fixture: 'mcp.tools' },
  'GET /api/mcp/recent': { fixture: 'mcp.recentCalls' },
  'GET /api/android': { fixture: 'android' },
  'GET /api/android/adb': { fixture: 'android.adb' },
  'GET /api/android/app': { fixture: 'android.app' },
  'GET /api/android/protocol': { fixture: 'android.protocol' },
  'GET /api/android/audio-route': { fixture: 'android.audioRoute' },
  'GET /api/stt': { fixture: 'stt' },
  'GET /api/tts': { fixture: 'tts' },
  'GET /api/call/live': { fixture: 'liveCall' },
  'GET /api/calls': { fixture: 'callHistory' },
  'GET /api/calls/:id': { fixture: 'callDetail' },
  'GET /api/storage': { fixture: 'storage' },
  'POST /api/call/answer': { gated: false },
  'POST /api/call/reject': { gated: false },
  'POST /api/call/hangup': { gated: false },
  'POST /api/call/dtmf': { gated: false },
  'POST /api/call/dial': { gated: true },
  'POST /api/storage/download': { gated: true },
  'POST /api/storage/delete': { gated: true },
  'POST /api/stt': { writeOnly: true },
  'POST /api/tts': { writeOnly: true },
};

function path(obj, dotted) {
  return dotted.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
}

function has(obj, key) {
  return obj != null && Object.prototype.hasOwnProperty.call(obj, key);
}

// Validators: each asserts the minimum honest fields a fixture must expose so the
// UI never renders against a shape it wasn't built for. Throws on violation.
export const VALIDATORS = {
  overview(f) {
    if (f.mode !== 'fixture') throw new Error('overview: mode must be fixture');
    if (!has(f, 'gateway') || !has(f.gateway, 'status')) throw new Error('overview.gateway.status missing');
    if (!has(f, 'transport')) throw new Error('overview.transport missing');
    if (typeof f.activeCalls !== 'number') throw new Error('overview.activeCalls must be number');
  },
  mcp(f) {
    if (!Array.isArray(f.tools)) throw new Error('mcp.tools must be array');
    for (const t of f.tools) {
      if (!has(t, 'name') || !has(t, 'kind') || typeof t.safe !== 'boolean') {
        throw new Error('mcp.tools entry missing name/kind/safe');
      }
    }
  },
  android(f) {
    if (!has(f, 'adb') || !has(f, 'device') || !has(f, 'app') || !has(f, 'protocol') || !has(f, 'audioRoute')) {
      throw new Error('android: missing adb/device/app/protocol/audioRoute');
    }
    const pcm = f.protocol.pcm;
    if (!pcm || pcm.frameBytes !== 640 || pcm.rate !== 16000) {
      throw new Error('android.protocol.pcm contract violated');
    }
  },
  provider(f, name) {
    if (!has(f, 'provider') || !has(f, 'configured')) throw new Error(`${name}: missing provider/configured`);
    if (f.apiKey !== 'REDACTED') throw new Error(`${name}: apiKey must be REDACTED (write-only)`);
  },
  liveCall(f) {
    if (!has(f, 'callId') || !has(f, 'state') || !has(f, 'transcript') || !has(f, 'vad') || !has(f, 'bargeIn')) {
      throw new Error('liveCall: missing core fields');
    }
  },
  callHistory(f) {
    if (!Array.isArray(f.calls)) throw new Error('callHistory.calls must be array');
    for (const c of f.calls) {
      if (!has(c, 'id') || !has(c, 'consent') || !has(c, 'completeness') || !has(c, 'hash')) {
        throw new Error('callHistory entry missing id/consent/completeness/hash');
      }
    }
  },
  callDetail(f) {
    if (!has(f, 'audio') || !has(f, 'consent') || !has(f, 'completeness') || !has(f, 'hash') || !has(f, 'retention')) {
      throw new Error('callDetail: missing audio/consent/completeness/hash/retention');
    }
  },
  storage(f) {
    if (!has(f, 'recording') || !has(f, 'health') || !has(f, 'settings')) {
      throw new Error('storage: missing recording/health/settings');
    }
  },
};

export function validateAll(F) {
  VALIDATORS.overview(F.overview);
  VALIDATORS.mcp(F.mcp);
  VALIDATORS.android(F.android);
  VALIDATORS.provider(F.stt, 'stt');
  VALIDATORS.provider(F.tts, 'tts');
  VALIDATORS.liveCall(F.liveCall);
  VALIDATORS.callHistory(F.callHistory);
  VALIDATORS.callDetail(F.callDetail(F.callHistory.calls[0].id));
  VALIDATORS.storage(F.storage);
  return true;
}

// Resolves a route key against the fixture bundle. Returns null for unknown.
export function resolveFixture(routeKey, F, params = {}) {
  const def = ROUTES[routeKey];
  if (!def) return null;
  if (def.fixture === 'callDetail') return F.callDetail(params.id);
  return path(F, def.fixture);
}

// Write-only POSTs accept a secret but never return it. Returns a receipt
// carrying only configured/non-sensitive status.
export function writeReceipt(name, input) {
  return {
    mode: 'fixture',
    name,
    accepted: true,
    configured: Boolean(input && (input.provider || input.model)),
    secretStored: Boolean(input && (input.apiKey || input.token)) && 'never-returned',
    note: 'secret accepted write-only; not echoed back',
  };
}
