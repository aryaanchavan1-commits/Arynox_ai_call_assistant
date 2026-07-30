import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

const execFileAsync = promisify(execFile);
const script = fileURLToPath(new URL('../scripts/simulator-soak.js', import.meta.url));

test('minimum-duration simulator soak uses no warmup so package smoke remains valid', async () => {
  const { stdout, stderr } = await execFileAsync(process.execPath, [script, '1000'], {
    env: { ...process.env, AGENTCALL_SOAK_WARMUP_MS: undefined },
    timeout: 15_000,
  });
  assert.equal(stderr, '');
  const report = JSON.parse(stdout);
  assert.equal(report.durationMs, 1000);
  assert.equal(report.warmupMs, 0);
  assert.equal(report.warmupCalls, 0);
  assert.equal(report.rssWarm, report.rssCold);
  assert.equal(report.heapWarm, report.heapCold);
});

test('simulator soak measures leak growth after a bounded lifecycle warmup', async () => {
  const { stdout, stderr } = await execFileAsync(process.execPath, [script, '2000'], {
    env: { ...process.env, AGENTCALL_SOAK_WARMUP_MS: '1000' },
    timeout: 15_000,
  });
  assert.equal(stderr, '');
  const report = JSON.parse(stdout);

  assert.equal(report.identity, 'SIMULATOR');
  assert.equal(report.simulator, true);
  assert.equal(report.durationMs, 2000);
  assert.equal(report.warmupMs, 1000);
  assert.ok(report.calls > 0);
  assert.ok(report.warmupCalls > 0);
  assert.ok(report.calls > report.warmupCalls);
  assert.ok(report.samples >= 2);
  assert.ok(Number.isSafeInteger(report.rssCold));
  assert.ok(Number.isSafeInteger(report.rssWarm));
  assert.equal(report.rssGrowth, report.rssEnd - report.rssWarm);
  assert.ok(Number.isSafeInteger(report.heapCold));
  assert.ok(Number.isSafeInteger(report.heapWarm));
  assert.equal(report.heapGrowth, report.heapEnd - report.heapWarm);
  assert.equal(report.activeCalls, 0);
  assert.equal(report.sockets, 1);
  assert.ok(report.fdsEnd <= report.fdsWarm + 2);
});
