import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { ControllerCredentialStore } from '../src/controller-credential-store.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'agentcall-controller-'));
  return { root, path: join(root, 'controller', 'controller.key') };
}

const createStore = (path) => new ControllerCredentialStore({ path });
const unixTest = process.platform === 'win32' ? test.skip : test;

test('fresh zero-touch controller store creates its private directory and reports absent', async () => {
  const f = await fixture();
  const store = createStore(f.path);
  assert.deepEqual(await store.recover(), { state: 'absent' });
  if (process.platform !== 'win32') assert.equal((await stat(join(f.root, 'controller'))).mode & 0o777, 0o700);
});

test('controller store stages and atomically commits an exact 0600 32-byte key', async () => {
  const f = await fixture();
  const store = createStore(f.path);
  const key = Buffer.alloc(32, 0x5a);
  const transaction = await store.stage(key, { serial: 'exact-serial' });
  assert.equal(await store.load(), null, 'staged key is not durable authority');
  assert.notDeepEqual(await readFile(transaction.stagedPath), key, 'atomic staged record includes exact-serial metadata');
  if (process.platform !== 'win32') assert.equal((await stat(transaction.stagedPath)).mode & 0o777, 0o600);
  await store.commit(transaction);
  assert.deepEqual(await store.load(), key);
  if (process.platform !== 'win32') assert.equal((await stat(f.path)).mode & 0o777, 0o600);
});

test('conflicting stage preserves an existing durable staged credential', async () => {
  const f = await fixture();
  const store = createStore(f.path);
  await store.stage(Buffer.alloc(32, 0x31), { serial: 'exact-serial' });
  const before = await readFile(`${f.path}.staged`);
  await assert.rejects(() => store.stage(Buffer.alloc(32, 0x32), { serial: 'other-serial' }), /exist|staged/i);
  assert.deepEqual(await readFile(`${f.path}.staged`), before);
  const recovery = await store.recover();
  assert.equal(recovery.state, 'staged');
  assert.equal(recovery.serial, 'exact-serial');
  recovery.key.fill(0);
});

test('controller store uses one deterministic durable staged path and recovers it after restart', async () => {
  const f = await fixture();
  const first = createStore(f.path);
  const transaction = await first.stage(Buffer.alloc(32, 0x33), { serial: 'exact-serial' });
  assert.equal(transaction.stagedPath, `${f.path}.staged`);
  assert.match((await readFile(transaction.stagedPath)).toString('latin1'), /exact-serial$/);

  const restarted = createStore(f.path);
  const recovery = await restarted.recover();
  assert.equal(recovery.state, 'staged');
  assert.equal(recovery.serial, 'exact-serial');
  assert.equal(recovery.transaction.stagedPath, `${f.path}.staged`);
  assert.deepEqual(recovery.key, Buffer.alloc(32, 0x33));
  recovery.key.fill(0);
});

unixTest('controller store rejects staged symlinks and wrong modes during recovery', async () => {
  const f = await fixture();
  await mkdir(join(f.root, 'controller'), { recursive: true, mode: 0o700 });
  await writeFile(join(f.root, 'target'), Buffer.alloc(32, 4), { mode: 0o600 });
  await symlink(join(f.root, 'target'), `${f.path}.staged`);
  const linked = createStore(f.path);
  await assert.rejects(() => linked.recover(), /regular|single-link|symlink/i);

  await (await import('node:fs/promises')).rm(`${f.path}.staged`);
  await writeFile(`${f.path}.staged`, Buffer.alloc(32, 5), { mode: 0o644 });
  await assert.rejects(() => linked.recover(), /0600|mode/i);
});


test('controller store abort removes only its staged transaction', async () => {
  const f = await fixture();
  const store = createStore(f.path);
  const transaction = await store.stage(Buffer.alloc(32, 1), { serial: 'exact-serial' });
  await store.abort(transaction);
  await assert.rejects(() => stat(transaction.stagedPath), /ENOENT/);
  assert.equal(await store.load(), null);
});

test('controller store treats a present invalid key as fatal and never absent', async () => {
  const f = await fixture();
  await mkdir(join(f.root, 'controller'), { recursive: true, mode: 0o700 });
  await writeFile(f.path, Buffer.alloc(31), { mode: 0o600 });
  const store = createStore(f.path);
  await assert.rejects(() => store.load(), /record|credential|size/);
  await assert.rejects(() => store.stage(Buffer.alloc(32), { serial: 'exact-serial' }), /already exists|present/i);
});

unixTest('controller store rejects a symlink parent without mutating its target', async () => {
  const f = await fixture();
  await mkdir(join(f.root, 'real'), { mode: 0o755 });
  await symlink(join(f.root, 'real'), join(f.root, 'controller'));
  const store = createStore(f.path);
  await assert.rejects(() => store.stage(Buffer.alloc(32), { serial: 'exact-serial' }), /directory|symlink|regular/i);
  assert.equal((await stat(join(f.root, 'real'))).mode & 0o777, 0o755);
});

test('controller store refuses duplicate commit rather than overwriting authority', async () => {
  const f = await fixture();
  const store = createStore(f.path);
  const first = await store.stage(Buffer.alloc(32, 1), { serial: 'exact-serial' });
  await store.commit(first);
  await assert.rejects(() => store.stage(Buffer.alloc(32, 2), { serial: 'exact-serial' }), /already exists|present/i);
  assert.deepEqual(await store.load(), Buffer.alloc(32, 1));
});

test('committed recovery returns exact serial without retaining a key copy', async () => {
  const f = await fixture();
  const store = createStore(f.path);
  const transaction = await store.stage(Buffer.alloc(32, 0x5a), { serial: 'exact-serial' });
  await store.commit(transaction);
  const originalFill = Buffer.prototype.fill;
  let zeroized = 0;
  Buffer.prototype.fill = function patchedFill(value, ...args) {
    if (this.length === 32 && value === 0) zeroized++;
    return originalFill.call(this, value, ...args);
  };
  try {
    assert.deepEqual(await store.recover(), { state: 'committed', serial: 'exact-serial' });
    assert.ok(zeroized >= 1, 'temporary committed key copy is zeroized');
  } finally {
    Buffer.prototype.fill = originalFill;
  }
});
