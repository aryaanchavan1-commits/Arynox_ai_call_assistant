import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import path from 'node:path';

const WINDOWS_PIPE = '\\\\.\\pipe\\agentcall-gatewayd-desktop';

export function windowsGatewayConfiguration({
  appPath,
  isPackaged,
  resourcesPath,
  userData,
  baseEnv = process.env,
} = {}) {
  if (![appPath, resourcesPath, userData].every((value) => typeof value === 'string' && path.isAbsolute(value))) {
    throw new Error('managed gateway paths must be absolute');
  }
  const gatewayRoot = isPackaged ? path.join(resourcesPath, 'gateway') : path.resolve(appPath, '..');
  const stateRoot = path.join(userData, 'gateway');
  const toolsRoot = path.join(resourcesPath, 'platform-tools');
  const adbPath = baseEnv.AGENTCALL_ADB_PATH
    || (isPackaged ? path.join(toolsRoot, 'adb.exe') : path.join(baseEnv.LOCALAPPDATA || '', 'Android', 'Sdk', 'platform-tools', 'adb.exe'));
  const ffmpegPath = baseEnv.AGENTCALL_FFMPEG_PATH
    || (isPackaged ? path.join(toolsRoot, 'ffmpeg.exe') : 'C:\\ffmpeg\\bin\\ffmpeg.exe');
  const socketPath = baseEnv.AGENTCALL_RPC_SOCKET || WINDOWS_PIPE;
  const recordingRoot = baseEnv.AGENTCALL_RECORDING_ROOT || path.join(stateRoot, 'recordings');
  const manifestPath = isPackaged
    ? path.join(gatewayRoot, 'matched-artifact.properties')
    : path.resolve(appPath, '..', '..', '..', 'protocol', 'matched-artifact.properties');
  return {
    gatewayPath: path.join(gatewayRoot, 'src', 'gatewayd.js'),
    logPath: path.join(stateRoot, 'logs', 'gatewayd.log'),
    providerTestPath: path.join(stateRoot, 'provider-test.wav'),
    recordingRoot,
    socketPath,
    env: {
      ...baseEnv,
      ELECTRON_RUN_AS_NODE: '1',
      AGENTCALL_MODE: 'hardware',
      AGENTCALL_RPC_SOCKET: socketPath,
      AGENTCALL_RECORDING_ROOT: recordingRoot,
      AGENTCALL_PROVIDER_SETTINGS_FILE: path.join(stateRoot, 'provider-settings.json'),
      AGENTCALL_PROVIDER_TEST_PATH: path.join(stateRoot, 'provider-test.wav'),
      AGENTCALL_CONTROLLER_SECRET_FILE: path.join(stateRoot, 'controller', 'controller.key'),
      AGENTCALL_REDACTION_SALT_FILE: path.join(stateRoot, 'redaction-salt'),
      AGENTCALL_ADB_HOME: path.join(stateRoot, 'adb'),
      AGENTCALL_ADB_PATH: adbPath,
      AGENTCALL_ADB_SERVER_SOCKET: baseEnv.AGENTCALL_ADB_SERVER_SOCKET || 'tcp:127.0.0.1:5037',
      AGENTCALL_HOST_PORT: baseEnv.AGENTCALL_HOST_PORT || '55040',
      AGENTCALL_PHONE_PORT: baseEnv.AGENTCALL_PHONE_PORT || '27183',
      AGENTCALL_MATCHED_ARTIFACT_FILE: manifestPath,
      AGENTCALL_FFMPEG_PATH: ffmpegPath,
    },
  };
}

export function startWindowsGateway(configuration, {
  executable = process.execPath,
  spawnProcess = spawn,
} = {}) {
  mkdirSync(path.dirname(configuration.logPath), { recursive: true, mode: 0o700 });
  const log = openSync(configuration.logPath, 'a', 0o600);
  let child;
  try {
    child = spawnProcess(executable, [configuration.gatewayPath], {
      env: configuration.env,
      stdio: ['ignore', log, log],
      windowsHide: true,
    });
  } finally {
    closeSync(log);
  }
  let stopped = false;
  return {
    child,
    stop() {
      if (stopped) return;
      stopped = true;
      if (child.exitCode === null && child.signalCode === null) child.kill();
    },
  };
}

export { WINDOWS_PIPE };
