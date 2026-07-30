# Upgrade and rollback runbook

Hardware call state is never resumed automatically.

## Pre-upgrade

1. Confirm no active/ringing call and stop `agentcall-gatewayd.service`.
2. Run `agentcall-backup-state /absolute/offline/path/agentcall-pre-upgrade.tar.gz`.
3. Store the generated SHA-256 sidecar separately.
4. Capture installed package version and package hash.
5. Inspect the candidate `.deb`, checksum, SBOM, signature, compatibility declaration, and migration notes.
6. Do not proceed if the current state schema is newer than the candidate understands.

## Upgrade

1. Install only in the approved Debian/Ubuntu VM first.
2. Run preflight with simulator mode and no device credentials mounted.
3. Verify unit hardening, socket inventory, logs, MCP stdio smoke, and simulator call matrix.
4. Configure exact serial/fingerprint and administrator-managed ADB key only after the simulator gate.
5. Hardware-mode preflight must remain blocked until recorder health is qualified.

## Rollback

1. Stop the service; verify no gateway/MCP process or owned ADB forward remains.
2. Save the failed-version logs and state before modifying them.
3. Reinstall the exact previous `.deb` by verified hash.
4. Verify and extract the prior backup into a new offline root: `agentcall-restore-state /absolute/backup.tar.gz /absolute/new-offline-root`. The command checks its SHA-256 sidecar, archive paths/types, JSON validity, and supported schema before extraction; it never writes directly to `/etc` or `/var/lib`.
5. Compare the offline state with the installed version's compatibility declaration. With the service still stopped, an administrator may promote only the compatible config/state trees using ownership-preserving local tools. Never overlay newer state blindly.
6. Run simulator preflight and smoke tests before restoring hardware credentials or enabling the service.
7. Never redial, reconnect media, or mark a partial recording complete after rollback.

## Uninstall and purge

Normal package removal preserves `/etc/agentcall` and `/var/lib/agentcall`. Purge is an explicit administrator action after an independently verified backup and must remove recordings, transcript indexes, caller-memory links, redaction material, and ADB credentials according to policy while retaining only an allowed non-content audit tombstone.
