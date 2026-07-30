#!/usr/bin/env bash
# Host-side, read-only Phase-0 qualification helper for POCO M2 Pro (atoll/gram).
# It never records audio, places calls, or reads call logs/SIM/account identifiers.
set -euo pipefail

ADB=${ADB:-adb}
REMOTE_TOOL=/data/local/tmp/agentcall-tinymix
BACKUP_TOOL=${REMOTE_TOOL}.atoll-diag.bak
OUTDIR=${OUTDIR:-"$PWD/atoll-diag-out"}

usage() {
  cat <<'EOF'
Usage: tools/diag/atoll-diag.sh COMMAND [ARG]
  selftest                    Check host dependencies and redaction
  inventory                   Save non-PII device/audio-policy inventory
  install-tool LOCAL_TINYMIX  Temporarily stage a static ARM64 tinymix
  remove-tool                 Restore/remove the staged tinymix
  snap idle|active|postcall   Save a read-only mixer + audio-policy snapshot
  report                      Produce redacted mixer diffs locally
  cleanup                     Remove remote tool/output and local evidence

The user must place/answer/hang up calls manually. No audio samples are captured.
EOF
}

redact() {
  sed -E \
    -e 's/\+?[0-9][0-9 -]{7,}[0-9]/<PHONE_OR_ID>/g' \
    -e 's/([[:xdigit:]]{2}:){5}[[:xdigit:]]{2}/<MAC>/g' \
    -e 's/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/<EMAIL>/g' \
    -e 's/(IMSI|ICCID|IMEI|ESN|MEID|serialno|ro\.serialno)[=: ]+[^ ]*/\1=<REDACTED>/gI'
}

adb_ready() {
  command -v "$ADB" >/dev/null || { echo "adb not found" >&2; exit 3; }
  [ "$("$ADB" get-state 2>/dev/null)" = device ] || { echo "no authorized device" >&2; exit 3; }
}

root_shell() {
  "$ADB" shell su -c "$1"
}

require_root() {
  root_shell id 2>/dev/null | grep -q 'uid=0' || { echo "ADB shell root not granted" >&2; exit 4; }
}

safe_tag() {
  case "$1" in idle|active|postcall) printf '%s' "$1";; *) echo "tag must be idle, active, or postcall" >&2; exit 2;; esac
}

inventory() {
  adb_ready; require_root; mkdir -p "$OUTDIR"
  {
    echo '=== identity (public Build properties only) ==='
    for p in ro.product.manufacturer ro.product.model ro.product.device ro.board.platform ro.hardware ro.build.version.release ro.build.version.sdk ro.build.fingerprint; do
      printf '%s=' "$p"; "$ADB" shell getprop "$p" | tr -d '\r'
    done
    echo '=== root/SELinux ==='
    root_shell id
    root_shell getenforce
    echo '=== audio policy capabilities ==='
    root_shell "grep -iE 'incall_music|TELEPHONY_TX|TELEPHONY_RX|voice_rx|voice_tx' /vendor/etc/audio_policy_configuration.xml 2>/dev/null || true"
  } | redact > "$OUTDIR/inventory.txt"
  echo "$OUTDIR/inventory.txt"
}

install_tool() {
  local bin=${1:-}
  [ -n "$bin" ] && [ -f "$bin" ] || { echo "local tinymix binary required" >&2; exit 2; }
  adb_ready; require_root
  file "$bin" | grep -qiE 'aarch64|ARM aarch64' || { echo "tinymix must be ARM64" >&2; exit 3; }
  "$ADB" push "$bin" /data/local/tmp/agentcall-tinymix.new >/dev/null
  root_shell "if [ -e '$REMOTE_TOOL' ] && [ ! -e '$BACKUP_TOOL' ]; then cp -p '$REMOTE_TOOL' '$BACKUP_TOOL'; fi; mv /data/local/tmp/agentcall-tinymix.new '$REMOTE_TOOL'; chmod 0755 '$REMOTE_TOOL'"
  echo "staged $REMOTE_TOOL (sha256 $(sha256sum "$bin" | cut -d' ' -f1))"
}

remove_tool() {
  adb_ready; require_root
  root_shell "rm -f /data/local/tmp/agentcall-tinymix.new; if [ -e '$BACKUP_TOOL' ]; then mv '$BACKUP_TOOL' '$REMOTE_TOOL'; else rm -f '$REMOTE_TOOL'; fi"
  echo "temporary tool restored/removed"
}

snapshot() {
  local tag; tag=$(safe_tag "${1:-}")
  adb_ready; require_root; mkdir -p "$OUTDIR"
  root_shell "test -x '$REMOTE_TOOL'" || { echo "run install-tool first" >&2; exit 5; }
  {
    echo "# tag=$tag captured=$(date -u +%FT%TZ)"
    echo '=== phone state ==='
    "$ADB" shell dumpsys media.audio_policy | grep -m1 'Phone state:' || true
    echo '=== relevant audio policy ==='
    "$ADB" shell dumpsys media.audio_policy | grep -iE 'incall_music_uplink|voice_rx|voice_tx|TELEPHONY_TX|TELEPHONY_RX|AUDIO_MODE_' || true
    echo '=== mixer ==='
    root_shell "$REMOTE_TOOL"
  } | redact > "$OUTDIR/snap-$tag.txt"
  echo "$OUTDIR/snap-$tag.txt"
}

mixer_only() {
  awk '/^=== mixer ===$/{on=1; next} on{print}' "$1"
}

report() {
  mkdir -p "$OUTDIR"
  local report_file="$OUTDIR/report.txt"
  : > "$report_file"
  if [ -f "$OUTDIR/snap-idle.txt" ] && [ -f "$OUTDIR/snap-active.txt" ]; then
    mixer_only "$OUTDIR/snap-idle.txt" > "$OUTDIR/.idle-mixer"
    mixer_only "$OUTDIR/snap-active.txt" > "$OUTDIR/.active-mixer"
    { echo '=== mixer diff idle -> active ==='; diff -u "$OUTDIR/.idle-mixer" "$OUTDIR/.active-mixer" || true; } | redact >> "$report_file"
  fi
  if [ -f "$OUTDIR/snap-idle.txt" ] && [ -f "$OUTDIR/snap-postcall.txt" ]; then
    mixer_only "$OUTDIR/snap-postcall.txt" > "$OUTDIR/.postcall-mixer"
    { echo '=== mixer diff idle -> postcall ==='; diff -u "$OUTDIR/.idle-mixer" "$OUTDIR/.postcall-mixer" || true; } | redact >> "$report_file"
  fi
  rm -f "$OUTDIR"/.*-mixer
  cat "$report_file"
}

cleanup() {
  remove_tool || true
  rm -rf "$OUTDIR"
  echo "removed local diagnostic evidence"
}

selftest() {
  command -v bash >/dev/null; command -v sed >/dev/null; command -v diff >/dev/null; command -v file >/dev/null
  local sample out
  sample='IMEI=123456789012345 +14155550100 aa:bb:cc:dd:ee:ff user@example.com'
  out=$(printf '%s\n' "$sample" | redact)
  ! grep -qE '123456789012345|14155550100|aa:bb:cc:dd:ee:ff|user@example.com' <<<"$out"
  echo "selftest: ok ($out)"
}

cmd=${1:-}; shift || true
case "$cmd" in
  selftest) selftest;; inventory) inventory;; install-tool) install_tool "$@";; remove-tool) remove_tool;;
  snap) snapshot "$@";; report) report;; cleanup) cleanup;; -h|--help|help|'') usage;;
  *) usage >&2; exit 2;;
esac
