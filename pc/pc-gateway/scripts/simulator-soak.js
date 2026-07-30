#!/usr/bin/env node

import { randomBytes } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { DeviceClient, PCM_FRAME_BYTES } from '../src/device-client.js';
import { PhoneSimulator } from '../src/phone-simulator.js';

const durationMs = Number(process.env.AGENTCALL_SOAK_MS || process.argv[2] || 60_000);
if (!Number.isSafeInteger(durationMs) || durationMs < 1_000 || durationMs > 4 * 60 * 60 * 1000) {
  throw new Error('duration must be 1000..14400000 ms');
}
const requestedWarmupMs = process.env.AGENTCALL_SOAK_WARMUP_MS;
const warmupMs = requestedWarmupMs == null
  ? Math.min(10 * 60_000, Math.floor(durationMs / 5), durationMs - 1_000)
  : Number(requestedWarmupMs);
if (!Number.isSafeInteger(warmupMs) || warmupMs < 0 || warmupMs > durationMs - 1_000) {
  throw new Error('warmup must be 0..duration-1000 ms');
}
const sampleEveryMs = Math.min(5_000, Math.max(250, Math.floor(durationMs / 20)));
const controllerSecret = randomBytes(32);
const simulator = new PhoneSimulator({ enrollmentSecret: Buffer.from(controllerSecret) });
const client = new DeviceClient({ enrollmentSecret: Buffer.from(controllerSecret) });
controllerSecret.fill(0);
const samples = [];
let calls = 0;
let frameValue = 0;

async function fdCount() {
  try { return (await readdir('/proc/self/fd')).length; } catch { return null; }
}
async function sample() {
  const memory = process.memoryUsage();
  samples.push({ rss: memory.rss, heapUsed: memory.heapUsed, fds: await fdCount() });
}

try {
  await simulator.start();
  await client.connect({ host: '127.0.0.1', port: simulator.port });
  const started = Date.now();
  const cold = { ...process.memoryUsage(), fds: await fdCount() };
  let warm = warmupMs === 0 ? { ...cold, calls } : null;
  let nextSample = started + warmupMs;
  while (Date.now() - started < durationMs) {
    const callId = `soak-${calls++}`;
    simulator.incoming(callId);
    await client.sendControl({ payload: Buffer.from(JSON.stringify({ command: 'answer', callId })) });
    simulator.sendRemotePcm(Buffer.alloc(PCM_FRAME_BYTES, frameValue++ & 0xff));
    await client.sendPcm({ payload: Buffer.alloc(PCM_FRAME_BYTES, frameValue++ & 0xff) });
    await client.sendControl({ payload: Buffer.from(JSON.stringify({ command: 'hangup', callId })) });
    const now = Date.now();
    if (!warm && now - started >= warmupMs) {
      warm = { ...process.memoryUsage(), fds: await fdCount(), calls };
    }
    if (now >= nextSample) {
      await sample();
      nextSample += sampleEveryMs;
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
  await sample();
  const last = samples.at(-1);
  const max = (key) => Math.max(...samples.map((value) => value[key] ?? 0));
  const report = {
    identity: 'SIMULATOR', simulator: true, durationMs, warmupMs, calls, warmupCalls: warm.calls,
    sentPcm: simulator.metrics.sentPcm, receivedPcm: simulator.metrics.receivedPcm,
    sockets: simulator.sockets.size, activeCalls: simulator.calls.size,
    samples: samples.length,
    rssCold: cold.rss, rssWarm: warm.rss, rssEnd: last.rss, rssMax: max('rss'), rssGrowth: last.rss - warm.rss,
    heapCold: cold.heapUsed, heapWarm: warm.heapUsed, heapEnd: last.heapUsed, heapMax: max('heapUsed'), heapGrowth: last.heapUsed - warm.heapUsed,
    fdsCold: cold.fds, fdsWarm: warm.fds, fdsEnd: last.fds, fdsMax: max('fds'),
  };
  console.log(JSON.stringify(report));
  if (report.activeCalls !== 0 || report.sockets !== 1 || report.fdsEnd > report.fdsWarm + 2) process.exitCode = 1;
  if (report.rssGrowth > 64 * 1024 * 1024 || report.heapGrowth > 32 * 1024 * 1024) process.exitCode = 1;
} finally {
  await client.disconnect();
  await simulator.stop();
}
