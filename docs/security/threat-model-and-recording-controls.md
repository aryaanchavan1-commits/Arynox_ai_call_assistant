# Threat Model and Recording Controls

Status: **Draft for review** — security/privacy/safety lead
Date: 2026-07-19
Scope: Linux-only USB-debugging cellular AI-call gateway (target architecture per `docs/phase0-direct-agent-gateway.md`)

This document is **not legal advice**. Jurisdiction, consent, and retention
language identifies configuration boundaries an operator must verify against
applicable law; it does not determine compliance.

## 1. System under test

The target product is a **USB-only agent-to-phone cellular gateway**. A
dedicated Android phone (qualified: Xiaomi POCO M2 Pro `gram`/`atoll`,
Android 15, LineageOS, Magisk 30.7, SELinux Enforcing) bridges a cellular
call to a Linux PC. The PC is the sole bridge between the phone and an MCP
agent (Hermes, OpenClaw, or other local MCP client).

Hard invariants inherited from the approved Phase 0 decision:

- **No SIP, no RTP, no Asterisk, no STUN, no LAN/Wi-Fi transport, no phone
  network listener.** Legacy `app/.../sip/*`, `app/.../rtp/*`,
  `app/.../net/StunClient.kt`, and the legacy `magisk/` module are removed
  from the production build. They remain in Git history only.
- The Android app listens only on its **loopback** interface.
- The PC owns `adb forward tcp:<host-port> tcp:<phone-port>` and verifies the
  expected device serial/fingerprint before connecting.
- The forwarded localhost socket carries ordered control/events and binary
  PCM. Raw audio never passes through ordinary MCP calls.
- **Every agent-handled call is recorded on the Linux host** for authorized
  human review. Recording is a separate consent/retention feature, off by
  default, fail-closed.
- ADB shell is not used to carry PCM or to execute arbitrary commands.

Directional digital audio is proven (Phase 0). Full-duplex production
qualification, soak, and agent-driven call control under policy are the
remaining gates and are **not yet proven**. This threat model covers the
target architecture; findings against code currently in the repository are
flagged as **legacy** and must be resolved by removal/replacement, not by
patching SIP-era components.

## 2. Assets

| Asset | Sensitivity | Location |
|---|---|---|
| Call audio — remote party (Telephony RX) | High (PII, voiceprint, conversation content) | Phone capture buffer → PC over USB |
| Call audio — agent track (Telephony TX injection) | High (agent output, may contain secrets) | PC PCM → phone injection buffer |
| Mixed call recording | High (both parties, strongest legal protection) | PC disk, encrypted |
| Transcript | High (text of full conversation) | PC disk, encrypted |
| Phone numbers (E.164) | Medium-High (dialing + CDR) | PC policy store, audit log |
| Provider API keys / STT-TTS / realtime-agent secrets | Critical | PC secret store |
| Recording/transcript encryption keys | Critical | PC key store |
| ADB device enrollment / pairing material | High | PC keystore + phone adb trust |
| Audit log (append-only) | High (tamper-evidence) | PC disk |
| Consent + jurisdiction policy | High (legal exposure) | PC config |
| Call-control safety policy (allowlists, rate limits) | High (abuse prevention) | PC config |
| Device fingerprint / capability matrix | Medium (supply chain integrity) | PC + phone |
| SIM identity / IMSI | Medium (read indirectly) | Phone/modem |

## 3. Trust boundaries

```
TB-1  Agent (MCP client)              ← least trusted controller of call actions
TB-2  PC gatewayd + MCP server        ← policy, audit, consent, recording owner
TB-3  PC OS / user account            ← host boundary for secrets + keys
TB-4  USB cable / ADB forward         ← physical + ADB-auth channel
TB-5  Android app (privileged)        ← telephony + audio bridge
TB-6  Android OS / SELinux / Magisk   ← device integrity
TB-7  Cellular modem / SIM / carrier  ← untrusted remote party + carrier network
TB-8  Provider APIs (STT/TTS/realtime) ← external service, own trust boundary
```

Boundary rules:

- **TB-1 → TB-2:** Agent speaks only MCP. Every tool call is authenticated,
  authorized against policy, idempotency-keyed, and audited. Agent never
  touches PCM directly.
- **TB-2 → TB-5:** PC speaks only the loopback media/control protocol over
  the ADB-forwarded socket. One authenticated controller lease at a time.
- **TB-7:** The remote party is untrusted. Their audio may contain attempts
  to manipulate the agent (prompt injection over voice), DTMF spoofing, or
  social engineering. Agent output to them is recorded.
