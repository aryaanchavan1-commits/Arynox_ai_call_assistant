import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const packageJson = JSON.parse(
  await readFile(new URL('../package.json', import.meta.url), 'utf8'),
);

test('Node 20 test scripts use a portable direct test glob', () => {
  assert.equal(packageJson.scripts.test.includes('test/*.test.js'), true);
  assert.equal(packageJson.scripts.check.includes('test/*.test.js'), true);
  assert.equal(packageJson.scripts.test.includes('**/*.test.js'), false);
  assert.equal(packageJson.scripts.check.includes('**/*.test.js'), false);
});
