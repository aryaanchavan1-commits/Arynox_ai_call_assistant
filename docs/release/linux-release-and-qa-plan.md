# Linux Release and Qualification Plan

Status: release gate specification — Debian/Ubuntu Linux only

This plan applies to the USB-only agentcall architecture. The Android phone is reachable solely through `adb forward` to an Android server bound to `127.0.0.1`; the Linux gateway, dashboard, and MCP interfaces are local-only. SIP, RTP, Asterisk, STUN, and LAN phone transport are out of scope.

## 1. Release artifacts

A release candidate consists of:

- a versioned Debian package for `gatewayd`, the stdio MCP entrypoint, dashboard assets, simulator, schemas, systemd unit, tmpfiles/sysusers declarations, udev guidance, and licenses;
- an independently versioned Android APK, not installed as part of the Debian package;
- source revision, reproducible-build instructions, checksums, signatures, SBOM, dependency lock files, test report, compatibility matrix, rollback instructions, and known limitations;
- protocol golden vectors shared by Kotlin and JavaScript;
- no bundled API keys, phone numbers, call recordings, transcripts, ADB private keys, or test-device credentials.

The Linux package must not mutate a phone, install an APK, place a call, start a paid provider session, or alter global ADB authorization during installation.

## 2. Reproducible package build

Build in a clean pinned Debian/Ubuntu container or VM with no user home credentials mounted.

Required evidence:

1. Build twice from the same source and lock files in separate clean environments.
2. Compare package payload manifests and cryptographic hashes.
3. Record compiler/runtime/package-manager versions and `SOURCE_DATE_EPOCH`.
4. Reject floating dependency ranges and network downloads during the final package assembly step.
5. Run package linting and inspect maintainer scripts.
6. Verify package contents contain no development worktrees, fixtures presented as real data, secrets, recordings, or writable source trees.

A non-reproducible artifact is not releaseable; document the exact differing paths rather than waiving the gate.

## 3. Dependency pinning, SBOM, and provenance

- Commit exact Node dependency locks and pin system dependencies to declared minimum/maximum supported versions.
- Generate CycloneDX or SPDX SBOMs for Linux and Android artifacts.
- Record direct and transitive licenses and vulnerability-scan output.
- Sign the Debian package, APK checksum manifest, SBOM, and release evidence bundle.
- Preserve the source revision and build recipe needed to reproduce each binary.
- The repository must declare a project license before public release.

## 4. Filesystem and service account

Install under conventional immutable locations, for example:

- `/usr/lib/agentcall/` — application code;
- `/usr/bin/agentcall-gatewayd` and `/usr/bin/agentcall-mcp` — stable launchers;
- `/etc/agentcall/` — root-owned non-secret configuration;
- `/var/lib/agentcall/` — recordings, manifests, caller memory, and durable state;
- `/var/log/agentcall/` only if journald is insufficient;
- `/run/agentcall/` — sockets and ephemeral state.

Use a dedicated unprivileged `agentcall` system user. Root is permitted only for narrowly reviewed installation/udev actions. `gatewayd` must not run as root and must not have a general shell, broad home-directory access, or Linux network-listen capability beyond loopback.

## 5. systemd supervision and hardening

The package supplies a service unit with:

- explicit executable and configuration paths;
- `Restart=on-failure` with bounded backoff/start limits;
- readiness and watchdog semantics only when implemented and tested;
- clean `SIGTERM` teardown that stops provider streams, closes USB sockets, finalizes recordings, and writes completeness state;
- hardening such as `NoNewPrivileges=yes`, `PrivateTmp=yes`, restrictive `ProtectSystem`, `ProtectHome`, `RestrictAddressFamilies`, `RestrictNamespaces`, and a precise writable-path allowlist;
- no automatic restart loop that can repeatedly redial or resume media after a crash.

Run `systemd-analyze security` and preserve its output. Any relaxed directive needs a written justification.

## 6. ADB and udev identity

- Require a separately installed, supported `adb` executable and verify its version at startup.
- Identify the phone by configured serial plus approved build fingerprint/device profile; never choose an arbitrary first device.
- Treat `unauthorized`, `offline`, multiple-device, wrong-serial, and changed-fingerprint states as fail-closed.
- Use argument-array process execution, never shell interpolation.
- Create only the required `adb forward tcp:<hostPort> tcp:<devicePort>` mapping and remove the owned mapping on shutdown.
- Udev rules may grant the dedicated service user access only to the approved USB vendor/product identity. Do not use world-writable modes.
- ADB host keys remain administrator-managed; packaging must not copy or regenerate them silently.

## 7. Loopback-only operation

