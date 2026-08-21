# Xiaomi POCO M2 Pro (`gram` / Qualcomm `atoll`)

## Current status

**Support level: Full-duplex qualified for one bounded call on the exact tuple below. Not yet release-supported.**

This is Arynox's reference device port. New profiles must not regress its selector precedence, USB/G2 behavior, cleanup, or measured full-duplex path.

## Qualified tuple

- Device: Xiaomi POCO M2 Pro
- Device codename: `gram`
- Board/platform: Qualcomm `atoll`
- Android: API 35 / Android 15 custom Lineage userdebug system
- Retained vendor fingerprint pin: `POCO/gram_in/gram:12/RKQ1.211019.001/V14.0.5.0.SJPINXM:user/release-keys`
- Magisk: 30.7
- SELinux: Enforcing after the qualification call
- Android package: `com.callagent.gateway`, selected as default dialer

Support does not automatically extend to another ROM, kernel, firmware, root method, or phone that merely shares `atoll`.

## Objective qualification result

On 2026-07-20, a consented 10-second simultaneous cellular call used the production USB-only path:

`cellular → Android Telecom/default dialer → Telephony RX/TX → loopback G2 → adb forward → gatewayd recorder`

Measured result:

- TX: 500/500 frames over 10.00 seconds;
- remote party confirmed the injected tone was clearly audible while speaking;
- RX: 496 frames / 158,720 samples over 9.92 seconds;
- RX aggregate RMS: 679.34; peak: 9,132; 6,477 unique sample values;
- remote speech was intelligible in the authoritative Linux recording;
- mandatory dual-track manifest was complete with outcome `ended`;
- Android returned to `MODE_NORMAL`;
- Android remained default dialer;
- SELinux remained Enforcing;
- Android endpoint remained loopback-only on port 27183.

The authoritative detailed report, artifact hashes, protocol, and failed-run disclosures are in [the full-duplex qualification report](../release/poco-m2-pro-full-duplex-qualification-2026-07-20.md).

## Implementation seams

- Identity selection: `DeviceSelector.ProfileId.ATOLL_GRAM`
- Profile factory: `DeviceProfile.atollGram()`
- Selector and fail-closed tests: `DeviceSelectorTest`
- Shared transport: `protocol/g2-v1.properties`

The profile's comments/capability metadata may still contain older phase labels. The dated qualification report is authoritative for measured results; metadata should only be promoted after its lifecycle semantics and tests are reviewed together.

## Known limitations / NOT RUN

The exact tuple is **not release-supported** until all of these pass:

- repeated real calls without reboot;
- one-hour physical full-duplex call/soak;
- USB interruption and reconnect during call;
- Android app and Linux daemon process death;
- screen-off/Doze behavior;
- bounded latency, jitter, frame-loss, thermal, memory, descriptor, and queue measurements;
- production signing and privilege audit;
- clean install, upgrade, uninstall, and rollback qualification.

Simulator results and successful package/MCP tests do not satisfy these physical-device gates.

## Port maintenance rule

Changes to generic Qualcomm selection, audio setup/restore, G2 framing, connection teardown, mandatory recording, or Android role/Telecom behavior must run the complete automated verifier and preserve this exact profile's focused tests. Any new physical support claim needs a separate dated evidence report for its exact device/firmware tuple.
