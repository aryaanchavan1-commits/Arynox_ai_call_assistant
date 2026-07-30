# Desktop completion status — 2026-07-23

> **Later same-day qualification:** The Windows package was rebuilt after live-call
> fixes and completed two real outgoing cellular calls with saved-contact presentation,
> PC microphone/speakers, OpenAI STT, ElevenLabs TTS, packaged MCP agent speech,
> complete dual-track recordings, and decoded playback. The current detailed evidence
> is in
> [`windows-real-call-qualification-2026-07-23.md`](windows-real-call-qualification-2026-07-23.md).
> Statements below that say no real call was placed describe the earlier integration
> checkpoint and are superseded by that report.

This is the evidence-backed handoff for the `wt/desktop-complete-v1` integration branch. It records what is implemented, what was actually executed, what works on the installed host and phone, what remains blocked, and what must happen before a release can be called complete.

## Live Windows completion update

The earlier USB pairing blocker documented below is resolved in the current source and live Windows qualification state. The phone had retained a stale paired-desktop authority while the active desktop state was absent. Revoking that stale enrollment once and using **Connect desktop** completed the authenticated bootstrap; subsequent app and desktop restarts reconnect with the preserved matched enrollment.

Executed current evidence:

- POCO M2 Pro `c27d0cd8` is connected, matched, authenticated, and reported ready through the private USB bridge.
- Android Gateway reports **Desktop connected**, qualified POCO M2 Pro, healthy Telecom, and healthy desktop recording.
- 500 contacts and 58 call-log rows synchronized to the desktop mirror; each collection reports progress independently.
- Desktop Calls, Contacts, Live Call, Recordings, Speech, MCP, Android, and Policy surfaces were visually exercised against the live daemon.
- OpenAI realtime STT and ElevenLabs TTS passed the built-in end-to-end speech test; Supertonic 3 passed health and synthesis through its official loopback server.
- The portable gateway check returns `check-ok` with 360/360 tests; the Electron suite passes 104/104; Android unit tests, lint, debug/release compilation, and release APK assembly completed successfully.
- A fresh Android qualification APK and Magisk module were built, and the module's embedded APK is byte-identical to the standalone APK.
- The current Android debug APK was installed in place and pairing/data state survived the upgrade.

The source is now a Windows/Android release candidate, not a production-signed public release. Still required for stable publication: production Android signing, an external incoming caller for real answer/microphone/speaker/STT/TTS acceptance, interruption and soak testing, and the final Linux package lifecycle on a Linux host. No real cellular call was placed automatically during this work.

## Source and publication state

