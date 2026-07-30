#!/bin/sh
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT INT TERM

if "$root/packaging/linux/release-evidence.sh" \
  --gateway-source "$root/pc/pc-gateway" \
  --output "$tmp/out"; then
  :
else
  printf 'release evidence command failed\n' >&2
  for diagnostic in \
    systemd-verify.txt \
    systemd-security.txt \
    sbom-status.txt \
    RELEASE-EVIDENCE.txt
  do
    if [ -f "$tmp/out/$diagnostic" ]; then
      printf '%s\n' "--- $diagnostic (last 40 lines) ---" >&2
      tail -n 40 "$tmp/out/$diagnostic" >&2
    fi
  done
  exit 1
fi

status="$tmp/out/RELEASE-EVIDENCE.txt"
test -f "$status"
grep -qx 'REPRODUCIBLE_DEB=PASS' "$status"
grep -qx 'PACKAGE_PATHS=PASS' "$status"
grep -qx 'SYSTEMD_VERIFY=PASS' "$status"
grep -Eq '^SYSTEMD_SECURITY=PASS:(offline-analysis|static-profile)$' "$status"
test -s "$tmp/out/systemd-security.txt"
grep -Eq '(Overall exposure level|Static hardening profile) for agentcall-gatewayd.service:' \
  "$tmp/out/systemd-security.txt"
grep -qx 'LEGACY_TRANSPORT_SCAN=PASS' "$status"
grep -qx 'SBOM_CYCLONEDX=PASS' "$status"
grep -qx 'MCP_PACKAGED_SMOKE=PASS' "$status"
grep -qx 'PROJECT_LICENSE=PASS:AGPL-3.0-only' "$status"
test -f "$tmp/out/mcp-packaged-smoke.json"
if grep -Eq '\+[1-9][0-9]{5,14}|"(pcm|base64|payload|audio|apiKey|token|secret|authorization)"[[:space:]]*:' "$tmp/out/mcp-packaged-smoke.json"; then
  printf 'sensitive or binary-shaped content entered MCP evidence\n' >&2
  exit 1
fi
grep -Eq '^LINTIAN=(PASS|NOT_RUN:not-installed)$' "$status"
grep -Eq '^VULNERABILITY_SCAN=(PASS|NOT_RUN:not-installed)$' "$status"

deb="$tmp/out/agentcall-gatewayd_0.2.5_all.deb"
test -f "$deb"
test -f "$deb.sha256"
test -f "$tmp/out/agentcall-gatewayd_0.2.5.cdx.json"
python3 -m json.tool "$tmp/out/agentcall-gatewayd_0.2.5.cdx.json" >/dev/null
python3 - "$tmp/out/agentcall-gatewayd_0.2.5.cdx.json" <<'PY'
import json, sys
bom = json.load(open(sys.argv[1], encoding='utf-8'))
assert bom['metadata']['component']['licenses'] == [{'license': {'id': 'AGPL-3.0-only'}}]
PY
sha256sum -c "$deb.sha256"

dpkg-deb --contents "$deb" > "$tmp/contents.txt"
dpkg-deb --field "$deb" Depends | grep -q 'python3'
grep -q './usr/bin/agentcall-simulator-soak' "$tmp/contents.txt"
grep -q './usr/bin/agentcall-backup-state' "$tmp/contents.txt"
grep -q './usr/bin/agentcall-restore-state' "$tmp/contents.txt"
grep -q './usr/lib/agentcall/pc-gateway/scripts/simulator-soak.js' "$tmp/contents.txt"
grep -q './usr/share/agentcall/protocol/g2-v1.properties' "$tmp/contents.txt"
grep -q './usr/share/doc/agentcall-gatewayd/LICENSE' "$tmp/contents.txt"
grep -q './usr/share/doc/agentcall-gatewayd/THIRD_PARTY_NOTICES.md' "$tmp/contents.txt"
grep -q './usr/share/doc/agentcall-gatewayd/copyright' "$tmp/contents.txt"
if grep -E '/(test|dist|\.git|recordings|credentials)/' "$tmp/contents.txt"; then
  printf 'development output or sensitive-looking directory entered package\n' >&2
  exit 1
fi
# Production npm dependencies are intentionally vendored from the exact lockfile;
# Electron/build tooling and other development-only packages must never enter.
if grep -E '/node_modules/(electron|electron-builder|@electron|app-builder-bin)/' "$tmp/contents.txt"; then
  printf 'development-only npm dependency entered package\n' >&2
  exit 1
fi

dpkg-deb --extract "$deb" "$tmp/extract"
grep -q 'GNU AFFERO GENERAL PUBLIC LICENSE' "$tmp/extract/usr/share/doc/agentcall-gatewayd/LICENSE"
grep -q 'License: AGPL-3.0-only' "$tmp/extract/usr/share/doc/agentcall-gatewayd/copyright"
report=$(node "$tmp/extract/usr/lib/agentcall/pc-gateway/scripts/simulator-soak.js" 1000)
printf '%s\n' "$report" | grep -q '"identity":"SIMULATOR"'
printf '%s\n' "$report" | grep -q '"simulator":true'
printf 'release-evidence-test-ok\n'