Automated tests and runtime assertions must prove:

- Android server bind address is exactly `127.0.0.1`;
- Linux dashboard/API listen addresses are exactly `127.0.0.1` or Unix sockets;
- MCP uses stdio or a local authenticated boundary;
- no production wildcard, LAN, Wi-Fi, SIP, RTP, STUN, or Asterisk listener exists;
- outbound cloud connections occur only through the selected consent-approved provider adapter.

Run socket inventory checks during package qualification and fail on unexpected listeners.

## 8. Simulator

Ship a deterministic Linux-side phone simulator that implements the canonical framing and call reducer but cannot place real calls. It must support:

- incoming ringing, answer/reject, outgoing dialing, active/end/error transitions;
- independent RX and TX PCM fixtures;
- malformed frames, partial reads, sequence gaps, duplicate commands, queue pressure, USB loss, delayed events, and process death;
- configurable recorder/provider failures;
- a visible `SIMULATOR` identity in dashboard, MCP status, logs, transcripts, and manifests.

Fixture mode must never be presented as a connected phone or a successful real call.

## 9. Protocol golden vectors

Kotlin and JavaScript tests must consume the same checked-in vectors for:

- `G2` magic, version 1, 24-byte header;
- CONTROL/EVENT/PCM kinds and host/device directions;
- unsigned big-endian session, sequence, timestamp-microseconds, and payload length fields;
- empty control frame and maximum payload boundary;
- exact 640-byte PCM requirement;
- truncated/trailing/unknown/reserved-invalid frames;
- streaming fragmentation/coalescing and bounded accumulator overflow.
- controller authentication client/server/session HMAC domains, nonce order,
  full proof bytes, and unsigned big-endian derived session ID.

A release is blocked if independently encoded bytes differ or one implementation accepts bytes the other rejects.

## 10. Queue, ownership, and zeroization tests

Prove under sustained pressure that:

- all media and event queues have fixed capacity and explicit overflow policy;
- consumer-owned dequeued data remains readable until release;
- discarded, released, and shutdown buffers are zeroized;
- sequence gaps and dropped-frame counts are observable;
- neither RX nor TX can starve control teardown indefinitely;
- RX is never copied into TX;
- memory usage reaches a stable bound during soak.

## 11. Full-duplex and latency qualification

Simulation gate:

- simultaneous deterministic RX/TX for at least one hour;
- no cross-channel contamination;
- measured frame loss, queue depth, memory, CPU, and timestamp drift;
- p50/p95/p99 latency for phone-to-STT partial/final and agent-text-to-first/last injected audio.

POCO device gate (approval required):

- exact `gram`/`atoll` device and approved Android build fingerprint;
- prove sustained simultaneous `VOICE_DOWNLINK` capture and `TYPE_TELEPHONY` playback on a real connected cellular call;
- verify intelligibility in both directions, barge-in, route persistence, and teardown restoration;
- test repeated calls and a one-hour call without audio leakage, route drift, or unbounded growth.

Independent direction probes do not satisfy the full-duplex gate.

## 12. Reconnect and process-death matrix

Test at every call state:

- unplug/replug USB;
- remove/recreate ADB forward;
- kill/restart Android app process;
- kill/restart `adb` server;
- kill/restart `gatewayd`;
- terminate MCP/dashboard clients;
- suspend/resume Linux where supported.

Expected behavior is fail-closed: stop injection, finalize or mark recording incomplete, emit an audited reason, never redial automatically, require fresh identity/profile/recorder checks, and reconnect only from a valid reducer state.

## 13. Recording completeness, disk-full, and crash recovery

Recording is mandatory and fail-closed before media/provider fan-out. Each call directory must contain or explicitly mark absence of:

- `remote.wav`;
- `agent.wav`;
- synchronized `conversation.mkv` or equivalent review media;
- `transcript.jsonl`;
- `events.jsonl`;
- `manifest.json` with consent, provider/model, timings, completeness, device/app/protocol versions, and failure reasons;
- a checksum manifest.

Tests cover preflight disk-space denial, mid-call disk full, permission loss, short writes, encoder failure, power/process loss, atomic metadata updates, orphan recovery, partial WAV/container repair, and checksum mismatch. No recording may be labeled complete unless all required finalization and hash checks pass.

## 14. Transcript, hash, retention, deletion, and audit

- Attribute every transcript turn to remote caller, agent, or system and retain original-language text separately from translations.
- Hash immutable finalized artifacts and seal the manifest/checksum relationship.
- Log access, export, retention changes, memory updates, and deletion without logging raw phone numbers or secret values.
- Enforce configured retention asynchronously with crash-safe retry.
- Deletion removes all call artifacts, derived indexes, caller-memory links as policy requires, and records a minimal non-content audit tombstone.
- Test legal-hold/policy denial, partial deletion recovery, expired artifacts, and unauthorized path traversal.

