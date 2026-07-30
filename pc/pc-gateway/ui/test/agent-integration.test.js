import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { agentIntegrationConfiguration } from '../electron/main.js';

test('packaged Windows agent commands use the bundled cmd launcher', () => {
  const resourcesPath = path.resolve('C:/agentcall/resources');
  const integration = agentIntegrationConfiguration({
    platform: 'win32',
    isPackaged: true,
    resourcesPath,
  });
  const launcher = path.join(resourcesPath, 'bin', 'agentcall-mcp.cmd');

  assert.equal(integration.os, 'Windows');
  assert.equal(integration.launcher, launcher);
  assert.equal(integration.hermesAdd, `hermes mcp add agentcall --command "${launcher}"`);
  assert.equal(integration.openclawAdd, `openclaw mcp add agentcall --command "${launcher}"`);
  assert.doesNotMatch(integration.launcher, /\/usr\/bin/);
});

test('development Windows and installed Linux launchers remain platform specific', () => {
  const windows = agentIntegrationConfiguration({
    platform: 'win32',
    isPackaged: false,
    appPath: path.resolve('pc/pc-gateway/ui'),
  });
  const linux = agentIntegrationConfiguration({ platform: 'linux' });

  assert.equal(windows.os, 'Windows');
  assert.match(windows.launcher, /^node ".*mcp-server\.js"$/);
  assert.doesNotMatch(windows.launcher, /\/usr\/bin/);
  assert.deepEqual(linux, {
    os: 'Linux',
    launcher: '/usr/bin/agentcall-mcp',
    hermesAdd: 'hermes mcp add agentcall --command /usr/bin/agentcall-mcp',
    openclawAdd: 'openclaw mcp add agentcall --command /usr/bin/agentcall-mcp',
  });
});
