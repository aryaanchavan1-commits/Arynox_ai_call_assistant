import { lstat as fsLstat, readFile as fsReadFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

const SECRET_BYTES = 32;
const SECRET_MODE = 0o640;

export async function loadControllerSecret(path, {
  lstat = fsLstat,
  readFile = fsReadFile,
  expectedUid = 0,
  expectedGid = process.getgid?.(),
} = {}) {
  if (typeof path !== 'string' || !isAbsolute(path) || path.length > 300) {
    throw new Error('controller secret path must be an absolute path up to 300 characters');
  }
  const stat = await lstat(path);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error('controller secret must be a regular non-symlink file');
  }
  if (stat.uid !== expectedUid) throw new Error('controller secret owner uid mismatch');
  if (!Number.isInteger(expectedGid) || stat.gid !== expectedGid) {
    throw new Error('controller secret group gid mismatch');
  }
  if ((stat.mode & 0o777) !== SECRET_MODE) {
    throw new Error('controller secret mode must be exactly 0640');
  }
  const secret = await readFile(path);
  if (!Buffer.isBuffer(secret) || secret.length !== SECRET_BYTES) {
    secret?.fill?.(0);
    throw new Error('controller secret must contain exactly 32 bytes');
  }
  return secret;
}

export const CONTROLLER_SECRET_BYTES = SECRET_BYTES;
