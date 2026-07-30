// Honest fixtures for the operator dashboard. Every value here is synthetic —
// no real device serial, no real call, no real provider key. The dashboard reads
// these as if a backend existed; they are clearly labeled FIXTURE so no one
// mistakes them for live gateway data.

export const MODE = 'fixture'; // ponytail: single source of truth for fixture-mode labeling

export const overview = {
  mode: MODE,
  gateway: {
    status: 'disconnected',
    reason: 'no USB device enrolled (fixture)',
    qualifiedDevice: {
      model: 'Xiaomi POCO M2 Pro',
      board: 'gram',
      soc: 'atoll',
      rom: 'lineage_miatoll',
      android: 'Android 15 / API 35',
      magisk: '30.7',
      selinux: 'Enforcing',
      fingerprintMatch: true,
    },
  },
  transport: { type: 'usb-adb-forward', hostPort: 27180, phonePort: 27180, connected: false },
  activeCalls: 0,
  today: { inbound: 3, outbound: 1, failed: 0 },
};

export const mcp = {
  mode: MODE,
  server: { running: false, endpoint: '127.0.0.1:27181', clients: [] },
  setup: { enrolled: false, controllerLease: 'none', authenticated: false },
  tools: [
    { name: 'phone.status', kind: 'resource', safe: true, description: 'Gateway + active call state' },
    { name: 'phone.dial', kind: 'tool', safe: false, gated: true, description: 'Place an outbound GSM call (policy-gated)' },
    { name: 'phone.answer', kind: 'tool', safe: true, description: 'Answer an incoming call' },
    { name: 'phone.reject', kind: 'tool', safe: true, description: 'Reject an incoming call' },
    { name: 'phone.hangup', kind: 'tool', safe: true, description: 'Hang up the active call' },
    { name: 'phone.send_dtmf', kind: 'tool', safe: true, description: 'Send DTMF tones' },
    { name: 'phone.speak', kind: 'tool', safe: true, description: 'Speak bounded agent text into the matching active call' },
  ],
  recentCalls: [
    { ts: '2026-07-19T22:13:15Z', tool: 'phone.status', ok: true, ms: 4 },
    { ts: '2026-07-19T22:13:20Z', tool: 'phone.answer', ok: true, ms: 12 },
    { ts: '2026-07-19T22:13:40Z', tool: 'phone.send_dtmf', ok: true, ms: 8 },
  ],
};

export const android = {
  mode: MODE,
  adb: { connected: false, deviceSerial: 'fixture0001', authorized: false, forwardActive: false },
  device: overview.gateway.qualifiedDevice,
  app: {
    package: 'com.callagent.gateway',
    versionName: '0.1.0-fixture',
    foreground: false,
    permissions: ['RECORD_AUDIO', 'CAPTURE_AUDIO_OUTPUT', 'MODIFY_AUDIO_ROUTING', 'MODIFY_PHONE_STATE'],
  },
  protocol: {
    version: 1,
    pcm: { encoding: 'PCM16-LE', rate: 16000, channels: 1, frameMs: 20, frameBytes: 640 },
    queueBound: 256,
    metrics: { seqGaps: 0, overruns: 0, underruns: 0, latencyMs: 0 },
  },
  audioRoute: {
    uplink: { device: 'incall_music_uplink2', dest: 'voice-tx', active: false },
    downlink: { source: 'VOICE_DOWNLINK', route: 'incall-rec-downlink', active: false },
  },
};

// Provider configs. Secrets are write-only: the fixture stores a placeholder
// marker, never a real key. The UI never receives the real value.
export const stt = {
  mode: MODE,
  provider: 'none',
  model: '',
  language: 'en-US',
  voice: '',
  configured: false,
  apiKey: 'REDACTED', // write-only: a stored key may be present but is never returned
};

