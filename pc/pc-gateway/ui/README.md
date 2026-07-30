# AgentCall Desktop

Secure Electron operations client for the USB-only cellular-agent gateway.

## Current truth

The production renderer is backed by a local-only `gatewayd` RPC boundary. It shows authenticated USB phone state, finalized call recordings, live call controls, daemon-owned STT/TTS configuration, and actionable Hermes/OpenClaw MCP setup. When `gatewayd` is unavailable, the interface reports an unavailable state rather than presenting fixtures as live data.

On Linux, those responsibilities remain inside the separately supervised `agentcall-gatewayd` service included by the all-in-one Debian installer. On Windows, the packaged desktop app supervises a bundled gateway daemon and bundled ADB/FFmpeg tools, while all credentials and recordings stay in the current user's application-data directory. Installing the desktop app never installs an APK, changes the Android dialer role, or mutates a phone.

## Security boundary

- packaged local files only; no production HTTP dashboard;
- local Unix socket or Windows named-pipe RPC to `gatewayd`; no renderer network access;
- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`;
- strict CSP with `connect-src 'none'`;
- denied navigation, popups, permissions, and downloads;
- typed allowlisted preload IPC;
- provider secrets are write-only and never returned to the renderer;
- renderer has no Node, shell, filesystem, ADB, or general clipboard access.

## Design

The interface uses the shared AgentCall communications design system: a calm teal identity and responsive three-pane operations layout. Compact widths collapse call history before primary controls and stack setup/configuration cards.

## Development

```bash
npm ci
npm test
npm run check
npm start
```

## Packaging

`npm run dist` builds the unprivileged Electron Debian base. From the repository root, `packaging/linux/build-unified-desktop-deb.sh --output release/desktop` composes the final all-in-one Debian with the verified gatewayd/MCP/systemd payload. Privileged installation, service activation, APK installation, Android role changes, release signing, SBOM/scanning, and physical-device qualification remain separate release gates.

`npm run dist:windows` stages the locally installed Android SDK platform tools and FFmpeg, then produces an NSIS installer with the Windows gateway daemon included. Set `ANDROID_SDK_ROOT` or `ANDROID_HOME` when the SDK is outside its standard location, and set `AGENTCALL_FFMPEG_PATH` when FFmpeg is outside `C:\\ffmpeg\\bin`.
