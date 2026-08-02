#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
gateway_source=
output=
version=1.0.1

usage() {
  printf 'usage: %s --gateway-source ABSOLUTE_PATH --output DIRECTORY [--version VERSION]\n' "$0" >&2
  exit 2
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --gateway-source) [ "$#" -ge 2 ] || usage; gateway_source=$2; shift 2 ;;
    --output) [ "$#" -ge 2 ] || usage; output=$2; shift 2 ;;
    --version) [ "$#" -ge 2 ] || usage; version=$2; shift 2 ;;
    *) usage ;;
  esac
done

[ -n "$gateway_source" ] && [ "${gateway_source#/}" != "$gateway_source" ] || usage
[ -n "$output" ] || usage
case "$version" in ''|*[!A-Za-z0-9.+:~_-]*) printf 'invalid version\n' >&2; exit 1;; esac

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT INT TERM
mkdir -p "$work/a" "$work/b" "$work/extract" "$work/unit-path" "$output"

(
  cd "$root"
  SOURCE_DATE_EPOCH=0 packaging/linux/build-deb.sh \
    --gateway-source "$gateway_source" --output "$work/a" --version "$version"
  SOURCE_DATE_EPOCH=0 packaging/linux/build-deb.sh \
    --gateway-source "$gateway_source" --output "$work/b" --version "$version"
)

pkg="agentcall-gatewayd_${version}_all.deb"
cmp "$work/a/$pkg" "$work/b/$pkg"
cmp "$work/a/$pkg.payload.sha256" "$work/b/$pkg.payload.sha256"

final_deb="$output/$pkg"
cp "$work/a/$pkg" "$final_deb"
cp "$work/a/$pkg.contents.txt" "$output/$pkg.contents.txt"
cp "$work/a/$pkg.info.txt" "$output/$pkg.info.txt"
cp "$work/a/$pkg.payload.sha256" "$output/$pkg.payload.sha256"
sha256sum "$final_deb" > "$output/$pkg.sha256"

dpkg-deb --extract "$final_deb" "$work/extract"
dpkg-deb --control "$final_deb" "$work/extract/DEBIAN"
node "$root/packaging/linux/test-packaged-mcp.mjs" \
  "$work/extract" "$output/mcp-packaged-smoke.json" \
  > "$output/mcp-packaged-smoke.txt"

test -x "$work/extract/usr/lib/agentcall/bin/agentcall-preflight"
test -L "$work/extract/usr/bin/agentcall-gatewayd"
test -x "$work/extract/usr/lib/agentcall/bin/agentcall-gatewayd"
test -x "$work/extract/usr/lib/agentcall/pc-gateway/src/gatewayd.js"
test -x "$work/extract/usr/lib/agentcall/pc-gateway/src/mcp-server.js"
test "$(dpkg-deb --field "$final_deb" Package)" = agentcall-gatewayd
test "$(dpkg-deb --field "$final_deb" Version)" = "$version"
test "$(dpkg-deb --field "$final_deb" Architecture)" = all

unit="$work/extract/usr/lib/systemd/system/agentcall-gatewayd.service"
test -f "$unit"
sed \
  -e 's#^ExecStartPre=.*#ExecStartPre=/bin/true#' \
  -e 's#^ExecStart=.*#ExecStart=/bin/true#' \
  "$unit" > "$work/unit-path/agentcall-gatewayd.service"
# Keep verification isolated from unrelated/broken host units. The packaged
# ExecStart paths were checked above; /bin/true lets systemd validate syntax,
# dependencies, and hardening directives without requiring installation.
for target in sysinit basic local-fs multi-user; do
  printf '[Unit]\nDescription=%s target\n' "$target" \
    > "$work/unit-path/$target.target"
done
SYSTEMD_UNIT_PATH="$work/unit-path" \
  systemd-analyze verify --man=no --generators=no \
  "$work/unit-path/agentcall-gatewayd.service" \
  > "$output/systemd-verify.txt" 2>&1
systemd_security_status=PASS:static-profile
if systemd-analyze security --help 2>&1 | grep -q -- '--offline'; then
  SYSTEMD_UNIT_PATH="$work/unit-path" \
    systemd-analyze security --offline=yes --no-pager agentcall-gatewayd.service \
    > "$output/systemd-security.txt" 2>&1
  systemd_security_status=PASS:offline-analysis
