#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
fixture="$tmp/agentcall.apk"
printf 'fixture-apk' > "$fixture"
mkdir -p "$tmp/bin"
cat > "$tmp/bin/aapt" <<'EOF'
#!/bin/sh
printf "package: name='com.callagent.gateway' versionCode='332' versionName='1.0.0' platformBuildVersionName=''\n"
EOF
chmod 0755 "$tmp/bin/aapt"

if PATH="$tmp/bin:$PATH" "$root/packaging/android/build-artifacts.sh" \
  --apk "$fixture" \
  --output "$tmp/version-mismatch" \
  --version-name 2.8.51 \
  --version-code 329 >"$tmp/version-mismatch.out" 2>"$tmp/version-mismatch.err"; then
  echo 'builder accepted caller metadata that disagrees with APK identity' >&2
  exit 1
fi
grep -F 'APK version mismatch' "$tmp/version-mismatch.err" >/dev/null

PATH="$tmp/bin:$PATH" "$root/packaging/android/build-artifacts.sh" \
  --apk "$fixture" \
  --output "$tmp/out" \
  --version-name 1.0.0 \
  --version-code 332

apk="$tmp/out/AgentCall-1.0.0-332.apk"
module="$tmp/out/AgentCall-privileged-1.0.0-332-magisk.zip"
test -f "$apk"
test -f "$module"
cmp -s "$fixture" "$apk"
unzip -t "$module" >/dev/null
unzip -p "$module" module.prop | grep -Fx 'id=agentcall-privileged' >/dev/null
unzip -p "$module" module.prop | grep -Fx 'name=AgentCall Privileged Telephony Bridge' >/dev/null
unzip -p "$module" module.prop | grep -Fx 'author=Sidin Search' >/dev/null
unzip -p "$module" module.prop | grep -Fx 'version=1.0.0' >/dev/null
unzip -p "$module" module.prop | grep -Fx 'versionCode=332' >/dev/null
unzip -p "$module" META-INF/com/google/android/update-binary > "$tmp/update-binary"
grep -F 'install_module || exit $?' "$tmp/update-binary" >/dev/null
if grep -Fx 'exit 0' "$tmp/update-binary" >/dev/null; then
  echo 'installer masks install_module failure with an unconditional success' >&2
  exit 1
fi
unzip -p "$module" customize.sh > "$tmp/customize.sh"
grep -F 'Embedded AgentCall APK hash mismatch' "$tmp/customize.sh" >/dev/null
if grep -F '.replace-app' "$tmp/customize.sh" >/dev/null; then
  echo 'customize.sh must not schedule destructive package replacement' >&2
  exit 1
fi
grep -F 'No separate APK installation is required' "$tmp/customize.sh" >/dev/null
if grep -Eq '^[[:space:]]*set[[:space:]]+-' "$tmp/customize.sh"; then
  echo 'customize.sh must not alter the Magisk installer shell options' >&2
  exit 1
fi
mkdir -p "$tmp/module-root/system/priv-app/agentcall" "$tmp/modules/agentcall-privileged"
unzip -p "$module" system/priv-app/agentcall/agentcall.apk > "$tmp/module-root/system/priv-app/agentcall/agentcall.apk"
printf 'versionCode=333\n' > "$tmp/modules/agentcall-privileged/module.prop"
if MODPATH="$tmp/module-root" NVBASE="$tmp" sh -c '
  ui_print() { :; }
  abort() { printf "%s\n" "$1" >&2; exit 1; }
  . "$1"
' sh "$tmp/customize.sh" >"$tmp/downgrade.out" 2>"$tmp/downgrade.err"; then
  echo 'customize.sh accepted an in-place module downgrade' >&2
  exit 1
fi
grep -F 'Refusing in-place downgrade from versionCode 333 to 332' "$tmp/downgrade.err" >/dev/null
unzip -p "$module" system/priv-app/agentcall/agentcall.apk > "$tmp/module.apk"
cmp -s "$fixture" "$tmp/module.apk"
unzip -p "$module" service.sh > "$tmp/service.sh"
unzip -p "$module" uninstall.sh > "$tmp/uninstall.sh"
grep -F 'pm install -r -t "$BUNDLED_APK"' "$tmp/service.sh" >/dev/null
if grep -E 'pm uninstall-system-updates|pm uninstall --user 0 "\$PKG"|install-existing' "$tmp/service.sh" >/dev/null; then
  echo 'service.sh must preserve the installed app, its data, and its dialer role during upgrades' >&2
  exit 1
