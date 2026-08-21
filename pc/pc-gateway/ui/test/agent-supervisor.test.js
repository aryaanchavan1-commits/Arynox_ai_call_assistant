import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import test from 'node:test';

import {
  AgentAnsweringSupervisor,
  agentSupervisorConfiguration,
} from '../electron/agent-supervisor.js';

test('supervisor configuration launches the packaged receptionist with the local socket', () => {
  const configuration = agentSupervisorConfiguration({
    platform: 'win32',
    isPackaged: true,
    resourcesPath: 'C:\\Arynox\\resources',
    appPath: 'C:\\Arynox\\resources\\app.asar',
    execPath: 'C:\\Arynox\\Arynox AI Call Assistant.exe',
    socketPath: '\\\\.\\pipe\\agentcall-gatewayd-desktop',
    environment: { SAFE_SETTING: 'kept' },
  });
  assert.equal(configuration.command, 'C:\\Arynox\\Arynox AI Call Assistant.exe');
  assert.equal(
    configuration.args[0],
    path.join('C:\\Arynox\\resources', 'gateway', 'scripts', 'hermes-voice-supervisor.js'),
  );
  assert.equal(configuration.environment.ELECTRON_RUN_AS_NODE, '1');
  assert.equal(configuration.environment.AGENTCALL_RECEPTIONIST_MODE, 'yes');
  assert.equal(configuration.environment.AGENTCALL_RPC_SOCKET, '\\\\.\\pipe\\agentcall-gatewayd-desktop');
});

test('answering supervisor stays running, restarts after failure, and stops when disabled', () => {
  const children = [];
  const timers = [];
  const spawnImpl = (...args) => {
    const child = new EventEmitter();
    child.args = args;
    child.killed = false;
    child.kill = () => { child.killed = true; };
    children.push(child);
    return child;
  };
  const supervisor = new AgentAnsweringSupervisor({
    configuration: {
      command: 'node',
      args: ['/agentcall/hermes-voice-supervisor.js'],
      environment: { AGENTCALL_RECEPTIONIST_MODE: 'yes' },
    },
    spawnImpl,
    setTimer: (callback) => {
      const timer = { callback, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      const index = timers.indexOf(timer);
      if (index >= 0) timers.splice(index, 1);
    },
  });

  supervisor.sync({ enabled: true, instructions: 'Take a message.' });
  assert.equal(children.length, 1);
  assert.equal(children[0].args[2].stdio, 'ignore');
  supervisor.sync({ enabled: true, instructions: 'Take a message.' });
  assert.equal(children.length, 1);
  supervisor.sync({ enabled: true, instructions: 'I am in a meeting. Take a message.' });
  assert.equal(children[0].killed, true);
  assert.equal(children.length, 2);
  supervisor.sync(
    { enabled: true, instructions: 'I am in a meeting. Take a message.' },
    { refresh: true },
  );
  assert.equal(children[1].killed, true);
  assert.equal(children.length, 3);
  children[2].emit('exit', 1);
  assert.equal(timers.length, 1);
  timers.shift().callback();
  assert.equal(children.length, 4);
  supervisor.sync({ enabled: false });
  assert.equal(children[3].killed, true);
});