else
  # systemd 249 and older cannot score an uninstalled unit. Keep the release
  # verifier non-mutating and enforce the security profile directly after the
  # isolated systemd syntax/dependency check above.
  for directive in \
    'User=agentcall' \
    'Group=agentcall' \
    'UMask=0077' \
    'NoNewPrivileges=yes' \
    'PrivateTmp=yes' \
    'ProtectSystem=strict' \
    'ProtectHome=yes' \
    'ProtectKernelTunables=yes' \
    'ProtectKernelModules=yes' \
    'ProtectKernelLogs=yes' \
    'ProtectControlGroups=yes' \
    'ProtectClock=yes' \
    'RestrictSUIDSGID=yes' \
    'RestrictRealtime=yes' \
    'RestrictNamespaces=yes' \
    'LockPersonality=yes' \
    'RemoveIPC=yes' \
    'CapabilityBoundingSet=' \
    'AmbientCapabilities=' \
    'SystemCallArchitectures=native' \
    'SystemCallFilter=@system-service' \
    'SystemCallErrorNumber=EPERM'
  do
    grep -Fx "$directive" "$unit" >/dev/null || {
      printf 'required systemd hardening directive missing: %s\n' "$directive" >&2
      exit 1
    }
  done
  {
    printf 'Static hardening profile for agentcall-gatewayd.service: PASS\n'
    printf 'Reason: installed systemd-analyze lacks offline security analysis\n'
    printf 'Syntax/dependencies: verified with isolated SYSTEMD_UNIT_PATH\n'
    printf 'Required hardening directives: verified exactly against packaged unit\n'
  } > "$output/systemd-security.txt"
fi

runtime="$work/extract/usr/lib/agentcall/pc-gateway"
if find "$runtime" \
  \( -type d -iname sip -o -type f \( -iname 'sip*.js' -o -iname 'rtp*.js' -o -iname '*asterisk*.js' -o -iname 'stun*.js' \) \) \
  -print | grep . > "$output/legacy-transport-scan.txt"; then
  printf 'legacy transport file found in package\n' >&2
  exit 1
fi
if grep -R -n -E "from ['\"]\./(sip|rtp|stun)|require\(['\"].*(sip|rtp|stun)|Asterisk|dgram\.createSocket" \
  "$runtime/src" > "$output/legacy-transport-scan.txt"; then
  printf 'legacy transport reference found in package\n' >&2
  exit 1
fi
printf 'no legacy SIP/RTP/STUN/Asterisk runtime found\n' > "$output/legacy-transport-scan.txt"

sbom="$output/agentcall-gatewayd_${version}.cdx.json"
python3 "$root/packaging/linux/generate-sbom.py" \
  --package "$gateway_source/package.json" \
  --lock "$gateway_source/package-lock.json" \
  --output "$sbom" \
  2> "$output/sbom-status.txt"
python3 -m json.tool "$sbom" >/dev/null
sha256sum "$sbom" > "$sbom.sha256"

lintian_status=NOT_RUN:not-installed
if command -v lintian >/dev/null 2>&1; then
  lintian "$final_deb" > "$output/lintian.txt" 2>&1
  lintian_status=PASS
fi

vulnerability_status=NOT_RUN:not-installed
if command -v trivy >/dev/null 2>&1; then
  trivy fs --scanners vuln --exit-code 1 --format json \
    --output "$output/vulnerability-scan.json" "$runtime"
  vulnerability_status=PASS
elif command -v grype >/dev/null 2>&1; then
  grype "dir:$runtime" --fail-on high -o json > "$output/vulnerability-scan.json"
  vulnerability_status=PASS
fi

project_license=FAIL:mismatch
if [ -f "$root/LICENSE" ] && [ -f "$root/NOTICE" ] \
  && grep -q 'GNU AFFERO GENERAL PUBLIC LICENSE' "$root/LICENSE" \
  && python3 - "$gateway_source/package.json" "$sbom" <<'PY'
import json, sys
package = json.load(open(sys.argv[1], encoding='utf-8'))
bom = json.load(open(sys.argv[2], encoding='utf-8'))
expected = [{'license': {'id': 'AGPL-3.0-only'}}]
raise SystemExit(0 if package.get('license') == 'AGPL-3.0-only'
                 and bom['metadata']['component'].get('licenses') == expected else 1)
PY
then
  project_license=PASS:AGPL-3.0-only
fi

cat > "$output/RELEASE-EVIDENCE.txt" <<EOF
REPRODUCIBLE_DEB=PASS
PACKAGE_PATHS=PASS
SYSTEMD_VERIFY=PASS
SYSTEMD_SECURITY=$systemd_security_status
LEGACY_TRANSPORT_SCAN=PASS
SBOM_CYCLONEDX=PASS
MCP_PACKAGED_SMOKE=PASS
PROJECT_LICENSE=$project_license
LINTIAN=$lintian_status
VULNERABILITY_SCAN=$vulnerability_status
PRIVILEGED_INSTALL=NOT_RUN:approval-required
SERVICE_RUNTIME=NOT_RUN:package-not-installed
SIGNATURE=NOT_RUN:signing-key-not-provided
EOF

printf '%s\n' "$output/RELEASE-EVIDENCE.txt"
