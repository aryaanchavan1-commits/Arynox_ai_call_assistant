import { randomUUID } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';

const PAGE_ROWS = 100;
const LIMITS = Object.freeze({ contacts: 500, callLog: 200 });
const FILES = Object.freeze({ contacts: 'contacts.json', callLog: 'call-log.json' });
const EVENTS = Object.freeze({ contacts_snapshot_v1: 'contacts', call_log_snapshot_v1: 'callLog' });
const CAPABILITIES = Object.freeze({ contacts: 'contacts_sync_v1', callLog: 'call_log_sync_v1' });
const REQUESTS = Object.freeze({ contacts: 'sync_contacts', callLog: 'sync_call_log' });
const TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const DECIMAL_RE = /^(0|[1-9][0-9]{0,18})$/;
const CALL_KINDS = new Set(['incoming', 'outgoing', 'missed', 'rejected', 'blocked', 'voicemail', 'unknown']);

function cleanText(value, max, { empty = false } = {}) {
  return typeof value === 'string' && value.length <= max && (empty || value.length > 0)
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && Object.keys(value).every((key) => keys.includes(key));
}

function normalizeContact(value) {
  if (!exactKeys(value, ['id', 'name', 'number'])
      || !DECIMAL_RE.test(value.id ?? '')
      || !cleanText(value.name, 256)
      || !cleanText(value.number, 64)) return null;
  return { id: value.id, name: value.name, number: value.number };
}

function normalizeCall(value) {
  if (!exactKeys(value, ['id', 'number', 'name', 'kind', 'timestampMillis', 'durationSeconds'])
      || !DECIMAL_RE.test(value.id ?? '')
      || !cleanText(value.number, 64)
      || !(value.name === null || cleanText(value.name, 256))
      || !CALL_KINDS.has(value.kind)
      || !DECIMAL_RE.test(value.timestampMillis ?? '')
      || !DECIMAL_RE.test(value.durationSeconds ?? '')) return null;
  const timestamp = Number(value.timestampMillis);
  const duration = Number(value.durationSeconds);
  if (!Number.isSafeInteger(timestamp) || timestamp < 0 || !Number.isSafeInteger(duration) || duration < 0) return null;
  return {
    id: value.id, number: value.number, name: value.name, kind: value.kind,
    timestampMillis: value.timestampMillis, durationSeconds: value.durationSeconds,
  };
}

function comparablePhone(value) {
  if (typeof value !== 'string' || value.length > 64) return '';
  const digits = value.replaceAll(/\D/g, '');
  return digits.length >= 6 && digits.length <= 15 ? digits : '';
}

