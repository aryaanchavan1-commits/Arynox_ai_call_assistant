# Realtime provider qualification — 2026-07-20

## Scope

Live, bounded qualification of the provider adapters. Credentials were injected into one process environment for each test and were not written to source, configuration, logs, or this report. No cellular call was placed.

## Results

| Path | Result | Evidence |
|---|---|---|
| OpenAI authenticated REST | PASS | `GET /v1/models` returned HTTP 200. |
| OpenAI Realtime STT, silence | PASS | WebSocket connected, transcription session accepted canonical 16 kHz input resampled to 24 kHz, manual commit succeeded, and a completed event returned an empty transcript as expected for silence. |
| Supertonic local health | PASS | Official `supertonic` 1.3.1 server, loopback `127.0.0.1:7788`, model `supertonic-3`, 44.1 kHz, 10 voices loaded. |
| Supertonic local TTS | PASS | The project adapter produced a 301,100-byte PCM16 WAV for “AgentCall local voice qualification.” |
| Supertonic → canonical PCM → OpenAI STT | PASS WITH RECOGNITION VARIANCE | Local output converted to 109,228 bytes of 16 kHz mono PCM. OpenAI returned “GSN2 SIP local voice qualification”. Transport, commit, and final-transcript boundaries passed; “GSM two” was imperfectly recognized. |
| ElevenLabs restricted-key authentication | PASS | `GET /v1/models` returned HTTP 200. User and voice-list endpoints returned precise `missing_permissions` responses for `user_read` and `voices_read`; this confirms a valid restricted key rather than an invalid credential. |
| ElevenLabs Scribe Realtime STT | PASS WITH RECOGNITION VARIANCE | WebSocket returned `session_started`, accepted native 16 kHz PCM and manual commit, then transcribed the Supertonic phrase as “GSN2 SIP local voice qualification.” |
| ElevenLabs TTS | PASS | `eleven_flash_v2_5` returned 52,012 bytes of raw 16 kHz PCM using an explicitly configured premade voice ID. |
| ElevenLabs Voice Changer | PASS | `eleven_english_sts_v2` accepted native `pcm_s16le_16` and returned 49,040 even bytes of `audio/pcm` at 16 kHz. This capability is qualified but is not part of the default production STT→agent→TTS call path. |

## Security and cleanup

- Realtime remains disabled unless `AGENTCALL_REALTIME_ENABLED=true`.
- Provider keys are resolved lazily from `OPENAI_API_KEY` and `ELEVENLABS_API_KEY`; they are not part of runtime configuration or status.
- Supertonic was run through an isolated `uv tool run` environment and bound to loopback only.
- The temporary Supertonic server was stopped after qualification.
- Repository secret scan found no OpenAI or ElevenLabs key patterns.
- Because credentials were pasted into chat, rotate both credentials after qualification.

## Remaining acceptance work

- Run hardware full-duplex, latency, interruption, reconnect, and soak qualification on the rooted POCO device.
- Integrate the committed-transcript → Hermes/OpenClaw agent-turn → TTS response orchestration; provider qualification alone does not supply the reasoning loop.
- Decide whether Voice Changer belongs in an optional advanced pipeline. Direct TTS remains the lower-latency default.
- Do not describe this as production release evidence until production signing and device qualification are complete.
