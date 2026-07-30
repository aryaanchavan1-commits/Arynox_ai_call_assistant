# Install and configure AgentCall

This guide covers the current AgentCall hardware-qualified release candidate. Read [`RELEASE_STATUS.md`](RELEASE_STATUS.md) before installing privileged artifacts.

## 1. Prerequisites

### Android reference device

The currently qualified tuple is the Xiaomi POCO M2 Pro (`gram`, Qualcomm `atoll`) running the tested Android 15 / API 35 system with Magisk and SELinux Enforcing. Other devices are unsupported until they pass [`DEVICE_PORTING.md`](DEVICE_PORTING.md).

Prepare:

- a dedicated phone with an active SIM;
- USB debugging enabled;
- an authorized Linux host ADB key;
- Magisk only if using the privileged module;
- an explicit rollback window and physical access to the phone.

### Linux host

Required:

- Debian/Ubuntu-compatible x86-64 Linux with systemd;
- `adb`, Node.js 20+, `ffmpeg`, Python 3 and standard Debian package tools;
- enough private storage under `/var/lib/agentcall` for recordings;
- Hermes Agent only if MCP integration is desired.

The all-in-one desktop Debian package includes the UI, gatewayd, MCP launcher, service and setup/recovery helpers. On first install it creates only safe local defaults and a private redaction salt, then enables and starts the offline-capable daemon. It does not install Android artifacts, place calls or contact providers. A fresh daemon remains available in a truthful waiting state until one authorized USB phone is connected and the Android user presses **Connect**.

## 2. Download and verify the release

Download assets from:

https://github.com/sidinsearch/AgentCall-AGPL/releases

Download the assets for your platform:

- `agentcall-desktop-0.2.5-amd64.deb`;
- `agentcall-desktop-0.2.5-x64-setup.exe`;
- `AgentCall-2.8.54-332.apk`;
- `AgentCall-privileged-2.8.54-332-magisk.zip`.

Choose either the APK or Magisk ZIP for installation, never both. Verify each downloaded file against the SHA-256 values printed in the release notes:

```bash
sha256sum agentcall-desktop-0.2.5-amd64.deb \
  AgentCall-2.8.54-332.apk \
  AgentCall-privileged-2.8.54-332-magisk.zip
```

Compare all three values with the release-note manifest before continuing.

## 3. Choose the Android installation model

### Option A — ordinary APK

Use `AgentCall-2.8.54-332.apk` for UI/development validation without protected telephony-audio permissions.

```bash
adb install AgentCall-2.8.54-332.apk
```

This does not qualify the protected full-duplex route.

### Option B — matched Magisk module

Use `AgentCall-privileged-2.8.54-332-magisk.zip` for the qualified rooted-device path. The module already embeds the exact matched APK and protected-permission allowlist.

Do **not** separately install the APK and module. Review the ZIP contents and hash first, install it through Magisk, require a successful installer exit, then reboot. Do not globally weaken SELinux, clear package caches or grant unrelated permissions.

After reboot verify:

```bash
adb shell pm path com.callagent.gateway
adb shell dumpsys package com.callagent.gateway
adb shell cmd role get-role-holders android.app.role.DIALER
```

Confirm the expected package version `2.8.54 (332)`, requested/granted privileges, launcher activity and system package path. If Package Manager metadata disagrees with the mounted APK, stop; do not test calls.

### Android rollback

For the Magisk path:

1. disable/remove the AgentCall module in Magisk;
2. reboot;
3. uninstall `com.callagent.gateway` normally if still present;
4. restore the previous default dialer explicitly;
5. verify normal mic/earpiece and cellular call behavior.

## 4. Select AgentCall as default dialer

Open the Android app and follow its role prompt, or use Android Settings → Apps → Default apps → Phone app. Confirm:

```bash
adb shell cmd role get-role-holders android.app.role.DIALER
```

The result must include `com.callagent.gateway` before relying on Telecom callbacks.

## 5. Install the complete Linux desktop application

Install the release package:

```bash
sudo apt install ./agentcall-desktop-0.2.5-amd64.deb
```

This single package installs the Electron desktop UI, `gatewayd`, MCP launcher, systemd unit, health tools and first-install defaults. It enables and starts `agentcall-gatewayd`; no phone is mutated by Linux package installation. The daemon may run safely without a phone and reports that it is waiting for ADB/Android authorization.

Install host dependencies if not already available:

```bash
sudo apt install adb ffmpeg python3
node --version
```

Install Node.js 20 or newer from your distribution or trusted Node.js package source if `node --version` is missing or older. Do not assume every Debian/Ubuntu `nodejs` package currently satisfies the gateway requirement.

