import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  AgentAnsweringSettingsStore,
  agentAnsweringPathFromEnv,
} from '../src/agent-answering-settings.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'agentcall-answering-'));
  return {
    root,
    path: join(root, 'private', 'agent-answering.json'),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

test('agent answering mode is disabled by default and uses a bounded absolute path', async () => {
  const item = await fixture();
  try {
    const store = new AgentAnsweringSettingsStore({ path: item.path });
    assert.deepEqual(await store.status(), { enabled: false, instructions: '' });
    assert.equal(agentAnsweringPathFromEnv({
      AGENTCALL_AGENT_ANSWERING_FILE: item.path,
    }), item.path);
    assert.throws(() => new AgentAnsweringSettingsStore({ path: 'relative.json' }), /path/i);
  } finally {
    await item.cleanup();
  }
});

test('agent answering context persists atomically without temporary leftovers', async () => {
  const item = await fixture();
  try {
    const instructions = 'I am in a meeting.\r\nCollect the caller name and reason.';
    const store = new AgentAnsweringSettingsStore({ path: item.path });
    assert.deepEqual(await store.configure({ enabled: true, instructions }), {
      enabled: true,
      instructions: 'I am in a meeting.\nCollect the caller name and reason.',
    });
    assert.deepEqual(await new AgentAnsweringSettingsStore({ path: item.path }).status(), {
      enabled: true,
      instructions: 'I am in a meeting.\nCollect the caller name and reason.',
    });
    assert.equal((await stat(item.path)).isFile(), true);
    assert.deepEqual(await readdir(join(item.root, 'private')), ['agent-answering.json']);
    const persisted = JSON.parse(await readFile(item.path, 'utf8'));
    assert.deepEqual(persisted, {
      version: 1,
      enabled: true,
      instructions: 'I am in a meeting.\nCollect the caller name and reason.',
    });
  } finally {
    await item.cleanup();
  }
});

test('agent answering settings reject unknown fields, control characters, and oversized context', async () => {
  const item = await fixture();
  try {
    const store = new AgentAnsweringSettingsStore({ path: item.path });
    await assert.rejects(
      store.configure({ enabled: true, instructions: 'hello', extra: true }),
      /invalid/i,
    );
    await assert.rejects(
      store.configure({ enabled: true, instructions: 'hello\u0000world' }),
      /invalid/i,
    );
    await assert.rejects(
      store.configure({ enabled: true, instructions: 'x'.repeat(2_001) }),
      /invalid/i,
    );
  } finally {
    await item.cleanup();
  }
});
