#!/system/bin/sh
# Diagnostic-only: copy bundled tinymix to a temporary data path.
MODDIR=${0%/*}
SRC="$MODDIR/tinymix"
DST=/data/local/tmp/agentcall-tinymix
[ -f "$SRC" ] || exit 0
cp "$SRC" "$DST" || exit 1
chown root:root "$DST"
chmod 0755 "$DST"
log -t agentcall-atoll-diag "staged read-only diagnostic tinymix at $DST"