## 6. Pair the authorized USB phone

1. Connect exactly one supported phone over physical USB with USB debugging enabled.
2. If Android displays its standard ADB host-authorization prompt, review it and approve this Linux controller.
3. Open AgentCall on Android and press **Connect**.
4. Leave the cable attached while `gatewayd` discovers the one authorized device, checks the matched artifact identity, performs the bounded authenticated bootstrap and proves the resulting operational session.
5. Open **AgentCall Desktop** and confirm that its setup state agrees with the Android screen.

No AgentCall credential is displayed, copied or typed. Do not manually configure an ADB serial, build fingerprint, ADB private-key path or controller secret. Missing, invalid or asymmetric trust state fails closed and requires the explicit **Forget Paired Desktop** / re-pair flow; normal authentication failure must never rotate authority silently.

## 7. Review gatewayd configuration

The package creates `/etc/agentcall/gateway.env` and a private redaction salt only when absent, preserving administrator changes on upgrade. The generated configuration contains the matched Android version/signer/manifest identity and service-owned runtime paths. It does not contain a default controller credential or ADB private key.

Use `/usr/share/doc/agentcall-gatewayd/gateway.env.example` only as an optional reference for recording, provider and policy settings. Do not add manual serial/fingerprint/key values. Outbound dialing remains subject to explicit local confirmation, strict E.164 validation, emergency blocking, authenticated/qualified USB state, consent, recording health, cooldown and rate limits.

## 8. Verify the waiting service

Package installation already enables and starts the offline-capable service. Verify it without probing the one-client forwarded phone socket:

```bash
sudo systemctl status agentcall-gatewayd
sudo /usr/bin/agentcall-health
sudo /usr/bin/agentcall-recorder-health
```

Before a phone is paired, a waiting/authorization-required status is expected. After pairing, local RPC, Android and desktop status must agree. Do not bypass preflight or use raw TCP/`nc` probes against the ADB-forwarded operational socket.

Useful commands:

```bash
sudo /usr/bin/agentcall-health
sudo /usr/bin/agentcall-recorder-health
sudo /usr/bin/agentcall-logs
```

## 9. Launch and verify the desktop application

Launch **AgentCall Desktop** from the application menu or run:

```bash
agentcall-desktop
```

The desktop should show live daemon, authenticated Android, recording and MCP status. It must never display fixture calls as real activity. The UI remains unprivileged; the included gateway continues to run as the separately supervised `agentcall` service account and communicates over the group-restricted local Unix socket.

AgentCall must be the only application capturing cellular call audio on the
dedicated phone. Disable BCR (`com.chiller3.bcr`) or any other call recorder
before hardware qualification. Two recorders can make Android's in-call capture
device return `Device or resource busy`; the visible symptom is an answered call
with a silent caller track and broken or unstable agent audio. Disabling the
other recorder preserves its existing data and is preferable to uninstalling it.

## 10. Configure STT/TTS

The desktop **Speech** screen writes provider configuration through local daemon RPC. API keys are write-only: they are never returned to the renderer or status APIs. Provider changes require restarting `gatewayd`.

Supported combinations:

- OpenAI realtime transcription + ElevenLabs streaming TTS;
- ElevenLabs Scribe v2 Realtime + ElevenLabs streaming TTS;
- OpenAI or ElevenLabs STT + local Supertonic TTS.

Alternatively configure `/etc/agentcall/gateway.env` before managed desktop settings exist:

```dotenv
AGENTCALL_REALTIME_ENABLED=true
AGENTCALL_STT_PROVIDER=openai
AGENTCALL_TTS_PROVIDER=supertonic
AGENTCALL_TTS_VOICE=F1
AGENTCALL_REALTIME_LANGUAGE=en
OPENAI_API_KEY=RUNTIME_SECRET
```

Keep the file `root:agentcall` mode `0640`. Never put provider keys in Hermes configuration, Git, command arguments or screenshots.

Restart after changing provider settings:

```bash
sudo systemctl restart agentcall-gatewayd
```

## 11. Configure Hermes / OpenClaw MCP

After the daemon is running:

```bash
hermes mcp add agentcall --command /usr/bin/agentcall-mcp
hermes mcp test agentcall
hermes mcp list
```

The MCP process uses stdio and talks to the local Unix RPC socket. It does not need a URL, ADB serial, controller credential or provider key.

OpenClaw uses the same stdio command. On Linux select `/usr/bin/agentcall-mcp`. On Windows copy the OS-specific `agentcall-mcp.cmd` launcher displayed on the desktop MCP page; do not substitute a Unix path.

