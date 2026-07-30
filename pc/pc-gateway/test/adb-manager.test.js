import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { AdbManager, parseDevices, parseForwardList } from '../src/adb-manager.js';

// A fake exec runner that records calls and returns canned stdout.
function makeRunner(responses) {
  const calls = [];
  const run = (file, args, opts, cb) => {
    calls.push({ file, args: [...args], opts });
    const key = args.join(' ');
    // Try exact key, then key with a leading "-s SERIAL" stripped, then the first arg.
    const stripped = args[0] === '-s' && args.length > 2 ? args.slice(2).join(' ') : null;
    const entry =
      responses[key] ??
      (stripped ? responses[stripped] : undefined) ??
      responses[args[0]] ??
      { stdout: '', stderr: '', code: 0 };
    const code = entry.code ?? 0;
    setImmediate(() => {
      if (code !== 0) {
        const err = new Error(`adb ${key} failed`);
        err.code = code;
        err.stderr = entry.stderr ?? '';
        err.stdout = entry.stdout ?? '';
        return cb(err, entry.stdout ?? '', entry.stderr ?? '');
      }
      cb(null, entry.stdout ?? '', entry.stderr ?? '');
    });
  };
  return { run, calls };
}

test('parseDevices reads exactly one serial from a clean adb devices -l output', () => {
  const out = [
    'List of devices attached',
    'a1b2c3d4               device usb:1-3 product:gram model:POCO_M2_Pro transport_id:1',
    '',
  ].join('\n');
  const devs = parseDevices(out);
  assert.equal(devs.length, 1);
  assert.equal(devs[0].serial, 'a1b2c3d4');
  assert.equal(devs[0].state, 'device');
  assert.equal(devs[0].transportId, 1);
  assert.equal(devs[0].product, 'gram');
  assert.equal(devs[0].model, 'POCO_M2_Pro');
});

test('parseDevices ignores the daemon banner line and unrelated/unauthorized devices', () => {
  const out = [
    'List of devices attached',
    'adb daemon is starting up now',
    '',
    'SERIAL1                device usb:1-1 transport_id:3',
    'SERIAL2                offline usb:1-2 transport_id:4',
    'SERIAL3                unauthorized transport_id:5',
    'recovery-serial        recovery transport_id:6',
    '',
  ].join('\n');
  const devs = parseDevices(out);
  assert.equal(devs.length, 1);
  assert.equal(devs[0].serial, 'SERIAL1');
  assert.equal(devs[0].state, 'device');
});

test('parseDevices returns empty list when only the daemon banner is present', () => {
  const out = 'List of devices attached\n* daemon not running. starting it now on port 5037 *\n';
  const devs = parseDevices(out);
  assert.equal(devs.length, 0, 'no devices parsed while daemon was booting');
});

test('AdbManager consumes the real execFile callback shape (error, stdout, stderr)', async () => {
  const exec = (_file, _args, _opts, cb) => setImmediate(() => cb(
    null,
    'List of devices attached\nREAL device usb:1-1 transport_id:7\n',
    '',
  ));
  const devs = await new AdbManager({ adbPath: 'adb', exec }).listDevices();
  assert.equal(devs.length, 1);
  assert.equal(devs[0].serial, 'REAL');
  assert.equal(devs[0].transportId, 7);
});

test('AdbManager uses execFile with argument arrays only (never shell=true, never interpolation)', async () => {
  const { run, calls } = makeRunner({
    'devices -l': { stdout: 'List of devices attached\nAAA device usb:1-1 transport_id:1\n' },
  });
  const mgr = new AdbManager({ adbPath: 'adb', exec: run });
  const devs = await mgr.listDevices();
  assert.equal(devs.length, 1);
  assert.equal(devs[0].serial, 'AAA');
  assert.equal(calls[0].file, 'adb');
  assert.deepEqual(calls[0].args, ['devices', '-l']);
  assert.equal(calls[0].opts.shell, false);
  assert.equal(calls[0].opts.windowsHide, true);
});

test('AdbManager selects exactly one device by an exact serial string', async () => {
  const out = 'List of devices attached\nAAA device usb:1-1 transport_id:1\nBBB device usb:1-2 transport_id:2\n';
  const { run } = makeRunner({ 'devices -l': { stdout: out } });
  const mgr = new AdbManager({ adbPath: 'adb', exec: run });
  const dev = await mgr.selectBySerial('BBB');
  assert.equal(dev.serial, 'BBB');
  assert.equal(dev.transportId, 2);
});

