# Contributing to Arynox

Thank you for helping make USB-only cellular agent gateways work on more Android devices.

## License and contribution terms

Arynox is licensed under the [GNU Affero General Public License v3.0 only](LICENSE). By submitting a pull request or other contribution for inclusion, you agree that it is provided under `AGPL-3.0-only`. Do not submit code, firmware, recordings, mixer tables, or vendor files that you do not have permission to share.

No separate contributor license agreement is currently required. Keep authorship in Git history; do not add personal copyright headers to every source file.

## Safety boundaries

Contributions must preserve these invariants:

- USB/ADB-forwarded loopback is the only phone transport. Do not add SIP, RTP, STUN, Asterisk, Wi-Fi, LAN, or wildcard listeners.
- `gatewayd` is the sole ADB owner.
- Unknown devices remain fail-closed and must not receive unverified mixer writes.
- Android never decides to auto-dial or auto-answer on its own. Agent actions must pass the authenticated desktop gateway, recording health, local policy, and explicit operator configuration.
- MCP carries bounded semantic text only—never PCM, raw payloads, secrets, or full phone numbers.
- Linux recordings are authoritative. Android copies are independently deletable convenience copies.
- Never include real phone numbers, caller names, credentials, ADB keys, private recordings, logcat dumps with PII, or proprietary firmware blobs in issues or pull requests.

## Development workflow

1. Fork the repository and create a focused branch.
2. Read `README.md`, `docs/DEVICE_PORTING.md`, and the relevant design/security documents.
3. Add a failing test before changing protocol, policy, lifecycle, or device-selection behavior.
4. Keep changes scoped. Separate generic runtime changes from device-profile evidence.
5. Run `./verify.sh` from the repository root.
6. State exactly what was tested and what was not. Hardware behavior that was not physically measured must be labeled `NOT RUN` or `UNVERIFIED`.

For UI changes, include redacted before-and-after captures for the affected
desktop and Android surfaces. Use mock names and numbers or remove them
entirely. Verify keyboard navigation, scrolling at the minimum supported
window size, Android dark and light themes, and that every visible control
performs its advertised action.

## Pull-request checklist

- [ ] No secrets, PII, recordings, proprietary firmware, or vendor binaries are included.
- [ ] New behavior has focused tests and `./verify.sh` passes.
- [ ] Protocol changes update the shared Kotlin/JavaScript vectors.
- [ ] Device changes include selector tests and default to read-only diagnostics.
- [ ] Mixer writes include an exact restore path and interruption/process-death analysis.
- [ ] Device, ROM/build fingerprint, Android version, root method, kernel, SELinux state, and test evidence are documented.
- [ ] Claims use the support levels in `docs/DEVICE_PORTING.md`.

## Reporting security issues

Do not open a public issue containing an exploitable vulnerability, credential, private phone number, or recording. Contact the maintainers privately at `maintainers@sidx.dev` with a minimal reproduction and redacted evidence.
