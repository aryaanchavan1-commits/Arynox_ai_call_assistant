#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)

usage() {
  echo "usage: $0 --apk PATH --output DIR --version-name NAME --version-code CODE [--classification qualification|production-signed]" >&2
  exit 2
}

apk=
out=
version_name=
version_code=
classification=qualification
while [ "$#" -gt 0 ]; do
  case "$1" in
    --apk) apk=${2-}; shift 2 ;;
    --output) out=${2-}; shift 2 ;;
    --version-name) version_name=${2-}; shift 2 ;;
    --version-code) version_code=${2-}; shift 2 ;;
    --classification) classification=${2-}; shift 2 ;;
    *) usage ;;
  esac
done

[ -f "$apk" ] || usage
[ -n "$out" ] || usage
case "$version_name" in *[!A-Za-z0-9._-]*|'') usage ;; esac
case "$version_code" in *[!0-9]*|'') usage ;; esac
case "$classification" in qualification|production-signed) ;; *) usage ;; esac

find_aapt() {
  if command -v aapt >/dev/null 2>&1; then
    command -v aapt
    return
  fi
  for sdk in "${ANDROID_SDK_ROOT-}" "${ANDROID_HOME-}" "$HOME/Android/Sdk" "$HOME/android-sdk"; do
    [ -d "$sdk/build-tools" ] || continue
    candidate=$(find "$sdk/build-tools" -mindepth 2 -maxdepth 2 -type f \( -name aapt -o -name aapt.exe \) | LC_ALL=C sort | tail -n 1)
    if [ -n "$candidate" ]; then
      printf '%s\n' "$candidate"
      return
    fi
  done
  echo 'aapt is required to verify APK identity' >&2
  exit 1
}

aapt=$(find_aapt)
badging=$($aapt dump badging "$apk") || {
  echo 'Unable to parse APK identity with aapt' >&2
  exit 1
}
apk_package=$(printf '%s\n' "$badging" | awk -F"'" '/^package: / { print $2; exit }')
apk_version_code=$(printf '%s\n' "$badging" | awk -F"'" '/^package: / { print $4; exit }')
apk_version_name=$(printf '%s\n' "$badging" | awk -F"'" '/^package: / { print $6; exit }')
[ "$apk_package" = com.callagent.gateway ] || {
  echo "APK package mismatch: expected com.callagent.gateway, got $apk_package" >&2
  exit 1
}
[ "$apk_version_name" = "$version_name" ] && [ "$apk_version_code" = "$version_code" ] || {
  echo "APK version mismatch: requested $version_name ($version_code), APK is $apk_version_name ($apk_version_code)" >&2
  exit 1
}

mkdir -p "$out"
out=$(CDPATH= cd -- "$out" && pwd)
apk=$(CDPATH= cd -- "$(dirname -- "$apk")" && pwd)/$(basename -- "$apk")
base="AgentCall-${version_name}-${version_code}"
normal_apk="$out/$base.apk"
module_zip="$out/AgentCall-privileged-${version_name}-${version_code}-magisk.zip"
cp "$apk" "$normal_apk"
apk_hash=$(sha256sum "$normal_apk" | cut -d' ' -f1)

stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
mkdir -p "$stage/system/priv-app/agentcall" "$stage/system/etc/permissions" \
  "$stage/META-INF/com/google/android"
cp "$normal_apk" "$stage/system/priv-app/agentcall/agentcall.apk"
cp "$root/packaging/android/magisk-module-installer.sh" \
  "$stage/META-INF/com/google/android/update-binary"
printf '#MAGISK\n' > "$stage/META-INF/com/google/android/updater-script"
chmod 0755 "$stage/META-INF/com/google/android/update-binary"
cat > "$stage/module.prop" <<EOF
id=agentcall-privileged
name=AgentCall Privileged Telephony Bridge
version=$version_name
versionCode=$version_code
author=Sidin Search
summary=Matched AgentCall APK with package-scoped activation for USB-only cellular audio
description=Refreshes the matched AgentCall package, preserves app data and the dialer role, and grants only its declared protected telephony-audio permissions.
EOF
cat > "$stage/system/etc/permissions/privapp-permissions-com.callagent.gateway.xml" <<'EOF'
<?xml version="1.0" encoding="utf-8"?>
<permissions>
    <privapp-permissions package="com.callagent.gateway">
        <permission name="android.permission.CAPTURE_AUDIO_OUTPUT" />
        <permission name="android.permission.MODIFY_AUDIO_ROUTING" />
        <permission name="android.permission.MODIFY_PHONE_STATE" />
    </privapp-permissions>
