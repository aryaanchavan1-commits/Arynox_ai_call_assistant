#!/usr/bin/env node

import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { ElevenLabsRealtimeSttProvider } from '../src/elevenlabs-realtime-stt-provider.js';
import { ElevenLabsTtsProvider } from '../src/elevenlabs-tts-provider.js';
import { OpenAiRealtimeSttProvider } from '../src/openai-realtime-stt-provider.js';

const phrase = 'Arynox provider qualification.';
const outputDirectory = resolve(process.argv[2] || './qualification-output');
const elevenKey = process.env.ELEVENLABS_API_KEY || '';
const openAiKey = process.env.OPENAI_API_KEY || '';
const configuredVoiceId = process.env.ELEVENLABS_VOICE_ID || '';
if (!elevenKey || !openAiKey) throw new Error('OPENAI_API_KEY and ELEVENLABS_API_KEY are required');
if (configuredVoiceId && !/^[A-Za-z0-9_-]{1,128}$/.test(configuredVoiceId)) {
  throw new Error('ELEVENLABS_VOICE_ID has an invalid shape');
}

function wav(samples, sampleRate = 16_000) {
  const dataBytes = samples.length * 2;
  const output = Buffer.alloc(44 + dataBytes);
  output.write('RIFF', 0); output.writeUInt32LE(36 + dataBytes, 4); output.write('WAVE', 8);
  output.write('fmt ', 12); output.writeUInt32LE(16, 16); output.writeUInt16LE(1, 20);
  output.writeUInt16LE(1, 22); output.writeUInt32LE(sampleRate, 24);
  output.writeUInt32LE(sampleRate * 2, 28); output.writeUInt16LE(2, 32); output.writeUInt16LE(16, 34);
  output.write('data', 36); output.writeUInt32LE(dataBytes, 40);
  for (let index = 0; index < samples.length; index++) output.writeInt16LE(samples[index], 44 + index * 2);
  return output;
}

async function selectVoice() {
  if (configuredVoiceId) return { id: configuredVoiceId, name: 'configured' };
  const response = await fetch('https://api.elevenlabs.io/v2/voices?page_size=10', {
    headers: { 'xi-api-key': elevenKey, accept: 'application/json' },
  });
  if (!response.ok) {
    let permission = '';
    try {
      const body = await response.json();
      const detail = body?.detail ?? body;
      if (detail?.status === 'missing_permissions') permission = `: ${String(detail.message).slice(0, 160)}`;
    } catch {}
    throw new Error(`ElevenLabs voice discovery failed with status ${response.status}${permission}; set ELEVENLABS_VOICE_ID for restricted keys`);
  }
  const body = await response.json();
  const voice = body.voices?.find((item) => typeof item?.voice_id === 'string');
  if (!voice) throw new Error('ElevenLabs returned no usable voice');
  return { id: voice.voice_id, name: typeof voice.name === 'string' ? voice.name.slice(0, 80) : 'unnamed' };
}

async function synthesize(voice) {
  const provider = new ElevenLabsTtsProvider({ apiKey: async () => elevenKey, zeroRetention: false });
  const health = await provider.health();
  if (!health.healthy) throw new Error(`ElevenLabs TTS unhealthy: ${health.reason}`);
  const chunks = [];
  let samples = 0;
  for await (const chunk of provider.synthesize({ text: phrase, voice: voice.id, language: 'en' })) {
    chunks.push(chunk.pcm16);
    samples += chunk.pcm16.length;
  }
  const pcm = new Int16Array(samples);
  let offset = 0;
  for (const chunk of chunks) { pcm.set(chunk, offset); offset += chunk.length; chunk.fill(0); }
  return { pcm, health };
}

async function transcribe(name, provider, pcm) {
  const health = await provider.health();
  if (!health.healthy) return { provider: name, healthy: false, reason: health.reason };
  const abort = new AbortController();
  let session;
  try {
    session = await provider.open({ language: 'en' }, abort.signal);
    const resultPromise = (async () => {
      for await (const event of session.events()) {
        if (event.type === 'final') return { provider: name, healthy: true, transcript: event.text };
        if (event.type === 'error') return { provider: name, healthy: false, reason: event.code };
      }
      return { provider: name, healthy: false, reason: 'event stream ended' };
    })();
    for (let offset = 0; offset < pcm.length; offset += 320) {
      const frame = new Int16Array(320);
      frame.set(pcm.subarray(offset, Math.min(offset + 320, pcm.length)));
      await session.pushPcm16(frame, BigInt(offset / 16) * 1000n);
      frame.fill(0);
    }
    await session.commitTurn();
    return await Promise.race([
      resultPromise,
      new Promise((resolve) => setTimeout(() => resolve({ provider: name, healthy: false, reason: 'transcript timeout' }), 30_000)),
    ]);
  } catch (error) {
    return { provider: name, healthy: false, reason: String(error?.message || 'connection failed').slice(0, 160) };
  } finally {
    abort.abort();
    await session?.close().catch(() => {});
  }
}

await mkdir(outputDirectory, { recursive: true });
const voice = await selectVoice();
const synthesis = await synthesize(voice);
await writeFile(resolve(outputDirectory, 'elevenlabs-qualification.wav'), wav(synthesis.pcm));
const stt = await Promise.all([
  transcribe('openai', new OpenAiRealtimeSttProvider({ apiKey: async () => openAiKey }), synthesis.pcm),
  transcribe('elevenlabs', new ElevenLabsRealtimeSttProvider({ apiKey: async () => elevenKey }), synthesis.pcm),
]);
const evidence = {
  generatedAt: new Date().toISOString(),
  phrase,
  elevenLabsTts: {
    healthy: true,
    model: synthesis.health.model,
    sampleRate: synthesis.health.sampleRate,
    voiceName: voice.name,
    samples: synthesis.pcm.length,
  },
  stt,
};
await writeFile(resolve(outputDirectory, 'qualification.json'), `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
synthesis.pcm.fill(0);
process.stdout.write(`${JSON.stringify(evidence)}\n`);
if (stt.some((item) => !item.healthy)) process.exitCode = 1;
