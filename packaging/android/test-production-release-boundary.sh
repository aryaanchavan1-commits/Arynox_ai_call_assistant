#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
script="$root/packaging/android/build-production-release.sh"
gradle="$root/app/build.gradle.kts"

test -x "$script"
grep -F 'verifyProductionSigningConfigured' "$gradle" >/dev/null
grep -F 'AGENTCALL_ANDROID_KEYSTORE_FILE' "$gradle" >/dev/null
grep -F 'enableV2Signing = true' "$gradle" >/dev/null
grep -F 'enableV3Signing = true' "$gradle" >/dev/null
grep -F 'AGENTCALL_ANDROID_SIGNING_CERT_SHA256' "$script" >/dev/null
grep -F 'tools/build_manifest.py --prepare' "$script" >/dev/null
grep -F 'tools/build_manifest.py --verify-final' "$script" >/dev/null
grep -F -- '--classification production-signed' "$script" >/dev/null

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
if env -i PATH="$PATH" "$script" --output "$tmp/out" >"$tmp/stdout" 2>"$tmp/stderr"; then
  echo 'production release unexpectedly accepted missing signing inputs' >&2
  exit 1
fi
grep -F 'Missing required production signing input: AGENTCALL_ANDROID_KEYSTORE_FILE' "$tmp/stderr" >/dev/null
test ! -e "$tmp/out"

if grep -R -E 'storePassword[[:space:]]*=[[:space:]]*"|keyPassword[[:space:]]*=[[:space:]]*"' \
  "$root/app" "$root/packaging/android" >/dev/null; then
  echo 'literal Android signing password found in source' >&2
  exit 1
fi

echo production-release-boundary-test-ok