## 15. Provider outage, language, VAD, and barge-in

Use mocked servers for routine CI; paid provider tests require separate approval.

For each adapter test:

- authentication failure, quota/rate limit, timeout, malformed stream, disconnect, reconnect, duplicate/out-of-order events, and cancellation;
- English, Hindi, mixed Hindi/English, and configured deployment languages;
- 16→24 kHz STT and 44.1/other→16 kHz TTS resampling quality and timestamp accounting;
- VAD false starts/ends, silence, noise, and long utterances;
- barge-in immediately stops Linux-to-phone injection, cancels TTS, and prevents post-cancel queued audio leakage;
- cloud-disabled or consent-denied sessions produce zero provider requests.

## 16. Repeated-call and one-hour soak

Simulation release gate:

- at least 100 complete short calls covering incoming/outgoing/reject/hangup/error paths;
- one continuous one-hour full-duplex media session;
- bounded memory/file descriptors/threads/queues;
- no stale ADB forwards, sockets, provider sessions, temp files, or unreleased audio devices;
- every call has a terminal reducer state and complete or honestly incomplete artifact manifest.

The approval-required POCO gate repeats a smaller safe matrix plus one sustained real call under controlled conditions.

## 17. Install, upgrade, uninstall, and rollback

Linux package tests in clean VMs cover:

1. fresh install without credentials/device;
2. configure and start in simulator mode;
3. upgrade with preserved compatible state and explicit migrations;
4. failed upgrade with package rollback;
5. downgrade refusal when state is incompatible;
6. uninstall that stops services and removes runtime files but preserves user data unless purge is explicitly requested;
7. purge with a clear destructive confirmation path;
8. reinstallation without stale sockets/users/permissions.

Android APK installation, privileged placement, permission grants, role changes, rollback, and phone mutation are a separate artifact gate and require explicit user approval. Produce commands, hashes, backup/rollback plan, and expected prompts before requesting approval.

## 18. Hermes/OpenClaw compatibility

Use the packaged stdio MCP command from a clean Hermes configuration and verify:

- initialization and capability negotiation;
- tool listing and strict schemas;
- `status`, `capabilities`, `dial`, `answer`, `reject`, `hangup`, and `send_dtmf` in simulator mode;
- incoming-call/transcript/recording/caller-context resources and events;
- idempotency, policy denial, unknown-field rejection, and redacted errors;
- no PCM/base64 audio in MCP inputs, outputs, notifications, logs, or resources;
- dashboard displays a correct copyable Hermes configuration snippet.

## Approval boundaries

The following may run without further approval in isolated worktrees/VMs:

- compilation, lint, unit/integration tests, simulator calls, fixture audio, package builds, static scans, local loopback browser tests, and MCP simulator smoke tests.

The following require explicit approval immediately before execution:

- installing or replacing an APK;
- privileged app placement, permission/app-op/role/property changes, rooting actions, or phone mutation;
- placing, answering, or recording real cellular calls;
- sending audio or incurring cost through a paid/cloud provider account;
- publishing packages/releases or pushing commits if not separately authorized.

## Release evidence checklist

A release candidate is accepted only when the evidence bundle contains:

- [ ] source revision and clean/diff inventory;
- [ ] reproducible Debian package hashes and package-lint output;
- [ ] signed checksums, SBOMs, licenses, and vulnerability scan;
- [ ] systemd hardening/readiness/teardown evidence;
- [ ] ADB serial/fingerprint/forward and udev tests;
- [ ] loopback socket inventory and legacy SIP/LAN scan;
- [ ] Kotlin/JavaScript golden-vector results;
- [ ] simulator, queue, reconnect, process-death, recording-failure, retention/deletion, provider-outage, and barge-in reports;
- [ ] 100-call and one-hour simulation soak metrics;
- [ ] Hermes/OpenClaw MCP smoke-test transcript;
- [ ] dashboard desktop/mobile browser evidence;
- [ ] POCO full-duplex/repeated-call/one-hour qualification evidence, or an explicit `DEVICE QUALIFICATION NOT RUN` blocker;
- [ ] Android APK hash, privilege audit, install/uninstall/rollback plan, or an explicit `INSTALL NOT APPROVED` blocker;
- [ ] independent architecture, code, security, and release reviews;
- [ ] known limitations and rollback procedure.

No green specialist self-report substitutes for parent-run commands and independently inspected artifacts.
