#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

usb="$root/app/src/main/java/com/callagent/gateway/usb"
service="$usb/UsbGatewayService.kt"
server="$usb/UsbGatewayServer.kt"
storage="$usb/AndroidControllerSecretStorage.kt"
activity="$usb/UsbGatewayActivity.kt"
source_manifest="$root/app/src/main/AndroidManifest.xml"
merged_manifest="$root/app/build/intermediates/merged_manifests/debug/AndroidManifest.xml"
apk="$root/app/build/outputs/apk/debug/app-debug.apk"

for file in "$service" "$server" "$storage" "$activity" "$source_manifest" "$merged_manifest" "$apk"; do
  test -f "$file" || { printf 'controller authentication artifact missing: %s\n' "$file" >&2; exit 1; }
done

grep -F 'ControllerEnrollmentStore(AndroidControllerSecretStorage(this))' "$service" >/dev/null
grep -F 'when (enrollmentStore.state())' "$service" >/dev/null
grep -F 'ControllerEnrollmentState.EMPTY -> startBootstrapGateway(enrollmentStore)' "$service" >/dev/null
grep -F 'ControllerEnrollmentState.STAGED -> startStagedRecovery(enrollmentStore)' "$service" >/dev/null
grep -F 'ControllerEnrollmentState.COMMITTED -> {' "$service" >/dev/null
grep -F 'ControllerEnrollmentState.ASYMMETRIC_RESET_REQUIRED -> {' "$service" >/dev/null
grep -F 'val controllerSecret = enrollmentStore.load() ?: run { stopGateway(); return }' "$service" >/dev/null
grep -F 'startEnrolledGateway(controllerSecret)' "$service" >/dev/null
grep -F 'controllerSecret.fill(0)' "$service" >/dev/null
grep -F 'enrollmentSecret = controllerSecret.copyOf()' "$service" >/dev/null

grep -F 'AUTH_MAGIC_SERVER_HELLO = "G2A1"' "$server" >/dev/null
grep -F 'AUTH_MAGIC_CLIENT_PROOF = "G2C1"' "$server" >/dev/null
grep -F 'AUTH_MAGIC_SERVER_PROOF = "G2S1"' "$server" >/dev/null
for domain in client server session; do
  grep -F "agentcall-controller-$domain-v1\\u0000" "$server" >/dev/null
done

grep -F 'AndroidKeyStore' "$storage" >/dev/null
grep -F 'AES/GCM/NoPadding' "$storage" >/dev/null
grep -F 'Context.MODE_PRIVATE' "$storage" >/dev/null
grep -F 'FLAG_SECURE' "$activity" >/dev/null

python3 - "$source_manifest" "$merged_manifest" <<'PY'
import sys
import xml.etree.ElementTree as ET

ANDROID = "{http://schemas.android.com/apk/res/android}"
EXPECTED_PRIVATE = {
    ".usb.UsbGatewayActivity": "activity",
    ".usb.UsbGatewayService": "service",
}
for path in sys.argv[1:]:
    app = ET.parse(path).getroot().find("application")
    if app is None:
        raise SystemExit(f"application missing in {path}")
    for name, kind in EXPECTED_PRIVATE.items():
        matches = [node for node in app.findall(kind) if node.attrib.get(ANDROID + "name") in {name, "com.callagent.gateway" + name}]
        if len(matches) != 1 or matches[0].attrib.get(ANDROID + "exported") != "false":
            raise SystemExit(f"controller component must be uniquely non-exported: {name} in {path}")
PY

found_classes=''
found_protocol=''
for dex in $(zipinfo -1 "$apk" | grep -E '^classes[0-9]*\.dex$'); do
  unzip -p "$apk" "$dex" > "$tmp/$dex"
  strings "$tmp/$dex" > "$tmp/$dex.strings"
  if grep -q 'Lcom/callagent/gateway/usb/AndroidControllerSecretStorage;' "$tmp/$dex.strings" \
      && grep -q 'Lcom/callagent/gateway/usb/ControllerEnrollmentStore;' "$tmp/$dex.strings"; then
    found_classes=1
  fi
  if grep -q 'agentcall-controller-client-v1' "$tmp/$dex.strings" \
      && grep -q 'agentcall-controller-server-v1' "$tmp/$dex.strings" \
      && grep -q 'agentcall-controller-session-v1' "$tmp/$dex.strings" \
      && grep -q 'G2A1' "$tmp/$dex.strings" \
      && grep -q 'G2C1' "$tmp/$dex.strings" \
      && grep -q 'G2S1' "$tmp/$dex.strings"; then
    found_protocol=1
  fi
done
[ "$found_classes" = 1 ] || { printf 'controller enrollment classes missing from APK DEX\n' >&2; exit 1; }
[ "$found_protocol" = 1 ] || { printf 'controller authentication protocol missing from APK DEX\n' >&2; exit 1; }

printf 'android-controller-auth-boundary-ok\n'
