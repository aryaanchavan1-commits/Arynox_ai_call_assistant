# AgentCall 0.2.4

AgentCall 0.2.4 is the final hardware-qualified release for the current
Xiaomi POCO M2 Pro reference platform. It ships matched Android, Magisk,
Windows, and Debian artifacts from the same source revision.

## Highlights

- Professional AgentCall branding, launcher icons, Android home-screen icon,
  responsive desktop layouts, and in-app GitHub project links.
- Authenticated USB phone connection with synchronized contacts, call history,
  saved-contact caller identity, and finalized recordings.
- Incoming and outgoing cellular calls from AgentCall Desktop, including PC
  microphone/speaker mode and an AI receptionist for Hermes or OpenClaw.
- Low-latency OpenAI/ElevenLabs speech operation, local Supertonic support,
  prepared greetings, conversational context, interruption handling, natural
  call closing, and a five-minute agent-call safety limit.
- In-app recording playback and Save As on Windows, Linux, and Android.
- Verified, retryable recording copy back to the connected phone.
- Linux recording export now uses digest-verified service-owned artifacts
  without exposing the private recording store.
- Complete README, installation, architecture, security, contribution, and
  hardware-qualification documentation.

## Downloads

- `AgentCall-2.8.53-331.apk` - Android default-dialer application.
- `AgentCall-privileged-2.8.53-331-magisk.zip` - matched AgentCall privileged
  Magisk module.
- `agentcall-desktop-0.2.4-x64-setup.exe` - Windows x86-64 installer.
- `agentcall-desktop-0.2.4-amd64.deb` - Ubuntu/Debian x86-64 package.
- `SHA256SUMS` - SHA-256 checksums for the four installable artifacts.
- `ARTIFACT-STATUS.txt` and `ANDROID-ROLLBACK-MANIFEST.txt` - Android build,
  pairing, and rollback evidence.

Install the APK and the exactly matched Magisk module together. Follow the
[installation guide](../INSTALL.md) for the required reboot, default-dialer
selection, USB pairing, provider setup, and Hermes/OpenClaw MCP configuration.

## Qualification

The canonical verification gate passed Android unit tests and lint, 440 Linux
gateway/MCP tests, 435 Windows gateway/MCP tests with five platform-specific
skips, 108 desktop tests on both hosts, package-contract checks, SBOM and
release-evidence checks, and matched Android/Magisk validation.

The final packages were also exercised on Ubuntu and a physical POCO M2 Pro:
the phone authenticated, contacts and call history synchronized, OpenAI STT
and ElevenLabs TTS passed a live round trip, recordings played/exported and
copied back to Android, and real incoming/outgoing agent calls completed.

## Signing and hardware scope

This is a hardware-qualified release, not an app-store/notary-signed
distribution. The APK uses the qualification signing identity; the Windows
installer is not Authenticode signed; the Debian package is not published
through a signed package repository. Privileged telephony audio is qualified
only for the documented POCO M2 Pro tuple. Read the full
[release status](../RELEASE_STATUS.md) before installing the Magisk module.
