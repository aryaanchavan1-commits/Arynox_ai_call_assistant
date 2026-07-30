# POCO M2 Pro (`atoll` / `gram`) Phase-0 diagnostics

`atoll-diag.sh` is a **Linux host-side** ADB helper. It reads device identity, audio policy, and mixer control values. It never opens an audio stream, records samples, places calls, or reads call logs, contacts, phone numbers, SIM IDs, or account data.

```bash
tools/diag/atoll-diag.sh selftest
tools/diag/atoll-diag.sh inventory
tools/diag/atoll-diag.sh install-tool /path/to/static-arm64-tinymix
tools/diag/atoll-diag.sh snap idle
# Manually start an ordinary GSM call, then:
tools/diag/atoll-diag.sh snap active
# Manually hang up, then:
tools/diag/atoll-diag.sh snap postcall
tools/diag/atoll-diag.sh report
tools/diag/atoll-diag.sh cleanup
```

Evidence defaults to `./atoll-diag-out`; set `OUTDIR` to override it. `cleanup` restores a pre-existing remote tool if one was backed up, otherwise removes the staged tool.

## Optional safe Magisk diagnostic variant

`magisk-safe/` is an optional minimal module skeleton. It only stages its bundled `tinymix` at `/data/local/tmp/agentcall-tinymix` and removes that file on uninstall. It deliberately contains no privileged APK, permission XML, system properties, app-ops changes, mixer writes, or PermissionController overlays/disable/kill commands.

For ordinary qualification, prefer the host script's temporary `install-tool`/`remove-tool` commands and do not install any module.

> **Do not install the repository's legacy `magisk/` module on a personal device unchanged.** It globally hides/disables Android's PermissionController and force-writes microphone app-ops.