async function durableAtomicJson(root, name, value) {
  await mkdir(root, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') await chmod(root, 0o700);
  const target = join(root, name);
  const temporary = join(root, `.${name}.${process.pid}.${randomUUID()}.tmp`);
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, target);
    if (process.platform !== 'win32') {
      await chmod(target, 0o600);
      const directory = await open(root, 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    }
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function loadSnapshot(root, kind) {
  try {
    const value = JSON.parse(await readFile(join(root, FILES[kind]), 'utf8'));
    if (!exactKeys(value, ['version', 'syncedAt', 'rows']) || value.version !== 1
        || typeof value.syncedAt !== 'string' || !Array.isArray(value.rows)
        || value.rows.length > LIMITS[kind]) throw new Error('invalid phone data mirror');
    const normalize = kind === 'contacts' ? normalizeContact : normalizeCall;
    const rows = value.rows.map(normalize);
    if (rows.some((row) => row === null)) throw new Error('invalid phone data mirror');
    return { rows, syncedAt: value.syncedAt };
  } catch (error) {
    if (error?.code === 'ENOENT') return { rows: [], syncedAt: null };
    throw error;
  }
}

export class PhoneDataStore {
  constructor({ root, now = Date.now, randomId = randomUUID } = {}) {
    if (typeof root !== 'string' || root.length < 2) throw new Error('phone data root is required');
    this.root = root;
    this.now = now;
    this.randomId = randomId;
    this.support = { contacts: null, callLog: null };
    this.connectionState = 'connected';
    this.pending = new Map();
  }

  setCapabilities(values) {
    const capabilities = new Set(Array.isArray(values) ? values : []);
    for (const kind of Object.keys(CAPABILITIES)) this.support[kind] = capabilities.has(CAPABILITIES[kind]);
    this.connectionState = 'connected';
    for (const [requestId, pending] of this.pending) {
      if (!this.support[pending.kind]) this.pending.delete(requestId);
    }
  }

  setDisconnected() {
    this.connectionState = 'offline';
    this.pending.clear();
  }

  syncRequests() {
    const requests = [];
    for (const kind of ['contacts', 'callLog']) {
      if (!this.support[kind]) continue;
      const requestId = this.randomId();
      if (!TOKEN_RE.test(requestId)) throw new Error('phone sync request id is invalid');
      this.pending.set(requestId, { kind, nextPage: 0, rows: [] });
      requests.push({ command: REQUESTS[kind], requestId });
    }
    return requests;
  }

  async consume(value) {
    const kind = EVENTS[value?.event];
    if (!kind) return false;
    const allowed = ['event', 'requestId', 'page', 'final', 'rows'];
    if (!exactKeys(value, allowed) || !TOKEN_RE.test(value.requestId ?? '')
        || !Number.isInteger(value.page) || value.page < 0
        || typeof value.final !== 'boolean' || !Array.isArray(value.rows)
        || value.rows.length > PAGE_ROWS) return false;
    let pending = this.pending.get(value.requestId);
    if (!pending) return false;
    if (pending.kind !== kind || pending.nextPage !== value.page) {
      this.pending.delete(value.requestId);
      return false;
    }
    const normalize = kind === 'contacts' ? normalizeContact : normalizeCall;
    const rows = value.rows.map(normalize);
    if (rows.some((row) => row === null) || pending.rows.length + rows.length > LIMITS[kind]
        || (!value.final && value.rows.length === 0)) {
      this.pending.delete(value.requestId);
      return false;
    }
    pending.rows.push(...rows);
    pending.nextPage++;
    if (!value.final) return true;
    this.pending.delete(value.requestId);
    const syncedAt = new Date(this.now()).toISOString();
    await durableAtomicJson(this.root, FILES[kind], { version: 1, syncedAt, rows: pending.rows });
    return true;
  }

  async #list(kind, { limit } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > LIMITS[kind]) throw new Error('phone data limit is invalid');
    const snapshot = await loadSnapshot(this.root, kind);
    return { rows: snapshot.rows.slice(0, limit), sync: this.#syncState(kind, snapshot) };
  }

  listContacts(args) { return this.#list('contacts', args); }
  listCallLog(args) { return this.#list('callLog', args); }

  async findContact({ number } = {}) {
    const target = comparablePhone(number);
    if (!target) return null;
    const snapshot = await loadSnapshot(this.root, 'contacts');
    const matches = snapshot.rows.flatMap((row) => {
      const candidate = comparablePhone(row.number);
      if (!candidate) return [];
      const exact = candidate === target;
      const suffix = candidate.length >= 10 && target.length >= 10
        && candidate.slice(-10) === target.slice(-10);
      return exact || suffix ? [{ row, exact }] : [];
    });
    const exactMatches = matches.filter((match) => match.exact);
    if (exactMatches.length > 0) {
      return { name: exactMatches[0].row.name, number: exactMatches[0].row.number };
    }
    const names = new Set(matches.map((match) => match.row.name));
    if (matches.length > 0 && names.size === 1) {
      return { name: matches[0].row.name, number: matches[0].row.number };
    }
    const calls = await loadSnapshot(this.root, 'callLog');
    const prior = calls.rows.find((row) => {
      if (typeof row.name !== 'string' || row.name.length === 0) return false;
      const candidate = comparablePhone(row.number);
      return candidate === target || (candidate.length >= 10 && target.length >= 10
        && candidate.slice(-10) === target.slice(-10));
    });
    return prior ? { name: prior.name, number: prior.number } : null;
  }

  #syncState(kind, snapshot) {
    let state = snapshot.syncedAt ? 'ready' : 'never';
    if (this.connectionState === 'offline') state = snapshot.syncedAt ? 'offline' : 'offline';
    else if (this.support[kind] === false) state = 'unsupported';
    else if (this.support[kind] === true
      && [...this.pending.values()].some((pending) => pending.kind === kind)) state = 'syncing';
    return {
      state, count: snapshot.rows.length,
      ...(snapshot.syncedAt ? { syncedAt: snapshot.syncedAt } : {}),
    };
  }

  async publicStatus() {
    const [contacts, callLog] = await Promise.all([loadSnapshot(this.root, 'contacts'), loadSnapshot(this.root, 'callLog')]);
    return { contacts: this.#syncState('contacts', contacts), callLog: this.#syncState('callLog', callLog) };
  }
}

export const PHONE_DATA_CAPABILITIES = CAPABILITIES;
