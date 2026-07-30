// Wraps adb with argument-array-only execFile. No shell. No string interpolation of
// untrusted input into argv. All serial/port values are validated before reaching adb.

import { execFile } from 'node:child_process';
import { isAbsolute, join } from 'node:path';

const SERIAL_RE = /^[A-Za-z0-9._-]{3,64}$/; // no metachars, no spaces, fixed shape
const RESERVED_PORTS = new Set([
  // ponytail: reject well-known/reserved ports defensively; the dynamic/private
  // range 49152-65535 is where a real forward lives, but we allow 1024-65535 so
  // the policy module can pick its own port. Add reserved entries here if needed.
]);

function isValidPort(p) {
  return Number.isInteger(p) && p >= 1024 && p <= 65535 && !RESERVED_PORTS.has(p);
}

/**
 * Parse `adb devices -l` output. Returns only fully-authorized, 'device'-state rows.
 * Daemon banner lines and blank lines are ignored; anything else that does not
 * match the strict row shape is skipped (never crashes on a surprise line).
 */
export function parseDevices(stdout) {
  const out = [];
  const lines = String(stdout).split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('List of devices')) continue;
    if (trimmed.startsWith('* daemon')) continue;
    if (trimmed.startsWith('adb daemon')) continue;
    // Expected: SERIAL   state  usb:... product:.. model:.. transport_id:N
    const m = trimmed.match(/^(\S+)\s+(\S+)(?:\s+usb:\S+)?(?:\s+product:(\S+))?(?:\s+model:(\S+))?(?:\s+device:(\S+))?\s+transport_id:(\d+)$/);
    if (!m) continue;
    const [, serial, state, product, model, name, transportId] = m;
    if (state !== 'device') continue; // skip offline/unauthorized/recovery/sideload
    out.push({
      serial,
      state,
      product: product ?? null,
      model: model ?? null,
      name: name ?? null,
      transportId: Number(transportId),
    });
  }
  return out;
}

function parseUnavailableDevices(stdout) {
  const out = [];
  for (const line of String(stdout).split(/\r?\n/)) {
    const match = line.trim().match(/^([A-Za-z0-9._-]{3,64})\s+(unauthorized|offline|recovery|sideload)(?:\s|$)/);
    if (match) out.push({ serial: match[1], state: match[2] });
  }
  return out;
}

function selectionError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function parseForwardList(stdout) {
  const out = [];
  for (const line of String(stdout).split(/\r?\n/)) {
    const m = line.trim().match(/^(\S+)\s+tcp:(\d+)\s+tcp:(\d+)$/);
    if (!m) continue;
    out.push({ serial: m[1], hostPort: Number(m[2]), phonePort: Number(m[3]) });
  }
  return out;
}

export class AdbManager {
  constructor(opts = {}) {
    this.adbPath = opts.adbPath ?? 'adb';
    // Default exec is node's execFile; tests inject a fake.
    this._exec = opts.exec ?? ((file, args, o, cb) => execFile(file, args, o, cb));
    this.expectedIdentity = opts.expectedIdentity ?? null;
    this._timeoutMs = opts.timeoutMs ?? 5000;
    this.serverSocket = opts.serverSocket ?? 'tcp:127.0.0.1:15037';
    this.adbHome = opts.adbHome ?? '/var/lib/agentcall/adb';
    this.platform = opts.platform ?? process.platform;
    if (!/^tcp:127\.0\.0\.1:\d{4,5}$/.test(this.serverSocket)) throw new Error('private adb server socket is invalid');
    if (typeof this.adbHome !== 'string' || !isAbsolute(this.adbHome) || this.adbHome.length > 300) {
      throw new Error('private adb home is invalid');
    }
    this._serverStartPromise = null;
  }

  _privateEnv() {
    return {
      ...process.env,
      ADB_SERVER_SOCKET: this.serverSocket,
      HOME: this.adbHome,
      USERPROFILE: this.platform === 'win32' ? this.adbHome : process.env.USERPROFILE,
      ADB_VENDOR_KEYS: join(this.adbHome, '.android', 'adbkey'),
    };
  }

  _execFile(args, env) {
    const opts = {
      shell: false,
      windowsHide: true,
      timeout: this._timeoutMs,
      maxBuffer: 1 << 20,
      env,
    };
    return new Promise((resolve, reject) => {
      this._exec(this.adbPath, args, opts, (err, stdout = '', stderr = '') => {
        if (err) {
          err.stdout ??= String(stdout);
          err.stderr ??= String(stderr);
          return reject(err);
        }
        resolve({ stdout: String(stdout), stderr: String(stderr) });
      });
    });
  }

  _isPrivateServerUnavailable(error) {
    const text = `${error?.message ?? ''}\n${error?.stderr ?? ''}`;
    return text.includes(this.serverSocket)
      && /cannot connect to daemon|failed to check server version|cannot start server on remote host/i.test(text);
  }

  async _startPrivateServer() {
    if (!this._serverStartPromise) {
      const port = this.serverSocket.slice(this.serverSocket.lastIndexOf(':') + 1);
      const env = this._privateEnv();
      delete env.ADB_SERVER_SOCKET;
      delete env.ADB_SERVER_PORT;
      this._serverStartPromise = this._execFile(['-P', port, 'start-server'], env)
        .finally(() => { this._serverStartPromise = null; });
    }
    await this._serverStartPromise;
  }

  async _run(args) {
    // Keep both the server and host key daemon-private. Never join the user's global adb server.
    try {
      return await this._execFile(args, this._privateEnv());
    } catch (error) {
      if (!this._isPrivateServerUnavailable(error)) throw error;
      await this._startPrivateServer();
      return this._execFile(args, this._privateEnv());
    }
  }

