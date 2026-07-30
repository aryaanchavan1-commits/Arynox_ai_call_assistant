#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$root"

printf '\n== Android USB app, transactional manifest, and final APK ==\n'
python3 -m unittest tools.test_build_manifest -v
./gradlew :app:testDebugUnitTest :app:lintDebug :app:assembleDebug
python3 tools/build_manifest.py --prepare app/build/outputs/apk/debug/app-debug.apk
./gradlew :app:assembleDebug
python3 tools/build_manifest.py --verify-final app/build/outputs/apk/debug/app-debug.apk

printf '\n== Android matched APK + minimal Magisk module contract ==\n'
packaging/android/test-build-artifacts.sh
packaging/android/test-legacy-boundary.sh
packaging/android/test-controller-auth-boundary.sh
packaging/android/test-permission-boundary.sh

printf '\n== Linux gatewayd + MCP ==\n'
(
  cd pc/pc-gateway
  npm test
  npm run check
  node test/process-smoke.mjs
)

printf '\n== Electron desktop ==\n'
(
  cd pc/pc-gateway/ui
  npm test
  npm run check
)

printf '\n== Linux package release evidence ==\n'
python3 packaging/linux/test-generate-sbom.py -v
packaging/linux/test-controller-enrollment.sh
packaging/linux/test-backup-restore.sh
packaging/linux/test-release-evidence.sh
packaging/linux/test-unified-desktop-package.sh

printf '\n== Production boundary contracts ==\n'
# Production registration and runtime must remain USB/loopback only. The Android
# source and built-APK legacy transport boundary is enforced above.
if grep -n -E 'android:name="(\.service\.(BootReceiver|GatewayService)|\.sip\.|\.rtp\.)|android.permission.(ACCESS_WIFI_STATE|CHANGE_WIFI_STATE|ACCESS_NETWORK_STATE|CHANGE_NETWORK_STATE)' \
  app/src/main/AndroidManifest.xml; then
  printf 'legacy Android production registration or Wi-Fi/network-state permission found\n' >&2
  exit 1
fi
if grep -R -n -E 'ServerSocket\([^)]*0\.0\.0\.0|InetAddress\.getByName\("0\.0\.0\.0"\)|BIND_ADDRESS[^\n]*0\.0\.0\.0' \
  app/src/main/java/com/callagent/gateway/usb; then
  printf 'non-loopback Android listener found\n' >&2
  exit 1
fi
if grep -R -n --exclude='provider-settings.js' \
  -E "from ['\"]\./(sip|rtp|stun)|require\(['\"].*(sip|rtp|stun)|Asterisk|dgram\.createSocket|from ['\"]node:http['\"]|require\(['\"]node:http['\"]\)|from ['\"]http['\"]|require\(['\"]http['\"]\)" \
  pc/pc-gateway/src pc/pc-gateway/ui/electron pc/pc-gateway/ui/renderer; then
  printf 'legacy transport, datagram, or HTTP production reference found\n' >&2
  exit 1
fi
# Supertonic is an intentionally local service. Its provider-catalog worker has
# one HTTP transport import, guarded by an exact loopback-origin validator.
provider_settings=pc/pc-gateway/src/provider-settings.js
if [ "$(grep -F -c "require('node:http')" "$provider_settings")" -ne 1 ] \
  || [ "$(grep -o 'http://' "$provider_settings" | wc -l)" -ne 1 ]; then
  printf 'Supertonic loopback HTTP exception changed unexpectedly\n' >&2
  exit 1
fi
grep -F "const DEFAULT_SUPERTONIC_BASE_URL = 'http://127.0.0.1:7788';" "$provider_settings" >/dev/null
grep -F "url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname)" "$provider_settings" >/dev/null
grep -F 'this.#supertonicBaseUrl = validateSupertonicBaseUrl(supertonicBaseUrl);' "$provider_settings" >/dev/null
# The daemon must expose RPC through an owner-only filesystem Unix socket, not
# a TCP host/port listener. node:net createServer() is expected for this boundary.
grep -F 'this.server.listen(this.socketPath, resolve)' pc/pc-gateway/src/gateway-rpc.js >/dev/null || {
  printf 'gateway RPC is not bound to its Unix socket path\n' >&2
  exit 1
}
grep -F 'chmod(this.socketPath, 0o660)' pc/pc-gateway/src/gateway-rpc.js >/dev/null || {
  printf 'gateway RPC socket is not owner/group-only\n' >&2
  exit 1
}

git diff --check

printf '\nverify-ok\n'
