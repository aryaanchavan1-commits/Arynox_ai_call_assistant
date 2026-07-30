#!/bin/sh
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT INT TERM

state="$tmp/source/state"
config="$tmp/source/config"
mkdir -p "$state/recordings/call-1" "$state/caller-memory/callers" "$config"
printf '{"schemaVersion":1,"callId":"call-1"}\n' > "$state/recordings/call-1/manifest.json"
printf '{"schemaVersion":1,"callerId":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}\n' > "$state/caller-memory/callers/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.json"
printf 'AGENTCALL_DIAL_ENABLED=false\n' > "$config/gateway.env"

archive="$tmp/state.tar.gz"
AGENTCALL_STATE_DIR="$state" AGENTCALL_CONFIG_DIR="$config" \
  "$root/packaging/linux/bin/agentcall-backup-state" "$archive" >/dev/null
(cd "$(dirname "$archive")" && sha256sum -c "$(basename "$archive").sha256")

restore="$tmp/restored"
AGENTCALL_STATE_DIR="$state" AGENTCALL_CONFIG_DIR="$config" \
  "$root/packaging/linux/bin/agentcall-restore-state" "$archive" "$restore" >/dev/null
cmp "$state/recordings/call-1/manifest.json" "$restore/${state#/}/recordings/call-1/manifest.json"
cmp "$config/gateway.env" "$restore/${config#/}/gateway.env"

if AGENTCALL_STATE_DIR="$state" AGENTCALL_CONFIG_DIR="$config" \
  "$root/packaging/linux/bin/agentcall-restore-state" "$archive" "$restore" >/dev/null 2>&1; then
  printf 'restore unexpectedly overwrote an existing target\n' >&2
  exit 1
fi

cp "$archive" "$tmp/tampered.tar.gz"
printf 'x' >> "$tmp/tampered.tar.gz"
cp "$archive.sha256" "$tmp/tampered.tar.gz.sha256"
if AGENTCALL_STATE_DIR="$state" AGENTCALL_CONFIG_DIR="$config" \
  "$root/packaging/linux/bin/agentcall-restore-state" "$tmp/tampered.tar.gz" "$tmp/tampered-restore" >/dev/null 2>&1; then
  printf 'restore unexpectedly accepted a checksum mismatch\n' >&2
  exit 1
fi

future_state="$tmp/future/state"
future_config="$tmp/future/config"
mkdir -p "$future_state/recordings/call-2" "$future_config"
printf '{"schemaVersion":2,"callId":"call-2"}\n' > "$future_state/recordings/call-2/manifest.json"
printf 'safe=true\n' > "$future_config/gateway.env"
future_archive="$tmp/future.tar.gz"
AGENTCALL_STATE_DIR="$future_state" AGENTCALL_CONFIG_DIR="$future_config" \
  "$root/packaging/linux/bin/agentcall-backup-state" "$future_archive" >/dev/null
if AGENTCALL_STATE_DIR="$future_state" AGENTCALL_CONFIG_DIR="$future_config" \
  "$root/packaging/linux/bin/agentcall-restore-state" "$future_archive" "$tmp/future-restore" >/dev/null 2>&1; then
  printf 'restore unexpectedly accepted a future schema\n' >&2
  exit 1
fi

link_state="$tmp/link/state"
link_config="$tmp/link/config"
mkdir -p "$link_state" "$link_config"
ln -s /etc/passwd "$link_state/external-link"
printf 'safe=true\n' > "$link_config/gateway.env"
link_archive="$tmp/link.tar.gz"
AGENTCALL_STATE_DIR="$link_state" AGENTCALL_CONFIG_DIR="$link_config" \
  "$root/packaging/linux/bin/agentcall-backup-state" "$link_archive" >/dev/null
if AGENTCALL_STATE_DIR="$link_state" AGENTCALL_CONFIG_DIR="$link_config" \
  "$root/packaging/linux/bin/agentcall-restore-state" "$link_archive" "$tmp/link-restore" >/dev/null 2>&1; then
  printf 'restore unexpectedly accepted a symlink\n' >&2
  exit 1
fi

printf 'backup-restore-test-ok\n'
