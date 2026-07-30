import { constants } from 'node:fs';
import {
  chmod, lstat, mkdir, open, rename, rm,
} from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';

const KEY_BYTES = 32;
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const SERIAL_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const RECORD_MAGIC = Buffer.from('G2K1', 'ascii');
const MIN_RECORD_BYTES = RECORD_MAGIC.length + KEY_BYTES + 2;
const MAX_RECORD_BYTES = RECORD_MAGIC.length + KEY_BYTES + 1 + 128;

function validatePath(path) {
  if (typeof path !== 'string' || !isAbsolute(path) || path.length > 300) {
    throw new Error('controller key path must be absolute');
  }
}

function encodeRecord(key, serial) {
  const serialBytes = Buffer.from(serial, 'utf8');
  const record = Buffer.alloc(RECORD_MAGIC.length + KEY_BYTES + 1 + serialBytes.length);
  RECORD_MAGIC.copy(record);
  key.copy(record, RECORD_MAGIC.length);
  record[RECORD_MAGIC.length + KEY_BYTES] = serialBytes.length;
  serialBytes.copy(record, RECORD_MAGIC.length + KEY_BYTES + 1);
  return record;
}

function decodeRecord(record) {
  if (!Buffer.isBuffer(record) || record.length < MIN_RECORD_BYTES || record.length > MAX_RECORD_BYTES
      || !record.subarray(0, RECORD_MAGIC.length).equals(RECORD_MAGIC)) {
    throw new Error('controller credential record is invalid');
  }
  const serialLength = record[RECORD_MAGIC.length + KEY_BYTES];
  if (record.length !== RECORD_MAGIC.length + KEY_BYTES + 1 + serialLength) {
    throw new Error('controller credential record is invalid');
  }
  const serialBytes = record.subarray(RECORD_MAGIC.length + KEY_BYTES + 1);
  const serial = serialBytes.toString('utf8');
  if (!SERIAL_RE.test(serial) || Buffer.byteLength(serial) !== serialLength) {
    throw new Error('controller credential serial is invalid');
  }
  return {
    key: Buffer.from(record.subarray(RECORD_MAGIC.length, RECORD_MAGIC.length + KEY_BYTES)),
    serial,
  };
}

export class ControllerCredentialStore {
  constructor({
    path,
    expectedUid = process.getuid?.(),
    expectedGid = process.getgid?.(),
    platform = process.platform,
  }) {
    validatePath(path);
    if (platform !== 'win32' && platform !== 'linux' && platform !== 'darwin') {
      throw new Error('controller credential platform is unsupported');
    }
    this.path = path;
    this.directory = dirname(path);
    this.stagedPath = `${path}.staged`;
    this.expectedUid = expectedUid;
    this.expectedGid = expectedGid;
    this.platform = platform;
  }

  async _validateDirectory() {
    const info = await lstat(this.directory);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('controller directory must be a real directory');
    if (this.platform !== 'win32') {
      if (info.uid !== this.expectedUid || info.gid !== this.expectedGid) throw new Error('controller directory owner mismatch');
      if ((info.mode & 0o777) !== DIRECTORY_MODE) throw new Error('controller directory mode must be exactly 0700');
    }
  }

  async _ensureDirectory() {
    try { await lstat(this.directory); } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      await mkdir(this.directory, { recursive: true, mode: DIRECTORY_MODE });
      if (this.platform !== 'win32') await chmod(this.directory, DIRECTORY_MODE);
    }
    await this._validateDirectory();
  }

  _validateFileInfo(info) {
    if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1) throw new Error('controller credential must be a regular single-link file');
    if (this.platform !== 'win32') {
      if (info.uid !== this.expectedUid || info.gid !== this.expectedGid) throw new Error('controller credential owner mismatch');
      if ((info.mode & 0o777) !== FILE_MODE) throw new Error('controller credential mode must be exactly 0600');
    }
    if (info.size < MIN_RECORD_BYTES || info.size > MAX_RECORD_BYTES) throw new Error('controller credential record size is invalid');
  }

  async _validateFile(path) {
    this._validateFileInfo(await lstat(path));
  }

  async _readRecord(path) {
    let handle;
    let record;
    try {
      try {
        handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      } catch (error) {
        if (error?.code === 'ELOOP') throw new Error('controller credential must be a regular non-symlink file');
        throw error;
      }
      this._validateFileInfo(await handle.stat());
      record = await handle.readFile();
      return decodeRecord(record);
    } finally {
      record?.fill(0);
      await handle?.close();
    }
  }

  async _syncDirectory() {
    // Windows does not permit opening directories as fs file handles. Atomic
    // rename still provides crash-safe publication on the local NTFS volume.
    if (this.platform === 'win32') return;
    const directory = await open(this.directory, 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  }

  async load() {
    try {
      await this._validateDirectory();
      return (await this._readRecord(this.path)).key;
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
  }

  async stage(key, { serial } = {}) {
    if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) throw new Error('controller key must contain exactly 32 bytes');
    if (typeof serial !== 'string' || !SERIAL_RE.test(serial)) throw new Error('exact ADB serial is required');
    await this._ensureDirectory();
    try { await lstat(this.path); throw new Error('controller key is already present'); }
    catch (error) { if (error?.code !== 'ENOENT') throw error; }
    const record = encodeRecord(key, serial);
    let handle;
    let created = false;
    try {
      handle = await open(this.stagedPath, 'wx', FILE_MODE);
      created = true;
      await handle.writeFile(record);
      await handle.sync();
      await handle.close();
      handle = null;
      await this._validateFile(this.stagedPath);
      await this._syncDirectory();
      return Object.freeze({ stagedPath: this.stagedPath });
    } catch (error) {
      try { await handle?.close(); } catch {}
      if (created) {
        await rm(this.stagedPath, { force: true });
        await this._syncDirectory();
      }
      throw error;
    } finally { record.fill(0); }
  }

  async recover() {
    await this._ensureDirectory();
    let committed = null;
    let staged = null;
    try { committed = await this._readRecord(this.path); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
    try { staged = await this._readRecord(this.stagedPath); } catch (error) { if (error?.code !== 'ENOENT') { committed?.key.fill(0); throw error; } }
    if (committed && staged) {
      committed.key.fill(0); staged.key.fill(0);
      throw new Error('controller credential state is asymmetric');
    }
    if (committed) {
      const serial = committed.serial;
      committed.key.fill(0);
      return { state: 'committed', serial };
    }
    if (!staged) return { state: 'absent' };
    return { state: 'staged', ...staged, transaction: Object.freeze({ stagedPath: this.stagedPath }) };
  }

  async commit(transaction) {
    if (transaction?.stagedPath !== this.stagedPath || Object.keys(transaction).some((key) => key !== 'stagedPath')) {
      throw new Error('invalid controller transaction');
    }
    await this._validateDirectory();
    try {
      await this._validateFile(this.path);
      try { await lstat(this.stagedPath); } catch (error) { if (error?.code === 'ENOENT') return; throw error; }
      throw new Error('controller credential state is asymmetric');
    } catch (error) { if (error?.code !== 'ENOENT') throw error; }
    await this._validateFile(this.stagedPath);
    await rename(this.stagedPath, this.path);
    await this._syncDirectory();
    await this._validateFile(this.path);
  }

  async abort(transaction) {
    if (transaction?.stagedPath === this.stagedPath) {
      await rm(this.stagedPath, { force: true });
      await this._syncDirectory();
    }
  }
}

export const CONTROLLER_KEY_BYTES = KEY_BYTES;
