import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const sources = readdirSync(resolve(root, 'src'))
  .filter((name) => name.endsWith('.js'))
  .sort();
const testFiles = readdirSync(resolve(root, 'test'))
  .filter((name) => name.endsWith('.test.js'))
  .sort()
  .map((name) => resolve(root, 'test', name));

for (const source of sources) {
  const result = spawnSync(process.execPath, ['--check', resolve(root, 'src', source)], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const tests = spawnSync(process.execPath, ['--test', '--test-reporter=dot', ...testFiles], {
  cwd: root,
  stdio: 'inherit',
});
if (tests.status !== 0) process.exit(tests.status ?? 1);
console.log('check-ok');
