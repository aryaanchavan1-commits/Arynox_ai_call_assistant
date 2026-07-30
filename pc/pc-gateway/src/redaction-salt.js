import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat as fsLstat, open as fsOpen } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';

const SALT_MODE = 0o640;
const MIN_BYTES = 16;
const MAX_BYTES = 4096;

export async function loadRedactionSalt(path, {
  open = fsOpen,
  expectedUid = 0,
  expectedGid = process.getgid?.(),
} = {}) {
  if (typeof path !== 'string' || path.length < 2 || path.length > 300 || !isAbsolute(path)) {
    throw new Error('redaction salt path must be an absolute path up to 300 characters');
  }
  let handle;
  let raw;
  try {
    try {
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if (error?.code === 'ELOOP') throw new Error('redaction salt must be a regular non-symlink file');
      throw error;
    }
    const info = await handle.stat();
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
      throw new Error('redaction salt must be a regular single-link file');
    }
    if (info.uid !== expectedUid) throw new Error('redaction salt owner uid is invalid');
    if (info.gid !== expectedGid) throw new Error('redaction salt group gid is invalid');
    if ((info.mode & 0o777) !== SALT_MODE) throw new Error('redaction salt mode must be exactly 0640');
    raw = await handle.readFile();
    if (!Buffer.isBuffer(raw)) throw new Error('redaction salt reader must return bytes');
    const valueBytes = raw.length > 0 && raw[raw.length - 1] === 0x0a
      ? raw.subarray(0, raw.length - 1)
      : raw;
    if (valueBytes.length < MIN_BYTES || valueBytes.length > MAX_BYTES) {
      throw new Error('redaction salt length must be 16..4096 bytes');
    }
    let value;
    try {
      value = new TextDecoder('utf-8', { fatal: true }).decode(valueBytes);
    } catch {
      throw new Error('redaction salt must be valid UTF-8');
    }
    if (/[\r\n\u0000-\u001f\u007f]/.test(value)) {
      throw new Error('redaction salt must be a single line without control characters');
    }
    return value;
  } finally {
    raw?.fill(0);
    await handle?.close();
  }
}

export async function loadOrCreateRedactionSalt(path, {
  lstat = fsLstat,
  open = fsOpen,
  expectedUid = process.getuid?.(),
  expectedGid = process.getgid?.(),
  platform = process.platform,
} = {}) {
  if (typeof path !== 'string' || path.length < 2 || path.length > 300 || !isAbsolute(path)) {
    throw new Error('redaction salt path must be an absolute path up to 300 characters');
  }
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1
        || (platform !== 'win32' && (info.uid !== expectedUid || info.gid !== expectedGid
          || (info.mode & 0o777) !== 0o600))) {
      throw new Error('service redaction salt state is unsafe');
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    const token = randomBytes(32).toString('base64url');
    let handle;
    try {
      handle = await open(path, 'wx', 0o600);
      await handle.writeFile(token, 'ascii');
      await handle.sync();
    } catch (createError) {
      if (createError?.code !== 'EEXIST') throw createError;
    } finally {
      await handle?.close();
    }
    if (handle && platform !== 'win32') {
      const directory = await open(dirname(path), 'r');
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    }
  }
  let stateHandle;
  let raw;
  try {
    stateHandle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const info = await stateHandle.stat();
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1
        || (platform !== 'win32' && (info.uid !== expectedUid || info.gid !== expectedGid
          || (info.mode & 0o777) !== 0o600)) || info.size !== 43) {
      throw new Error('service redaction salt state is unsafe');
    }
    raw = await stateHandle.readFile();
    if (!Buffer.isBuffer(raw) || raw.length !== 43 || !/^[A-Za-z0-9_-]{43}$/.test(raw.toString('ascii'))) {
      throw new Error('service redaction salt state is unsafe');
    }
    return raw.toString('ascii');
  } finally {
    raw?.fill(0);
    await stateHandle?.close();
  }
}
