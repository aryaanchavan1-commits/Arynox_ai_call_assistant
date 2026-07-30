import assert from 'node:assert/strict';
import { mkdtemp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { loadOrCreateRedactionSalt, loadRedactionSalt } from '../src/redaction-salt.js';

function fixture({ mode = 0o100640, uid = 0, gid = 991, nlink = 1, value = 'private-redaction-salt\n' } = {}) {
  return {
    open: async () => ({
      stat: async () => ({
        isFile: () => (mode & 0o170000) === 0o100000,
        isSymbolicLink: () => (mode & 0o170000) === 0o120000,
        mode, uid, gid, nlink,
      }),
      readFile: async () => Buffer.isBuffer(value) ? Buffer.from(value) : Buffer.from(value),
      close: async () => {},
    }),
  };
}

test('redaction salt loader accepts exact root-service-group 0640 regular file', async () => {
  assert.equal(await loadRedactionSalt('/etc/agentcall/redaction-salt', {
    ...fixture(), expectedUid: 0, expectedGid: 991,
  }), 'private-redaction-salt');
});

test('redaction salt loader rejects symlink, ownership, mode, and unsafe content', async () => {
  const cases = [
    [{ mode: 0o120640 }, /regular|symlink/i],
    [{ uid: 1000 }, /owner|uid/i],
    [{ gid: 1000 }, /group|gid/i],
    [{ mode: 0o100644 }, /mode|0640/i],
    [{ value: 'x'.repeat(15) + '\n' }, /length/i],
    [{ value: 'x'.repeat(4097) }, /length/i],
    [{ value: 'valid-length-but\nembedded' }, /single line/i],
    [{ value: Buffer.from([0xff, ...Buffer.from('valid-redaction-salt')]) }, /UTF-8/i],
  ];
  for (const [options, pattern] of cases) {
    await assert.rejects(() => loadRedactionSalt('/etc/agentcall/redaction-salt', {
      ...fixture(options), expectedUid: 0, expectedGid: 991,
    }), pattern);
  }
});

test('redaction salt loader requires an absolute bounded path', async () => {
  await assert.rejects(() => loadRedactionSalt('redaction-salt', {
    ...fixture(), expectedUid: 0, expectedGid: 991,
  }), /absolute/i);
});

test('zero-touch salt syncs the containing directory after first creation', async () => {
  const calls = [];
  const info = { isFile: () => true, isSymbolicLink: () => false, nlink: 1, uid: 991, gid: 991, mode: 0o100600 };
  const createHandle = { writeFile: async () => calls.push('write'), sync: async () => calls.push('file-sync'), close: async () => calls.push('file-close') };
  const directory = { sync: async () => calls.push('dir-sync'), close: async () => calls.push('dir-close') };
  const stateHandle = {
    stat: async () => ({ ...info, size: 43 }),
    readFile: async () => Buffer.from('a'.repeat(43)),
    close: async () => calls.push('state-close'),
  };
  let missing = true;
  let fileOpens = 0;
  await loadOrCreateRedactionSalt('/var/lib/agentcall/redaction-salt', {
    expectedUid: 991, expectedGid: 991,
    platform: 'linux',
    lstat: async () => { if (missing) { missing = false; const error = new Error('missing'); error.code = 'ENOENT'; throw error; } return info; },
    open: async (path) => path === '/var/lib/agentcall' ? directory : (++fileOpens === 1 ? createHandle : stateHandle),
  });
  assert.deepEqual(calls, ['write', 'file-sync', 'file-close', 'dir-sync', 'dir-close', 'state-close']);
});

test('zero-touch salt creates private service-owned state once and reuses it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agentcall-salt-'));
  const path = join(root, 'redaction-salt');
  const first = await loadOrCreateRedactionSalt(path);
  const second = await loadOrCreateRedactionSalt(path);
  assert.equal(first, second);
  assert.match(first, /^[A-Za-z0-9_-]{43}$/);
  if (process.platform !== 'win32') assert.equal((await stat(path)).mode & 0o777, 0o600);
});
