# AgentCall 1.0.1

AgentCall 1.0.1 is a hardware-qualified patch release for the matched Android,
Magisk, Windows, and Debian stack.

## What changed

- Restores automatic qualified-device evidence provisioning after a fresh or
  repaired USB pairing.
- Ensures a supported POCO M2 Pro selects the qualified Qualcomm atoll audio
  bridge instead of silently falling back to the generic profile.
- Preserves exact device and vendor fingerprint checks, authenticated pairing,
  and fail-closed handling for near-match or incomplete device identities.
- Keeps Hermes/OpenClaw MCP calling, realtime speech, recording, and Android
  recording synchronization on the verified call path.

## Downloads

- `AgentCall-1.0.1-333.apk` — Android default-dialer application.
- `AgentCall-privileged-1.0.1-333-magisk.zip` — matched AgentCall privileged
  Magisk module with the identical embedded APK.
- `agentcall-desktop-1.0.1-x64-setup.exe` — Windows x86-64 installer.
- `agentcall-desktop-1.0.1-amd64.deb` — Ubuntu/Debian x86-64 package.

Use either the standalone APK for UI/development validation or the matched
Magisk module for the qualified rooted-phone path. Follow the
[installation guide](../INSTALL.md) for reboot, default-dialer selection, USB
pairing, speech-provider setup, and Hermes/OpenClaw MCP configuration.

## Verification

- Gateway/MCP suite: 455 total, 450 passed on Windows with 5 expected
  platform-specific skips and no failures; all 455 pass on Linux.
- Desktop checks and dependency audit pass.
- Real Linux-to-POCO M2 Pro Hermes call completed with clear bidirectional
  audio, contextual replies, farewell, hang-up, recording, and phone sync.
- The standalone APK and Magisk-embedded APK are byte-identical.

The Android artifacts retain the established AgentCall signing identity. The
Windows installer is not Authenticode-signed, and the Debian package is not
published through a signed package repository. Privileged telephony audio is
qualified only for the documented POCO M2 Pro device/build tuple. See the
[release status](../RELEASE_STATUS.md) before installation.