</permissions>
EOF
cat > "$stage/customize.sh" <<EOF
#!/system/bin/sh
# Magisk sources customize.sh into its installer environment. Do not change
# global shell options here; abort explicitly on every validation failure.
current_prop="\${NVBASE:-/data/adb}/modules/agentcall-privileged/module.prop"
if [ -f "\$current_prop" ]; then
  installed_code=\$(sed -n 's/^versionCode=//p' "\$current_prop" | head -n 1)
  case "\$installed_code" in
    ''|*[!0-9]*) abort 'Refusing install: current module versionCode is invalid' ;;
  esac
  if [ "\$installed_code" -gt '$version_code' ]; then
    abort "Refusing in-place downgrade from versionCode \$installed_code to $version_code; remove the module, reboot, verify package absence, then install a verified prior matched artifact"
  fi
fi
expected='$apk_hash'
actual=\$(sha256sum "\$MODPATH/system/priv-app/agentcall/agentcall.apk" | cut -d' ' -f1)
if [ "\$actual" != "\$expected" ]; then
  ui_print '! Embedded AgentCall APK hash mismatch'
  abort 'Refusing corrupted privileged module'
fi
rm -f "\$MODPATH/disable" "\$MODPATH/remove" "\$MODPATH/skip_mount"
set_perm_recursive "\$MODPATH" 0 0 0755 0644
set_perm "\$MODPATH/service.sh" 0 0 0755
set_perm "\$MODPATH/uninstall.sh" 0 0 0755
ui_print '- AgentCall APK hash verified'
ui_print '- Existing AgentCall app will be refreshed from the bundled matched APK after reboot'
ui_print '- App data and the default-dialer role are preserved for same-signature upgrades'
ui_print '- No separate APK installation is required'
EOF
chmod 0755 "$stage/customize.sh"
cat > "$stage/service.sh" <<EOF
#!/system/bin/sh
MODDIR="\${0%/*}"
PKG='com.callagent.gateway'
EXPECTED_CODE='$version_code'
EXPECTED_HASH='$apk_hash'
TAG='agentcall-module'
BUNDLED_APK="\$MODDIR/system/priv-app/agentcall/agentcall.apk"

# Magisk late_start service runs after the module overlay is mounted. Wait
# boundedly for Package Manager; never alter SELinux or unrelated packages.
i=0
while [ "\$i" -lt 60 ]; do
  [ "\$(getprop sys.boot_completed 2>/dev/null)" = 1 ] && break
  i=\$((i + 1))
  sleep 1
done

# Package Manager can retain cached metadata when only the Magisk-mounted APK
# changes. A same-signature replace install forces a bounded rescan without
# clearing app data, controller enrollment, permissions, or the dialer role.
if ! pm install -r -t "\$BUNDLED_APK" >/dev/null 2>&1; then
  log -t "\$TAG" 'activation failed: Package Manager rejected the matched APK refresh'
  exit 1
fi

active=\$(pm path "\$PKG" 2>/dev/null | sed -n 's/^package://p' | head -n 1)
code=\$(dumpsys package "\$PKG" 2>/dev/null | sed -n 's/^[[:space:]]*versionCode=\([0-9][0-9]*\).*/\1/p' | head -n 1)
hash=
[ -n "\$active" ] && [ -f "\$active" ] && hash=\$(sha256sum "\$active" | cut -d' ' -f1)
if [ "\$code" != "\$EXPECTED_CODE" ] || [ "\$hash" != "\$EXPECTED_HASH" ]; then
  log -t "\$TAG" "activation failed: matched package not active"
  exit 1
fi

