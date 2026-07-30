#!/bin/sh
set -eu

version=1.0.0
arch=all
gateway_source=
output=
script_root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)

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
[ "$(realpath -e "$gateway_source")" = "$script_root/pc/pc-gateway" ] || {
  printf 'gateway source must be the canonical checkout runtime\n' >&2
  exit 1
}
manifest_version=$(sed -n 's/^desktopPackageVersion=//p' "$script_root/protocol/matched-artifact.properties")
[ -n "$manifest_version" ] && [ "$version" = "$manifest_version" ] || {
  printf 'Debian version must match canonical artifact manifest\n' >&2
  exit 1
}
[ -f "$gateway_source/package.json" ] || { printf 'missing gateway package.json\n' >&2; exit 1; }
[ -f "$gateway_source/src/gatewayd.js" ] || { printf 'missing executable gatewayd.js\n' >&2; exit 1; }
[ -f "$gateway_source/src/mcp-server.js" ] || { printf 'missing executable mcp-server.js\n' >&2; exit 1; }
[ -f LICENSE ] || { printf 'missing root LICENSE\n' >&2; exit 1; }
[ -f NOTICE ] || { printf 'missing root NOTICE\n' >&2; exit 1; }
[ -f THIRD_PARTY_NOTICES.md ] || { printf 'missing third-party notices\n' >&2; exit 1; }
[ -f packaging/linux/copyright ] || { printf 'missing Debian copyright file\n' >&2; exit 1; }
[ "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1], encoding="utf-8")).get("license", ""))' "$gateway_source/package.json")" = AGPL-3.0-only ] || {
  printf 'gateway package license must be AGPL-3.0-only\n' >&2
  exit 1
}

case "$version" in ''|*[!A-Za-z0-9.+:~_-]*) printf 'invalid version\n' >&2; exit 1;; esac

# Validate source before copying. No install, ADB, device, provider, or network action.
( cd "$gateway_source" && npm test && npm run check )

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT INT TERM
root=$work/root
pkg=agentcall-gatewayd_${version}_${arch}.deb
mkdir -p "$root/DEBIAN" \
  "$root/usr/lib/agentcall/pc-gateway" \
  "$root/usr/lib/agentcall/bin" \
  "$root/usr/bin" \
  "$root/usr/lib/systemd/system" \
  "$root/usr/lib/udev/rules.d" \
  "$root/usr/lib/sysusers.d" \
  "$root/usr/lib/tmpfiles.d" \
  "$root/usr/share/doc/agentcall-gatewayd" \
  "$root/usr/share/agentcall/udev" \
  "$root/usr/share/agentcall/protocol" \
  "$root/etc/agentcall"

cp -R "$gateway_source/src" "$gateway_source/package.json" "$gateway_source/package-lock.json" "$root/usr/lib/agentcall/pc-gateway/"
mkdir -p "$root/usr/lib/agentcall/pc-gateway/scripts"
cp \
  "$gateway_source/scripts/simulator-soak.js" \
  "$gateway_source/scripts/hermes-voice-supervisor.js" \
  "$root/usr/lib/agentcall/pc-gateway/scripts/"