test('AdbManager refuses to select when multiple devices are attached and no serial given', async () => {
  const out = 'List of devices attached\nAAA device usb:1-1 transport_id:1\nBBB device usb:1-2 transport_id:2\n';
  const { run } = makeRunner({ 'devices -l': { stdout: out } });
  const mgr = new AdbManager({ adbPath: 'adb', exec: run });
  await assert.rejects(() => mgr.selectOne(), /multiple|ambiguous|serial/i);
});

test('AdbManager distinguishes the private host-key authorization prompt from no phone', async () => {
  const out = 'List of devices attached\nAAA unauthorized usb:1-1 transport_id:1\n';
  const { run } = makeRunner({ 'devices -l': { stdout: out } });
  const mgr = new AdbManager({ adbPath: 'adb', exec: run });
  await assert.rejects(
    () => mgr.selectOne(),
    (error) => error.code === 'ADB_AUTHORIZATION_REQUIRED' && /authorization/i.test(error.message),
  );
  await assert.rejects(
    () => mgr.selectBySerial('AAA'),
    (error) => error.code === 'ADB_AUTHORIZATION_REQUIRED' && !error.message.includes('AAA'),
  );
});

test('AdbManager distinguishes an attached offline phone without exposing its serial', async () => {
  const out = 'List of devices attached\nSECRET-SERIAL offline usb:1-1 transport_id:1\n';
  const { run } = makeRunner({ 'devices -l': { stdout: out } });
  const mgr = new AdbManager({ adbPath: 'adb', exec: run });
  await assert.rejects(
    () => mgr.selectOne(),
    (error) => error.code === 'ADB_DEVICE_OFFLINE' && !error.message.includes('SECRET-SERIAL'),
  );
});

test('AdbManager refuses a serial that does not exactly match any attached device', async () => {
  const out = 'List of devices attached\nAAA device usb:1-1 transport_id:1\n';
  const { run } = makeRunner({ 'devices -l': { stdout: out } });
  const mgr = new AdbManager({ adbPath: 'adb', exec: run });
  await assert.rejects(() => mgr.selectBySerial('AAA; rm -rf /'), /refused|invalid|not found|no device/i);
  await assert.rejects(() => mgr.selectBySerial('AAA '), /refused|invalid|not found|no device/i);
  await assert.rejects(() => mgr.selectBySerial('aaaa'), /not found|no device/i);
});

test('AdbManager scopes operational forwards to the exact serial', async () => {
  const { run, calls } = makeRunner({ forward: { stdout: '127.0.0.1:5040' } });
  const mgr = new AdbManager({ adbPath: 'adb', exec: run });
  const spec = await mgr.forward({ serial: 'AAA', hostPort: 5040, phonePort: 5040 });
  assert.equal(spec.hostPort, 5040);
  assert.equal(spec.phonePort, 5040);
  assert.deepEqual(calls[0].args, ['-s', 'AAA', 'forward', 'tcp:5040', 'tcp:5040']);
  assert.equal(calls[0].opts.shell, false);
});

test('AdbManager rejects unsafe forward port numbers', async () => {
  const { run } = makeRunner({ forward: { stdout: '' } });
  const mgr = new AdbManager({ adbPath: 'adb', exec: run });
  await assert.rejects(() => mgr.forward({ serial: 'AAA', hostPort: 0, phonePort: 5040 }), /port/i);
  await assert.rejects(() => mgr.forward({ serial: 'AAA', hostPort: 80, phonePort: 5040 }), /port|reserved/i);
  await assert.rejects(() => mgr.forward({ serial: 'AAA', hostPort: 65536, phonePort: 5040 }), /port/i);
  await assert.rejects(() => mgr.forward({ serial: 'AAA', hostPort: -1, phonePort: 5040 }), /port/i);
  await assert.rejects(() => mgr.forward({ serial: 'AAA', hostPort: 22, phonePort: 5040 }), /port|reserved/i);
  await assert.rejects(() => mgr.forward({ serial: 'AAA', hostPort: 5040, phonePort: 0 }), /port/i);
});

test('AdbManager owns a serial-scoped random host port to the loopback bootstrap port', async () => {
  const { run, calls } = makeRunner({
    '-s AAA forward tcp:0 tcp:27184': { stdout: '54321\n' },
  });
  const mgr = new AdbManager({ adbPath: 'adb', exec: run });
  const forward = await mgr.forwardBootstrap({ serial: 'AAA' });
  assert.deepEqual(forward, { serial: 'AAA', hostPort: 54321, remote: 'tcp:27184' });
  assert.deepEqual(calls[0].args, ['-s', 'AAA', 'forward', 'tcp:0', 'tcp:27184']);
  await mgr.killForward(forward);
  assert.deepEqual(calls[1].args, ['-s', 'AAA', 'forward', '--remove', 'tcp:54321']);
});

