# Current Linux package evidence (development, not release-approved)

Date: 2026-07-20

## Proven

- USB-only Linux gateway source tests: 75/75 passing before package assembly.
- Node syntax/check gate passes.
- Exact configured ADB serial and build fingerprint are mandatory in runtime configuration.
- Loopback-only device client and canonical G2 framing are covered by tests.
- Package installation does not start/enable the service, generate ADB keys, install an APK, mutate a phone, place a call, create a recording, or contact a provider.
- Hardware preflight fails closed because mandatory recorder health is not implemented.
- Two builds with `SOURCE_DATE_EPOCH=1720000000` were byte-identical.
- Development package SHA-256: `9ed8c1310b2cd3f08845e0785bd6963e0c144f3ef79238e76be6bade7c3ff862`.
- Package payload ownership is root/root; executable modes are 0755 and immutable data/unit/docs modes are 0644.
- Static `systemd-analyze verify` passes for the agentcall unit after relocating executable paths; warnings observed were from unrelated host units.
- Legacy SIP/RTP/STUN/Asterisk files and imports are rejected from the staged Linux runtime.

## Not proven / release blockers

- The repository has no approved public license declaration.
- `lintian`, SBOM tooling, signing keys, and vulnerability scanners are unavailable in the current environment.
- No clean Debian/Ubuntu VM install/upgrade/uninstall/rollback run was performed.
- This host systemd version cannot run offline `systemd-analyze security` against an uninstalled unit; no security score is claimed.
- `gatewayd` and MCP still require a verified single-owner local IPC architecture; two independent Gateway instances must not compete for ADB/device ownership.
- Mandatory recorder implementation/health, artifacts, crash recovery, retention, deletion, and audit are absent.
- Simulator, full-duplex, reconnect/process-death, 100-call, and one-hour soak gates are absent.
- No APK was installed and no real cellular call/device qualification was run.
- No package was installed or published.

This artifact is development evidence only and must not be described as a release candidate.