- Repository: [`sidinsearch/AgentCall`](https://github.com/sidinsearch/AgentCall)
- Branch: `wt/desktop-complete-v1`
- Integrated code commit: `5383308` (`feat: complete zero-touch desktop gateway integration`)
- Pull request: not created
- Tag/release: not created
- Installable assets: built locally for qualification, not published by this branch push

The branch push contains source, tests, packaging, and documentation only. It does not contain ADB private keys, controller credentials, provider keys, phone identifiers, contacts, call-log rows, recordings, lifecycle backups, rollback archives, or generated release artifacts.

## Implemented behavior

### Linux gateway and lifecycle

- `gatewayd` starts and remains available without a phone.
- A five-second reconnect loop discovers an eligible ADB-authorized phone without terminating local RPC.
- A daemon-private ADB server uses `127.0.0.1:15037` and a service-owned key home under `/var/lib/agentcall/adb`.
- Missing private ADB/controller directories are declared through tmpfiles with owner-only `0700` modes.
- The Unix RPC socket is `/run/agentcall/gatewayd.sock`, owned by `agentcall:agentcall`, mode `0660`.
- The systemd unit remains hardened while explicitly allowing the USB character-device class required by ADB. Per-device access is still restricted by udev/DAC; it is not granted with `MODE="0666"` or broad `plugdev` membership.
- Package-owned matched-artifact identity is loaded after preserved administrator configuration.
- Retired manual serial/fingerprint/ADB-key selectors are removed only from the daemon process environment. `/etc/agentcall/gateway.env` is not rewritten on upgrade.
- Package installation creates safe defaults only when absent, enrolls at most one validated interactive operator, enables the service, and makes service-start failure visible.
- Package installation does not generate controller credentials or ADB keys, mutate a phone, place a call, or contact a provider.

### Zero-touch Android pairing

- The Android UI exposes **Connect desktop**, **Disconnect desktop**, and **Forget paired desktop** actions.
- No agentcall controller secret is shown, copied, or typed.
- Bootstrap uses the ADB-forwarded, loopback-only authenticated protocol and matched APK identity.
- Authentication remains fail-closed; normal connection failure does not silently rotate authority.
- The active production bootstrap identity is binary protocol v1. The separately tested v2 codec remains foundation code and is not advertised as the active artifact identity.

### Contacts and call-log synchronization

- Android provides repository-backed contacts and call-log snapshots.
- Pages are limited to 10 rows and less than 4 KiB UTF-8.
- Snapshot delivery is correlated, sequential, and bound to the authenticated connection generation.
- Linux mirrors update atomically and retain the last known-good snapshot on incomplete, replayed, stale, malformed, or interrupted synchronization.
- Desktop mirrors are capped at 500 contacts and 200 call-log rows.
- Raw names and numbers remain confined to the local Unix RPC and Electron UI.
- MCP exposes only metadata through `agentcall://phone-data/status`; hostile-input tests check that raw rows, paths, secrets, and phone numbers do not escape.

### Desktop UI and dialing

- Electron includes Contacts, synchronized Calls, safe New Call routing, recordings, speech/provider setup, and truthful cached/offline/unsupported states.
- The preload surface is frozen and bounded; renderer Node globals remain disabled.
- Dialing requires explicit confirmation, strict E.164 validation, authenticated USB state, policy approval, emergency blocking, consent, recording health, cooldown, and rate limits.
- The UI does not fall back to fixture calls or claim device actions when the daemon is unavailable.

### Android artifacts

- Android package identity: `com.callagent.gateway`, version `2.8.52 (330)`.
- The standalone APK and Magisk ZIP are matched; the ZIP embeds byte-identical APK bytes.
- The module is package-scoped and contains no global SELinux weakening, PermissionController suppression, mixer hacks, broad app-ops, or unrelated-package mutation.
- The phone was migrated to one privileged `/system/priv-app` path with SELinux Enforcing.
- agentcall was restored as both RoleManager and Telecom default dialer after migration.
- No cellular call or audio recording was performed during package migration.

## Executed verification

The following are real command results from this integration work, not planned checks:

| Area | Result |
|---|---|
| Gateway complete Node suite after the private-ADB regression | `311/311` passed; `npm run check` returned `check-ok` |
| Focused ADB manager suite | `20/20` passed |
| Electron suite | `89/89` passed; JavaScript syntax checks passed |
| Android Gradle | `:app:testDebugUnitTest :app:assembleDebug` successful |
| Android artifact boundary | `android-artifacts-ok` |
| Android controller-auth boundary | `android-controller-auth-boundary-ok` |
| Android permission boundary | `android-permission-boundary-ok` |
| Android legacy boundary | `android-legacy-boundary-ok` |
| Unified desktop package contract | `unified-desktop-package-ok` |
| Packaged MCP source syntax | passed |
| Git whitespace/error scan | `git diff --check` passed before the integrated commit |
| Independent read-only security scan | no high- or medium-severity finding survived its confidence threshold |

The independent scan returned only a terse security summary rather than the requested full release-verdict format. It is useful corroboration, but it is **not** counted as complete independent release approval.

## Privileged lifecycle evidence already obtained

- An older installed `agentcall-desktop 0.2.3` package was backed up and removed.
- Normal removal preserved `/etc/agentcall` and `/var/lib/agentcall`.
- The qualification package installed successfully.
- Administrator configuration and redaction-salt hashes remained unchanged across removal and installation.
- The original package startup failure was reproduced and traced to preserved manual-era configuration selecting a fatal legacy path.
- The upgraded runtime compatibility fix was added without rewriting administrator configuration.
- A second live failure was traced with `strace` to systemd's BPF device cgroup denying `/dev/bus/usb/...` with `EPERM`; `DeviceAllow=char-usb_device rw` fixes that layer while udev/DAC remains the exact-device boundary.
- The installed service is currently active with zero automatic restarts, and its local Unix socket is present at mode `0660`.

Private backups and rollback artifacts remain local and are intentionally not committed or uploaded.

## Local qualification artifacts

The `v0.2.3-qualification.2` set contains four installable files:

1. `agentcall-desktop-0.2.3-amd64.deb`
2. `agentcall-desktop-0.2.3-x64-setup.exe`
3. `AgentCall-2.8.52-330.apk`
4. `AgentCall-privileged-2.8.52-330-magisk.zip`

Recorded SHA-256 values from the exact completed artifact builds:

- Linux desktop: `85ae97914ab4518810c70d7b139a861b0e7b3806bfcb7e1b7d773ccf61308d3c`
- Windows desktop: `9d2099eb91e8f3068c1658b680fc66a1df360fcef82a1f05702a044cc62cadf5`
- Android APK: `2d9e3cd5c6b68758a8fc29eb7a9be956dc02b6ff518753d4f8d45a107d97f1de`
- Magisk ZIP: `7a0ab6735b28d1a75cd46c10eb5ddd26e7abdda21bf3b294cdd5625cab2ed981`

The exact final Debian file passed extracted payload, line-ending, launcher,
systemd/helper, and packaged MCP smoke inspection. Physical Linux-host
install/upgrade/rollback acceptance remains open. All four files remain
unsigned or debug-signed qualification artifacts and are not a stable release.

## Resolved historical blocker

An earlier run found the daemon-private ADB server listing no phone when the handset enumerated as USB product `18d1:4ee2`. The exact-device allowlist now covers the verified POCO mode, and the current Windows qualification uses the bundled platform tools with the same narrow, serial-scoped forwarding model.

Observed live USB state:

```text
POCO M2 Pro USB identity: 18d1:4ee2
interfaces: ff:ff:00 and ff:42:01
private ADB devices: none
```

The committed udev rule admits both verified exact identities:

```text
18d1:4ee2 → group agentcall, mode 0660
18d1:4ee7 → group agentcall, mode 0660
```

The phone re-enumerated as `18d1:4ee2`; this mode was verified and added to the exact allowlist. The later connection failure was a stale Android enrollment, not an ADB transport failure: normal ADB commands and the loopback listener were already working. After the explicit one-time **Forget paired desktop** action and a new **Connect desktop** bootstrap, authenticated reconnect, UI agreement, contacts, and call-log synchronization all passed.

Do **not** work around this by:

- adding the service to broad `plugdev` access;
- using `MODE="0666"`;
- copying the user's global ADB private key;
- weakening the systemd device policy;
- disabling SELinux or PermissionController.

The implemented fix retains exact-device access and never broadens permissions to unrelated USB devices.

## Acceptance still open

The following must remain marked incomplete:

1. **Production Android and release signing.** Current Android artifacts are debug-signed qualification artifacts.
2. **Real incoming-call acceptance:** use an external caller to verify desktop ringing, answer/reject, PC microphone/speaker, recording playback, transcription, agent response, and returning-caller context together.
3. **Final Linux package lifecycle:** rebuild and install the exact final `.deb` on Linux, verify preserved configuration/salt, service/RPC permissions, Electron acceptance, and rollback.
4. **Long-duration hardware qualification:** repeated calls, interruption/process-death recovery, screen-off/Doze, latency/thermal/resource measurements, and a one-hour soak.
5. **Complete independent release review** with a structured verdict and inspected command evidence.
6. **Optional external scanners** (`lintian`, `syft`, `trivy`, `grype`) where available.

No real cellular call, answering, DTMF, provider spend, or audio recording should be used merely to prove USB pairing. Complete the no-call connection and synchronization gates first.

## Recommended next work, in order

1. Use an external caller to execute incoming answer/reject, PC microphone/speaker, recording playback, transcript, agent response, and returning-caller-context acceptance.
2. Repeat interruption, reconnect, screen-off/Doze, and long-duration hardware tests.
3. Build and reinstall one uncontended final Linux `.deb`; verify immutable payloads, configuration/salt preservation, service/RPC state, and rollback.
4. Replace qualification Android signing with protected production signing and regenerate the matched manifest and artifacts.
5. Obtain a structured independent review and optional scanner evidence.
6. Publish only the exact verified desktop, APK, and matched Magisk artifacts with checksums.

## Security and product invariants

These remain non-negotiable:

- USB-only phone transport; no SIP, RTP, STUN, Asterisk, LAN, Wi-Fi, or wildcard phone listener.
- Android listeners bind loopback only and are reached through serial-scoped ADB forwarding.
- One supervised Linux daemon owns ADB and operational forwards.
- SELinux remains Enforcing.
- No global PermissionController suppression, package-cache clearing, mixer hacks, or unrelated-package mutation.
- Raw contacts, call rows, numbers, audio, transcripts, filesystem paths, and secrets never enter MCP/status/public logs.
- Linux recording remains authoritative and mandatory for call actions.
- Dialing remains confirmation- and policy-gated; emergency destinations remain blocked.
- Upgrades preserve administrator configuration and the redaction salt.
- Release output contains four installable assets: Windows desktop installer, unified Linux desktop `.deb`, APK, and matched APK-embedding Magisk ZIP.

## Bottom line

The automated source gates are green and the Windows desktop, authenticated POCO M2 Pro bridge, Android UI, phone-data synchronization, and speech-provider paths are working as a release candidate. Stable publication still requires production signing, a real external incoming-call acceptance run, and final Linux package/soak evidence.