export const tts = {
  mode: MODE,
  provider: 'none',
  model: '',
  voice: '',
  language: 'en-US',
  speed: 1.0,
  configured: false,
  apiKey: 'REDACTED',
};

// Live call console — a synthetic ringing call.
export const liveCall = {
  mode: MODE,
  callId: 'call-fixture-001',
  state: 'RINGING',
  direction: 'inbound',
  from: '+15551234567',
  to: '+15559999999',
  startedAt: '2026-07-19T22:13:00Z',
  transcript: [
    { role: 'caller', text: 'Hi, is this the support line?', ts: '2026-07-19T22:13:05Z' },
    { role: 'agent', text: 'Yes, how can I help?', ts: '2026-07-19T22:13:07Z' },
  ],
  vad: { speaking: false, level: 0.0 },
  bargeIn: { enabled: true, lastTrigger: null },
  callerMemory: {
    summary: 'Fixture caller. No prior history.',
    lastSeen: null,
    tags: ['first-contact'],
  },
};

export const callHistory = {
  mode: MODE,
  calls: [
    {
      id: 'call-fixture-001',
      direction: 'inbound',
      from: '+15551234567',
      to: '+15559999999',
      startedAt: '2026-07-19T22:13:00Z',
      durationSec: 0,
      state: 'RINGING',
      consent: false,
      completeness: 0.0,
      recorded: false,
      hash: 'sha256:f4a3...fixture',
      retained: false,
    },
    {
      id: 'call-fixture-000',
      direction: 'outbound',
      from: '+15559999999',
      to: '+15551234567',
      startedAt: '2026-07-19T18:02:00Z',
      durationSec: 184,
      state: 'COMPLETED',
      consent: true,
      completeness: 1.0,
      recorded: true,
      hash: 'sha256:9b1c...fixture',
      retained: true,
      retentionDays: 30,
      retentionExpired: false,
    },
  ],
};

export const callDetail = (id) => {
  const c = callHistory.calls.find((x) => x.id === id) || callHistory.calls[0];
  return {
    mode: MODE,
    call: c,
    audio: {
      remote: { present: c.recorded, format: 'PCM16-LE 16kHz mono', bytes: c.recorded ? 1024 : 0 },
      agent: { present: c.recorded, format: 'PCM16-LE 16kHz mono', bytes: c.recorded ? 512 : 0 },
      mixed: { present: c.recorded, format: 'PCM16-LE 16kHz mono', bytes: c.recorded ? 1536 : 0 },
    },
    transcript: [
      { role: 'caller', text: 'Fixture transcript line one.', ts: c.startedAt },
      { role: 'agent', text: 'Fixture response.', ts: c.startedAt },
    ],
    consent: { recorded: c.consent, at: c.consent ? c.startedAt : null },
    completeness: c.completeness,
    hash: c.hash,
    retention: { days: c.retentionDays ?? 30, expired: c.retentionExpired ?? false },
    policy: {
      recordingEnabled: c.recorded,
      consentRecorded: c.consent,
      completeness: c.completeness,
      retentionExpired: c.retentionExpired ?? false,
      allowlist: ['+15551234567'],
      denylist: [],
      blockPremium: true,
      blockEmergency: true,
      autoDialEnabled: false,
    },
  };
};

export const storage = {
  mode: MODE,
  recording: { enabled: false, defaultOn: false, retentionDays: 30, consentRequired: true },
  health: {
    diskFreeBytes: 8n * 1024n * 1024n * 1024n, // ponytail: BigInt keeps >2GB honest
    diskTotalBytes: 16n * 1024n * 1024n * 1024n,
    lastWriteOk: true,
    corruption: false,
  },
  settings: {
    autoDeleteExpired: true,
    redactNumbersByDefault: true,
    exportRequiresConsent: true,
  },
};

export const fixtures = {
  overview,
  mcp,
  android,
  stt,
  tts,
  liveCall,
  callHistory,
  callDetail,
  storage,
  MODE,
};
