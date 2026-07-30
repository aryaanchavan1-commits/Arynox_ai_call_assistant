#!/usr/bin/env node

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { GatewayRpcClient, MAX_LINE_BYTES } from './gateway-rpc.js';
import {
  contextualAcknowledgement,
  contextualAcknowledgementFollowUp,
} from './conversation-phrases.js';
import { rpcSocketFromEnv } from './runtime-config.js';

export {
  contextualAcknowledgement,
  contextualAcknowledgementFollowUp,
} from './conversation-phrases.js';

export const JSONRPC_ERROR = Object.freeze({
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
});

const PROTOCOL_VERSION = '2024-11-05';
const E164_RE = /^\+[1-9]\d{5,14}$/;
const DTMF_RE = /^[0-9*#A-D]{1,32}$/;
const ID_SCHEMA = Object.freeze({ type: 'string', minLength: 1, maxLength: 128 });
const CALL_ID_SCHEMA = Object.freeze({ type: 'string', minLength: 1, maxLength: 128 });
const RESPONSE_TEXT_SCHEMA = Object.freeze({ type: 'string', minLength: 1, maxLength: 4000 });
const EMPTY_SCHEMA = Object.freeze({ type: 'object', properties: {}, additionalProperties: false });
const MAX_RESOURCE_EVENTS = 100;
const DEFAULT_TURN_WAIT_MS = 30_000;
const MIN_TURN_WAIT_MS = 250;
const MAX_TURN_WAIT_MS = 30_000;
const DEFAULT_ACKNOWLEDGEMENT_DELAY_MS = 250;
const DEFAULT_ACKNOWLEDGEMENT_FOLLOW_UP_DELAY_MS = 2_200;
const DEFAULT_ACKNOWLEDGEMENT_INTERVAL_MS = 8_000;
const DEFAULT_COMPLETE_TURN_SETTLE_MS = 250;
const DEFAULT_INCOMPLETE_TURN_SETTLE_MS = 600;
const DEFAULT_FRAGMENT_TURN_SETTLE_MS = 900;
const DEFAULT_DIAL_CORRELATION_TIMEOUT_MS = 5_000;
const DEFAULT_DIAL_CORRELATION_POLL_MS = 25;
const DEFAULT_OPENING_MEDIA_STABILIZATION_MS = 250;
const DEFAULT_OPENING_READY_TIMEOUT_MS = 5_000;
const DEFAULT_OPENING_READY_POLL_MS = 50;
const BOOLEAN = 'boolean';
const NUMBER = 'number';
const identifier = (maxLength = 128) => Object.freeze({ identifier: maxLength });
const oneOf = (...values) => Object.freeze({ oneOf: new Set(values) });
const text = (maxLength) => Object.freeze({ text: maxLength });
const listOf = (schema, maxItems = MAX_RESOURCE_EVENTS) => Object.freeze({ listOf: schema, maxItems });
const language = Object.freeze({ language: true });
const REALTIME_PROVIDER = oneOf('openai', 'elevenlabs', 'supertonic');
const REALTIME_MODEL = oneOf(
  'gpt-4o-transcribe', 'gpt-4o-mini-transcribe', 'gpt-4o-mini-transcribe-2025-12-15',
  'whisper-1', 'scribe_v2_realtime', 'supertonic-3', 'eleven_flash_v2_5',
  'eleven_multilingual_v2', 'eleven_v3', 'gpt-4o-mini-tts-2025-12-15',
  'gpt-4o-mini-tts', 'tts-1', 'tts-1-hd',
);
const hex = Object.freeze({ hex: true });
const digits = Object.freeze({ digits: true });
const timestamp = Object.freeze({ timestamp: true });
const TOOL_NAME = oneOf(
  'status', 'capabilities', 'wait_for_incoming_call', 'wait_for_turn',
  'dial', 'prepare_speech', 'answer', 'reject', 'hangup', 'send_dtmf', 'speak',
);
const IDENTITY = oneOf('HARDWARE', 'SIMULATOR');
const GATEWAY_STATE = oneOf('stopped', 'connecting', 'running');
const COPY_STATE = oneOf('unavailable', 'ready', 'syncing', 'stored', 'failed');
const CALL_STATE = oneOf('idle', 'ringing', 'dialing', 'active', 'ending', 'ended');
const DEVICE_PHASE = oneOf('disconnected', 'authorizing', 'ready', 'simulator');
const CALL_PHASE = oneOf('ringing', 'dialing', 'active', 'ending', 'ended');
const CALL_DIRECTION = oneOf('incoming', 'outgoing');
const PHONE_SYNC_STATE = oneOf('never', 'syncing', 'ready', 'offline', 'unsupported');
const EVENT = oneOf(
  'incoming', 'capabilities', 'ringing', 'dialing', 'active', 'ending', 'ended', 'dtmf',
  'error', 'media_failure', 'transcript_final', 'recording_artifact_stored', 'recording_artifact_failed',
);
const PUBLIC_REASON = oneOf(
  'ok', 'unavailable', 'negotiated', 'recording_sync_v1 negotiated', 'phone capability not negotiated',
  'phone disconnected', 'phone copy failed', 'recording not initialized', 'recording unavailable',
  'insufficient recording storage', 'recording preflight failed', 'recording health failed',
  'recording session acknowledgement failed', 'recording write failed', 'recording finalization failed',
  'realtime not initialized', 'realtime unavailable', 'realtime provider unavailable',
  'speech provider unavailable',
  'realtime start failed', 'realtime close failed', 'credential unavailable',
  'models endpoint unavailable', 'configured model cannot synthesize speech',
  'health endpoint unavailable', 'unexpected model or sample rate',
  'stale caller turn',
  'call not available for speech preparation',
  'opening speech unavailable',
  'dial disabled by default', 'emergency destination blocked', 'destination denied',
  'destination not explicitly allowed', 'premium destination blocked', 'international destination blocked',
  'manual approval required', 'destination cooldown active', 'global dial rate exceeded',
  'operation aborted', 'gateway unavailable', 'gateway timed out', 'gateway request failed',
  'invalid gateway response',
);
const CALL_HISTORY_RECEIPT = Object.freeze({
  callId: identifier(), startedAt: timestamp, endedAt: timestamp, direction: CALL_DIRECTION,
  outcome: identifier(64), summary: text(1_000), transcript: text(4_000), recordingId: identifier(),
});
const CALLER_CONTEXT_RECEIPT = Object.freeze({
  summary: text(1_000), language, voice: identifier(),
  facts: listOf(text(256), 8), followUps: listOf(text(256), 8),
  history: listOf(CALL_HISTORY_RECEIPT, 8),
});
const CALLER_RECEIPT = Object.freeze({
  found: BOOLEAN,
  callerId: hex,
  consent: { memory: BOOLEAN, expiresAt: timestamp },
  context: CALLER_CONTEXT_RECEIPT,
});
const STATUS_RECEIPT = Object.freeze({
  identity: IDENTITY,
  simulator: BOOLEAN,
  state: GATEWAY_STATE,
  device: { connected: BOOLEAN, authenticated: BOOLEAN, transport: oneOf('usb', 'simulator'), phase: DEVICE_PHASE },
  recording: { healthy: BOOLEAN, active: BOOLEAN, enabled: BOOLEAN, reason: PUBLIC_REASON },
  phoneRecordingCopy: { state: COPY_STATE, reason: PUBLIC_REASON, enabled: BOOLEAN, active: BOOLEAN },
  realtime: {
    healthy: BOOLEAN, active: BOOLEAN, enabled: BOOLEAN, reason: PUBLIC_REASON,
    provider: REALTIME_PROVIDER, model: REALTIME_MODEL, language,
  },
  currentCall: {
    callId: identifier(), phase: CALL_PHASE, state: CALL_STATE, direction: CALL_DIRECTION,
    contactName: text(128), caller: CALLER_RECEIPT,
  },
  metrics: {
    commandsSent: NUMBER, commandsDenied: NUMBER, idempotencyReplays: NUMBER,
    incoming: NUMBER, events: NUMBER, eventsReceived: NUMBER, malformedDeviceMessages: NUMBER, droppedSends: NUMBER,
    recordingsStarted: NUMBER, recordingsFinalized: NUMBER, recordingFailures: NUMBER,
    realtimeFailures: NUMBER, copiesAttempted: NUMBER, copiesCompleted: NUMBER, copiesFailed: NUMBER,
  },
});
const CAPABILITIES_RECEIPT = Object.freeze({
  identity: IDENTITY,
  simulator: BOOLEAN,
  tools: [TOOL_NAME],
  transport: oneOf('stdio'),
  protocolVersion: oneOf(PROTOCOL_VERSION),
  framing: { kinds: [oneOf('CONTROL', 'EVENT')], directions: [oneOf('HOST_TO_DEVICE', 'DEVICE_TO_HOST')] },
  policy: { dialEnabled: BOOLEAN, manualApprovalRequired: BOOLEAN, maxCallDurationMs: NUMBER },
});
const EVENT_RECEIPT = Object.freeze({
  event: EVENT, callId: identifier(), phase: CALL_PHASE, state: CALL_STATE, direction: CALL_DIRECTION,
  speaker: oneOf('remote', 'agent'), complete: BOOLEAN, final: BOOLEAN, language, text: text(4_000),
  contactName: text(128), caller: CALLER_RECEIPT,
  agentAnswering: { enabled: BOOLEAN, instructions: text(2_000) },
});
const MUTATION_RECEIPT = Object.freeze({
  accepted: BOOLEAN,
  callId: identifier(),
  destination: { hash: hex, last4: digits },
  reason: PUBLIC_REASON,
});
const DIAL_RECEIPT = Object.freeze({
  ...MUTATION_RECEIPT,
  nextAction: oneOf('wait_for_turn'),
  afterSequence: NUMBER,
});
const PREPARE_RECEIPT = Object.freeze({
  accepted: BOOLEAN,
  callId: identifier(),
  queued: NUMBER,
  reason: PUBLIC_REASON,
});
const WAIT_RECEIPT = Object.freeze({
  status: oneOf('turn', 'timeout', 'ended'),
  callId: identifier(),
  sequence: NUMBER,
  speaker: oneOf('remote'),
  text: text(4_000),
  previousCallerText: text(4_000),
  interruptedAgentText: text(4_000),
  complete: BOOLEAN,
  language,
  contactName: text(128),
  caller: CALLER_RECEIPT,
  preparedReplySpoken: BOOLEAN,
  preparedReplyText: text(240),
  preparedReplyInterrupted: BOOLEAN,
});
const INCOMING_WAIT_RECEIPT = Object.freeze({
  status: oneOf('incoming', 'timeout', 'disabled'),
  sequence: NUMBER,
  callId: identifier(),
  contactName: text(128),
  caller: CALLER_RECEIPT,
  instructions: text(2_000),
});
const PHONE_DATA_STATUS_RECEIPT = Object.freeze({
  contacts: { state: PHONE_SYNC_STATE, count: NUMBER, syncedAt: timestamp },
  callLog: { state: PHONE_SYNC_STATE, count: NUMBER, syncedAt: timestamp },
});
const RESOURCE_RECEIPTS = Object.freeze({
  'agentcall://gateway/status': STATUS_RECEIPT,
  'agentcall://gateway/capabilities': CAPABILITIES_RECEIPT,
  'agentcall://calls/current': EVENT_RECEIPT,
  'agentcall://events/recent': { events: [EVENT_RECEIPT] },
  'agentcall://phone-data/status': PHONE_DATA_STATUS_RECEIPT,
});
const CREDENTIAL_KEYWORD = /(?:bearer|token|secret|credential|authorization|api[_-]?key)/i;
const OPENAI_CREDENTIAL = /^sk-(?:proj-)?[A-Za-z0-9_-]{16,}$/;
const GITHUB_CREDENTIAL = /^gh[pousr]_[A-Za-z0-9]{16,}$/;
const SLACK_CREDENTIAL = /^xox[baprs]-[A-Za-z0-9-]{16,}$/;
const JWT_CREDENTIAL = /^[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}$/;
const TOKEN_ALPHABET = /^[A-Za-z0-9_-]{40,}$/;
const EMBEDDED_CREDENTIAL = /(?:sk-(?:proj-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{16,}|xox[baprs]-[A-Za-z0-9-]{16,}|Bearer\s+[A-Za-z0-9._-]{16,})/i;
const IDENTIFIER_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const LANGUAGE_RE = /^[a-z]{2,3}(?:-[A-Z]{2})?$/;
const UTC_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function highEntropyToken(value) {
  if (!TOKEN_ALPHABET.test(value)) return false;
  const counts = new Map();
  for (const character of value) counts.set(character, (counts.get(character) ?? 0) + 1);
  const entropy = [...counts.values()].reduce((total, count) => {
    const probability = count / value.length;
    return total - probability * Math.log2(probability);
  }, 0);
  return entropy >= 3.5;
}

function credentialShaped(value) {
  return CREDENTIAL_KEYWORD.test(value) || OPENAI_CREDENTIAL.test(value)
    || GITHUB_CREDENTIAL.test(value) || SLACK_CREDENTIAL.test(value)
    || JWT_CREDENTIAL.test(value) || highEntropyToken(value);
}
const HEX_RE = /^[a-f0-9]{64}$/;
const DIGITS_RE = /^\d{1,4}$/;

export const RESOURCES = Object.freeze([
  { uri: 'agentcall://gateway/status', name: 'Gateway status', description: 'Redacted gateway state and counters.', mimeType: 'application/json' },
  { uri: 'agentcall://gateway/capabilities', name: 'Gateway capabilities', description: 'Semantic tools, policy gates, and protocol capabilities.', mimeType: 'application/json' },
  { uri: 'agentcall://calls/current', name: 'Current call', description: 'Most recent bounded semantic call state.', mimeType: 'application/json' },
  { uri: 'agentcall://events/recent', name: 'Recent events', description: 'Bounded redacted semantic event ledger.', mimeType: 'application/json' },
  { uri: 'agentcall://phone-data/status', name: 'Phone data status', description: 'Contacts and call-log synchronization state and counts without private rows.', mimeType: 'application/json' },
]);
const RESOURCE_URIS = new Set(RESOURCES.map(({ uri }) => uri));
const canonicalResourceUri = (uri) => uri;
const resourceUriAliases = (uri) => [uri];

function schemaValue(value, schema, depth = 0) {
  if (depth > 8) return undefined;
  if (value === null) return null;
  if (schema === BOOLEAN) return typeof value === 'boolean' ? value : undefined;
  if (schema === NUMBER) return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
  if (schema?.oneOf instanceof Set) return typeof value === 'string' && schema.oneOf.has(value) ? value : undefined;
  if (schema?.identifier) return typeof value === 'string' && value.length <= schema.identifier
      && IDENTIFIER_RE.test(value) && !credentialShaped(value) ? value : undefined;
  if (Number.isInteger(schema?.text)) return typeof value === 'string' && value.length > 0 && value.length <= schema.text
      && !value.includes('\0') && !EMBEDDED_CREDENTIAL.test(value) ? value : undefined;
  if (schema?.language === true) return typeof value === 'string' && LANGUAGE_RE.test(value) ? value : undefined;
  if (schema?.hex === true) return typeof value === 'string' && HEX_RE.test(value) ? value : undefined;
  if (schema?.digits === true) return typeof value === 'string' && DIGITS_RE.test(value) ? value : undefined;
  if (schema?.timestamp === true) return typeof value === 'string' && UTC_TIMESTAMP_RE.test(value) ? value : undefined;
  if (Array.isArray(schema)) {
    if (!Array.isArray(value)) return undefined;
    return value.slice(0, MAX_RESOURCE_EVENTS)
      .map((item) => schemaValue(item, schema[0], depth + 1))
      .filter((item) => item !== undefined);
  }
  if (schema?.listOf) {
    if (!Array.isArray(value)) return undefined;
    return value.slice(0, schema.maxItems)
      .map((item) => schemaValue(item, schema.listOf, depth + 1))
      .filter((item) => item !== undefined);
  }
  if (!isObject(value) || !isObject(schema)) return undefined;
  const result = {};
  for (const [key, childSchema] of Object.entries(schema)) {
    const clean = schemaValue(value[key], childSchema, depth + 1);
    if (clean !== undefined) result[key] = clean;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function exactResourceParams(params) {
  return isObject(params)
    && Object.keys(params).length === 1
    && typeof params.uri === 'string'
    && RESOURCE_URIS.has(params.uri);
}

function mutationSchema(properties, required) {
  return {
    type: 'object',
    properties: { ...properties, idempotencyKey: ID_SCHEMA },
    required: [...required, 'idempotencyKey'],
    additionalProperties: false,
  };
}

export const TOOLS = Object.freeze([
  { name: 'status', description: 'Return gateway state and metrics.', inputSchema: EMPTY_SCHEMA },
  { name: 'capabilities', description: 'Return gateway capabilities.', inputSchema: EMPTY_SCHEMA },
  {
    name: 'wait_for_incoming_call',
    description: 'Wait for an incoming call only when the user-enabled AI answering mode is active. Returns the saved receptionist context/instructions and consented caller context; call answer explicitly to accept it.',
    inputSchema: {
      type: 'object',
      properties: {
        afterSequence: { type: 'integer', minimum: 0 },
        timeoutMs: { type: 'integer', minimum: MIN_TURN_WAIT_MS, maximum: MAX_TURN_WAIT_MS },
      },
      required: ['afterSequence'],
      additionalProperties: false,
    },
  },
  {
    name: 'wait_for_turn',
    description: 'Wait efficiently for the next complete remote caller turn or call end. AgentCall immediately plays an exact warmed prepared reply when a strong caller-intent match exists; when preparedReplySpoken is true, do not call speak for that turn and immediately wait again. Pass autoPreparedReply false to disable this behavior. Otherwise, brief contextual acknowledgements may play while response generation is pending; pass autoAcknowledge false to disable them.',
    inputSchema: {
      type: 'object',
      properties: {
        callId: CALL_ID_SCHEMA,
        afterSequence: { type: 'integer', minimum: 0 },
        timeoutMs: { type: 'integer', minimum: MIN_TURN_WAIT_MS, maximum: MAX_TURN_WAIT_MS },
        autoAcknowledge: { type: 'boolean' },
        autoPreparedReply: { type: 'boolean' },
      },
      required: ['callId', 'afterSequence'],
      additionalProperties: false,
    },
  },
  {
    name: 'dial',
    description: 'Prepare the complete contextual opening in the selected voice, then place a manually approved, policy-gated, mandatory-recorded call. AgentCall waits for the exact new call and live recording/media before playing the opening once. Supply one to four likely complete replies so AgentCall can warm them while the phone rings. When a caller turn matches one, pass that exact prepared reply unchanged to speak so the cached audio is reused; generate a live reply only when none fits. After an accepted dial, do not finish the agent turn: immediately call wait_for_turn with the returned callId and afterSequence, then keep alternating wait_for_turn and speak until the call ends.',
    inputSchema: mutationSchema({
      destination: { type: 'string', pattern: '^\\+[1-9]\\d{5,14}$' },
      openingText: { type: 'string', minLength: 7, maxLength: 1_200 },
      preparedReplies: {
        type: 'array',
        minItems: 1,
        maxItems: 4,
        items: { type: 'string', minLength: 3, maxLength: 240 },
      },
      approved: { type: 'boolean', const: true },
      consent: {
        type: 'object',
        properties: {
          recorded: { type: 'boolean', const: true },
          policy: { type: 'string', minLength: 1, maxLength: 256 },
        },
        required: ['recorded', 'policy'],
        additionalProperties: false,
      },
    }, ['destination', 'openingText', 'preparedReplies', 'approved', 'consent']),
  },
  {
    name: 'prepare_speech',
    description: 'Queue up to four short, context-grounded candidate lines in the active TTS voice after a call starts dialing. This never speaks automatically. Prepare only likely greetings, acknowledgements, or follow-up questions; use a candidate only when the caller intent matches, otherwise generate a live reply.',
    inputSchema: {
      type: 'object',
      properties: {
        callId: CALL_ID_SCHEMA,
        texts: {
          type: 'array',
          minItems: 1,
          maxItems: 4,
          items: { type: 'string', minLength: 3, maxLength: 240 },
        },
      },
      required: ['callId', 'texts'],
      additionalProperties: false,
    },
  },
  { name: 'answer', description: 'Answer a call.', inputSchema: mutationSchema({ callId: CALL_ID_SCHEMA }, ['callId']) },
  { name: 'reject', description: 'Reject a call.', inputSchema: mutationSchema({ callId: CALL_ID_SCHEMA }, ['callId']) },
  { name: 'hangup', description: 'End a call.', inputSchema: mutationSchema({ callId: CALL_ID_SCHEMA }, ['callId']) },
  {
    name: 'send_dtmf',
    description: 'Send DTMF digits to a call.',
    inputSchema: mutationSchema({
      callId: CALL_ID_SCHEMA,
      digits: { type: 'string', minLength: 1, maxLength: 32, pattern: '^[0-9*#A-D]+$' },
    }, ['callId', 'digits']),
  },
  {
    name: 'speak',
    description: 'Speak a bounded agent response into the matching active consented call. Pass the wait_for_turn sequence so a response is rejected instead of speaking over a newer caller turn.',
    inputSchema: mutationSchema({
      callId: CALL_ID_SCHEMA,
      text: RESPONSE_TEXT_SCHEMA,
      respondingToSequence: { type: 'integer', minimum: 0 },
    }, ['callId', 'text']),
  },
]);

function error(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function boundedString(value, maxLength = 128) {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength;
}

function validRequestId(id) {
  return id === undefined || id === null
    || (typeof id === 'string' && id.length > 0 && id.length <= 128)
    || (typeof id === 'number' && Number.isSafeInteger(id));
}

function publicReceipt(name, value) {
  const schema = name === 'status' ? STATUS_RECEIPT
    : (name === 'capabilities' ? CAPABILITIES_RECEIPT
      : (name === 'wait_for_turn' ? WAIT_RECEIPT
        : (name === 'wait_for_incoming_call' ? INCOMING_WAIT_RECEIPT
          : (name === 'prepare_speech' ? PREPARE_RECEIPT
            : (name === 'dial' ? DIAL_RECEIPT : MUTATION_RECEIPT)))));
  return schemaValue(value, schema);
}

function callToolResult(value, isError = false) {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    isError,
  };
}

function publicGatewayFailure(problem) {
  const code = String(problem?.code ?? '').toUpperCase();
  const message = String(problem?.message ?? '').toLowerCase();
  if (code === 'ABORT_ERR' || message.includes('aborted')) return 'operation aborted';
  if (code === 'ETIMEDOUT' || message.includes('timed out')) return 'gateway timed out';
  if (['ENOENT', 'ECONNREFUSED', 'ECONNRESET', 'EPIPE'].includes(code)
      || message.includes('connection closed') || message.includes('socket hang up')) {
    return 'gateway unavailable';
  }
  if (code === 'INVALID_RPC_RESPONSE' || message.includes('invalid rpc response')
      || message.includes('response id mismatch') || message.includes('response too large')) {
    return 'invalid gateway response';
  }
  return 'gateway request failed';
}

function failedToolResult(problem) {
  return callToolResult({ accepted: false, reason: publicGatewayFailure(problem) }, true);
}

function validateArguments(name, value) {
  if (!isObject(value)) return 'arguments must be an object';
  const allowed = {
    status: [], capabilities: [], dial: [
      'approved', 'consent', 'destination', 'openingText', 'preparedReplies', 'idempotencyKey',
    ],
    prepare_speech: ['callId', 'texts'],
    wait_for_incoming_call: ['afterSequence', 'timeoutMs'],
    wait_for_turn: ['callId', 'afterSequence', 'timeoutMs', 'autoAcknowledge', 'autoPreparedReply'],
    answer: ['callId', 'idempotencyKey'], reject: ['callId', 'idempotencyKey'],
    hangup: ['callId', 'idempotencyKey'], send_dtmf: ['callId', 'digits', 'idempotencyKey'],
    speak: ['callId', 'text', 'respondingToSequence', 'idempotencyKey'],
  }[name];
  if (!allowed) return 'unknown tool';
  if (Object.keys(value).some((key) => !allowed.includes(key))) return 'unknown argument';
  if (name === 'status' || name === 'capabilities') return null;
  if (name === 'prepare_speech') {
    if (!boundedString(value.callId) || !Array.isArray(value.texts)
        || value.texts.length < 1 || value.texts.length > 4
        || value.texts.some((item) => !boundedString(item, 240)
          || /[\u0000-\u001f\u007f]/u.test(item) || EMBEDDED_CREDENTIAL.test(item))) {
      return 'callId and one to four bounded speech candidates are required';
    }
    return null;
  }
  if (name === 'wait_for_incoming_call') {
    if (!Number.isSafeInteger(value.afterSequence) || value.afterSequence < 0) {
      return 'afterSequence must be a nonnegative safe integer';
    }
    if (value.timeoutMs !== undefined
        && (!Number.isSafeInteger(value.timeoutMs)
          || value.timeoutMs < MIN_TURN_WAIT_MS || value.timeoutMs > MAX_TURN_WAIT_MS)) {
      return `timeoutMs must be an integer from ${MIN_TURN_WAIT_MS} to ${MAX_TURN_WAIT_MS}`;
    }
    return null;
  }
  if (name === 'wait_for_turn') {
    if (!boundedString(value.callId)) return 'callId must be a nonempty string up to 128 characters';
    if (!Number.isSafeInteger(value.afterSequence) || value.afterSequence < 0) {
      return 'afterSequence must be a nonnegative safe integer';
    }
    if (value.timeoutMs !== undefined
        && (!Number.isSafeInteger(value.timeoutMs)
          || value.timeoutMs < MIN_TURN_WAIT_MS || value.timeoutMs > MAX_TURN_WAIT_MS)) {
      return `timeoutMs must be an integer from ${MIN_TURN_WAIT_MS} to ${MAX_TURN_WAIT_MS}`;
    }
    if (value.autoAcknowledge !== undefined && typeof value.autoAcknowledge !== 'boolean') {
      return 'autoAcknowledge must be a boolean';
    }
    if (value.autoPreparedReply !== undefined && typeof value.autoPreparedReply !== 'boolean') {
      return 'autoPreparedReply must be a boolean';
    }
    return null;
  }
  if (!boundedString(value.idempotencyKey)) return 'idempotencyKey must be a nonempty string up to 128 characters';
  if (name === 'dial') {
    if (!E164_RE.test(value.destination)) return 'destination must be strict E.164';
    if (value.approved !== true) return 'manual approval is required';
    if (!boundedString(value.openingText, 1_200)
        || value.openingText.length < 7
        || /[\u0000-\u001f\u007f]/u.test(value.openingText)
        || EMBEDDED_CREDENTIAL.test(value.openingText)) {
      return 'a bounded complete opening is required before dialing';
    }
    if (!Array.isArray(value.preparedReplies)
        || value.preparedReplies.length < 1 || value.preparedReplies.length > 4
        || value.preparedReplies.some((item) => !boundedString(item, 240)
          || /[\u0000-\u001f\u007f]/u.test(item) || EMBEDDED_CREDENTIAL.test(item))) {
      return 'one to four bounded expected replies are required before dialing';
    }
    if (!isObject(value.consent)
        || Object.keys(value.consent).length !== 2
        || !Object.hasOwn(value.consent, 'recorded')
        || !Object.hasOwn(value.consent, 'policy')
        || value.consent.recorded !== true
        || !boundedString(value.consent.policy, 256)) {
      return 'explicit recording consent is required';
    }
    return null;
  }
  if (!boundedString(value.callId)) return 'callId must be a nonempty string up to 128 characters';
  if (name === 'send_dtmf' && !DTMF_RE.test(value.digits)) return 'digits must match [0-9*#A-D] and contain at most 32 characters';
  if (name === 'speak' && !boundedString(value.text, 4_000)) return 'text must be a nonempty string up to 4000 characters';
  if (name === 'speak' && value.respondingToSequence !== undefined
      && (!Number.isSafeInteger(value.respondingToSequence) || value.respondingToSequence < 0)) {
    return 'respondingToSequence must be a nonnegative safe integer';
  }
  return null;
}

export function mergeTranscriptFragments(values) {
  const merged = [];
  const normalized = (value) => value
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}' ]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  const attentionCheck = (value) => /^(?:(?:hello|hi|hey|yes)(?: (?:hello|hi|hey|yes)){0,7}|hello please speak|please speak|are you there|can you hear me|are you listening|still there)$/u
    .test(normalized(value));
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const fragment = value.trim();
    if (!fragment) continue;
    const previous = merged.at(-1);
    if (!previous) {
      merged.push(fragment);
      continue;
    }
    const a = normalized(previous);
    const b = normalized(fragment);
    if (a === b || b.startsWith(a)) {
      merged[merged.length - 1] = fragment.length >= previous.length ? fragment : previous;
    } else if (attentionCheck(previous) && attentionCheck(fragment)) {
      merged[merged.length - 1] = fragment.length >= previous.length ? fragment : previous;
    } else if (!a.startsWith(b)) {
      merged.push(fragment);
    }
  }
  return merged.join(' ').slice(0, 4_000);
}

export class McpHandler {
  constructor(gateway, {
    notify = () => {},
    acknowledgementDelayMs = DEFAULT_ACKNOWLEDGEMENT_DELAY_MS,
    acknowledgementFollowUpDelayMs = DEFAULT_ACKNOWLEDGEMENT_FOLLOW_UP_DELAY_MS,
    acknowledgementIntervalMs = DEFAULT_ACKNOWLEDGEMENT_INTERVAL_MS,
    completeTurnSettleMs = DEFAULT_COMPLETE_TURN_SETTLE_MS,
    incompleteTurnSettleMs = DEFAULT_INCOMPLETE_TURN_SETTLE_MS,
    fragmentTurnSettleMs = DEFAULT_FRAGMENT_TURN_SETTLE_MS,
    dialCorrelationTimeoutMs = DEFAULT_DIAL_CORRELATION_TIMEOUT_MS,
    dialCorrelationPollMs = DEFAULT_DIAL_CORRELATION_POLL_MS,
    openingMediaStabilizationMs = DEFAULT_OPENING_MEDIA_STABILIZATION_MS,
    openingReadyTimeoutMs = DEFAULT_OPENING_READY_TIMEOUT_MS,
    openingReadyPollMs = DEFAULT_OPENING_READY_POLL_MS,
  } = {}) {
    this.gateway = gateway;
    this.notify = notify;
    this.subscriptions = new Set();
    this.currentCall = null;
    this.events = [];
    this.turnSequence = 0;
    this.turnEvents = [];
    this.turnWaiters = new Set();
    this.incomingSequence = 0;
    this.incomingEvents = [];
    this.incomingWaiters = new Set();
    this.pendingRemoteTurns = new Map();
    this.lastRemoteTurnByCall = new Map();
    this.interruptedAgentByCall = new Map();
    this.pendingAcknowledgement = null;
    this.lastAcknowledgementAt = 0;
    this.lastAcknowledgementCallId = null;
    this.acknowledgementVariantByCall = new Map();
    this.preparedOpenings = new Map();
    this.preparedOpeningCallIds = new Set();
    this.preparedRepliesByCall = new Map();
    this.acknowledgementDelayMs = acknowledgementDelayMs;
    this.acknowledgementFollowUpDelayMs = acknowledgementFollowUpDelayMs;
    this.acknowledgementIntervalMs = acknowledgementIntervalMs;
    this.completeTurnSettleMs = completeTurnSettleMs;
    this.incompleteTurnSettleMs = incompleteTurnSettleMs;
    this.fragmentTurnSettleMs = fragmentTurnSettleMs;
    this.dialCorrelationTimeoutMs = dialCorrelationTimeoutMs;
    this.dialCorrelationPollMs = dialCorrelationPollMs;
    this.openingMediaStabilizationMs = openingMediaStabilizationMs;
    this.openingReadyTimeoutMs = openingReadyTimeoutMs;
    this.openingReadyPollMs = openingReadyPollMs;
    this._capture = (value) => {
      const clean = schemaValue(value, EVENT_RECEIPT);
      if (!clean || Object.keys(clean).length === 0) return;
      this.events.push(clean);
      while (this.events.length > MAX_RESOURCE_EVENTS) this.events.shift();
      if (typeof clean.callId === 'string') {
        if (clean.event === 'ended' && this.currentCall?.callId === clean.callId) {
          this.currentCall = null;
        } else {
          const phase = CALL_PHASE.oneOf.has(clean.event) ? clean.event : clean.phase;
          this.currentCall = this.currentCall?.callId === clean.callId
            ? { ...this.currentCall, ...clean, ...(phase ? { phase } : {}) }
            : { ...clean, ...(phase ? { phase } : {}) };
        }
      }
      if (clean.event === 'incoming' && clean.agentAnswering?.enabled === true
          && typeof clean.callId === 'string') {
        this._publishIncoming({
          status: 'incoming',
          callId: clean.callId,
          contactName: clean.contactName,
          caller: clean.caller,
          instructions: clean.agentAnswering.instructions,
        });
      }
      if (clean.event === 'transcript_final' && clean.speaker === 'remote'
          && typeof clean.text === 'string') {
        this._queueRemoteTurn({
          ...clean,
          contactName: clean.contactName ?? this.currentCall?.contactName,
          caller: clean.caller ?? this.currentCall?.caller,
          status: 'turn',
        });
      } else if (clean.event === 'transcript_final' && clean.speaker === 'agent'
          && clean.complete === false && typeof clean.text === 'string') {
        this.interruptedAgentByCall.set(clean.callId, clean.text);
      } else if (clean.event === 'ended' && typeof clean.callId === 'string') {
        this._cancelPreparedOpening(clean.callId);
        this._flushRemoteTurn(clean.callId);
        this._publishTurn({ status: 'ended', callId: clean.callId });
        this.lastRemoteTurnByCall.delete(clean.callId);
        this.interruptedAgentByCall.delete(clean.callId);
        this.acknowledgementVariantByCall.delete(clean.callId);
        this.preparedRepliesByCall.delete(clean.callId);
      }
      if (clean.event === 'active' && clean.direction === 'outgoing'
          && typeof clean.callId === 'string') {
        this._schedulePreparedOpening(clean.callId);
      }
      this._updated('agentcall://events/recent');
      if (typeof clean.callId === 'string') this._updated('agentcall://calls/current');
    };
    if (typeof gateway.on === 'function') {
      gateway.on('incoming', this._capture);
      gateway.on('event', this._capture);
    }
  }

  _queueRemoteTurn(value) {
    const pending = this.pendingRemoteTurns.get(value.callId) ?? {
      callId: value.callId,
      fragments: [],
      latest: value,
      timer: null,
    };
    pending.fragments.push(value.text);
    pending.latest = value;
    if (pending.timer) clearTimeout(pending.timer);
    const normalized = value.text.trim();
    const looksComplete = /[.!?]["')\]]?$/u.test(normalized);
    const standaloneShortTurn = /^(?:hi|hello|hey|yes|no|okay|ok|sure|right|correct|thanks|thank you|bye|goodbye)$/iu
      .test(normalized);
    const likelyFragment = !looksComplete && !standaloneShortTurn
      && normalized.split(/\s+/u).length === 1;
    const settleMs = (looksComplete || standaloneShortTurn)
      ? this.completeTurnSettleMs
      : (likelyFragment ? this.fragmentTurnSettleMs : this.incompleteTurnSettleMs);
    pending.timer = setTimeout(
      () => this._flushRemoteTurn(value.callId),
      settleMs,
    );
    this.pendingRemoteTurns.set(value.callId, pending);
  }

  _flushRemoteTurn(callId) {
    const pending = this.pendingRemoteTurns.get(callId);
    if (!pending) return;
    this.pendingRemoteTurns.delete(callId);
    if (pending.timer) clearTimeout(pending.timer);
    const text = mergeTranscriptFragments(pending.fragments);
    const previousCallerText = this.lastRemoteTurnByCall.get(callId);
    const interruptedAgentText = this.interruptedAgentByCall.get(callId);
    const turn = {
      ...pending.latest,
      text,
      ...(previousCallerText ? { previousCallerText } : {}),
      ...(interruptedAgentText ? { interruptedAgentText } : {}),
      status: 'turn',
    };
    this._publishTurn(turn);
    this.lastRemoteTurnByCall.set(callId, text);
    if (interruptedAgentText) this.interruptedAgentByCall.delete(callId);
  }

  _publishTurn(value) {
    const event = publicReceipt('wait_for_turn', { ...value, sequence: ++this.turnSequence });
    if (!event) return;
    const previous = this.turnEvents.at(-1);
    if (event.status === 'ended' && previous?.status === 'ended' && previous.callId === event.callId) {
      this.turnSequence--;
      return;
    }
    this.turnEvents.push(event);
    while (this.turnEvents.length > MAX_RESOURCE_EVENTS) this.turnEvents.shift();
    for (const waiter of [...this.turnWaiters]) {
      if (waiter.callId === event.callId && event.sequence > waiter.afterSequence) waiter.resolve(event);
    }
    if (event.status === 'ended') this._cancelAcknowledgement(event.callId);
  }

  _publishIncoming(value) {
    const event = publicReceipt('wait_for_incoming_call', {
      ...value,
      sequence: ++this.incomingSequence,
    });
    if (!event) return;
    this.incomingEvents.push(event);
    while (this.incomingEvents.length > MAX_RESOURCE_EVENTS) this.incomingEvents.shift();
    for (const waiter of [...this.incomingWaiters]) {
      if (event.sequence > waiter.afterSequence) waiter.resolve(event);
    }
  }

  _scheduleAcknowledgement(turn) {
    const previous = this.pendingAcknowledgement;
    this._cancelAcknowledgement(turn.callId);
    if (previous?.started) return;
    const variant = this.acknowledgementVariantByCall.get(turn.callId) ?? 0;
    const phrase = contextualAcknowledgement(turn.text, variant);
    if (!phrase) return;
    const followUp = contextualAcknowledgementFollowUp(turn.text);
    if (this.lastAcknowledgementCallId === turn.callId
        && Date.now() - this.lastAcknowledgementAt < this.acknowledgementIntervalMs) return;
    const pending = {
      callId: turn.callId,
      sequence: turn.sequence,
      timers: new Set(),
      active: Promise.resolve(),
      cancelled: false,
      started: false,
      queued: 0,
    };
    const fresh = () => {
      const latest = this.turnEvents.findLast(
        (event) => event.callId === turn.callId && event.status === 'turn',
      );
      return !pending.cancelled
        && !this.pendingRemoteTurns.has(turn.callId)
        && (!latest || latest.sequence <= turn.sequence);
    };
    const schedule = (text, delayMs, kind) => {
      if (!text) return;
      const timer = setTimeout(() => {
        pending.timers.delete(timer);
        if (!fresh()) return;
        pending.started = true;
        pending.queued += 1;
        pending.active = pending.active.then(async () => {
          if (!fresh()) return undefined;
          const receipt = await this.gateway.speak({
            callId: turn.callId,
            text,
            idempotencyKey: `mcp-ack-${kind}-${turn.sequence}-${Date.now().toString(36)}`,
          });
          if (receipt?.accepted === true && kind === 'primary') {
            this.lastAcknowledgementAt = Date.now();
            this.lastAcknowledgementCallId = turn.callId;
            this.acknowledgementVariantByCall.set(turn.callId, variant + 1);
          }
          return receipt;
        }).catch(() => undefined).finally(() => {
          pending.queued -= 1;
          if (pending.timers.size === 0 && pending.queued === 0
              && this.pendingAcknowledgement === pending) {
            this.pendingAcknowledgement = null;
          }
        });
      }, delayMs);
      timer.unref?.();
      pending.timers.add(timer);
    };
    schedule(phrase, this.acknowledgementDelayMs, 'primary');
    schedule(followUp, this.acknowledgementFollowUpDelayMs, 'follow-up');
    this.pendingAcknowledgement = pending;
  }

  async _cancelAcknowledgement(callId) {
    const pending = this.pendingAcknowledgement;
    if (!pending || (callId !== undefined && pending.callId !== callId)) return;
    this.pendingAcknowledgement = null;
    pending.cancelled = true;
    for (const timer of pending.timers) clearTimeout(timer);
    pending.timers.clear();
    await pending.active;
  }

  _cancelPreparedOpening(callId) {
    const pending = this.preparedOpenings.get(callId);
    if (pending?.timer) clearTimeout(pending.timer);
    this.preparedOpenings.delete(callId);
    this.preparedOpeningCallIds.delete(callId);
  }

  _schedulePreparedOpening(callId) {
    const pending = this.preparedOpenings.get(callId);
    if (!pending || pending.timer || pending.started) return;
    pending.started = true;
    pending.timer = setTimeout(async () => {
      pending.timer = null;
      if (this.preparedOpenings.get(callId) !== pending) return;
      const deadline = Date.now() + this.openingReadyTimeoutMs;
      let attempt = 0;
      while (this.preparedOpenings.get(callId) === pending && Date.now() < deadline) {
        const status = await this.gateway.status().catch(() => null);
        const current = status?.currentCall;
        const phase = String(current?.phase ?? current?.state).toLowerCase();
        if (current?.callId !== callId || ['ending', 'ended'].includes(phase)) break;
        const readinessReported = status?.recording?.active !== undefined
          || status?.realtime?.active !== undefined;
        const mediaReady = phase === 'active'
          && (!readinessReported
            || (status.recording?.active === true && status.realtime?.active === true));
        if (mediaReady) {
          attempt += 1;
          const receipt = await this.gateway.speak({
            callId,
            text: pending.text,
            interruptible: false,
            idempotencyKey: `${pending.idempotencyKey}-${attempt}`,
          }).catch(() => null);
          if (receipt?.accepted === true) {
            if (this.preparedOpenings.get(callId) === pending) {
              this.preparedOpenings.delete(callId);
            }
            return;
          }
          if (receipt?.reason !== 'realtime unavailable') break;
        }
        await new Promise((resolveDelay) => {
          setTimeout(resolveDelay, this.openingReadyPollMs);
        });
      }
      if (this.preparedOpenings.get(callId) === pending) this.preparedOpenings.delete(callId);
    }, this.openingMediaStabilizationMs);
    pending.timer.unref?.();
  }

  _preparedReplyForTurn(callId, callerText) {
    const prepared = this.preparedRepliesByCall.get(callId);
    if (!prepared) return null;
    const normalized = callerText.toLowerCase().replace(/[^\p{L}\p{N}' ]+/gu, ' ').replace(/\s+/gu, ' ').trim();
    const callerIntent = (() => {
      if (/\b(?:goodbye|bye|that(?:'s| is) all|will call back|i(?:'ll| will) call back)\b/u.test(normalized)) return 'closing';
      if (/\b(?:repeat|say (?:that|it) again|didn(?:'t| not) (?:hear|catch))\b/u.test(normalized)) return 'repeat';
      if (/\b(?:not found|haven(?:'t| not) found|couldn(?:'t| not) find|didn(?:'t| not) find)\b/u.test(normalized)) return 'negative';
      if (/\b(?:found|got|have)\b.{0,32}\b(?:location|place|address|details?|pin)\b/u.test(normalized)
          || /\b(?:yes|yeah|correct|right)\b/u.test(normalized)) return 'positive';
      return null;
    })();
    if (!callerIntent) return null;
    const replyIntent = (text) => {
      const candidate = text.toLowerCase();
      if (/\b(?:goodbye|bye|pass that along|thank you)\b/u.test(candidate)) return 'closing';
      if (/\b(?:repeat|say .* slowly)\b/u.test(candidate)) return 'repeat';
      if (/\b(?:no problem)\b/u.test(candidate)
          && /\b(?:find|look|call back)\b/u.test(candidate)) return 'negative';
      if (/\b(?:great|perfect|excellent)\b/u.test(candidate)
          && /\b(?:tell|share|send|exact|details?|map|location|place|area|landmark|pin)\b/u.test(candidate)) return 'positive';
      return null;
    };
    const index = prepared.replies.findIndex(
      (text, candidateIndex) => !prepared.used.has(candidateIndex) && replyIntent(text) === callerIntent,
    );
    return index < 0 ? null : { index, text: prepared.replies[index] };
  }

  async _finalizeWaitTurn(args, event, { signal } = {}) {
    if (event.status !== 'turn') return event;
    if (args.autoPreparedReply !== false) {
      const candidate = this._preparedReplyForTurn(event.callId, event.text);
      if (candidate) {
        await this._cancelAcknowledgement(event.callId);
        const receipt = await this.gateway.speak({
          callId: event.callId,
          text: candidate.text,
          idempotencyKey: `mcp-prepared-${event.sequence}-${candidate.index}`,
        }, { signal }).catch(() => null);
        if (receipt?.accepted === true) {
          this.preparedRepliesByCall.get(event.callId)?.used.add(candidate.index);
          return publicReceipt('wait_for_turn', {
            ...event,
            preparedReplySpoken: true,
            preparedReplyText: candidate.text,
            preparedReplyInterrupted: receipt.interrupted === true,
          });
        }
      }
    }
    if (args.autoAcknowledge !== false) this._scheduleAcknowledgement(event);
    return event;
  }

  async _waitForTurn(args, { signal } = {}) {
    const available = this.turnEvents.filter(
      (event) => event.callId === args.callId && event.sequence > args.afterSequence,
    );
    const last = available.at(-1);
    const turns = available.filter((event) => event.status === 'turn');
    const interrupted = turns.findLast((event) => event.interruptedAgentText);
    const existing = last?.status === 'ended'
      ? last
      : (turns.length === 0 ? undefined : {
        ...turns.at(-1),
        sequence: turns.at(-1).sequence,
        text: mergeTranscriptFragments(turns.map(({ text: value }) => value)),
        ...(interrupted ? { interruptedAgentText: interrupted.interruptedAgentText } : {}),
      });
    if (existing) {
      return this._finalizeWaitTurn(args, existing, { signal });
    }
    const timeoutMs = args.timeoutMs ?? DEFAULT_TURN_WAIT_MS;
    const event = await new Promise((resolve) => {
      let timer;
      const waiter = {
        callId: args.callId,
        afterSequence: args.afterSequence,
        resolve: (event) => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          this.turnWaiters.delete(waiter);
          resolve(event);
        },
      };
      const onAbort = () => waiter.resolve({
        status: 'timeout', callId: args.callId, sequence: args.afterSequence,
      });
      timer = setTimeout(() => waiter.resolve({
        status: 'timeout', callId: args.callId, sequence: args.afterSequence,
      }), timeoutMs);
      this.turnWaiters.add(waiter);
      if (signal?.aborted) onAbort();
      else signal?.addEventListener('abort', onAbort, { once: true });
    });
    return this._finalizeWaitTurn(args, event, { signal });
  }

  async _waitForIncomingCall(args, { signal } = {}) {
    const mode = await this.gateway.agentAnsweringStatus({ signal });
    if (mode?.enabled !== true) {
      return { status: 'disabled', sequence: args.afterSequence };
    }
    const existing = this.incomingEvents.findLast(
      (event) => event.sequence > args.afterSequence,
    );
    if (existing) return existing;
    const timeoutMs = args.timeoutMs ?? DEFAULT_TURN_WAIT_MS;
    return new Promise((resolve) => {
      let timer;
      const waiter = {
        afterSequence: args.afterSequence,
        resolve: (event) => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          this.incomingWaiters.delete(waiter);
          resolve(event);
        },
      };
      const onAbort = () => waiter.resolve({
        status: 'timeout', sequence: args.afterSequence,
      });
      timer = setTimeout(() => waiter.resolve({
        status: 'timeout', sequence: args.afterSequence,
      }), timeoutMs);
      this.incomingWaiters.add(waiter);
      if (signal?.aborted) onAbort();
      else signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  async _dial(args, { signal } = {}) {
    if (typeof this.gateway.prewarmSpeech !== 'function') {
      return { accepted: false, reason: 'opening speech unavailable' };
    }
    const opening = await this.gateway.prewarmSpeech({ text: args.openingText }, { signal })
      .catch(() => null);
    if (opening?.ready !== true) {
      return { accepted: false, reason: 'opening speech unavailable' };
    }
    const dialArgs = {
      destination: args.destination,
      approved: args.approved,
      consent: args.consent,
      idempotencyKey: args.idempotencyKey,
    };
    let receipt = await this.gateway.dial(dialArgs, { signal });
    if (receipt?.accepted !== true) return receipt;
    if (!boundedString(receipt.callId)) {
      const deadline = Date.now() + this.dialCorrelationTimeoutMs;
      do {
        const cachedPhase = String(
          this.currentCall?.phase ?? this.currentCall?.state ?? this.currentCall?.event,
        ).toLowerCase();
        let observed = this.currentCall?.direction === 'outgoing'
          && ['dialing', 'ringing', 'active'].includes(cachedPhase)
          ? this.currentCall
          : null;
        if (!observed) {
          observed = await this.gateway.status({ signal }).then((status) => status?.currentCall);
        }
        const observedPhase = String(
          observed?.phase ?? observed?.state ?? observed?.event,
        ).toLowerCase();
        if (observed?.direction === 'outgoing'
            && ['dialing', 'ringing', 'active'].includes(observedPhase)
            && boundedString(observed.callId)) {
          receipt = { ...receipt, callId: observed.callId };
          break;
        }
        if (signal?.aborted || Date.now() >= deadline) break;
        await new Promise((resolveDelay) => {
          setTimeout(resolveDelay, this.dialCorrelationPollMs);
        });
      } while (!signal?.aborted);
    }

    if (boundedString(receipt.callId) && !this.preparedOpeningCallIds.has(receipt.callId)) {
      this.preparedOpeningCallIds.add(receipt.callId);
      this.preparedOpenings.set(receipt.callId, {
        text: args.openingText,
        idempotencyKey: `mcp-opening-${args.idempotencyKey}`,
        timer: null,
        started: false,
      });
      const phase = String(this.currentCall?.phase ?? this.currentCall?.state).toLowerCase();
      if (this.currentCall?.callId === receipt.callId && phase === 'active') {
        this._schedulePreparedOpening(receipt.callId);
      }
    }
    const replies = [...args.preparedReplies];
    if (boundedString(receipt.callId)) {
      this.preparedRepliesByCall.set(receipt.callId, { replies, used: new Set() });
    }
    void (async () => {
      for (const text of replies) await this.gateway.prewarmSpeech({ text });
    })().catch(() => {});
    return {
      ...receipt,
      ...(boundedString(receipt.callId)
        ? { nextAction: 'wait_for_turn', afterSequence: 0 }
        : {}),
    };
  }

  _updated(uri) {
    for (const candidate of resourceUriAliases(uri)) {
      if (this.subscriptions.has(candidate)) this.notify({
        jsonrpc: '2.0',
        method: 'notifications/resources/updated',
        params: { uri: candidate },
      });
    }
  }

  async _resource(uri, { signal } = {}) {
    const canonicalUri = canonicalResourceUri(uri);
    const value = await {
      'agentcall://gateway/status': () => this.gateway.status({ signal }),
      'agentcall://gateway/capabilities': () => this.gateway.capabilities({ signal }),
      'agentcall://calls/current': () => this.currentCall ?? { state: 'idle' },
      'agentcall://events/recent': () => ({ events: this.events }),
      'agentcall://phone-data/status': () => this.gateway.phoneDataStatus({ signal }),
    }[canonicalUri]();
    return { contents: [{
      uri,
      mimeType: 'application/json',
      text: JSON.stringify(schemaValue(value, RESOURCE_RECEIPTS[canonicalUri])),
    }] };
  }

  async handle(message, { signal } = {}) {
    if (!isObject(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
      return error(null, JSONRPC_ERROR.INVALID_REQUEST, 'invalid JSON-RPC 2.0 request');
    }
    if (!validRequestId(message.id)) {
      return error(null, JSONRPC_ERROR.INVALID_REQUEST, 'request id must be a bounded scalar');
    }
    const { id, method, params } = message;
    const notification = id === undefined || id === null;
    const reply = (response) => notification ? undefined : response;

    if (method === 'initialize') {
      return reply({ jsonrpc: '2.0', id, result: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {}, resources: { subscribe: true, listChanged: false } },
        serverInfo: { name: 'agentcall-mcp', version: '1.0.0' },
      } });
    }
    if (method === 'notifications/initialized') return undefined;
    if (method === 'tools/list') return reply({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
    if (method === 'tools/call') {
      if (notification) return error(null, JSONRPC_ERROR.INVALID_REQUEST, 'tools/call requires a request id');
      return this._call(id, params, { signal });
    }
    if (method === 'resources/list') {
      if (params !== undefined && (!isObject(params) || Object.keys(params).length !== 0)) {
        return reply(error(id, JSONRPC_ERROR.INVALID_PARAMS, 'resources/list takes no parameters'));
      }
      return reply({ jsonrpc: '2.0', id, result: { resources: RESOURCES } });
    }
    if (method === 'resources/read') {
      if (!exactResourceParams(params)) return reply(error(id, JSONRPC_ERROR.INVALID_PARAMS, 'unknown or invalid resource'));
      return reply({ jsonrpc: '2.0', id, result: await this._resource(params.uri, { signal }) });
    }
    if (method === 'resources/subscribe') {
      if (!exactResourceParams(params)) return reply(error(id, JSONRPC_ERROR.INVALID_PARAMS, 'unknown or invalid resource'));
      this.subscriptions.add(params.uri);
      return reply({ jsonrpc: '2.0', id, result: {} });
    }
    if (method === 'resources/unsubscribe') {
      if (!exactResourceParams(params)) return reply(error(id, JSONRPC_ERROR.INVALID_PARAMS, 'unknown or invalid resource'));
      this.subscriptions.delete(params.uri);
      return reply({ jsonrpc: '2.0', id, result: {} });
    }
    return reply(error(id, JSONRPC_ERROR.METHOD_NOT_FOUND, `method not found: ${method}`));
  }

  async _call(id, params, { signal } = {}) {
    if (!isObject(params) || typeof params.name !== 'string') {
      return error(id, JSONRPC_ERROR.INVALID_PARAMS, 'invalid tools/call params');
    }
    const args = params.arguments ?? {};
    const problem = validateArguments(params.name, args);
    if (problem) return error(id, JSONRPC_ERROR.INVALID_PARAMS, problem);

    const methods = {
      status: () => this.gateway.status({ signal }),
      capabilities: async () => ({
        ...await this.gateway.capabilities({ signal }),
        tools: TOOLS.map(({ name }) => name),
      }),
      wait_for_incoming_call: () => this._waitForIncomingCall(args, { signal }),
      wait_for_turn: () => this._waitForTurn(args, { signal }),
      dial: () => this._dial(args, { signal }),
      prepare_speech: async () => {
        const status = await this.gateway.status({ signal });
        const current = status?.currentCall;
        if (current?.callId !== args.callId
            || !['dialing', 'ringing', 'active'].includes(String(current.phase ?? current.state).toLowerCase())
            || typeof this.gateway.prewarmSpeech !== 'function') {
          return {
            accepted: false,
            callId: args.callId,
            queued: 0,
            reason: 'call not available for speech preparation',
          };
        }
        const texts = [...args.texts];
        void (async () => {
          for (const text of texts) await this.gateway.prewarmSpeech({ text });
        })().catch(() => {});
        return { accepted: true, callId: args.callId, queued: texts.length };
      },
      answer: () => this.gateway.answer(args, { signal }),
      reject: () => this.gateway.reject(args, { signal }),
      hangup: () => this.gateway.hangup(args, { signal }),
      send_dtmf: () => this.gateway.sendDtmf(args, { signal }),
      speak: async () => {
        await this._cancelAcknowledgement(args.callId);
        if (args.respondingToSequence !== undefined) {
          const latest = this.turnEvents.findLast(
            (event) => event.callId === args.callId && event.status === 'turn',
          );
          if (this.pendingRemoteTurns.has(args.callId)
              || (latest && latest.sequence > args.respondingToSequence)) {
            return { accepted: false, callId: args.callId, reason: 'stale caller turn' };
          }
        }
        return this.gateway.speak({
          callId: args.callId,
          text: args.text,
          idempotencyKey: args.idempotencyKey,
        }, { signal });
      },
    };
    try {
      const receipt = publicReceipt(params.name, await methods[params.name]());
      if (receipt === undefined) {
        return { jsonrpc: '2.0', id, result: failedToolResult(
          Object.assign(new Error('invalid RPC response'), { code: 'INVALID_RPC_RESPONSE' }),
        ) };
      }
      return { jsonrpc: '2.0', id, result: callToolResult(receipt) };
    } catch (problem) {
      return { jsonrpc: '2.0', id, result: failedToolResult(problem) };
    }
  }

  close() {
    this.gateway.off?.('incoming', this._capture);
    this.gateway.off?.('event', this._capture);
    this.subscriptions.clear();
    this._cancelAcknowledgement();
    for (const callId of [...this.preparedOpeningCallIds]) this._cancelPreparedOpening(callId);
    for (const pending of this.pendingRemoteTurns.values()) clearTimeout(pending.timer);
    this.pendingRemoteTurns.clear();
    this.lastRemoteTurnByCall.clear();
    this.interruptedAgentByCall.clear();
    this.preparedRepliesByCall.clear();
    for (const waiter of [...this.turnWaiters]) waiter.resolve({
      status: 'ended', callId: waiter.callId, sequence: waiter.afterSequence,
    });
    for (const waiter of [...this.incomingWaiters]) waiter.resolve({
      status: 'timeout', sequence: waiter.afterSequence,
    });
  }
}

export async function runStdio(gateway, input = process.stdin, output = process.stdout) {
  let writeQueue = Promise.resolve();
  let outputFailed = false;
  const onOutputError = () => { outputFailed = true; };
  output.on?.('error', onOutputError);
  const write = (message) => {
    if (outputFailed || output.destroyed || output.writableEnded) return;
    let text = JSON.stringify(message);
    if (Buffer.byteLength(text) > MAX_LINE_BYTES) {
      text = JSON.stringify(error(validRequestId(message?.id) ? (message.id ?? null) : null,
        JSONRPC_ERROR.INTERNAL_ERROR, 'response too large'));
    }
    writeQueue = writeQueue.then(() => new Promise((resolve) => {
      if (outputFailed || output.destroyed || output.writableEnded) {
        resolve();
        return;
      }
      let settled = false;
      const finish = (problem) => {
        if (settled) return;
        settled = true;
        output.off?.('error', finish);
        if (problem) outputFailed = true;
        resolve();
      };
      output.once?.('error', finish);
      try {
        output.write(`${text}\n`, finish);
      } catch (problem) {
        finish(problem);
      }
    }));
  };
  const handler = new McpHandler(gateway, { notify: write });
  const controllers = new Set();
  let pending = Buffer.alloc(0);
  let discarding = false;
  const tasks = new Set();
  const dispatch = (line) => {
    if (line.length === 0) return;
    let message;
    try {
      message = JSON.parse(line.toString('utf8'));
    } catch {
      write(error(null, JSONRPC_ERROR.PARSE_ERROR, 'parse error'));
      return;
    }
    const controller = new AbortController();
    controllers.add(controller);
    const task = handler.handle(message, { signal: controller.signal })
      .then((response) => { if (response !== undefined) write(response); })
      .catch(() => write(error(validRequestId(message.id) ? (message.id ?? null) : null,
        JSONRPC_ERROR.INTERNAL_ERROR, 'internal error')))
      .finally(() => { controllers.delete(controller); tasks.delete(task); });
    tasks.add(task);
  };
  await gateway.startEvents?.();
  try {
    for await (const chunk of input) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      let offset = 0;
      while (offset < bytes.length) {
        const newline = bytes.indexOf(0x0a, offset);
        const end = newline < 0 ? bytes.length : newline;
        const segment = bytes.subarray(offset, end);
        if (!discarding) {
          pending = Buffer.concat([pending, segment]);
          if (pending.length > MAX_LINE_BYTES) {
            pending = Buffer.alloc(0);
            discarding = true;
            write(error(null, JSONRPC_ERROR.PARSE_ERROR, 'frame too large'));
          }
        }
        if (newline < 0) break;
        if (discarding) discarding = false;
        else dispatch(pending);
        pending = Buffer.alloc(0);
        offset = newline + 1;
      }
    }
    if (!discarding && pending.length > 0) dispatch(pending);
    for (const controller of controllers) controller.abort();
    await Promise.race([
      Promise.allSettled([...tasks]),
      new Promise((resolve) => setTimeout(resolve, 100)),
    ]);
    await writeQueue;
  } finally {
    for (const controller of controllers) controller.abort();
    handler.close();
    gateway.stopEvents?.();
    output.off?.('error', onOutputError);
  }
}

export function isMcpServerEntrypoint(argv = process.argv, moduleUrl = import.meta.url) {
  return Boolean(argv[1] && resolve(argv[1]) === fileURLToPath(moduleUrl));
}

if (isMcpServerEntrypoint()) {
  try {
    const gateway = new GatewayRpcClient({ socketPath: rpcSocketFromEnv(process.env) });
    await runStdio(gateway);
  } catch {
    process.stderr.write('gatewayd connection failed\n');
    process.exitCode = 1;
  }
}