Expected semantic tools are `status`, `capabilities`, `wait_for_incoming_call`, `wait_for_turn`, `dial`, `prepare_speech`, `answer`, `reject`, `hangup`, `send_dtmf`, and `speak`. Resources use the canonical `agentcall://` namespace. An external Hermes/OpenClaw MCP session should generate a complete contextual opening and one to four likely complete replies before calling `dial`; AgentCall renders the opening before touching the phone, correlates the exact new outgoing call, waits for recording and realtime media readiness, automatically plays the opening once, and warms likely replies while the phone rings. When a caller turn matches a prepared reply, the client should pass that exact text unchanged to `speak` so the warmed audio is reused; unmatched turns remain live and context-aware. An accepted dial returns `nextAction: "wait_for_turn"` and `afterSequence: 0`; the agent must remain attached, alternate `wait_for_turn` and `speak`, and pass the latest turn `sequence` as `respondingToSequence` until the call ends. The context-matched latency bridge is enabled by default and can be disabled with `autoAcknowledge: false` when the external loop supplies its own bridge. It starts a short prewarmed acknowledgement after about 250 ms and may add one brief follow-up after about 2.2 seconds if the complete answer is still pending; both stages cancel on a quick response and serialize before the real answer. Speech rendering and pre-generation have a longer bounded local RPC deadline than quick control operations, preventing healthy multi-second TTS playback from surfacing as an MCP internal error. The managed Hermes voice supervisor uses the same low-latency bridge: AgentCall waits for the turn, sends it directly to a persistent AgentCall-only Hermes session, keeps the caller audibly engaged while Hermes thinks, and sends each concise, complete one-to-three-sentence answer through one continuous TTS request. This prevents sentence tails from being dropped and avoids a second TTS prosody restart. The spoken opening is carried into later prompts so the agent does not greet the caller twice. Rapid short transcript fragments receive a bounded continuation window, and transient agent failures receive audible recovery turns followed by a natural farewell if the agent remains unavailable. Unrelated coding rules and tools are not injected into this managed telephone session, while the user's selected model/provider and within-call context remain authoritative. A cross-turn cooldown prevents natural pauses from stacking filler speech. AgentCall paces provider audio onto the host-to-phone link at one 20 ms frame every 20 ms, while the Android bridge continuously supplies silent frames between utterances; this prevents a faster-than-real-time provider burst from overflowing the phone queue and leaving only the end of a greeting audible. The incoming receptionist generates morning, afternoon, evening, and neutral-night openings plus common name, message, urgency, callback, privacy, repeat, identity, and closing responses when AI pickup is enabled. The same selected-voice clips are reused for every caller, while unmatched answers continue through live Hermes. Saving new receptionist context or changing the selected TTS provider, model, voice, or language regenerates the prepared audio. Outgoing calls generate their context-specific plan before dialing and pre-render high-value replies while ringing. Both call directions keep the short 250 ms route guard but no longer attempt speech until the exact call's recording and realtime media are ready. Policy and recording health still control every action.

Current clients should treat `preparedReplySpoken: true` from `wait_for_turn` as
an already completed response and immediately wait again. AgentCall selects
only strong, single-use prepared matches; pass `autoPreparedReply: false` to
disable this. A three-second no-audio TTS watchdog retries once before any audio
is sent, then releases the speech slot with `speech provider unavailable` so a
provider stall cannot block the remaining call.

Use the production conversation instruction and latency guidance in
[`AGENT_VOICE_MODE.md`](AGENT_VOICE_MODE.md). AgentCall uses the user's current
Hermes/OpenClaw model by default and does not require a separate voice profile.

## 13. Verify the source build

From a clone:

```bash
./verify.sh
```

The verifier is non-mutating. It does not install packages, modify the phone, place calls or contact paid providers.

## 14. Backup, upgrade and rollback

Before upgrading:

1. stop the service and confirm no active call;
2. run `agentcall-backup-state` for `/etc/agentcall` and `/var/lib/agentcall`;
3. verify the new package hash and inspect its payload;
4. install the new package;
5. run simulator/package preflight before hardware mode;
6. start hardware mode only after review.

On failure, stop the service, reinstall the previous package and use `agentcall-restore-state` while offline. Never auto-resume a call or media stream after rollback.

Uninstall preserves `/etc/agentcall` and `/var/lib/agentcall`; purging them is a separate explicit administrator action.

See [`../packaging/linux/UPGRADE-ROLLBACK.md`](../packaging/linux/UPGRADE-ROLLBACK.md).