- **TB-8:** Provider APIs receive audio/transcripts. Their data handling is
  outside our control; minimize what is sent, route per consent/jurisdiction
  policy, and never send recording keys or unrelated call data.

## 4. Threats and mitigations

### T1. Unbounded agent dialing / autonomous calling abuse
- **Threat:** Agent dials premium, international, emergency, or numbers
  outside allowlist; floods; cost fraud; harassment.
- **Mitigation:** Outbound dialing disabled by default. Enable only behind
  all gates in §10. E.164 normalization, allowlist/denylist, premium/
  emergency/international restrictions, per-call confirmation in early dev,
  rate/duration/daily-spend/per-destination cooldown, idempotency keys,
  inbound-only and media-only kill switches, on-device active-call
  indicator + physical stop control, redacted audit.
- **Status:** Phase 2 gate, not yet implemented.

### T2. Recording without consent / wrong jurisdiction
- **Threat:** Call recorded where one-party or two-party consent not met;
  recording retained/exported across jurisdiction boundary illegally.
- **Mitigation:** Recording off by default. Explicit per-call or per-config
  consent flag. Jurisdiction policy gates whether recording, retention, and
  provider routing are even offered. Fail-closed when consent unknown. See
  §9, §11.

### T3. Recording fails open / silent partial recording
- **Threat:** Disk full, key missing, writer crash, or USB loss leaves a
  partial/decrypted/unkeyed recording, or the call proceeds unrecorded.
- **Mitigation:** Recording is **fail-closed**. If recording cannot start
  (no key, no disk, consent missing, writer error), the agent call does not
  proceed or is torn down per policy. Partial artifacts are finalized,
  hashed, and either sealed or destroyed — never left half-written. See §13.

### T4. Secrets leakage (provider keys, recording keys, ADB material)
- **Threat:** Secrets in plaintext config, world-readable files, env vars
  leaked to subprocesses, committed to Git.
- **Legacy finding (current code):** `GatewayService.kt` stores SIP password
  in plaintext `SharedPreferences` (`pass`). `CallLogStore.kt` stores full
  phone numbers in plaintext `SharedPreferences` (`num`). Both violate the
  target invariants and are removed with the SIP-era code.
- **Mitigation:** OS keyring/secret store for provider keys and recording
  keys; file permissions `0600`, directory `0700`, owner = gatewayd service
  account. No secret in env passed to untrusted subprocesses. See §6.

### T5. Phone-number / PII over-retention
- **Threat:** Full E.164 numbers accumulate in logs, CDRs, transcripts.
- **Mitigation:** Minimize. Store hashed/truncated forms by default
  (`sha256(e164 + per-deployment salt)` plus last-4 for operator recall).
  Full number retained only where consent + retention policy explicitly
  require, time-bounded, and purged on expiry. Audit references use the hash.

### T6. Loopback socket hijack / unauthenticated controller
- **Threat:** Local process on phone or PC connects to the forwarded socket
  and injects call-control commands or siphons PCM.
- **Mitigation:** Android binds loopback only. One authenticated controller
  lease; a second pending or authenticated connection is refused. Explicit
  on-phone approval creates a high-entropy per-controller enrollment secret;
  it is not silently provisioned through ADB. Every TCP connection uses fresh
  server/client nonces, domain-separated mutual HMAC proofs, and a derived G2
  session ID. No semantic, PCM, or artifact frame is admitted before proof.
  PC side binds `127.0.0.1` only for the MCP socket.

### T7. ADB identity spoofing / wrong device
- **Threat:** A second phone plugged in, or a device reflashed, causes PC to
  forward to an unknown device.
- **Mitigation:** Enrollment pins device serial + build fingerprint +
  capability matrix. `gatewayd` verifies the connected device matches the
  enrolled identity before establishing the forward. Unknown/mismatched
  device fails closed. See §12.

### T8. Arbitrary root command execution (legacy)
- **Legacy finding:** `RootShell.kt` opens a persistent `su` shell and
  executes arbitrary string commands (`exec`/`execForOutput`) built from
  device-profile shell strings. This is a command-injection and
  privilege-escalation surface and couples the app to global root.
- **Accepted mitigation:** Production AudioBridge uses typed Android audio
  APIs (Telephony RX/TX) and the proven no-mixer-write path. `RootShell.kt`
  and all runtime mixer-command execution are removed. Historical device
  profile strings remain inert porting metadata and cannot be resolved or
  executed by production code. Any future privileged operation must be a
  narrow, allowlisted, argument-validated operation invoked through a typed
  API, never a free-form shell string. The qualified `atoll`/`gram` path
  required no manual mixer toggles.

