#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { runGatewayd } from '../src/gatewayd.js';
import { FRAME_SAMPLES, PCM_FRAME_BYTES, PCM_SAMPLE_RATE } from '../src/framing.js';
import {
  createPcmMetrics,
  summarizePcmMetrics,
  updatePcmMetrics,
} from './qualification-pcm-metrics.js';

const requestedDurationMs = Number.parseInt(process.env.AGENTCALL_QUALIFICATION_DURATION_MS || '6000', 10);
if (!Number.isInteger(requestedDurationMs) || requestedDurationMs < 1_000 || requestedDurationMs > 30_000 || requestedDurationMs % 20 !== 0) {
  throw new Error('AGENTCALL_QUALIFICATION_DURATION_MS must be a 20 ms multiple between 1000 and 30000');
}
const TEST_DURATION_MS = requestedDurationMs;
const FRAME_MS = 20;
const TONE_HZ = 440;
const TONE_AMPLITUDE = 1_000;
const REQUIRED_REMOTE_FRAMES = 20;
const REQUIRED_REMOTE_RMS = 20;
const DOWNLINK_ONLY = process.env.AGENTCALL_QUALIFICATION_MODE === 'downlink-only';

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function waitForEvent(emitter, predicate, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`${label} timed out`));
    }, timeoutMs);
    const handler = (value) => {
      if (!predicate(value)) return;
      cleanup();
      resolve(value);
    };
    function cleanup() {
      clearTimeout(timeout);
      emitter.off('incoming', handler);
      emitter.off('event', handler);
    }
    emitter.on('incoming', handler);
    emitter.on('event', handler);
  });
}

function toneFrame(frameIndex) {
  const frame = Buffer.alloc(PCM_FRAME_BYTES);
  const base = frameIndex * FRAME_SAMPLES;
  for (let i = 0; i < FRAME_SAMPLES; i++) {
    const sample = Math.round(TONE_AMPLITUDE * Math.sin((2 * Math.PI * TONE_HZ * (base + i)) / PCM_SAMPLE_RATE));
    frame.writeInt16LE(sample, i * 2);
  }
  return frame;
}

async function readManifest(root, callId) {
  return JSON.parse(await readFile(`${root}/${callId}/manifest.json`, 'utf8'));
}

async function main() {
  if (process.env.AGENTCALL_QUALIFICATION_CONSENT !== 'recording-approved') {
    throw new Error('AGENTCALL_QUALIFICATION_CONSENT=recording-approved is required');
  }
  const recordingRoot = process.env.AGENTCALL_RECORDING_ROOT;
  if (!recordingRoot) throw new Error('AGENTCALL_RECORDING_ROOT is required');

  const runtime = await runGatewayd();
  const { gateway } = runtime;
  let callId = null;
  let callEnded = false;
  const metrics = { toneFramesSent: 0, remote: createPcmMetrics() };
  const pcmHandler = ({ payload }) => updatePcmMetrics(metrics.remote, payload, PCM_FRAME_BYTES);
  gateway.device.on('pcm', pcmHandler);

  try {
    process.stdout.write(`${JSON.stringify({ phase: 'waiting_for_incoming_call' })}\n`);
    const incoming = await waitForEvent(
      gateway,
      (event) => event?.event === 'incoming' && typeof event.callId === 'string',
      180_000,
      'incoming call',
    );
    callId = incoming.callId;
    process.stdout.write(`${JSON.stringify({ phase: 'incoming', callId })}\n`);

    await gateway.beginRecording({
      callId,
      sessionId: `hardware-qualification-${Date.now()}`,
      consent: {
        recorded: true,
        policy: 'explicit operator and remote-party hardware qualification consent',
        scope: `${TEST_DURATION_MS}-millisecond simultaneous full-duplex test`,
      },
      provider: 'synthetic-440hz-local',
    });
    const activeEvent = waitForEvent(
      gateway,
      (event) => event?.event === 'active' && event.callId === callId,
      30_000,
      'active call',
    );
    const answer = await gateway.answer({ callId, idempotencyKey: randomUUID() });
    if (answer?.accepted !== true) throw new Error(`answer refused: ${answer?.reason ?? 'unknown'}`);
    await activeEvent;
    process.stdout.write(`${JSON.stringify({ phase: 'active', callId })}\n`);

    const frameCount = TEST_DURATION_MS / FRAME_MS;
    if (DOWNLINK_ONLY) {
      await sleep(TEST_DURATION_MS);
    } else {
      const startedAt = performance.now();
      for (let i = 0; i < frameCount; i++) {
        await gateway.sendAgentPcm(toneFrame(i));
        metrics.toneFramesSent++;
        const target = startedAt + ((i + 1) * FRAME_MS);
        const wait = target - performance.now();
        if (wait > 0) await sleep(wait);
      }
    }

    const endedEvent = waitForEvent(
      gateway,
      (event) => event?.event === 'ended' && event.callId === callId,
      20_000,
      'ended call',
    );
    await gateway.hangup({ callId, idempotencyKey: randomUUID() });
    try {
      await endedEvent;
      callEnded = true;
    } catch {
      // Gateway.stop() below still deactivates recording and finalizes safely.
    }
    await gateway.flushRecording();
  } finally {
    gateway.device.off('pcm', pcmHandler);
    if (callId && !callEnded) {
      try { await gateway.hangup({ callId, idempotencyKey: randomUUID() }); } catch {}
    }
    await runtime.stop();
  }

  const remote = summarizePcmMetrics(metrics.remote);
  const manifest = await readManifest(recordingRoot, callId);
  const result = {
    callId,
    tone: {
      frequencyHz: TONE_HZ,
      amplitude: TONE_AMPLITUDE,
      durationMs: TEST_DURATION_MS,
      framesSent: metrics.toneFramesSent,
    },
    remote: {
      frames: remote.frames,
      samples: remote.samples,
      mean: Math.round(remote.mean * 100) / 100,
      rms: Math.round(remote.rms * 100) / 100,
      acRms: Math.round(remote.acRms * 100) / 100,
      peak: remote.peak,
    },
    recording: {
      complete: manifest.complete,
      outcome: manifest.outcome,
      remoteFrames: manifest.tracks?.remote?.frames,
      agentFrames: manifest.tracks?.agent?.frames,
      failureReasons: manifest.failureReasons,
    },
    gates: {
      allToneFramesSent: DOWNLINK_ONLY || metrics.toneFramesSent === TEST_DURATION_MS / FRAME_MS,
      downlinkFramesPresent: remote.frames >= REQUIRED_REMOTE_FRAMES,
      downlinkNonSilent: remote.acRms >= REQUIRED_REMOTE_RMS,
      recordingComplete: manifest.complete === true,
      callEnded,
    },
  };
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (Object.values(result.gates).some((value) => value !== true)) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ error: String(error?.message || 'qualification failed').slice(0, 200) })}\n`);
  process.exitCode = 1;
});
