import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';

const VERSION = 1;
const DEFAULT_PATH = '/var/lib/agentcall/agent-answering.json';
const MAX_INSTRUCTIONS = 2_000;

function validateInstructions(value) {
  if (typeof value !== 'string' || value.length > MAX_INSTRUCTIONS
      || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) {
    throw new Error('agent answering instructions are invalid');
  }
  return value.replace(/\r\n?/gu, '\n').trim();
}

function validateState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || value.version !== VERSION || typeof value.enabled !== 'boolean') {
    throw new Error('agent answering settings are invalid');
  }
  const keys = Object.keys(value);
  if (keys.length !== 3 || !keys.every((key) => ['version', 'enabled', 'instructions'].includes(key))) {
    throw new Error('agent answering settings are invalid');
  }
  return Object.freeze({
    version: VERSION,
    enabled: value.enabled,
    instructions: validateInstructions(value.instructions),
  });
}

export function agentAnsweringPathFromEnv(env = process.env) {
  if (env.AGENTCALL_AGENT_ANSWERING_FILE) return env.AGENTCALL_AGENT_ANSWERING_FILE;
  if (process.platform === 'win32' && env.APPDATA) {
    return join(env.APPDATA, 'agentcall-desktop', 'gateway', 'agent-answering.json');
  }
  return DEFAULT_PATH;
}

export class AgentAnsweringSettingsStore {
  constructor({ path }) {
    if (typeof path !== 'string' || !isAbsolute(path) || path.length > 4_096) {
      throw new Error('agent answering settings path is invalid');
    }
    this.path = path;
    this.state = null;
  }

  async #load() {
    if (this.state) return this.state;
    try {
      this.state = validateState(JSON.parse(await readFile(this.path, 'utf8')));
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      this.state = Object.freeze({ version: VERSION, enabled: false, instructions: '' });
    }
    return this.state;
  }

  async status() {
    const state = await this.#load();
    return { enabled: state.enabled, instructions: state.instructions };
  }

  async configure(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).length !== 2
        || !Object.hasOwn(value, 'enabled') || !Object.hasOwn(value, 'instructions')) {
      throw new Error('agent answering settings are invalid');
    }
    const { enabled, instructions } = value;
    const next = validateState({ version: VERSION, enabled, instructions });
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.tmp-${process.pid}-${Date.now().toString(36)}`;
    let handle;
    try {
      handle = await open(temporary, 'wx', 0o600);
      await handle.writeFile(`${JSON.stringify(next)}\n`, 'utf8');
      await handle.sync();
      await handle.close();
      handle = null;
      await rename(temporary, this.path);
    } finally {
      await handle?.close().catch(() => {});
      await rm(temporary, { force: true });
    }
    this.state = next;
    return this.status();
  }
}