test('AdbManager isolates adb in the daemon private server and key environment', async () => {
  const { run, calls } = makeRunner({ 'devices -l': { stdout: 'List of devices attached\n' } });
  const mgr = new AdbManager({
    adbPath: 'adb', exec: run,
    serverSocket: 'tcp:127.0.0.1:15037', adbHome: '/var/lib/agentcall/adb',
  });
  await mgr.listDevices();
  assert.equal(calls[0].opts.env.ADB_SERVER_SOCKET, 'tcp:127.0.0.1:15037');
  assert.equal(calls[0].opts.env.HOME, '/var/lib/agentcall/adb');
  assert.equal(calls[0].opts.env.ADB_VENDOR_KEYS, join('/var/lib/agentcall/adb', '.android', 'adbkey'));
});

test('AdbManager starts its loopback-private ADB server and retries when it is absent', async () => {
  const calls = [];
  let serverStarted = false;
  const run = (file, args, opts, cb) => {
    calls.push({ file, args: [...args], opts });
    if (args.join(' ') === '-P 15037 start-server') {
      serverStarted = true;
      return setImmediate(() => cb(null, '* daemon started successfully *\n', ''));
    }
    if (args.join(' ') === 'devices -l' && !serverStarted) {
      const err = new Error('cannot connect to private adb server');
      err.code = 1;
      err.stderr = "adb: failed to check server version: cannot connect to daemon at tcp:127.0.0.1:15037\n";
      return setImmediate(() => cb(err, '', err.stderr));
    }
    return setImmediate(() => cb(
      null,
      'List of devices attached\nAAA device usb:1-1 product:gram model:POCO_M2_Pro device:atoll transport_id:1\n',
      '',
    ));
  };
  const mgr = new AdbManager({
    adbPath: 'adb', exec: run,
    serverSocket: 'tcp:127.0.0.1:15037', adbHome: '/var/lib/agentcall/adb',
  });

  const devices = await mgr.listDevices();

  assert.equal(devices.length, 1);
  assert.equal(devices[0].serial, 'AAA');
  assert.deepEqual(calls.map((call) => call.args), [
    ['devices', '-l'],
    ['-P', '15037', 'start-server'],
    ['devices', '-l'],
  ]);
  assert.equal(calls[1].opts.env.ADB_SERVER_SOCKET, undefined);
  assert.equal(calls[1].opts.env.HOME, '/var/lib/agentcall/adb');
  assert.equal(calls[1].opts.env.ADB_VENDOR_KEYS, join('/var/lib/agentcall/adb', '.android', 'adbkey'));
  assert.equal(calls[2].opts.env.ADB_SERVER_SOCKET, 'tcp:127.0.0.1:15037');
});

test('AdbManager verifies expected identity/fingerprint before claiming a device', async () => {
  const out = 'List of devices attached\nAAA device usb:1-1 transport_id:1\n';
  const identity = {
    product: 'gram',
    model: 'POCO_M2_Pro',
    fingerprint: 'xiaomi/gram/gram:15/abcd',
  };
  const { run, calls } = makeRunner({
    'devices -l': { stdout: out },
    'shell getprop ro.product.name': { stdout: 'gram\n' },
    'shell getprop ro.product.model': { stdout: 'POCO_M2_Pro\n' },
    'shell getprop ro.build.fingerprint': { stdout: 'xiaomi/gram/gram:15/abcd\n' },
  });
  const mgr = new AdbManager({ adbPath: 'adb', exec: run, expectedIdentity: identity });
  const dev = await mgr.verifyIdentity('AAA');
  assert.equal(dev.serial, 'AAA');
  assert.equal(dev.identity.product, 'gram');
  assert.equal(dev.identity.fingerprint, 'xiaomi/gram/gram:15/abcd');
  const shellCalls = calls.filter((c) => c.args[0] === 'shell');
  for (const c of shellCalls) {
    assert.equal(c.opts.shell, false);
    assert.ok(c.args[1] === 'getprop');
    assert.ok(typeof c.args[2] === 'string' && !c.args[2].includes('$') && !c.args[2].includes(';'));
  }
});

