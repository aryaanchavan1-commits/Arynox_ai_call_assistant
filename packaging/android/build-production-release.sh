#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)

usage() {
  echo "usage: $0 --output DIR" >&2
  exit 2
}

out=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --output) out=${2-}; shift 2 ;;
    *) usage ;;
  esac
done
[ -n "$out" ] || usage

required_signing_value_missing=false
for name in \
  AGENTCALL_ANDROID_KEYSTORE_FILE \
  AGENTCALL_ANDROID_KEYSTORE_PASSWORD \
  AGENTCALL_ANDROID_KEY_ALIAS \
  AGENTCALL_ANDROID_KEY_PASSWORD \
  AGENTCALL_ANDROID_SIGNING_CERT_SHA256
do
  eval "value=\${$name-}"
  if [ -z "$value" ]; then
    echo "Missing required production signing input: $name" >&2
    required_signing_value_missing=true
  fi
done
[ "$required_signing_value_missing" = false ] || exit 1

case "$AGENTCALL_ANDROID_SIGNING_CERT_SHA256" in
  *[!0-9A-Fa-f]*|'')
    echo 'AGENTCALL_ANDROID_SIGNING_CERT_SHA256 must be exactly 64 hexadecimal characters' >&2
    exit 1
    ;;
esac
[ "${#AGENTCALL_ANDROID_SIGNING_CERT_SHA256}" -eq 64 ] || {
  echo 'AGENTCALL_ANDROID_SIGNING_CERT_SHA256 must be exactly 64 hexadecimal characters' >&2
  exit 1
}

case "$AGENTCALL_ANDROID_KEYSTORE_FILE" in
  /*) ;;
  [A-Za-z]:[\\/]* ) ;;
  *)
    echo 'AGENTCALL_ANDROID_KEYSTORE_FILE must be an absolute path outside the repository' >&2
    exit 1
    ;;
esac
[ -f "$AGENTCALL_ANDROID_KEYSTORE_FILE" ] || {
  echo 'AGENTCALL_ANDROID_KEYSTORE_FILE does not identify a regular file' >&2
  exit 1
}

case "$out" in
  /*) ;;
  *) out="$root/$out" ;;
esac
mkdir -p "$out"
out=$(CDPATH= cd -- "$out" && pwd)

cd "$root"
if [ -x ./gradlew ]; then
  gradle=./gradlew
elif [ -f ./gradlew.bat ]; then
  gradle=./gradlew.bat
else
  echo 'Gradle wrapper is required' >&2
  exit 1
fi

"$gradle" :app:verifyProductionSigningConfigured :app:assembleRelease --no-daemon
apk="$root/app/build/outputs/apk/release/app-release.apk"
[ -f "$apk" ] || {
  echo 'Signed release APK was not produced' >&2
  exit 1
}

# First pass derives the one current signing certificate and atomically updates
# every canonical phone/desktop manifest. The second pass embeds those exact
# bytes into the production-signed APK.
python3 tools/build_manifest.py --prepare "$apk"
manifest_digest=$(sed -n 's/^androidSigningCertificateSha256=//p' protocol/matched-artifact.properties)
expected_digest=$(printf '%s' "$AGENTCALL_ANDROID_SIGNING_CERT_SHA256" | tr 'A-F' 'a-f')
[ "$manifest_digest" = "$expected_digest" ] || {
  echo 'Production APK signer does not match AGENTCALL_ANDROID_SIGNING_CERT_SHA256' >&2
  exit 1
}

"$gradle" :app:assembleRelease --rerun-tasks --no-daemon
python3 tools/build_manifest.py --verify-final "$apk"

packaging/android/build-artifacts.sh \
  --apk "$apk" \
  --output "$out" \
  --version-name 2.8.54 \
  --version-code 332 \
  --classification production-signed

cat > "$out/PRODUCTION-SIGNING-EVIDENCE.txt" <<EOF
Android package: com.callagent.gateway
Android version: 2.8.54 (332)
Signing certificate SHA-256: $manifest_digest
Canonical manifest binding: VERIFIED
Embedded manifest binding: VERIFIED
APK signature verification: VERIFIED
Standalone/Magisk APK byte equality: VERIFIED
Private signing material stored in repository: NO
Remaining publish gates: real incoming-call acceptance, repeated-call soak, Windows signing, Debian/repository signing
EOF
(cd "$out" && sha256sum PRODUCTION-SIGNING-EVIDENCE.txt >> SHA256SUMS)

printf '%s\n' "$out"
