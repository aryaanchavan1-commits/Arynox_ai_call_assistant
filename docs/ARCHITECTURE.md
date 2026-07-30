# AgentCall architecture

## Product boundary

AgentCall is a USB-only bridge between one Android cellular phone and one local
Windows or Linux host. The phone remains the cellular endpoint. The host owns
policy, recording, realtime speech, the desktop UI, and the local agent
integration.

The supported product does not contain SIP, RTP, Asterisk, STUN, a LAN call
listener, a Wi-Fi phone transport, or a remote MCP service.

## Runtime components

### Android application

The `com.callagent.gateway` application is the Android default dialer and owns:

- Telecom call discovery and correlated answer, reject, dial, hang-up, and DTMF;
- the on-phone call, keypad, call-history, gateway, and recording UI;
- protected cellular audio capture/injection on a qualified privileged build;
- the loopback-only G2 server;
- controller enrollment and one active authenticated controller lease;
- bounded contacts/call-log snapshots;
- verified recording-artifact reception into Android storage.

The Magisk module embeds the exact matched APK and a package-specific protected
permission allowlist. It does not disable SELinux or grant broad permissions to
other packages.

### Gateway

The Node.js gateway is the authority for:

- exact ADB device selection and matched-artifact identity;
- the private ADB daemon/forward lifecycle;
- authenticated framed control, event, PCM, and recording-artifact traffic;
- call state, idempotency, policy, rate limits, and emergency blocking;
- mandatory remote/agent recording and integrity manifests;
- private contacts and call-log mirrors;
- realtime STT/TTS routing, VAD, barge-in, and paced telephone audio;
- consent-bound caller memory;
- local RPC used by the desktop and MCP processes.

On Linux the RPC endpoint is the group-restricted Unix socket
`/run/agentcall/gatewayd.sock`. On Windows the packaged desktop supervises an
equivalent per-user local gateway and named-pipe boundary.

### Desktop application

The Electron desktop application provides:

- live connection and call state;
- incoming call notification and ringtone;
- dialer, saved contacts, and synchronized call history;
- incoming/outgoing call controls;
- PC microphone/speaker mode;
- recording catalog, in-app player, export, sync, and deletion controls;
- STT/TTS provider, model, language, and voice selection;
- Android, MCP, policy, and AI receptionist setup.

The renderer is sandboxed. It has no Node.js globals and reaches the daemon only
through a strict preload/IPC allowlist.

### MCP and managed agent voice

`agentcall-mcp` is a local stdio MCP 2024-11-05 server. It exposes semantic
tools and redacted text resources; it never exposes PCM, provider credentials,
ADB payloads, private paths, contact rows, or raw phone numbers.

Hermes or OpenClaw remains the reasoning engine. The managed voice supervisor
keeps one AgentCall-only Hermes session through a call, carries the prior
conversation and interrupted reply forward, and uses the user's selected model
unless an operator explicitly configures a healthy override.

Finalized mixed recordings are copied to the connected Android app only after
capability negotiation and hash verification. If the phone disconnects or the
transfer fails, the finalized recording remains queued and is retried
idempotently on the next authenticated capability handshake; the Android app
publishes it only after the complete size and SHA-256 match.

## Call data flow

### Outgoing

1. A desktop user or authorized MCP agent requests a destination.
2. The gateway validates E.164, approval, consent, policy, recording health,
   device identity, cooldown, and rate limits.
3. Android places the Telecom call and returns a correlated call ID.
4. AgentCall prepares a context-aware opening and a bounded set of high-value
   speech responses while the phone is dialing.
5. When the call becomes active, paced audio starts after a 250 ms route safety
   margin.
6. Remote PCM is recorded before STT fan-out. Provider-supported input-noise
   reduction and the stable local VAD keep background noise from becoming false
   turns. Final caller turns enter the same agent session.
7. One complete agent reply is synthesized, paced at the telephone clock, and
   recorded.
8. Caller interruption cancels stale speech/reasoning. Explicit goodbye or
   end-call language produces a complete farewell and correlated hang-up.

### Incoming receptionist

1. Android reports a ringing call with its locally resolved contact name when
   available.
2. The gateway exposes only bounded caller memory and saved receptionist
   instructions to the agent.
3. While the phone rings, AgentCall prepares the correct time/contact/context
   opening.
4. After the configured answer window, the same call is rechecked and answered
   only if AI answering is still enabled and all safety gates are healthy.
5. The opening and subsequent conversation use the same paced speech and
   context-preserving turn loop as outgoing calls. The protected-opening turn
   boundary discards pickup noise and early overlapping transcripts before the
   agent begins normal barge-in handling.

### Human PC audio

The desktop captures microphone PCM, converts it to exact 20 ms frames, and
sends it only for the correlated active call. Remote PCM returns on the separate
local audio channel for speaker playback. Both sides are written to the
mandatory recording.

## Recording model

Every consented managed call owns:

- `remote.wav`;
- `agent.wav`;
- `conversation.mkv` or mixed conversation media;
- bounded transcript and event ledgers;
- a manifest and checksums.

Only the exact terminal outcome `ended` with both required tracks may be marked
complete. Transport loss, media failure, process shutdown, or incomplete tracks
remain incomplete and cannot be presented as a successful recording. A
finalized recording is copied to Android only after capability negotiation,
ordered transfer, hash verification, and an Android acceptance receipt.

## Trust and privacy boundaries

- The phone listener binds to `127.0.0.1` only.
- The gateway is the sole ADB owner.
- Controller bootstrap is bounded and matched to the installed Android artifact.
- Operational sessions use mutual authentication and replay protection.
- Provider keys remain daemon-owned and write-only.
- MCP and logs use explicit allowlists and reject credential-shaped values.
- Phone data rows stay inside local daemon/Desktop RPC.
- Recording and caller memory are local, bounded, and consent controlled.

## Product identifiers

The product name, desktop UI, Android UI, repository, MCP server identity,
Linux service account and paths, environment variables, privileged module ID,
and MCP resources consistently use AgentCall identifiers. MCP clients use the
`agentcall://` resource namespace.

## Source map

| Area | Location |
|---|---|
| Android application | `app/` |
| Gateway and MCP | `pc/pc-gateway/src/` |
| Managed Hermes voice supervisor | `pc/pc-gateway/scripts/hermes-voice-supervisor.js` |
| Desktop application | `pc/pc-gateway/ui/` |
| Android/Magisk packaging | `packaging/android/` |
| Linux/Debian packaging | `packaging/linux/` |
| Shared framing/artifact contract | `protocol/` |
| Security and release evidence | `docs/security/`, `docs/release/` |