test('AdbManager rejects identity mismatch (wrong fingerprint) as a safety stop', async () => {
  const out = 'List of devices attached\nAAA device usb:1-1 transport_id:1\n';
  const identity = {
    product: 'gram',
    model: 'POCO_M2_Pro',
    fingerprint: 'xiaomi/gram/gram:15/EXPECTED',
  };
  const { run } = makeRunner({
    'devices -l': { stdout: out },
    'shell getprop ro.product.name': { stdout: 'gram\n' },
    'shell getprop ro.product.model': { stdout: 'POCO_M2_Pro\n' },
    'shell getprop ro.build.fingerprint': { stdout: 'xiaomi/gram/gram:15/ATTEMPTED\n' },
  });
  const mgr = new AdbManager({ adbPath: 'adb', exec: run, expectedIdentity: identity });
  await assert.rejects(() => mgr.verifyIdentity('AAA'), /identity|fingerprint|mismatch/i);
});

test('parseForwardList parses "adb forward --list" output', () => {
  const out = 'AAA tcp:5040 tcp:5040\nBBB tcp:5041 tcp:5041\n';
  const list = parseForwardList(out);
  assert.equal(list.length, 2);
  assert.deepEqual(list[0], { serial: 'AAA', hostPort: 5040, phonePort: 5040 });
});

test('AdbManager health() reports connected only when devices -l returns one authorized device', async () => {
  const good = 'List of devices attached\nAAA device usb:1-1 transport_id:1\n';
  const unauthorized = 'List of devices attached\nAAA unauthorized transport_id:1\n';
  const empty = 'List of devices attached\n';

  const r1 = makeRunner({ 'devices -l': { stdout: good } });
  const r2 = makeRunner({ 'devices -l': { stdout: unauthorized } });
  const r3 = makeRunner({ 'devices -l': { stdout: empty } });

  assert.equal((await new AdbManager({ exec: r1.run }).health()).connected, true);
  assert.equal((await new AdbManager({ exec: r2.run }).health()).connected, false);
  assert.equal((await new AdbManager({ exec: r3.run }).health()).connected, false);
});

test('AdbManager reconnect re-establishes health after a transient failure', async () => {
  let devicesOut = 'List of devices attached\nAAA offline usb:1-1 transport_id:1\n';
  const calls = [];
  const run = (file, args, opts, cb) => {
    calls.push({ args: [...args] });
    if (args[0] === 'devices' && args[1] === '-l') {
      return setImmediate(() => cb(null, devicesOut, ''));
    }
    if (args[0] === 'reconnect' || args[0] === 'kill-server') {
      devicesOut = 'List of devices attached\nAAA device usb:1-1 transport_id:1\n';
      return setImmediate(() => cb(null, '', ''));
    }
    setImmediate(() => cb(null, '', ''));
  };
  const mgr = new AdbManager({ adbPath: 'adb', exec: run });
  const before = await mgr.health();
  assert.equal(before.connected, false);
  await mgr.reconnect();
  const after = await mgr.health();
  assert.equal(after.connected, true);
});

test('AdbManager killForward uses exact "forward --remove" arguments', async () => {
  const { run, calls } = makeRunner({ forward: { stdout: '' } });
  const mgr = new AdbManager({ adbPath: 'adb', exec: run });
  await mgr.forward({ serial: 'AAA', hostPort: 5040, phonePort: 5040 });
  await mgr.killForward({ serial: 'AAA', hostPort: 5040 });
  const removeCall = calls.find((c) => c.args.includes('--remove'));
  assert.ok(removeCall, 'forward --remove was issued');
  assert.deepEqual(removeCall.args, ['-s', 'AAA', 'forward', '--remove', 'tcp:5040']);
  assert.equal(removeCall.opts.shell, false);
});

test('AdbManager killForward is idempotent only when the exact listener is already absent', async () => {
  const missing = makeRunner({
    'forward --remove tcp:5040': { code: 1, stderr: "adb: error: listener 'tcp:5040' not found\n" },
  });
  await new AdbManager({ adbPath: 'adb', exec: missing.run }).killForward({ serial: 'AAA', hostPort: 5040 });

  const otherFailure = makeRunner({
    'forward --remove tcp:5040': { code: 1, stderr: 'adb: error: device offline\n' },
  });
  await assert.rejects(
    () => new AdbManager({ adbPath: 'adb', exec: otherFailure.run }).killForward({ serial: 'AAA', hostPort: 5040 }),
    /failed/,
  );
});
