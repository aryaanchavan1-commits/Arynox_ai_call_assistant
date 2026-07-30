# AgentCall 1.0.0

AgentCall 1.0.0 is the first unified release of the hardware-qualified
AgentCall stack. It ships matched Android, Magisk, Windows, and Debian
artifacts from one source revision.

## Highlights

- Canonical project ownership and in-app links now use
  `sidinsearch/AgentCall`.
- The GitHub README now includes a complete Full HD desktop gallery and native
  1080 × 2400 Android captures.
- Calls, contacts, and recent-call screenshots use fictional identities and
  reserved `202-555-01xx` example numbers.
- Hermes and OpenClaw are described consistently as local reasoning and call
  control integrations.
- Original Hermes, OpenClaw, OpenAI, ElevenLabs, and Supertonic artwork is used
  in the integration gallery.
- Automated dependency-update branches are disabled so the repository retains
  its deliberate single-branch workflow.

## Downloads

- `AgentCall-1.0.0-332.apk` - Android default-dialer application.
- `AgentCall-privileged-1.0.0-332-magisk.zip` - matched AgentCall privileged
  Magisk module.
- `agentcall-desktop-1.0.0-x64-setup.exe` - Windows x86-64 installer.
- `agentcall-desktop-1.0.0-amd64.deb` - Ubuntu/Debian x86-64 package.

Install the APK and the exactly matched Magisk module together. Follow the
[installation guide](../INSTALL.md) for the required reboot, default-dialer
selection, USB pairing, provider setup, and Hermes/OpenClaw MCP configuration.

## Qualification and signing

The functional runtime retains the physically qualified cellular media
architecture. AgentCall 1.0.0 updates project identity, packaging metadata, and
documentation without changing that call path.

The distributed Android APK uses the qualification signing identity. The
Windows installer is not Authenticode signed, and the Debian package is not
published through a signed package repository. Privileged telephony audio
remains qualified only for the documented POCO M2 Pro tuple. Read the full
[release status](../RELEASE_STATUS.md) before installing the Magisk module.
