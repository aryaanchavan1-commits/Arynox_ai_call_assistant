import assert from 'node:assert/strict';
import test from 'node:test';

import { loadControllerSecret } from '../src/controller-secret.js';

function fixture({ mode = 0o100640, uid = 0, gid = 991, bytes = Buffer.alloc(32, 0x5a) } = {}) {
  return {
    lstat: async () => ({
      isFile: () => (mode & 0o170000) === 0o100000,
      isSymbolicLink: () => (mode & 0o170000) === 0o120000,
      mode,
      uid,
      gid,
    }),
    readFile: async () => Buffer.from(bytes),
  };
}

test('controller secret loader accepts only exact root-service-group 0640 regular file', async () => {
  const io = fixture();
  const secret = await loadControllerSecret('/etc/agentcall/controller.key', {
    ...io,
    expectedUid: 0,
    expectedGid: 991,
  });
  assert.equal(secret.length, 32);
  assert.equal(secret.every((value) => value === 0x5a), true);
});

test('controller secret loader rejects symlink, wrong ownership, unsafe mode, and wrong length', async () => {
  const cases = [
    [{ mode: 0o120640 }, /regular|symlink/i],
    [{ uid: 1000 }, /owner|uid/i],
    [{ gid: 1000 }, /group|gid/i],
    [{ mode: 0o100660 }, /mode|0640/i],
    [{ mode: 0o100644 }, /mode|0640/i],
    [{ bytes: Buffer.alloc(31) }, /32 bytes/i],
    [{ bytes: Buffer.alloc(33) }, /32 bytes/i],
  ];
  for (const [options, pattern] of cases) {
    const io = fixture(options);
    await assert.rejects(
      () => loadControllerSecret('/etc/agentcall/controller.key', {
        ...io,
        expectedUid: 0,
        expectedGid: 991,
      }),
      pattern,
    );
  }
});

test('controller secret loader requires an absolute bounded path and propagates missing file', async () => {
  const io = fixture();
  await assert.rejects(
    () => loadControllerSecret('controller.key', { ...io, expectedUid: 0, expectedGid: 991 }),
    /absolute/i,
  );
  await assert.rejects(
    () => loadControllerSecret('/etc/agentcall/controller.key', {
      lstat: async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
      readFile: io.readFile,
      expectedUid: 0,
      expectedGid: 991,
    }),
    /missing|ENOENT/i,
  );
});
