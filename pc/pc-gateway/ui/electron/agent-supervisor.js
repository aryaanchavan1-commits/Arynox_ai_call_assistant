import { spawn } from 'node:child_process';
import path from 'node:path';

export function agentSupervisorConfiguration({
  platform = process.platform,
  isPackaged = false,
  resourcesPath = process.resourcesPath,
  appPath = process.cwd(),
  execPath = process.execPath,
  socketPath,
  environment = process.env,
} = {}) {
  if (typeof socketPath !== 'string' || socketPath.length === 0) {
    throw new TypeError('gateway socket path is required');
  }
  const script = isPackaged
    ? (platform === 'win32'
        ? path.join(resourcesPath, 'gateway', 'scripts', 'hermes-voice-supervisor.js')
        : '/usr/lib/agentcall/pc-gateway/scripts/hermes-voice-supervisor.js')
    : path.resolve(appPath, '..', 'scripts', 'hermes-voice-supervisor.js');
  return Object.freeze({
    command: execPath,
    args: Object.freeze([script]),
    environment: Object.freeze({
      ...environment,
      ELECTRON_RUN_AS_NODE: '1',
      AGENTCALL_RECEPTIONIST_MODE: 'yes',
      AGENTCALL_RPC_SOCKET: socketPath,
    }),
  });
}

export class AgentAnsweringSupervisor {
  constructor({
    configuration,
    spawnImpl = spawn,
    restartDelayMs = 5_000,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  } = {}) {
    if (!configuration?.command || !Array.isArray(configuration.args) || !configuration.environment) {
      throw new TypeError('agent supervisor configuration is required');
    }
    this.configuration = configuration;
    this.spawn = spawnImpl;
    this.restartDelayMs = restartDelayMs;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.enabled = false;
    this.instructions = '';
    this.child = null;
    this.restartTimer = null;
  }

  sync({ enabled, instructions = '' } = {}, { refresh = false } = {}) {
    const nextEnabled = enabled === true;
    const nextInstructions = nextEnabled && typeof instructions === 'string' ? instructions : '';
    const mustRefresh = this.enabled && nextEnabled
      && (this.instructions !== nextInstructions || refresh === true);
    this.enabled = nextEnabled;
    this.instructions = nextInstructions;
    if (!this.enabled) {
      this.stop();
      return;
    }
    if (mustRefresh) this.refresh();
    else this.#start();
  }

  #start() {
    if (!this.enabled || this.child || this.restartTimer) return;
    const child = this.spawn(this.configuration.command, this.configuration.args, {
      env: this.configuration.environment,
      windowsHide: true,
      stdio: 'ignore',
    });
    this.child = child;
    const finished = () => {
      if (this.child !== child) return;
      this.child = null;
      if (!this.enabled || this.restartTimer) return;
      this.restartTimer = this.setTimer(() => {
        this.restartTimer = null;
        this.#start();
      }, this.restartDelayMs);
      this.restartTimer?.unref?.();
    };
    child.once('error', finished);
    child.once('exit', finished);
  }

  refresh() {
    if (!this.enabled) return;
    if (this.restartTimer) this.clearTimer(this.restartTimer);
    this.restartTimer = null;
    const child = this.child;
    this.child = null;
    child?.kill('SIGTERM');
    this.#start();
  }

  stop() {
    this.enabled = false;
    this.instructions = '';
    if (this.restartTimer) this.clearTimer(this.restartTimer);
    this.restartTimer = null;
    const child = this.child;
    this.child = null;
    child?.kill('SIGTERM');
  }
}
