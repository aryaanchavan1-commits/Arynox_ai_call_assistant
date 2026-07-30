import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../electron/preload.cjs', import.meta.url), 'utf8');

test('preload exposes only a bounded one-way native navigation listener', () => {
  assert.match(source, /navigation:route/);
  assert.match(source, /ROUTES/);
  assert.match(source, /ipcRenderer\.on\(['"]navigation:route['"]/);
  assert.match(source, /return\s*\(\)\s*=>\s*ipcRenderer\.removeListener/);
  assert.match(source, /checkProviderHealth:\s*\(kind\)\s*=>\s*invoke\(['"]action:provider-health['"],\s*\{\s*kind\s*\}\)/);
  assert.match(source, /testProviders:\s*\(\)\s*=>\s*invoke\(['"]action:provider-test['"],\s*\{\s*\}\)/);
  assert.doesNotMatch(source, /ipcRenderer\.send\s*\(/);
});
