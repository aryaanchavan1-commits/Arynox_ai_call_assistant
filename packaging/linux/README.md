# agentcall Linux package harness

This directory packages only the USB-only Linux `pc-gateway` implementation supplied with `--gateway-source`. It must never package the legacy Android SIP/Asterisk repository root.

## Safety properties

- No APK install, phone mutation, ADB key creation, call, recording, or provider request occurs during build/install.
- Service runs as the unprivileged `agentcall` user.
- Hardware identity remains constrained to the supported device profile; an
  optional configured serial/fingerprint may narrow discovery further.
- Production hardware mode fails closed unless mandatory recorder storage and `ffmpeg` health are green.
- MCP uses stdio. No dashboard HTTP listener is installed.
- Udev rule is only an administrator template with exact IDs and mode `0660`; it is not enabled automatically.

## Build a disposable package

```bash
packaging/linux/build-deb.sh \
  --gateway-source /absolute/path/to/pc-gateway \
  --output /tmp/agentcall-deb
```

The script stages an immutable package tree, validates source tests, checks legacy transport strings in the packaged runtime, builds with `dpkg-deb`, and writes SHA-256 and payload manifests. This does not install the package.

## Generate release evidence without installing

```bash
packaging/linux/release-evidence.sh \
  --gateway-source /absolute/path/to/pc-gateway \
  --output /absolute/path/to/evidence
```

This builds the Debian package twice with normalized timestamps, requires byte-identical package and payload manifests, validates extracted executable paths and metadata, verifies the systemd unit in an isolated temporary unit root, scans the staged runtime for legacy transports, creates a deterministic CycloneDX 1.5 SBOM from the npm lockfile, and launches the extracted package through the real simulator → Gateway → Unix RPC → stdio MCP path. The retained MCP transcript verifies initialization, strict semantic tools/resources, visible simulator identity, and policy denial while rejecting full phone numbers and binary/secret-shaped fields. The package ships the canonical cross-platform G2 vectors at `/usr/share/agentcall/protocol/g2-v1.properties` and an explicitly labeled `agentcall-simulator-soak` command; source tests and Electron build output are excluded. Simulator results validate software integration only and never qualify physical hardware. `RELEASE-EVIDENCE.txt` distinguishes required `PASS` gates from optional tools that were `NOT_RUN`; it never treats an unavailable scanner, absent signing key, or uninstalled service as a pass.

The project is licensed under `AGPL-3.0-only`. Release evidence requires the root license, npm SPDX metadata, CycloneDX metadata, and Debian payload license/copyright files to agree; a missing or conflicting declaration fails the package contract.

## Configuration

The unified desktop package installs a matched `gateway.env.default` on first
install and preserves `/etc/agentcall/gateway.env` on upgrade. The service keeps
its private ADB home under `/var/lib/agentcall/adb`; authorize this host through
Android's ordinary USB-debugging prompt, then tap **Connect desktop** in the
agentcall Android Gateway screen. Pairing derives and stores the controller key
through the authenticated bootstrap protocol. Operators never copy an ADB key,
device identifier, fingerprint, or controller secret into configuration.

`gateway.env.example` is retained only as a source/standalone packaging
reference. Keep the recording root absolute, private to `agentcall`, and sized
above the configured free-space reserve.

### Explicit desktop operator enrollment

The desktop and MCP clients use `/run/agentcall/gatewayd.sock`, which remains group-restricted. The unified installer attempts to enroll only its verified invoking interactive user through the same helper. An administrator may explicitly enroll another trusted operator later:

```bash
sudo agentcall-enroll-operator USER
```

The helper accepts one existing non-system user, adds only that user to the `agentcall` group, and does not handle controller or provider credentials. Start a new login session before opening the desktop app or MCP client. Runtime directory traversal is `0750`; the socket remains `0660`; state, recordings, logs, and credentials remain private to the service account.

### Automatic controller pairing

1. Connect the supported phone over USB and approve Android's ordinary
   USB-debugging authorization for this desktop.
2. Open agentcall's Android Gateway screen and tap **Connect desktop**.
3. `gatewayd` reaches the shell-only bootstrap socket through ADB, verifies the
   matched package/version/signing identity, completes X25519/AES-GCM exchange,
   and proves the resulting key through the operational G2 session.
4. Only after mutual proof does each side commit its private controller key.
   The desktop key stays under `/var/lib/agentcall/controller/`; it is never shown,
   copied through a prompt, placed in environment values, or logged.
5. Use **Forget paired desktop** on Android to revoke trust, then repeat the
   same ADB-authorized flow. No manual controller-enrollment command is shipped.

## Upgrade and rollback

1. Stop the service and confirm no active call.
2. Back up `/etc/agentcall` and `/var/lib/agentcall` atomically with `agentcall-backup-state`.
3. Verify package hash and inspect payload.
4. Install the new package and run preflight in simulator mode first.
5. On failure, stop the service, reinstall the previous package, and run `agentcall-restore-state BACKUP.tar.gz NEW_OFFLINE_ROOT`; promote only independently reviewed, schema-compatible state while the service remains stopped.
6. Never auto-resume a call or media stream after rollback.

Uninstall preserves `/etc/agentcall` and `/var/lib/agentcall`; purge is an explicit administrator action outside package maintainer scripts.