  async listDevices() {
    const { stdout } = await this._run(['devices', '-l']);
    return parseDevices(stdout);
  }

  async _deviceSnapshot() {
    const { stdout } = await this._run(['devices', '-l']);
    return { ready: parseDevices(stdout), unavailable: parseUnavailableDevices(stdout) };
  }

  async selectBySerial(serial) {
    if (typeof serial !== 'string' || !SERIAL_RE.test(serial)) {
      throw new Error(`refused invalid serial: ${JSON.stringify(serial)}`);
    }
    const snapshot = await this._deviceSnapshot();
    const match = snapshot.ready.find((d) => d.serial === serial);
    if (!match) {
      const unavailable = snapshot.unavailable.find((d) => d.serial === serial);
      if (unavailable?.state === 'unauthorized') {
        throw selectionError('ADB_AUTHORIZATION_REQUIRED', 'phone is waiting for USB debugging authorization');
      }
      if (unavailable) throw selectionError('ADB_DEVICE_OFFLINE', 'phone is not ready for ADB');
      throw selectionError('ADB_DEVICE_NOT_FOUND', 'paired phone device not found');
    }
    return match;
  }

  async selectOne() {
    const snapshot = await this._deviceSnapshot();
    const devs = snapshot.ready;
    if (devs.length === 0 && snapshot.unavailable.some((device) => device.state === 'unauthorized')) {
      throw selectionError('ADB_AUTHORIZATION_REQUIRED', 'phone is waiting for USB debugging authorization');
    }
    if (devs.length === 0 && snapshot.unavailable.length > 0) {
      throw selectionError('ADB_DEVICE_OFFLINE', 'phone is not ready for ADB');
    }
    if (devs.length === 0) throw selectionError('ADB_DEVICE_NOT_FOUND', 'no phone is attached');
    if (devs.length > 1) throw new Error('multiple devices attached; specify a serial');
    return devs[0];
  }

  _validateSerial(serial) {
    if (typeof serial !== 'string' || !SERIAL_RE.test(serial)) {
      throw new Error(`refused invalid serial: ${JSON.stringify(serial)}`);
    }
  }

  async forward({ serial, hostPort, phonePort }) {
    this._validateSerial(serial);
    if (!isValidPort(hostPort)) throw new RangeError(`invalid/reserved host port: ${hostPort}`);
    if (!isValidPort(phonePort)) throw new RangeError(`invalid/reserved phone port: ${phonePort}`);
    await this._run(['-s', serial, 'forward', `tcp:${hostPort}`, `tcp:${phonePort}`]);
    return { serial, hostPort, phonePort };
  }

  async forwardBootstrap({ serial }) {
    this._validateSerial(serial);
    const remote = 'tcp:27184';
    const { stdout } = await this._run(['-s', serial, 'forward', 'tcp:0', remote]);
    const hostPort = Number(stdout.trim());
    if (!isValidPort(hostPort)) throw new Error('adb returned an invalid bootstrap port');
    return { serial, hostPort, remote };
  }

  async killForward({ serial, hostPort }) {
    this._validateSerial(serial);
    if (!isValidPort(hostPort)) throw new RangeError(`invalid host port: ${hostPort}`);
    const listener = `tcp:${hostPort}`;
    try {
      await this._run(['-s', serial, 'forward', '--remove', listener]);
    } catch (error) {
      if (String(error?.stderr ?? '').trim() === `adb: error: listener '${listener}' not found`) return;
      throw error;
    }
  }

  async getprop(serial, prop) {
    if (!SERIAL_RE.test(serial)) throw new Error(`refused invalid serial: ${JSON.stringify(serial)}`);
    if (!/^ro\.[A-Za-z0-9_.]+$/.test(prop)) throw new Error(`refused invalid getprop name: ${JSON.stringify(prop)}`);
    const { stdout } = await this._run(['-s', serial, 'shell', 'getprop', prop]);
    return stdout.trim();
  }

  async verifyIdentity(serial) {
    if (!this.expectedIdentity) {
      // No expected identity configured: still require the device to be present.
      return this.selectBySerial(serial);
    }
    const dev = await this.selectBySerial(serial);
    const actual = {
      product: await this.getprop(serial, 'ro.product.name'),
      device: await this.getprop(serial, 'ro.product.device'),
      model: await this.getprop(serial, 'ro.product.model'),
      api: await this.getprop(serial, 'ro.build.version.sdk'),
      fingerprint: await this.getprop(serial, 'ro.build.fingerprint'),
      vendorFingerprint: await this.getprop(serial, 'ro.vendor.build.fingerprint'),
    };
    for (const key of Object.keys(this.expectedIdentity)) {
      const want = this.expectedIdentity[key];
      if (want && want !== actual[key]) {
        throw new Error(`identity mismatch: ${key} expected ${JSON.stringify(want)}, got ${JSON.stringify(actual[key])}`);
      }
    }
    dev.identity = actual;
    return dev;
  }

  async health() {
    try {
      const devs = await this.listDevices();
      return { connected: devs.length >= 1, device: devs[0] ?? null };
    } catch {
      return { connected: false, device: null };
    }
  }

  async reconnect() {
    // Best-effort: ask the daemon to reconnect offline devices; if still bad, restart server.
    try {
      await this._run(['reconnect', 'offline']);
    } catch { /* ignore; will retry via kill-server */ }
    const h = await this.health();
    if (h.connected) return h;
    await this._run(['kill-server']);
    await this._run(['start-server']);
    return this.health();
  }
}
