# Realtime speech provider contract

Status: implementation contract, 2026-07-19. This document defines the Linux-side provider boundary. It does not claim production qualification; each adapter still requires measured latency, interruption, reconnect, language, and retention tests.

## Architectural boundary

Android always exchanges **16 kHz, mono, signed PCM16LE**, 20 ms frames (320 samples / 640 bytes) with Linux through the ADB-forwarded loopback socket. Provider-specific formats never cross the USB protocol.

```text
Android 16 kHz PCM -> recorder remote track -> STT resampler/adapter -> transcript -> Hermes/OpenClaw
Hermes/OpenClaw text -> TTS adapter -> resampler to 16 kHz -> recorder agent track -> Android
```

The Linux recorder receives the exact Android downlink and exact post-resample audio offered to Android before provider fan-out/injection. Provider transcripts are supplementary evidence.

## Interfaces

```ts
export interface SttProvider {
  open(config: SttConfig, signal: AbortSignal): Promise<SttSession>;
}

export interface SttSession {
  pushPcm16(frame: Int16Array, timestampMicros: bigint): Promise<void>;
  commitTurn(): Promise<void>;
  events(): AsyncIterable<SttEvent>;
  close(): Promise<void>;
}

export type SttEvent =
  | { type: 'speech_started'; timestampMicros: bigint }
  | { type: 'partial'; text: string; language?: string; confidence?: number }
  | { type: 'final'; text: string; language?: string; confidence?: number; words?: WordTiming[] }
  | { type: 'speech_stopped'; timestampMicros: bigint }
  | { type: 'error'; retryable: boolean; code: string; message: string };

export interface TtsProvider {
  synthesize(request: TtsRequest, signal: AbortSignal): AsyncIterable<TtsChunk>;
}

export type TtsChunk = {
  pcm16: Int16Array;
  sampleRate: number;
  channels: 1;
  sequence: number;
};
```

Requirements:

- Provider adapters accept/return owned buffers; consumers release or zeroize them.
- Queues are bounded. STT overflow marks the transcript incomplete. TTS overflow cancels speech and stops agent media.
- `AbortSignal` cancellation is mandatory. Barge-in first stops Linux-to-phone injection locally, then cancels provider synthesis; it never waits for an MCP round trip.
- Provider disconnect cannot silently switch provider mid-utterance. The utterance is marked incomplete and policy decides retry, apology, transfer, or hangup.
- Secrets are resolved by opaque credential references from the Linux secret store and never returned through MCP/dashboard APIs.

## Language contract

Configuration:

- `inputLanguage`: `auto` or a fixed BCP-47/language code supported by the selected STT adapter.
- `replyLanguage`: `same-as-caller`, a fixed language, or `translated`.
- `agentLanguage`: original transcript language by default; optionally English when translated mode is enabled.

Every final transcript event stores:

- original text;
- detected/requested language and confidence when supplied;
- optional English translation as a separate field;
- provider/model and timing;
- whether the result is partial/final and complete/incomplete.

The original transcript is never overwritten by translation. The agent normally replies in the caller's detected language. A low-confidence or rapidly changing language result must not cause repeated voice/model switching inside one turn.

## OpenAI hosted STT adapter

Official documentation retrieved 2026-07-19:

- Speech-to-text transcription can preserve the source language; translation-to-English is a distinct operation.
- Realtime transcription uses a `type: "transcription"` session over WebSocket for server-side pipelines.
- For `audio/pcm`, the documented realtime input is **24 kHz mono PCM**.
- Audio is appended through realtime input-buffer events; optional server VAD can commit turn boundaries.
- The language field is an optional hint; production must test languages, vocabulary, and latency.

Adapter boundary:

1. Deterministically resample Android 16 kHz mono PCM16LE to 24 kHz mono PCM16.
2. Preserve original 16 kHz timestamps; account for resampler delay in the manifest.
3. Send bounded chunks and consume partial/final events.
4. Do not use OpenAI translation implicitly. If enabled, record it as a separate derived artifact.

Primary sources:

- https://platform.openai.com/docs/guides/realtime-transcription
- https://platform.openai.com/docs/guides/speech-to-text

## ElevenLabs STT adapter

Official documentation retrieved 2026-07-19 states:

- Scribe v2 Realtime supports realtime WebSocket transcription.
- It supports 90+ languages, dynamic language detection, precise word-level timestamps, and keyterm prompting.
- The documentation advertises approximately 150 ms realtime latency; this is not an acceptance result for agentcall.
- HIPAA use requires an executed BAA; privacy/retention configuration must be verified for the deployed account and region.

The adapter must negotiate only a documented accepted audio format. No assumed sample rate or encoding is accepted until the concrete API-reference request schema is captured in adapter tests. Resampling occurs inside the adapter, never Android.

Primary source:

- https://elevenlabs.io/docs/capabilities/speech-to-text

## ElevenLabs TTS adapter

Use the official streaming HTTP or WebSocket TTS interface. The adapter must:

- request a documented PCM output format where available, otherwise decode the documented stream format;
- expose provider chunks as mono PCM16 with their true sample rate;
- support cancellation and close the upstream stream on barge-in;
- resample once to 16 kHz before the authoritative agent recording/injection boundary;
- store voice/model/output-format identifiers in the call manifest.

Zero Retention Mode and regional/privacy terms are deployment settings, not assumed defaults. They must be recorded in the deployment policy and verified before cloud audio is enabled.

Primary sources:

- https://elevenlabs.io/docs/websockets
- https://elevenlabs.io/docs/api-reference/text-to-speech/v-1-text-to-speech-voice-id-stream

## Supertonic 3 local TTS adapter

The official repository states that Supertonic 3:

- runs locally using ONNX Runtime with no cloud API call;
- supports 31 languages, including Hindi and English;
- emits **44.1 kHz, 16-bit WAV**;
- is approximately 99M parameters and does not require a GPU.

The adapter must decode WAV framing, expose PCM16, and deterministically resample 44.1 kHz to 16 kHz. Supertonic is TTS only; it does not replace STT, VAD, the agent, or recording.

Primary source:

- https://github.com/supertone-inc/supertonic

## Provider routing

Initial supported combinations:

| STT | TTS | Intended use |
|---|---|---|
| OpenAI realtime transcription | ElevenLabs streaming TTS | hosted multilingual primary |
| ElevenLabs Scribe v2 Realtime | ElevenLabs streaming TTS | single-vendor hosted option |
| OpenAI or ElevenLabs STT | Supertonic 3 | hosted recognition, local/private synthesis |

No automatic cost/quality failover during an active utterance. A session pins provider/model/voice after consent and recording readiness. Failover can occur only at a turn boundary with an explicit transcript/manifest event.

## Acceptance tests

Each provider combination must pass before production enablement:

1. 16 kHz phone fixture -> adapter format -> transcript, with timestamp drift measured.
2. English, Hindi, and mixed Hindi/English fixtures; add deployment-specific languages.
3. Partial/final ordering, duplicate final suppression, and reconnect behavior.
4. TTS first-audio latency, full utterance latency, cancellation latency, and no post-cancel audio leakage.
5. Barge-in stops phone injection locally within the configured budget.
6. Resampler quality, exact output frame size, bounded queues, and payload zeroization.
7. Cloud-disabled/consent-denied calls send no audio to provider endpoints.
8. Provider outage marks artifacts incomplete and invokes the configured fail-closed behavior.
9. Secrets never appear in logs, MCP results, dashboard state, manifests, or crash reports.
10. Local recordings match actual received/injected PCM and remain authoritative.
