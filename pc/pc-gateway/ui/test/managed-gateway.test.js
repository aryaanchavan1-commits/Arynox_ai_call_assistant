import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  WINDOWS_PIPE,
  startWindowsGateway,
  windowsGatewayConfiguration,
} from '../electron/managed-gateway.js';

test('packaged Windows gateway uses per-user state and bundled runtime assets', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'agentcall-managed-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = windowsGatewayConfiguration({
    appPath: path.join(root, 'resources', 'app.asar'),
    isPackaged: true,
    resourcesPath: path.join(root, 'resources'),
    userData: path.join(root, 'user-data'),
    baseEnv: { PATH: 'safe-path' },
  });

  assert.equal(config.socketPath, WINDOWS_PIPE);
  assert.equal(config.gatewayPath, path.join(root, 'resources', 'gateway', 'src', 'gatewayd.js'));
  assert.equal(config.env.AGENTCALL_ADB_PATH, path.join(root, 'resources', 'platform-tools', 'adb.exe'));
  assert.equal(config.env.AGENTCALL_FFMPEG_PATH, path.join(root, 'resources', 'platform-tools', 'ffmpeg.exe'));
  assert.equal(config.env.AGENTCALL_ADB_SERVER_SOCKET, 'tcp:127.0.0.1:5037');
  assert.match(config.env.AGENTCALL_CONTROLLER_SECRET_FILE, /user-data[\\/]gateway[\\/]controller/);
  assert.equal(config.env.AGENTCALL_PROVIDER_TEST_PATH, config.providerTestPath);
  assert.equal(config.env.ELECTRON_RUN_AS_NODE, '1');
});

test('managed gateway is spawned without a shell and is stopped once', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'agentcall-managed-spawn-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = windowsGatewayConfiguration({
    appPath: path.join(root, 'app'),
    isPackaged: false,
    resourcesPath: path.join(root, 'resources'),
    userData: path.join(root, 'user-data'),
    baseEnv: { LOCALAPPDATA: root },
  });
  const calls = [];
  let kills = 0;
  const managed = startWindowsGateway(config, {
    executable: path.join(root, 'electron.exe'),
    spawnProcess: (...args) => {
      calls.push(args);
      return { exitCode: null, signalCode: null, kill: () => { kills += 1; } };
    },
  });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0][1], [config.gatewayPath]);
  assert.equal(calls[0][2].windowsHide, true);
  assert.equal(Object.hasOwn(calls[0][2], 'shell'), false);
  managed.stop();
  managed.stop();
  assert.equal(kills, 1);
});
