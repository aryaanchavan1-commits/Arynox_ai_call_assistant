# Arynox AI Call Assistant — PC Gateway

USB-only PC call-control gateway and local stdio MCP server, made by
**Aryan Chavan · ArynoxTech**. No provider, SIP, RTP, LAN, Wi-Fi, or remote MCP
transport. Device traffic uses existing `adb forward` loopback connection.
Extends Arynox with native **Groq** speech and conversation models.

## Groq support

- STT: `groq-realtime-stt-provider.js` buffers 16 kHz turns into WAV and
  transcribes with Whisper (`whisper-large-v3-turbo`, `whisper-large-v3`,
  `distil-whisper-large-v3-en`).
- TTS: `groq-tts-provider.js` synthesizes with PlayAI / Orpheus models and
  decodes WAV PCM16.
- Conversation: `groq-conversation-responder.js` drives Llama chat models
  (`llama-3.3-70b-versatile` and more) with bounded history and abort handling.
- Config: `GROQ_API_KEY` secret, wired through `provider-settings.js`,
  `realtime-registry.js`, and the desktop Speech UI.

## Safety model

- Device identity is verified before creating ADB forward.
- Device client connects only to loopback.
- Dial is denied by default.
- Dial allow/deny entries are exact E.164 values; deny wins.
- Emergency destinations are always blocked.
- Premium and international calls require explicit policy gates.
- Manual approval is required unless explicitly disabled for automation.
- Per-destination cooldown, global dial rate, and maximum call duration are bounded.
- Phone numbers in errors and results use salted SHA-256 hash plus last four digits.
- Mutation results replay from bounded idempotency cache.

## Modules

| Module | Responsibility |
|---|---|
| `src/adb-manager.js` | Device selection, identity verification, loopback forward lifecycle. |
| `src/framing.js` | Canonical G2 CONTROL, EVENT, and PCM framing. |
| `src/device-client.js` | Loopback-only framed device connection. |
| `src/policy.js` | Dial policy and redacted destination identity. |
| `src/gateway.js` | Semantic call control, replay cache, state, metrics, and device events. |
| `src/mcp-server.js` | MCP 2024-11-05 stdio server. |

Gateway sends semantic commands as canonical CONTROL JSON in
`DIR_HOST_TO_DEVICE`. Device CONTROL and EVENT JSON become gateway `incoming`
and `event` events. Device PCM stays internal and is never exposed by MCP.

## MCP

Server identity: `agentcall-mcp`. Protocol version: `2024-11-05`. Transport:
line-delimited JSON-RPC over local stdio.

Tools are exactly:

- `status {}`
- `capabilities {}`
- `wait_for_incoming_call { afterSequence, timeoutMs? }`
- `wait_for_turn { callId, afterSequence, timeoutMs?, autoAcknowledge?, autoPreparedReply? }`
- `dial { destination, openingText, preparedReplies, approved, consent, idempotencyKey }`
- `prepare_speech { callId, texts }`
- `answer { callId, idempotencyKey }`
- `reject { callId, idempotencyKey }`
- `hangup { callId, idempotencyKey }`
- `send_dtmf { callId, digits, idempotencyKey }`
- `speak { callId, text, respondingToSequence?, idempotencyKey }`

Every input schema is strict with `additionalProperties: false`. `destination`
is strict E.164. `digits` accepts only `0-9`, `*`, `#`, and `A-D`.
`wait_for_turn` is an event-driven cursor: pass the returned `sequence` into
the next call so Hermes/OpenClaw receives every final caller turn once without
polling. By default, Arynox may play one short context-aware acknowledgement
after 650 milliseconds; pass `autoAcknowledge: false` when the external loop
supplies its own latency bridge. A quick `speak` cancels it, greetings and
goodbyes never trigger it, and an eight-second limiter prevents repetition.
Arynox also plays an unused warmed reply automatically when the caller's
meaning is a strong match. A receipt with `preparedReplySpoken: true` means the
reply already reached the call: do not call `speak` for that sequence; wait for
the next turn. Pass `autoPreparedReply: false` to opt out.
Hermes/OpenClaw remains the reasoning engine.
`dial` pre-renders its opening, correlates the exact new outgoing call, and
waits for recording plus realtime media readiness before playing it. An
accepted result returns `nextAction: "wait_for_turn"` and `afterSequence: 0`;
Hermes/OpenClaw must remain attached and alternate `wait_for_turn` and `speak`
until the call ends. Strong prepared matches are spoken automatically and
reported in the wait receipt; unmatched turns remain with Hermes/OpenClaw.
For live dialogue, pass the latest
`wait_for_turn.sequence` as
`respondingToSequence`; Arynox rejects the draft if the caller has already
started a newer turn.

Each TTS stream has a three-second no-audio watchdog. Arynox retries once
only when no audio has reached the phone, then releases the speech slot and
returns `speech provider unavailable` instead of leaving MCP blocked.
Incoming and outgoing openings are protected continuous segments. Barge-in is
enabled immediately after the opening finishes for every later turn.

Canonical resources are `agentcall://gateway/status`,
`agentcall://gateway/capabilities`, `agentcall://calls/current`,
`agentcall://events/recent`, and `agentcall://phone-data/status`.

Example:

```json
{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"dial","arguments":{"destination":"+15551234567","openingText":"Good afternoon. May I speak with Siddharth, please?","preparedReplies":["Hello. I am calling on behalf of the person who requested this call."],"approved":true,"consent":{"recorded":true,"policy":"explicit user consent"},"idempotencyKey":"dial-20260720-1"}}}
```

## Run

```bash
cd pc-gateway
AGENTCALL_DEVICE_FINGERPRINT=xiaomi/gram/gram:15/abcd \
AGENTCALL_REDACTION_SALT=local-secret \
node src/mcp-server.js
```

`AGENTCALL_DIAL_ENABLED=true` enables first dial gate. Production callers must
also supply policy configuration that explicitly permits destinations and
handles manual approval; default configuration cannot dial.

## Verify

```bash
npm test
npm run check
```

Tests use fakes and loopback sockets. No device or network provider needed.