for permission in \
  android.permission.READ_PHONE_STATE \
  android.permission.CALL_PHONE \
  android.permission.ANSWER_PHONE_CALLS \
  android.permission.RECORD_AUDIO \
  android.permission.READ_CONTACTS \
  android.permission.READ_CALL_LOG \
  android.permission.POST_NOTIFICATIONS
do
  pm grant "\$PKG" "\$permission" >/dev/null 2>&1 || true
done
log -t "\$TAG" "matched AgentCall APK active: versionCode=\$code"
EOF
cat > "$stage/uninstall.sh" <<'EOF'
#!/system/bin/sh
pm uninstall --user 0 com.callagent.gateway >/dev/null 2>&1 || true
EOF
chmod 0755 "$stage/service.sh" "$stage/uninstall.sh"
# Normalize metadata and archive entries in lexical order for reproducibility.
find "$stage" -exec touch -h -t 198001010000.00 {} +
rm -f "$module_zip"
if command -v zip >/dev/null 2>&1; then
  (
    cd "$stage"
    find . -type f -print | LC_ALL=C sort | zip -X -q "$module_zip" -@
  )
elif command -v jar >/dev/null 2>&1; then
  archive_list="${stage}.files"
  (cd "$stage" && find . -type f -print | LC_ALL=C sort) > "$archive_list"
  (cd "$stage" && jar cMf "$module_zip" "@$archive_list")
  rm -f "$archive_list"
else
  echo 'zip or jar is required to create the Magisk module' >&2
  exit 1
fi

if [ "$classification" = production-signed ]; then
  artifact_classification=PRODUCTION_SIGNED_RELEASE_CANDIDATE
  publishable='PENDING_REAL_CALL_SOAK_AND_PLATFORM_SIGNING_GATES'
  signing_note='The production workflow cryptographically verified this APK against the operator-pinned signing certificate before packaging.'
else
  artifact_classification=QUALIFICATION_ONLY_DEBUG_SIGNED
  publishable=NO
  signing_note='These artifacts are qualification builds unless a separately verified production workflow classifies them. Do not publish them.'
fi

cat > "$out/ARTIFACT-STATUS.txt" <<EOF
$artifact_classification
Publishable: $publishable

$signing_note
Do not install without the explicit privileged-artifact approval gate.

Normal APK: $(basename "$normal_apk")
Magisk module: $(basename "$module_zip")
Package: com.callagent.gateway
Version: $version_name ($version_code)
Parsed APK package: $apk_package
Parsed APK version: $apk_version_name ($apk_version_code)
Standalone APK SHA-256: $apk_hash
Embedded APK SHA-256: $apk_hash
Standalone/embedded APK byte equality: VERIFIED

Install model:
- Normal APK: ordinary UI/development installation; protected cellular audio permissions remain unavailable.
- Magisk ZIP: matched APK as /system/priv-app plus exact protected-permission allowlist and package-scoped activation; reboot required.
- Do not install both independently. The Magisk ZIP already contains the APK.
- Module update: Magisk stages and replaces the old module; first boot performs a same-signature package refresh so Android reads the bundled APK while preserving app data and the dialer role.
- Rollback: disable/remove the module in Magisk and reboot; uninstall.sh removes only com.callagent.gateway for the primary user.
EOF
cat > "$out/ANDROID-ROLLBACK-MANIFEST.txt" <<EOF
Current package: $apk_package
Current version: $apk_version_name ($apk_version_code)
Current standalone APK SHA-256: $apk_hash
Current Magisk module: $(basename "$module_zip")
Downgrade policy: REFUSE_IN_PLACE_DOWNGRADE
Rollback requires: remove module, reboot, verify package absence, then install a separately verified prior matched artifact
Previous artifact package/version/hash: OPERATOR_MUST_SUPPLY_AND_VERIFY
Previous default dialer: OPERATOR_MUST_RECORD_BEFORE_INSTALL
Device rollback qualification: NOT_RUN_APPROVAL_REQUIRED

Never use adb install -d, force Package Manager state, or install the standalone APK beside the active module to bypass anti-downgrade checks.
EOF
(
  cd "$out"
  sha256sum "$(basename "$normal_apk")" "$(basename "$module_zip")" > SHA256SUMS
)
printf '%s\n%s\n' "$normal_apk" "$module_zip"
