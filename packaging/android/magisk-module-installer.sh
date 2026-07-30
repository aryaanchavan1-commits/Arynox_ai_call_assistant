#!/sbin/sh
# Vendored from topjohnwu/Magisk scripts/module_installer.sh (master), retrieved 2026-07-20.
# Source: https://github.com/topjohnwu/Magisk/blob/master/scripts/module_installer.sh

umask 022

ui_print() { echo "$1"; }

require_new_magisk() {
  ui_print "*******************************"
  ui_print " Please install Magisk v20.4+! "
  ui_print "*******************************"
  exit 1
}

OUTFD=$2
ZIPFILE=$3

mount /data 2>/dev/null

[ -f /data/adb/magisk/util_functions.sh ] || require_new_magisk
. /data/adb/magisk/util_functions.sh
[ "$MAGISK_VER_CODE" -lt 20400 ] && require_new_magisk

install_module || exit $?
