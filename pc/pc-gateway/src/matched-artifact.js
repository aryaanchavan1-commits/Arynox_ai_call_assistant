import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat as fsLstat, open as fsOpen } from 'node:fs/promises';

const KEYS = Object.freeze(['schemaVersion', 'bootstrapProtocolVersion', 'desktopPackageVersion', 'androidPackageName', 'androidVersionCode', 'androidSigningCertificateSha256']);

export function parseMatchedArtifactManifest(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.at(-1) !== 0x0a) throw new Error('matched artifact manifest must end with LF');
  for (const byte of bytes) if (byte !== 0x0a && (byte < 0x20 || byte > 0x7e)) throw new Error('matched artifact manifest must be strict ASCII');
  const lines = bytes.toString('ascii').slice(0, -1).split('\n');
  if (lines.length !== KEYS.length) throw new Error('matched artifact manifest field count is invalid');
  const values = lines.map((line, index) => {
    if (line.indexOf('=') < 1 || line.indexOf('=') !== line.lastIndexOf('=') || line.slice(0, line.indexOf('=')) !== KEYS[index]) throw new Error('matched artifact manifest field order is invalid');
    const value = line.slice(line.indexOf('=') + 1);
    if (!value) throw new Error('matched artifact manifest value is empty');
    return value;
  });
  if (values[0] !== '1' || values[1] !== '1' || !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(values[2]) || !/^[1-9]\d*$/.test(values[4]) || !/^[0-9a-f]{64}$/.test(values[5]) || /^0{64}$/.test(values[5])) throw new Error('matched artifact manifest value is invalid');
  if (values[2] !== '1.0.1' || values[3] !== 'com.callagent.gateway' || values[4] !== '333') throw new Error('matched artifact release identity is unsupported');
  const versionCode = Number(values[4]);
  if (!Number.isSafeInteger(versionCode) || versionCode <= 0) throw new Error('matched artifact version is invalid');
  return { schemaVersion: 1, bootstrapProtocolVersion: 1, desktopPackageVersion: values[2], androidPackageName: values[3], androidVersionCode: versionCode, androidSigningCertificateSha256: values[5] };
}

export async function loadMatchedArtifactManifest(path, {
  open = fsOpen,
  lstat = fsLstat,
  expectedUid = 0,
  expectedGid = 0,
  platform = process.platform,
} = {}) {
  let handle;
  try {
    const before = await lstat(path);
    if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1) {
      throw new Error('matched artifact manifest file is unsafe');
    }
    try {
      handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    } catch (error) {
      if (error?.code === 'ELOOP') throw new Error('matched artifact manifest file is unsafe');
      throw error;
    }
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || info.dev !== before.dev || info.ino !== before.ino
        || (platform !== 'win32' && (info.uid !== expectedUid || info.gid !== expectedGid
          || (info.mode & 0o777) !== 0o644))
        || info.size < 1 || info.size > 4096) {
      throw new Error('matched artifact manifest file is unsafe');
    }
    const bytes = await handle.readFile();
    return { manifest: parseMatchedArtifactManifest(bytes), digest: createHash('sha256').update(bytes).digest() };
  } finally {
    await handle?.close();
  }
}