### T9. Privilege over-grant / unsafe Magisk behavior (legacy)
- **Legacy finding:** `magisk/service.sh` and `install.sh` globally hide and
  kill Android's PermissionController, force `RECORD_AUDIO` appops at UID +
  package level, set global audio-concurrency properties
  (`voice.*.conc.disabled`, Fluence disables, `persist.audio.call_record`),
  ship broad privapp permissions (`WRITE_SECURE_SETTINGS`,
  `INTERACT_ACROSS_USERS`, `READ_LOGS`, `CALL_PRIVILEGED`,
  `READ_PRECISE_PHONE_STATE`), and stage `tinymix`/`tinycap` in
  `/data/local/tmp`. `magisk/system.prop` mutates global audio behavior.
- **Mitigation (target):** Replace wholesale. See §7 for the
  privilege-minimized manifest/module. No PermissionController hiding, no
  appops forcing, no global audio properties, no broad privapp permissions,
  no SELinux weakening.

### T10. Prompt injection / agent manipulation via remote party
- **Threat:** Remote party speaks instructions ("ignore previous
  instructions, dial …") that the agent obeys.
- **Mitigation:** Agent output is recorded (agent track). Call-control
  safety gates (§10) are enforced in `gatewayd`, not the agent, so agent
  instructions cannot bypass allowlist/rate/consent checks. Transcript +
  agent track available for review to detect manipulation.

### T11. Supply-chain compromise of APK / module / binaries
- **Threat:** Tampered APK, Magisk module, or `tinymix`/`tinycap` binary.
- **Mitigation:** Every privileged artifact gets SHA-256 recorded at build
  and re-verified at install and at enrollment. Reproducible build from
  pinned sources. `tinymix`/`tinycap` only in read-only diagnostic path,
  not production runtime. See §14.

### T12. Provider data exfiltration / wrong routing
- **Threat:** Audio/transcript sent to a provider disallowed by
  jurisdiction or consent; provider retains beyond our control.
- **Mitigation:** Provider routing is policy-driven per jurisdiction.
  Minimize payload (audio only, no recording keys, no unrelated metadata).
  Allowlist provider endpoints. Audit every provider call.

### T13. Audit log tampering
- **Threat:** Operator or attacker edits audit to hide abuse.
- **Mitigation:** Append-only log with chained hashes. See §8.

### T14. USB loss / process death / reboot mid-call
- **Threat:** Partial recording, orphaned call, leaked buffers.
- **Mitigation:** Single idempotent teardown path. On USB loss: stop
  injection immediately, zeroize capture buffers, finalize or destroy
  partial recording per policy, preserve or end cellular call per
  configured policy. Recovery re-establishes forward and re-verifies
  identity. See §13.

## 5. Abuse cases

- **A1. Agent dials its own number / loops calls** → rate limit +
  per-destination cooldown + denylist self + idempotency keys.
- **A2. Agent exfiltrates data via DTMF** → DTMF send is gated behind
  allowlist + rate + audit; recorded on agent track.
- **A3. Operator exports a recording outside retention/jurisdiction** →
  export is an audited, policy-gated action; blocked when jurisdiction or
  retention disallows; every export recorded.
- **A4. Attacker with physical USB plugs rogue phone** → device identity
  verification fails closed; no forward to unknown device.
- **A5. Local malware on PC reads PCM socket** → MCP + media sockets bind
  `127.0.0.1`; controller authentication; service-account isolation.
- **A6. Replay of a recorded MCP command** → idempotency keys + per-session
  controller secret.
- **A7. Recording kept after retention expiry** → retention enforcer purges
  on schedule; deletion audited with hash tombstone.
- **A8. Agent calls emergency services** → emergency numbers hard-denied in
  policy; agent cannot override.

## 6. Secrets model

**Secret classes and storage:**

| Secret | Storage | Notes |
|---|---|---|
| Provider API keys (STT/TTS/realtime) | OS secret store / keyring, `0600` file fallback | Never in env passed to agent subprocesses |
| Recording + transcript encryption keys | OS secret store, envelope encryption | Per-deployment master key, per-call DEK |
| ADB host key | Root-owned host key + adb trust store | Separate from controller authorization |
| Controller enrollment secret | Android Keystore AES-256/GCM + app-private ciphertext; PC root/service-group `0640` raw key file | Exact 32 bytes, explicitly enrolled, rotatable and revocable |
| Controller connection nonces/session ID | In memory for one connection | Fresh nonces; domain-separated HMAC; derived unsigned 32-bit G2 session ID |
| Phone numbers | Hashed + truncated by default | Full form only under consent+retention |
| Policy config | `0600` file, `0700` dir | Tamper-evident via audit |

**Rules:**
- No secret in Git, logs, crash dumps, or MCP resource output.
- Secrets validated present at startup; missing critical secret = fail
  closed, no calls accepted.
- Provider keys rotatable without re-recording existing data (keys are
  independent of recording keys).
- `allowBackup="false"` on the Android app (already set).
- Rotation procedure documented per secret class; rotation is an audited
  event.

## 7. Privilege-minimized Android manifest and module (replacing legacy Magisk)

Derived from the exact proven features, not copied from the legacy
broad allowlist. This is the production set; the legacy `magisk/` module
is **not shipped forward**.

### 7.1 Production manifest permissions

Runtime-visible (user grants, each tied to implemented dialer behavior):
- `android.permission.RECORD_AUDIO` — Telephony RX capture prerequisite.
- `android.permission.READ_PHONE_STATE`, `android.permission.CALL_PHONE`, and
  `android.permission.ANSWER_PHONE_CALLS` — explicitly selected default-dialer
  call state/control; outbound calls remain recording- and policy-gated.
- `android.permission.READ_CONTACTS` and `android.permission.READ_CALL_LOG` —
  read-only Contacts and Recents screens. No contact or call-log write grant.
- `android.permission.POST_NOTIFICATIONS` — visible foreground-service status.

Normal/service permissions:
- `android.permission.INTERNET` — required only for the exact loopback
  `127.0.0.1:27183` listener reached through ADB forwarding; the artifact gate
  separately proves there is no LAN/Wi-Fi bind.
- `android.permission.MODIFY_AUDIO_SETTINGS` — Android call route/volume APIs.
- `android.permission.FOREGROUND_SERVICE`,
  `android.permission.FOREGROUND_SERVICE_PHONE_CALL`,
  `android.permission.MANAGE_OWN_CALLS`, and `android.permission.WAKE_LOCK` —
  supervised USB appliance lifecycle. Target SDK 35 requires
  `MANAGE_OWN_CALLS` for a `phoneCall` foreground-service type.

Signature/privileged (priv-app only, each justified):
- `android.permission.CAPTURE_AUDIO_OUTPUT` — proven `VOICE_DOWNLINK` /
  Telephony RX capture.
- `android.permission.MODIFY_AUDIO_ROUTING` — proven Telephony TX path.
- `android.permission.MODIFY_PHONE_STATE` — typed call/audio operations
  that demonstrably require it (mirrors the approved probe model).
- `READ_PRIVILEGED_PHONE_STATE` is omitted because the selected default-dialer
  architecture does not require it.

**Explicitly excluded** (present in legacy, forbidden in production unless
separately demonstrated and approved):
- `CALL_PRIVILEGED`, `READ_PRECISE_PHONE_STATE`, `READ_PHONE_NUMBERS`, and
  `WRITE_CALL_LOG` (Contacts/Recents are read-only and the app never writes the
  system call log).
- `WRITE_SECURE_SETTINGS`, `INTERACT_ACROSS_USERS`, `READ_LOGS`.
- `ACCESS_FINE_LOCATION`, `ACCESS_COARSE_LOCATION`, `ACCESS_WIFI_STATE`,
  `CHANGE_WIFI_STATE`, and `RECEIVE_BOOT_COMPLETED`.
- `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` unless appliance soak proves it
  required.

If `CALL_PHONE` or outbound dialing is enabled in a later phase, it is
granted only behind the §10 gates and the manifest entry is added at that
phase, not preemptively.

### 7.2 Production privapp-permissions XML

Allowlist only the signature permissions actually declared and justified in
§7.1. Concretely the production set is no larger than:

- `CAPTURE_AUDIO_OUTPUT`
- `MODIFY_AUDIO_ROUTING`
- `MODIFY_PHONE_STATE`
- `READ_PRIVILEGED_PHONE_STATE` *(only if §7.1 requirement met)*
- `REGISTER_CALL_PROVIDER`, `REGISTER_SIM_SUBSCRIPTION`,
  `BIND_INCALL_SERVICE`, `BIND_TELECOM_CONNECTION_SERVICE` *(Telecom
  registration only)*

No `WRITE_SECURE_SETTINGS`, no `INTERACT_ACROSS_USERS`, no `READ_LOGS`.

### 7.3 Production module behavior (replaces legacy `magisk/`)

The production Magisk module is rebuilt from the narrow proven model. It
must:

- **Not** hide, disable, or kill PermissionController.
- **Not** force-set appops (`appops set … RECORD_AUDIO allow`, UID or
  package).
- **Not** set global audio properties (`voice.*.conc.disabled`,
  `persist.audio.*`, Fluence disables, `ro.qc.sdk.audio.*`).
- **Not** weaken SELinux or replace PermissionController via `.replace`
  overlay.
- **Not** auto-grant runtime permissions; runtime permissions follow normal
  Android grant flow or a documented, audited enrollment step.
- Stage `tinymix`/`tinycap` only if a proven production path needs them; the
  qualified `atoll`/`gram` path needed no manual mixer toggles, so
  production ships **no** mixer binaries by default. Diagnostics use the
  read-only `tools/diag/magisk-safe/` skeleton only.
- Install the APK as priv-app with the §7.2 allowlist only.
- Be hashed and version-pinned; install verifies the hash.

This mirrors the already-approved probe modules
(`com.callagent.uplinkprobe`, `com.callagent.downlinkprobe`), which
demonstrate the minimal model: only `MODIFY_AUDIO_ROUTING` +
`MODIFY_PHONE_STATE`, `allowBackup="false"`, no global props, no
PermissionController manipulation, fail-closed capture guards
(`StoredCaptureGuard` rejects writes unless `routedDeviceType == TYPE_TELEPHONY
(18)` and sample counts match).

### 7.4 Device capability fail-closed

`DeviceAudioPlugin` requires exact `gram`/`atoll` fingerprint + capability
match (`Capabilities.injectionVerified`, `mixerWritesAllowed`). Unknown
builds fail closed. No guessed mixer writes. This is already the `atollGram`
profile behavior and is the production rule.

## 8. Append-only audit and hashes

**Audit log (PC, append-only):**
- Open with `O_APPEND`; no in-place edits; rotation preserves chain.
- Each entry: monotonic sequence, monotonic timestamp (PC clock; phone
  events carry phone-side monotonic timestamp + session ID for correlation),
  actor (controller/agent/operator/system), action, target (call id /
  number hash), outcome, and previous-entry hash → chained hash tree.
- Periodic anchored root hash (e.g., daily) optionally signed or
  notarized for tamper-evidence.

**Audited events (minimum):**
- Device enrollment / identity verification / forward establish / forward
  loss.
- Controller lease grant / evict / session secret rotation.
- Every call-control command (dial/answer/reject/hangup/DTMF) with
  idempotency key, policy decision, outcome.
- Recording start/stop, partial-finalize, destroy.
- Transcript generation.
- Retention expiry purge, export, playback, deletion.
- Provider call (provider id, payload type, jurisdiction decision) — no
  audio content, no secret.
- Policy/consent/config change.
- Key rotation, secret presence check failures.
- Permission/privilege grant or denial on device.

**Hashes:**
- Each recording (remote track, agent track, mixed) → SHA-256 in the
  manifest and audit.
- Each transcript → SHA-256 in the manifest and audit.
- Each shipped privileged artifact (APK, module ZIP, any binary) → SHA-256
  recorded at build, verified at install and enrollment.
- Audit entry hashes are SHA-256 of `prev_hash || canonical(entry)`.

## 9. Recording controls

**Invariant:** every agent-handled call is recorded on the Linux host for
authorized human review. This is a product requirement, not optional.

**Tracks and artifacts:**
- **Remote track** — Telephony RX capture (the human/cellular party).
- **Agent track** — Telephony TX injection (the agent's output).
- **Mixed artifact** — synchronized mix of both tracks for review.
- **Transcript** — text of the call, attributed per track where possible.
- **Manifest** — per-call JSON: call id, timestamps, direction, number
  hash (+last-4), consent flag, jurisdiction, track file ids + hashes,
  transcript id + hash, retention class, retention-expiry, key id, provider
  calls, audit sequence range.

**Default and gating:**
- Recording off by default at the config level; the agent-call recording
  requirement is satisfied by enabling recording in the approved
  deployment configuration, not by the agent deciding per call.
- Recording is **fail-closed**: if a call cannot be recorded (missing key,
  no disk, writer error, consent unknown), the agent call does not proceed
  or is torn down per policy. An unrecorded agent call is a security
  failure, not a degraded mode.
- Tracks written encrypted-at-rest as they stream (see §11); plaintext
  exists only in transient locked memory, zeroized after write.

**Retention, access, export, playback, deletion:**
- Retention class per jurisdiction + consent; each artifact has
  retention-expiry in manifest.
- Access is role-gated (authorized human reviewer only); every
  access/playback/export is audited with actor + purpose.
- Export is policy-gated; blocked when jurisdiction or retention
  disallows; exported bundle includes manifest + hashes, re-encrypted.
- Deletion on retention expiry is enforced by a retention sweeper; deletion
  writes a hash tombstone to the audit log (artifact destroyed, hash
  retained for proof-of-existence).
- Secure deletion: key destruction renders ciphertext unrecoverable;
  file overwrite where feasible.

## 10. Call-control and provider safety gates

**Call-control gates (enforced in `gatewayd`, not the agent):**
1. Authenticated device enrollment + one active controller lease.
2. E.164 normalization; reject non-E.164.
3. Destination allowlist + denylist.
4. Premium, emergency, international restrictions (emergency hard-denied).
5. Per-call confirmation mode in early development (manual approve).
6. Rate, duration, daily-spend, and per-destination cooldown limits.
7. Idempotency keys prevent duplicate calls.
8. Inbound-only kill switch and media-only kill switch.
9. On-device active-call indicator + physical stop control.
10. Redacted audit records (no full numbers by default).
11. Recording verified on before call proceeds (fail-closed).

Initial development keeps dialing manually approved or allowlist-only.
Automatic dialing enabled only after policy tests pass.

**Provider-use gates:**
1. Provider endpoint allowlist; no arbitrary URLs.
2. Provider routing decided by jurisdiction + consent policy; disallowed
   provider → call does not use that provider (fail-closed or fallback per
   policy).
3. Minimize payload: audio/transcript only; no recording keys, no
   unrelated call data, no full numbers unless required.
4. Every provider call audited (provider id, payload type, jurisdiction
   decision, outcome). No audio content or secrets in the audit entry.
5. Provider keys rotated independently of recording keys.
6. Provider failure does not silently fall back to an unrecorded path.

## 11. File permissions, encryption, and key handling

**File permissions (PC):**
- Recording/transcript/audit/config dirs: `0700`, owner = `gatewayd`
  service account, not shared with the interactive user.
- Files: `0600`. No world/group read on any artifact, secret, or log.
- MCP socket + media socket bind `127.0.0.1` only.
- tmpfiles/directories for in-flight PCM: `0700`, on tmpfs where possible,
  zeroized and unlinked on release.

**Encryption at rest:**
- Recordings, transcripts, and manifests encrypted at rest with envelope
  encryption: per-call data-encryption key (DEK) wraps content, DEK wrapped
  by per-deployment master key (KEK) in the OS secret store.
- Ciphertext written as PCM streams; never a complete plaintext file on
  disk.
- Audit log is append-only; not encrypted (must be readable for
  tamper-evidence) but `0600` and hash-chained. Secrets never appear in it.

**Key handling:**
- KEK in OS keyring/secret store; presence checked at startup; missing →
  fail closed.
- DEK per call, generated on call start, wrapped, stored with manifest,
  destroyed from memory after sealing.
- Key rotation: KEK rotatable; re-wrap DEKs without re-encrypting content.
- Compromise procedure: rotate KEK, re-wrap, audit; if recording keys
  compromised, key destruction renders all ciphertext unrecoverable
  (documented trade-off).
- No key ever in env passed to untrusted subprocesses, logs, crash dumps,
  or MCP output.

## 12. ADB identity and pairing

- **Pairing:** device enrolled once over an authenticated ADB pairing; PC
  stores adb trust + a per-device enrollment record (serial, build
  fingerprint, capability matrix hash).
- **Forward ownership:** `gatewayd` owns `adb forward tcp:<host-port>
  tcp:<phone-port>`; verifies connected device serial + fingerprint match
  the enrolled record before connecting. Mismatch/unknown → fail closed,
  no forward.
- **Channel use:** ADB carries the localhost socket only. ADB shell is not
  used to carry PCM or execute arbitrary commands.
- **Reconnect:** USB unplug/replug and ADB restart handled by `gatewayd`
  with re-verification; backoff; audited.
- **No ADB shell command surface in production** (legacy `RootShell` removed).

## 13. Crash and partial-recording semantics

- **Single idempotent teardown path** for remote hangup, local hangup,
  transport loss, process stop, and errors. States: `IDLE`, `RINGING`,
  `DIALING`, `ACTIVE_NO_MEDIA`, `STREAMING`, `TEARING_DOWN`, `ERROR`.
- **On USB/transport loss:** stop injection immediately, stop/zeroize
  capture buffers, finalize or destroy partial recording per policy,
  preserve or end cellular call per configured policy.
- **On writer crash / disk full / key error mid-call:** fail closed —
  finalize partial artifact (seal + hash + mark partial) or destroy it;
  never leave a half-written unencrypted or unkeyed file; tear down the
  agent call per policy.
- **On `gatewayd` process death:** restart re-establishes forward,
  re-verifies identity, reconciles in-flight call state from phone,
  finalizes any orphaned partial recording (seal/destroy), audits.
- **On phone reboot:** `gatewayd` detects forward loss, waits for device,
  re-verifies identity, audits; in-flight recording on PC is finalized per
  the transport-loss rule (PC side retains what it has).
- **Partial artifact rule:** a partial recording is either sealed (hashed,
  marked `partial=true`, retention-bound) for review or destroyed; it is
  never silently completed and never left plaintext. The manifest records
  `partial` and the reason.

## 14. Supply chain

- **Reproducible build** from pinned sources (gradle, JDK, NDK versions
  pinned; dependency lockfile).
- **Artifact hashes:** APK SHA-256, module ZIP SHA-256, any shipped binary
  SHA-256 — recorded at build, printed in release notes, verified at
  install and at enrollment. (Phase 0 already records probe APK/ZIP
  SHA-256; production follows the same rule.)
- **Binary minimization:** `tinymix`/`tinycap` shipped only if a proven
  production path needs them; default production ships none. Diagnostics
  use the read-only `tools/diag` host script or `magisk-safe` skeleton.
- **No third-party Magisk modules, no unverified overlays.**
- **Dependency review:** new dependencies require review for the privileged
  app; transitive deps inspected. Provider SDKs run PC-side only.
- **Signing:** APK signed with a documented key; signature verified at
  priv-app install.
- **Rollback:** every privileged artifact change ships rollback
  instructions; rollback is an audited event.

## 15. Incident response

1. **Detect:** anomaly via audit (rate-limit hits, denied dials, recording
   failures, identity mismatches, unexpected provider calls, partial
   recordings).
2. **Contain:** kill switches — inbound-only, media-only, and full
   recording/dialing stop. Revoke controller lease. Optionally revoke
   device enrollment to halt all call activity.
3. **Preserve:** seal affected recordings/transcripts/audit; do not purge
   until investigation closes (overrides retention sweeper for hold).
4. **Investigate:** reconstruct from append-only audit + manifests + hashes;
   verify hashes detect tampering.
5. **Notify:** follow operator's legal/privacy notification obligations
   (out of scope here — operator must map to applicable law).
6. **Remediate:** rotate compromised secrets/keys; patch; re-enroll device
   if identity compromised.
7. **Post-incident:** add detection; update threat model; record lessons
   in audit.

## 16. Privacy and legal configuration boundaries (not legal advice)

This section names configuration boundaries an operator must verify against
applicable law. It is **not** a compliance determination.

- **Consent:** one-party vs two-party/all-party consent varies by
  jurisdiction. The gateway exposes a consent policy (off by default; per-
  call or per-config). Operator must set it to match the jurisdictions of
  **all** parties on a call, not just the operator's.
- **Jurisdiction:** a jurisdiction policy gates whether recording,
  retention, provider routing, and export are offered at all. Calls
  crossing jurisdiction boundaries may need stricter settings. Operator is
  responsible for mapping call endpoints to jurisdictions.
- **Retention:** retention classes are configurable; default to minimum
  necessary for authorized human review. Longer retention requires explicit
  justification and may be disallowed by jurisdiction.
- **Provider routing:** sending audio/transcripts to a third-party provider
  may itself be a disclosure requiring consent and a data-processing
  agreement. Minimize payload; allowlist providers; route per jurisdiction.
- **Phone numbers:** minimize by default; full numbers only under
  consent+retention; hashed form for audit.
- **Subject access / deletion:** operator must be able to locate, export,
  and delete an individual's data on request; the manifest + hash index
  enables this. Deletion is audited.
- **No legal advice:** none of the above is legal advice. Operator must
  obtain qualified legal review for each deployment jurisdiction.

## 17. Release-blocking checklist

A release is **blocked** until every item is true. (Caveman off for this
list — order matters.)

- [x] Legacy `app/.../sip/*`, `app/.../rtp/*`, `app/.../net/StunClient.kt`
      removed from source and the production APK; `packaging/android/test-legacy-boundary.sh`
      scans source paths, exact symbols, manifests, and every APK DEX file.
- [x] Legacy `magisk/` module not shipped; the production module is built only
      from `packaging/android/`, verifies the embedded APK hash, allowlists only
      three protected permissions, and rejects daemon scripts, global properties,
      SELinux rules, mixer binaries, `.replace`, and broad privileges.
- [x] `RootShell.kt` removed from production; no free-form `su` command
      execution in runtime path. `packaging/android/test-legacy-boundary.sh`
      scans source and rebuilt APK DEX for the executor and known launch forms.
- [x] Android app binds only `127.0.0.1:27183`; no LAN/Wi-Fi/SIP listener.
      Kotlin unit tests and `packaging/android/test-legacy-boundary.sh` enforce
      the exact bind constant and scan the merged manifest and built APK.
- [x] Production manifest matches §7.1; no excluded permissions present.
      `packaging/android/test-permission-boundary.sh` compares the source and
      merged manifests against exact permission sets; `WRITE_CALL_LOG` is gone.
- [x] privapp-permissions XML matches §7.2; broad permissions removed.
      `packaging/android/test-build-artifacts.sh` requires exactly the three
      proven signature grants and rejects any additional allowlist entry.
- [x] Device capability fail-closed enforced. `DeviceSelector` qualifies only
      `ATOLL_GRAM` for release audio; `UsbAudioBridgeCoordinator` requires that
      qualification before opening Telephony RX/TX. Unit and source-boundary
      tests prove unsupported devices never invoke `bridge.start()`, and no
      runtime mixer-command executor remains.
- [x] `gatewayd` verifies enrolled device serial+fingerprint before forward;
      unknown device fails closed. Hardware config requires both values, and
      integration tests prove a mismatch creates no ADB forward, opens no device
      connection, and leaves the daemon stopped.
- [x] Loopback controller authenticated with one pending/active lease and a
      fresh derived session ID per connection. Enrollment requires explicit
      on-phone confirmation; Android stores only Keystore AES-GCM ciphertext;
      Linux validates a root/service-group `0640` 32-byte key file. Mutual HMAC
      authentication precedes all G2 traffic, stale sessions and duplicate or
      backward sequences are rejected, wrong-secret clients are not promoted,
      failed authentication rolls back the owned ADB forward, and simulator,
      soak, source, manifest, and APK gates exercise the authenticated path.
- [ ] MCP socket + media socket bind `127.0.0.1` only.
- [ ] Recording fail-closed verified: no key/disk/consent failure allows an
      unrecorded agent call.
- [ ] Separate remote track, agent track, mixed artifact, and transcript
      manifest implemented; all hashed.
- [ ] Encryption at rest (envelope encryption) verified; no plaintext
      recording/transcript on disk.
- [ ] File permissions `0600`/`0700`, service-account owned; verified.
- [ ] Append-only audit log with chained hashes implemented; audited event
      set covers §8.
- [ ] Call-control gates §10 enforced in `gatewayd`; automatic dialing off
      until policy tests pass.
- [ ] Provider gates §10 enforced; provider allowlist + jurisdiction
      routing + audited.
- [ ] Consent + jurisdiction policy configurable; recording off by default.
- [ ] Retention, access, export, playback, deletion all audited; retention
      sweeper + hash tombstones implemented.
- [ ] Phone numbers minimized (hashed+truncated default); full numbers only
      under consent+retention.
- [ ] Crash/partial-recording semantics §13 verified: single idempotent
      teardown; partial artifacts sealed or destroyed, never left plaintext.
- [ ] USB-loss / process-death / reboot recovery tested.
- [ ] Supply chain: reproducible build, artifact SHA-256 recorded and
      verified at install and enrollment; no unverified binaries shipped.
- [ ] Each changed privileged artifact has tests, lint, manifest/allowlist
      audit, exact hashes, explicit approval, reboot verification, and
      rollback instructions.
- [ ] No privileged APK/Magisk artifact installed without its own hash
      review.
- [ ] No real destination dialed without the consent/policy gate.
- [ ] SELinux not weakened; PermissionController not modified; no global
      audio properties applied.

---

**Out of scope of this document:** implementation code, Git changes, device
changes. This is a controls and threat-model specification only.