fi
grep -F "EXPECTED_CODE='332'" "$tmp/service.sh" >/dev/null
grep -F "EXPECTED_HASH='$(sha256sum "$apk" | cut -d' ' -f1)'" "$tmp/service.sh" >/dev/null
grep -F 'android.permission.READ_CONTACTS' "$tmp/service.sh" >/dev/null
grep -F 'android.permission.READ_CALL_LOG' "$tmp/service.sh" >/dev/null
grep -F 'pm uninstall --user 0 com.callagent.gateway' "$tmp/uninstall.sh" >/dev/null
if grep -Eqi 'setenforce|permissioncontroller|tinymix|tinycap|/data/app|pm (disable|enable) ' \
    "$tmp/service.sh" "$tmp/uninstall.sh" "$tmp/customize.sh"; then
  echo 'forbidden global policy, mixer, or data-app synchronization behavior found' >&2
  exit 1
fi
unzip -p "$module" system/etc/permissions/privapp-permissions-com.callagent.gateway.xml > "$tmp/permissions.xml"
python3 - "$tmp/permissions.xml" <<'PY'
import sys
import xml.etree.ElementTree as ET

expected = {
    "android.permission.CAPTURE_AUDIO_OUTPUT",
    "android.permission.MODIFY_AUDIO_ROUTING",
    "android.permission.MODIFY_PHONE_STATE",
}
root = ET.parse(sys.argv[1]).getroot()
packages = root.findall("privapp-permissions")
if len(packages) != 1 or packages[0].attrib.get("package") != "com.callagent.gateway":
    raise SystemExit("unexpected privapp package boundary")
actual = {node.attrib.get("name") for node in packages[0].findall("permission")}
if actual != expected:
    raise SystemExit(f"privapp permission boundary mismatch: {sorted(actual)}")
PY
if unzip -Z1 "$module" | grep -E '(^|/)(post-fs-data\.sh|system\.prop|sepolicy\.rule|tinymix|tinycap|\.replace)$'; then
  echo 'forbidden module payload found' >&2
  exit 1
fi
(cd "$tmp/out" && sha256sum -c SHA256SUMS)
grep -F 'QUALIFICATION_ONLY_DEBUG_SIGNED' "$tmp/out/ARTIFACT-STATUS.txt" >/dev/null
grep -F 'Publishable: NO' "$tmp/out/ARTIFACT-STATUS.txt" >/dev/null
grep -F 'Parsed APK package: com.callagent.gateway' "$tmp/out/ARTIFACT-STATUS.txt" >/dev/null
grep -F 'Parsed APK version: 1.0.0 (332)' "$tmp/out/ARTIFACT-STATUS.txt" >/dev/null
grep -F "Standalone APK SHA-256: $(sha256sum "$apk" | cut -d' ' -f1)" "$tmp/out/ARTIFACT-STATUS.txt" >/dev/null
grep -F 'Standalone/embedded APK byte equality: VERIFIED' "$tmp/out/ARTIFACT-STATUS.txt" >/dev/null

test -f "$tmp/out/ANDROID-ROLLBACK-MANIFEST.txt"
grep -F 'Current package: com.callagent.gateway' "$tmp/out/ANDROID-ROLLBACK-MANIFEST.txt" >/dev/null
grep -F 'Current version: 1.0.0 (332)' "$tmp/out/ANDROID-ROLLBACK-MANIFEST.txt" >/dev/null
grep -F 'Downgrade policy: REFUSE_IN_PLACE_DOWNGRADE' "$tmp/out/ANDROID-ROLLBACK-MANIFEST.txt" >/dev/null
grep -F 'Rollback requires: remove module, reboot, verify package absence, then install a separately verified prior matched artifact' "$tmp/out/ANDROID-ROLLBACK-MANIFEST.txt" >/dev/null
grep -F 'Device rollback qualification: NOT_RUN_APPROVAL_REQUIRED' "$tmp/out/ANDROID-ROLLBACK-MANIFEST.txt" >/dev/null

PATH="$tmp/bin:$PATH" "$root/packaging/android/build-artifacts.sh" \
  --apk "$fixture" \
  --output "$tmp/out-second" \
  --version-name 1.0.0 \
  --version-code 332 >/dev/null
for artifact in \
  AgentCall-1.0.0-332.apk \
  AgentCall-privileged-1.0.0-332-magisk.zip \
  ARTIFACT-STATUS.txt \
  ANDROID-ROLLBACK-MANIFEST.txt \
  SHA256SUMS; do
  cmp -s "$tmp/out/$artifact" "$tmp/out-second/$artifact" || {
    echo "non-deterministic Android artifact: $artifact" >&2
    exit 1
  }
done
printf 'android-artifacts-ok\n'
