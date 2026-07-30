# POCO M2 Pro simultaneous full-duplex qualification — 2026-07-20

## Scope

Consented incoming cellular call through the production USB-only path:

`cellular call → Android Telecom/default dialer → privileged Telephony RX/TX bridge → loopback G2 → adb forward → gatewayd mandatory dual-track recorder`

No raw caller number, SIM/carrier/cell identifier, contact, or call-log data is retained in this evidence.

## Qualified device/build

- Device: POCO M2 Pro (`gram`, Qualcomm `atoll`)
- Android: API 35 / Android 15 custom Lineage userdebug system
- Retained vendor fingerprint pin: `POCO/gram_in/gram:12/RKQ1.211019.001/V14.0.5.0.SJPINXM:user/release-keys`
- Magisk: 30.7
- SELinux after test: Enforcing
- agentcall package: `com.callagent.gateway`, default dialer
- Mounted qualification APK SHA-256: `0ddd6d9f9cedfc235de81b5adc941677c7e4f903a96b84b1204be0dd36fdb934`
- Qualification Magisk ZIP SHA-256: `8d734b50df8eae642f4f86351fe31d02e4cb1eb593dcea143b0ab2fb2f2b38ca`

These are debug-signed qualification artifacts, not production-release artifacts.

## Test protocol

Both parties explicitly consented to a recorded 10-second simultaneous test. The remote party spoke continuously while gatewayd injected a low-amplitude 440 Hz tone through Telephony TX. The controller owned gatewayd/ADB, started mandatory recording before answering, paced 20 ms frames, hung up, finalized, and stopped in a bounded cleanup path.

## Result — PASS

- Incoming event correlated and answered by agentcall: PASS
- Uplink tone frames: 500/500 (10.00 s): PASS
- Remote human confirmation that tone was clearly audible while speaking: PASS
- Downlink frames: 496 (9.92 s): PASS
- Downlink samples: 158,720 at 16 kHz mono PCM16: PASS
- Downlink aggregate RMS: 679.34; peak: 9,132
- Downlink waveform: 6,477 unique values; materially varying/intelligible speech after route settling
- Operator review: remote speech was intelligible in `remote.wav` and combined recording: PASS
- Mandatory recording manifest: complete, outcome `ended`, no failure reasons: PASS
- Agent track: 500 frames; remote track: 496 frames
- Android post-call audio mode: `MODE_NORMAL`: PASS
- agentcall remained RoleManager/Telecom default dialer: PASS
- SELinux remained Enforcing: PASS
- Android endpoint remained loopback-only on port 27183: PASS

## Recording integrity

Recordings remain in an owner-only (`0700`) temporary qualification directory pending explicit retention/deletion direction.

- `remote.wav`: `88e53da8259efd757dd3ad7349ad568025ba6ab4ccdf66bfd5cd4403f646d835`
- `agent.wav`: `8d561e3764f1d218834f81c37031bbe6694118fcee064740ffb20596361d071c`
- `conversation.mkv`: `e2b1559e8f58b22b51e06c55ba7c9251d08e1b55258924c9b9f38d99102f26ec`
- `manifest.json`: `3dcd367a214728eeca4fd3afcf780b175120d6035c9855e73ac43972a030a273`

The call-local `checksums.sha256` verified every finalized artifact.

## Failed runs and regression

Earlier runs exposed two real defects rather than being relabeled as successes:

1. Telecom callback attempted socket I/O on Android's main thread and crashed with `NetworkOnMainThreadException`. Fixed with one bounded connection-owned writer; sequence numbers are assigned at dequeue and overflow fails closed.
2. Some runs returned a routed but invalid DC-like downlink stream (nearly every sample was value `8`). Those runs failed the signal gate and are not qualification evidence. The controller now gates on centered/AC RMS, with tests proving high constant DC cannot pass.

## Remaining gates

This pass proves one bounded simultaneous call on the exact device/build. Production support still requires repeated calls, one-hour soak, transport/process-death recovery, screen-off/Doze, latency/loss/thermal measurements, production signing, and release/rollback qualification.
