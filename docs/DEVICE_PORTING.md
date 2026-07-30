# Porting AgentCall to another Android device

This guide describes how to add a phone without weakening the fail-closed production boundary. A matching model name is not proof that cellular RX/TX audio works.

## Support levels

Use exactly one level when documenting a device/firmware tuple:

1. **Unknown** — generic Android APIs only; no device-specific mixer writes.
2. **Recognized** — `DeviceSelector` identifies the device using public `Build.*` fields, with JVM tests.
3. **Diagnostic-only** — read-only capability and mixer evidence is available; injection is not enabled.
4. **RX-qualified** — cellular downlink capture passed objective fixture and intelligibility checks.
5. **Full-duplex qualified** — independent RX and TX passed objective PCM metrics, remote intelligibility, cleanup, and repeated-call checks.
6. **Release-supported** — the exact device + ROM/build fingerprint + kernel + root method passed the complete release matrix, including reconnect, interruption, process death, latency, repeated calls, and soak.

Support applies to an exact tuple, not every phone with the same marketing name or SoC.

## Existing extension points

- `app/src/main/java/com/callagent/gateway/DeviceSelector.kt` contains pure Android-free identity matching.
- `app/src/main/java/com/callagent/gateway/DeviceProfile.kt` contains device audio capabilities, calibration, setup, and restore behavior.
- `app/src/test/java/com/callagent/gateway/DeviceSelectorTest.kt` demonstrates selector precedence and fail-closed tests.
- `docs/release/` contains qualification evidence formats and acceptance gates.
- `protocol/g2-v1.properties` is the shared Android/Linux wire contract and is not device-specific.

Keep generic USB, Telecom, recording, and protocol code independent of a particular phone. A port should normally add a selector entry, profile factory, focused tests, and evidence—not fork the gateway protocol.

## Port workflow

### 1. Record a redacted identity tuple

Record these public device facts:

- manufacturer and model;
- `Build.HARDWARE`, `Build.BOARD`, `Build.DEVICE`;
- Android/API version;
- exact build fingerprint (keep it in private deployment config if it contains organization-specific data);
- kernel version, ROM name/version, root method/version, and SELinux state;
- audio SoC/codec and available ALSA cards.

Do not publish serial numbers, IMEI/MEID, subscriber identifiers, phone numbers, ADB keys, or recordings.

### 2. Add recognition before mixer behavior

Add a new `ProfileId` and a narrow selector rule. Device-specific rules must precede generic Qualcomm/Exynos fallbacks. Use board/device identifiers rather than a broad hardware match. Add positive, variant, precedence, and unrelated-device tests.

Recognition must initially select a diagnostic-only profile with:

- empty setup/restore/in-call mixer commands;
- no unverified HAL parameter;
- `injectionVerified = false`;
- `mixerWritesAllowed = false`;
- read-only diagnostics only.

### 3. Collect read-only evidence

Inventory `/proc/asound/cards`, relevant audio policy files, and named mixer controls without changing values. Redact the output. Never cargo-cult numeric control IDs or commands from another model; names, enums, routing, and restore values vary by codec, kernel, and ROM.

Do not redistribute proprietary vendor XML, firmware, kernel modules, or binaries unless their license explicitly permits it. Document commands and minimal redacted observations instead.

### 4. Qualify RX and TX separately

Use deterministic fixture audio and measure each direction independently:

- 16 kHz mono PCM16LE, 640-byte/20 ms frames;
- frame counts, gaps, loss, clipping, RMS/peak, and latency;
- remote caller intelligibility for TX;
- local captured intelligibility for RX;
- silence/noise behavior and absence of unintended speaker/microphone leakage.

A successful Telecom call or selector match is not audio qualification.

### 5. Introduce mixer writes only after evidence

Every write must have:

- exact device/firmware scope;
- named controls where possible;
- pre-change value capture or a proven deterministic restore value;
- cleanup on hangup, USB loss, process death, and failed setup;
- bounded timeout and failure handling;
- tests proving unrelated devices cannot select the profile.

Never enable a write merely because it worked on another phone sharing the SoC.

### 6. Run lifecycle and release gates

At minimum test:

- outgoing and incoming calls;
- answer, reject, hangup, and DTMF;
- repeated calls without reboot;
- USB disconnect/reconnect;
- Android app and Linux daemon process death;
- interrupted setup and teardown;
- recorder/provider failure;
- bounded queue pressure and latency;
- sustained full-duplex soak;
- post-call mixer/audio restoration;
- Linux-authoritative recording and verified Android-copy behavior.

Run `./verify.sh` before submitting. Physical device tests are separate and must be reported with exact counts/durations. Never convert `NOT RUN` into `PASS`.

## Device evidence document

Add `docs/devices/<codename>.md` containing:

- exact support tuple and current support level;
- contributor and test date;
- safe identity facts;
- RX/TX method and objective metrics;
- lifecycle/soak results;
- known limitations and rollback steps;
- explicit `NOT RUN` gates.

The POCO M2 Pro (`gram`/`atoll`) is the current primary qualification target and reference port. Its implementation remains preserved while additional profiles are added through the same extension points.
