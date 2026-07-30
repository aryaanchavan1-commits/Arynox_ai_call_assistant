## Summary

Describe the bounded change and why it is needed.

## Verification

- [ ] `./verify.sh` passed, or exact failures are documented below.
- [ ] `git diff --check` passed.
- [ ] New behavior has focused tests.
- [ ] Generated artifacts, credentials, recordings and local evidence are not committed.

## Android/device changes

- [ ] Not applicable, or the exact device/ROM/kernel/root tuple is documented.
- [ ] Unknown devices still fail closed.
- [ ] Mixer/audio changes include setup, cleanup, process-death and rollback behavior.
- [ ] No global SELinux weakening, cache clearing or unrelated privilege grants.
- [ ] Physical PASS and NOT RUN gates are reported separately.

## Security and privacy

- [ ] No phone numbers, SIM identifiers, ADB keys, controller credentials, provider keys, PCM/audio, or unredacted logs cross MCP/renderer boundaries.
- [ ] User-controlled input is bounded and validated.
- [ ] Secrets remain daemon-owned and write-only where applicable.

## Release/operations

- [ ] Install, upgrade, uninstall and rollback impact is documented.
- [ ] Package/version/SBOM changes are synchronized where applicable.
- [ ] No unsupported production or device-support claim was added.

## Exact test output or blockers

<!-- Paste bounded, redacted evidence. Never convert NOT RUN into PASS. -->
