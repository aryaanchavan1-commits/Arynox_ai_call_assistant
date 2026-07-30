import { createHmac } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';

const E164_RE = /^\+[1-9][0-9]{1,14}$/;
const ID_RE = /^[a-f0-9]{64}$/;
const MAX_ITEMS = 8;
const CALL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CALL_DIRECTION = new Set(['incoming', 'outgoing']);

function bounded(value, name, max, { optional = true } = {}) {
  if (value === undefined && optional) return '';
  if (typeof value !== 'string' || value.length > max || (!optional && value.length === 0)) {
    throw new Error(`${name} must be a bounded string`);
  }
  return value;
}

function list(value, name) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_ITEMS) throw new Error(`${name} must contain at most ${MAX_ITEMS} items`);
  return value.map((item, index) => bounded(item, `${name}[${index}]`, 256, { optional: false }));
}

function optionalTimestamp(value, name) {
  const result = bounded(value, name, 40);
  if (result && !Number.isFinite(Date.parse(result))) throw new Error(`${name} must be a timestamp`);
  return result;
}

function normalizeCall(value, index = 0) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`history[${index}] must be an object`);
  const allowed = new Set([
    'callId', 'startedAt', 'endedAt', 'direction', 'outcome', 'summary', 'transcript', 'recordingId',
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw new Error(`history[${index}] contains an unsupported field`);
  const callId = bounded(value.callId, `history[${index}].callId`, 128, { optional: false });
  if (!CALL_ID_RE.test(callId)) throw new Error(`history[${index}].callId has an invalid shape`);
  const direction = bounded(value.direction, `history[${index}].direction`, 8);
  if (direction && !CALL_DIRECTION.has(direction)) throw new Error(`history[${index}].direction is invalid`);
  const recordingId = bounded(value.recordingId, `history[${index}].recordingId`, 128);
  if (recordingId && !CALL_ID_RE.test(recordingId)) throw new Error(`history[${index}].recordingId has an invalid shape`);
  return {
    callId,
    startedAt: optionalTimestamp(value.startedAt, `history[${index}].startedAt`),
    endedAt: optionalTimestamp(value.endedAt, `history[${index}].endedAt`),
    direction,
    outcome: bounded(value.outcome, `history[${index}].outcome`, 64),
    summary: bounded(value.summary, `history[${index}].summary`, 1_000),
    transcript: bounded(value.transcript, `history[${index}].transcript`, 4_000),
    recordingId,
  };
}

function history(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_ITEMS) throw new Error(`history must contain at most ${MAX_ITEMS} calls`);
  return value.map(normalizeCall);
}

function normalizeContext(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('context must be an object');
  const allowed = new Set(['summary', 'language', 'voice', 'facts', 'followUps', 'history']);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw new Error('context contains an unsupported field');
  const language = bounded(value.language, 'language', 16);
  if (language && !/^[a-z]{2,3}(?:-[A-Z]{2})?$/.test(language)) throw new Error('language has an invalid shape');
  return {
    summary: bounded(value.summary, 'summary', 1_000),
    language,
    voice: bounded(value.voice, 'voice', 128),
    facts: list(value.facts, 'facts'),
    followUps: list(value.followUps, 'followUps'),
    history: history(value.history),
  };
}

