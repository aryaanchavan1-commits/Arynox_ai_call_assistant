#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

source_root="$root/app/src/main/java/com/callagent/gateway"
manifest="$root/app/src/main/AndroidManifest.xml"
apk="$root/app/build/outputs/apk/debug/app-debug.apk"
merged_manifest="$root/app/build/intermediates/merged_manifest/debug/AndroidManifest.xml"

for path in \
  "$source_root/sip" \
  "$source_root/rtp" \
  "$source_root/net/StunClient.kt" \
  "$source_root/bridge/CallOrchestrator.kt" \
  "$source_root/service/GatewayService.kt" \
  "$source_root/RootShell.kt"; do
  if [ -e "$path" ]; then
    printf 'legacy Android production path found: %s\n' "$path" >&2
    exit 1
  fi
done

legacy_symbols='SipClient|SipCall|SipMessage|SipAuth|RtpSession|RtpPacket|G722Codec|StunClient|CallOrchestrator|GatewayService'
if grep -R -n -E "(^|[^[:alnum:]_])($legacy_symbols|RootShell)([^[:alnum:]_]|$)|SIP agent audio|Runtime\.getRuntime\(\)\.exec\([^)]*su|arrayOf\(\"su\",[[:space:]]*\"-c\"" "$source_root"; then
  printf 'legacy Android production symbol, root executor, or terminology found\n' >&2
  exit 1
fi
stale_theme='Theme\.S''ip'
stale_project='S''ipGsmGateway'
stale_label='S''IP-GSM Gateway'
if grep -R -n -E "$stale_theme|$stale_project|$stale_label" "$root/app/src/main/res" "$manifest"; then
  printf 'legacy Android production resource identifier found\n' >&2
  exit 1
fi
grep -F 'const val BIND_ADDRESS: String = "127.0.0.1"' \
  "$source_root/usb/UsbGatewayServer.kt" >/dev/null || {
  printf 'Android gateway bind address is not exact IPv4 loopback\n' >&2
  exit 1
}
grep -F 'val shouldRun = deviceQualified() &&' \
  "$source_root/usb/UsbAudioBridgeCoordinator.kt" >/dev/null || {
  printf 'Android privileged audio must fail closed for unsupported devices\n' >&2
  exit 1
}
grep -F 'deviceQualified = { qualifyDevice(evidenceProvider) }' \
  "$source_root/usb/UsbGatewayService.kt" >/dev/null || {
  printf 'Android device qualification must authorize the audio coordinator\n' >&2
  exit 1
}

legacy_manifest='android:name="(\.service\.(BootReceiver|GatewayService)|\.sip\.|\.rtp\.)|android.permission.(ACCESS_WIFI_STATE|CHANGE_WIFI_STATE|ACCESS_NETWORK_STATE|CHANGE_NETWORK_STATE)'
for candidate in "$manifest" "$merged_manifest"; do
  test -f "$candidate"
  if grep -n -E "$legacy_manifest" "$candidate"; then
    printf 'legacy Android component or network-state permission found in %s\n' "$candidate" >&2
    exit 1
  fi
done

test -f "$apk"
for dex in $(zipinfo -1 "$apk" | grep -E '^classes[0-9]*\.dex$'); do
  unzip -p "$apk" "$dex" > "$tmp/$dex"
  strings "$tmp/$dex" > "$tmp/$dex.strings"
  if grep -n -E 'Lcom/callagent/gateway/(sip|rtp)/|Lcom/callagent/gateway/net/StunClient;|Lcom/callagent/gateway/bridge/CallOrchestrator;|Lcom/callagent/gateway/service/GatewayService;|Lcom/callagent/gateway/RootShell;' "$tmp/$dex.strings"; then
    printf 'legacy Android class found in APK dex: %s\n' "$dex" >&2
    exit 1
  fi
done

printf 'android-legacy-boundary-ok\n'