(
  cd "$root/usr/lib/agentcall/pc-gateway"
  npm ci --omit=dev --ignore-scripts --no-audit --no-fund
  node -e "import('./src/gatewayd.js')"
)
cp packaging/linux/bin/* "$root/usr/lib/agentcall/bin/"
# Manual controller-secret entry is retired. The historical helper remains in
# source for migration archaeology but must never enter a production package;
# authenticated ADB bootstrap owns credential creation and persistence.
rm -f "$root/usr/lib/agentcall/bin/agentcall-enroll-controller"
cp packaging/linux/systemd/agentcall-gatewayd.service "$root/usr/lib/systemd/system/"
cp packaging/linux/udev/70-agentcall-poco-m2-pro.rules "$root/usr/lib/udev/rules.d/"
cp packaging/linux/sysusers.d/agentcall.conf "$root/usr/lib/sysusers.d/"
cp packaging/linux/tmpfiles.d/agentcall.conf "$root/usr/lib/tmpfiles.d/"
cp packaging/linux/config/gateway.env.example "$root/usr/share/doc/agentcall-gatewayd/"
cp packaging/linux/udev/70-agentcall-android.rules.example "$root/usr/share/agentcall/udev/"
cp protocol/g2-v1.properties "$root/usr/share/agentcall/protocol/"
cp protocol/matched-artifact.properties "$root/usr/share/agentcall/protocol/"
cp packaging/linux/README.md "$root/usr/share/doc/agentcall-gatewayd/README.md"
cp LICENSE "$root/usr/share/doc/agentcall-gatewayd/LICENSE"
cp NOTICE "$root/usr/share/doc/agentcall-gatewayd/NOTICE"
cp THIRD_PARTY_NOTICES.md "$root/usr/share/doc/agentcall-gatewayd/THIRD_PARTY_NOTICES.md"
cp packaging/linux/copyright "$root/usr/share/doc/agentcall-gatewayd/copyright"
ln -s /usr/lib/agentcall/bin/agentcall-gatewayd "$root/usr/bin/agentcall-gatewayd"
ln -s /usr/lib/agentcall/bin/agentcall-mcp "$root/usr/bin/agentcall-mcp"
ln -s /usr/lib/agentcall/bin/agentcall-health "$root/usr/bin/agentcall-health"
ln -s /usr/lib/agentcall/bin/agentcall-recorder-health "$root/usr/bin/agentcall-recorder-health"
ln -s /usr/lib/agentcall/bin/agentcall-logs "$root/usr/bin/agentcall-logs"
ln -s /usr/lib/agentcall/bin/agentcall-backup-state "$root/usr/bin/agentcall-backup-state"
ln -s /usr/lib/agentcall/bin/agentcall-restore-state "$root/usr/bin/agentcall-restore-state"
ln -s /usr/lib/agentcall/bin/agentcall-simulator-soak "$root/usr/bin/agentcall-simulator-soak"
ln -s /usr/lib/agentcall/bin/agentcall-enroll-operator "$root/usr/bin/agentcall-enroll-operator"
cp packaging/linux/UPGRADE-ROLLBACK.md "$root/usr/share/doc/agentcall-gatewayd/"

# Git worktrees created on Windows may expose CRLF even for Linux-only payloads.
# Normalize every staged executable/configuration/document after all copies so
# shebangs and exact systemd/tmpfiles/udev directives remain valid on Linux.
find \
  "$root/usr/lib/agentcall/bin" \
  "$root/usr/lib/systemd/system" \
  "$root/usr/lib/udev/rules.d" \
  "$root/usr/lib/sysusers.d" \
  "$root/usr/lib/tmpfiles.d" \
  "$root/usr/share/doc/agentcall-gatewayd" \
  "$root/usr/share/agentcall" \
  -type f -exec sed -i 's/\r$//' {} +

chmod 0755 "$root/usr/lib/agentcall/bin/"*
find "$root" -type d -exec chmod 0755 {} \;
chmod 0750 "$root/etc/agentcall"
find "$root/usr/lib/agentcall/pc-gateway" -type f -exec chmod 0644 {} \;
chmod 0755 \
  "$root/usr/lib/agentcall/pc-gateway/src/gatewayd.js" \
  "$root/usr/lib/agentcall/pc-gateway/src/mcp-server.js" \
  "$root/usr/lib/agentcall/pc-gateway/scripts/simulator-soak.js" \
  "$root/usr/lib/agentcall/pc-gateway/scripts/hermes-voice-supervisor.js"
chmod 0644 \
  "$root/usr/lib/systemd/system/agentcall-gatewayd.service" \
  "$root/usr/lib/udev/rules.d/70-agentcall-poco-m2-pro.rules" \
  "$root/usr/lib/sysusers.d/agentcall.conf" \
  "$root/usr/lib/tmpfiles.d/agentcall.conf" \
  "$root/usr/share/doc/agentcall-gatewayd/README.md" \
  "$root/usr/share/doc/agentcall-gatewayd/UPGRADE-ROLLBACK.md" \
  "$root/usr/share/doc/agentcall-gatewayd/gateway.env.example" \
  "$root/usr/share/doc/agentcall-gatewayd/LICENSE" \
  "$root/usr/share/doc/agentcall-gatewayd/NOTICE" \
  "$root/usr/share/doc/agentcall-gatewayd/THIRD_PARTY_NOTICES.md" \
  "$root/usr/share/doc/agentcall-gatewayd/copyright" \
  "$root/usr/share/agentcall/udev/70-agentcall-android.rules.example" \
  "$root/usr/share/agentcall/protocol/g2-v1.properties" \
  "$root/usr/share/agentcall/protocol/matched-artifact.properties"

cat > "$root/DEBIAN/control" <<EOF
Package: agentcall-gatewayd
Version: $version
Section: comm
Priority: optional
Architecture: $arch
Depends: nodejs (>= 20), python3, android-tools-adb, ffmpeg
Maintainer: sidinsearch <siddhushinde788@gmail.com>
Description: USB-only local cellular agent gateway
 Linux gateway daemon and stdio MCP boundary for an ADB-forwarded,
 loopback-only Android cellular gateway. Hardware mode remains fail-closed
 until exact identity and mandatory recording health are configured.
EOF

cat > "$root/DEBIAN/postinst" <<'EOF'
#!/bin/sh
set -e
# Deliberately do not enable/start the service or create ADB keys/config.
systemd-sysusers /usr/lib/sysusers.d/agentcall.conf
chown root:agentcall /etc/agentcall
chmod 0750 /etc/agentcall
systemd-tmpfiles --create /usr/lib/tmpfiles.d/agentcall.conf
exit 0
EOF
cat > "$root/DEBIAN/prerm" <<'EOF'
#!/bin/sh
set -e
if [ "$1" = remove ] || [ "$1" = deconfigure ]; then
  systemctl stop agentcall-gatewayd.service >/dev/null 2>&1 || true
fi
exit 0
EOF
cat > "$root/DEBIAN/postrm" <<'EOF'
#!/bin/sh
set -e
# Preserve /etc/agentcall and /var/lib/agentcall. Purge is an explicit admin step.
systemctl daemon-reload >/dev/null 2>&1 || true
exit 0
EOF
chmod 0755 "$root/DEBIAN/postinst" "$root/DEBIAN/prerm" "$root/DEBIAN/postrm"
chmod 0644 "$root/DEBIAN/control"

# Normalize mtimes for reproducible archive metadata. Callers may pin an exact
# source revision timestamp; zero is a deterministic safe default for the harness.
epoch=${SOURCE_DATE_EPOCH:-0}
find "$root" -exec touch -h -d "@$epoch" {} +

# Fail if legacy runtime modules or listeners accidentally enter the package.
# Do not match the product name "agentcall" itself.
if find "$root/usr/lib/agentcall/pc-gateway" \
  \( -type d -iname sip -o -type f \( -iname 'sip*.js' -o -iname 'rtp*.js' -o -iname '*asterisk*.js' -o -iname 'stun*.js' \) \) \
  -print | grep .; then
  printf 'legacy transport file found in staged runtime\n' >&2
  exit 1
fi
if grep -R -n -E "from ['\"]\./(sip|rtp|stun)|require\(['\"].*(sip|rtp|stun)|Asterisk|dgram\.createSocket" \
  "$root/usr/lib/agentcall/pc-gateway/src"; then
  printf 'legacy transport reference found in staged runtime\n' >&2
  exit 1
fi

mkdir -p "$output"
dpkg-deb --root-owner-group --build "$root" "$output/$pkg" >/dev/null
dpkg-deb --contents "$output/$pkg" > "$output/$pkg.contents.txt"
dpkg-deb --info "$output/$pkg" > "$output/$pkg.info.txt"
sha256sum "$output/$pkg" > "$output/$pkg.sha256"
( cd "$root" && find . -type f -print0 | sort -z | xargs -0 sha256sum ) > "$output/$pkg.payload.sha256"
printf '%s\n' "$output/$pkg"