async function atomicWrite(path, content) {
  const temporary = `${path}.${process.pid}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
}

export class CallerMemoryStore {
  constructor({ root, secret } = {}) {
    if (typeof root !== 'string' || root.length < 2) throw new Error('caller memory root is required');
    if (typeof secret !== 'string' || secret.length < 8) throw new Error('caller memory secret is required');
    this.root = root;
    this.secret = secret;
    this.callers = join(root, 'callers');
    this.auditWork = Promise.resolve();
    this.recordWork = Promise.resolve();
  }

  callerId(phoneNumber) {
    if (typeof phoneNumber !== 'string' || !E164_RE.test(phoneNumber)) throw new Error('phoneNumber must be strict E.164');
    return createHmac('sha256', this.secret).update(phoneNumber).digest('hex');
  }

  async #prepare() {
    await mkdir(this.callers, { recursive: true, mode: 0o700 });
  }

  async #audit(value) {
    this.auditWork = this.auditWork.then(async () => {
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      const handle = await open(join(this.root, 'audit.jsonl'), 'a', 0o600);
      try {
        await handle.writeFile(`${JSON.stringify({ at: new Date().toISOString(), ...value })}\n`);
        await handle.sync();
      } finally {
        await handle.close();
      }
    });
    await this.auditWork;
  }

  async update({ phoneNumber, consent, operatorRole, context } = {}) {
    if (operatorRole !== 'operator') throw new Error('operator role is required');
    if (consent?.memory !== true) throw new Error('memory consent is required');
    const expiresAt = bounded(consent.expiresAt, 'consent.expiresAt', 40, { optional: false });
    if (!Number.isFinite(Date.parse(expiresAt))) throw new Error('consent expiry is invalid');
    const callerId = this.callerId(phoneNumber);
    const normalized = normalizeContext(context);
    const operation = this.recordWork.catch(() => {}).then(async () => {
      await this.#prepare();
      const record = { schemaVersion: 2, callerId, consent: { memory: true, expiresAt }, context: normalized };
      await atomicWrite(join(this.callers, `${callerId}.json`), `${JSON.stringify(record, null, 2)}\n`);
      await this.#audit({ action: 'caller_memory_update', callerId, operatorRole });
      return { callerId, consent: record.consent, context: normalized };
    });
    this.recordWork = operation;
    return operation;
  }

  async resolve({ phoneNumber, now = new Date() } = {}) {
    const callerId = this.callerId(phoneNumber);
    let record;
    try { record = JSON.parse(await readFile(join(this.callers, `${callerId}.json`), 'utf8')); } catch { return { found: false }; }
    if (record?.callerId !== callerId || !ID_RE.test(record.callerId) || record?.consent?.memory !== true) return { found: false };
    const expiresAt = Date.parse(record.consent.expiresAt ?? '');
    if (!Number.isFinite(expiresAt) || expiresAt <= now.getTime()) return { found: false };
    const context = normalizeContext(record.context);
    await this.#audit({ action: 'caller_memory_read', callerId });
    return { found: true, callerId, consent: { memory: true, expiresAt: record.consent.expiresAt }, context };
  }

  async appendCall({ phoneNumber, call, now = new Date() } = {}) {
    const callerId = this.callerId(phoneNumber);
    const normalizedCall = normalizeCall(call);
    const operation = this.recordWork.catch(() => {}).then(async () => {
      let record;
      try { record = JSON.parse(await readFile(join(this.callers, `${callerId}.json`), 'utf8')); } catch {
        return { appended: false, reason: 'memory consent unavailable' };
      }
      const expiresAt = Date.parse(record?.consent?.expiresAt ?? '');
      if (record?.callerId !== callerId || !ID_RE.test(record.callerId)
          || record?.consent?.memory !== true || !Number.isFinite(expiresAt) || expiresAt <= now.getTime()) {
        return { appended: false, reason: 'memory consent unavailable' };
      }
      const context = normalizeContext(record.context);
      context.history = [normalizedCall, ...context.history.filter(({ callId }) => callId !== normalizedCall.callId)]
        .slice(0, MAX_ITEMS);
      const updated = { schemaVersion: 2, callerId, consent: record.consent, context };
      await this.#prepare();
      await atomicWrite(join(this.callers, `${callerId}.json`), `${JSON.stringify(updated, null, 2)}\n`);
      await this.#audit({ action: 'caller_memory_call_append', callerId, callId: normalizedCall.callId });
      return { appended: true, callerId, context };
    });
    this.recordWork = operation;
    return operation;
  }

  async delete({ phoneNumber, operatorRole, reason } = {}) {
    if (operatorRole !== 'operator') throw new Error('operator role is required');
    bounded(reason, 'reason', 256, { optional: false });
    const callerId = this.callerId(phoneNumber);
    await rm(join(this.callers, `${callerId}.json`), { force: true });
    await this.#audit({ action: 'caller_memory_delete', callerId, operatorRole, reason });
    return { deleted: true };
  }
}

export default CallerMemoryStore;
