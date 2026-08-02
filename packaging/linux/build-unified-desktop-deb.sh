#!/bin/sh
set -eu

version=1.0.1
output=
root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)

usage() {
  printf 'usage: %s --output DIRECTORY [--version VERSION]\n' "$0" >&2
  exit 2
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --output) [ "$#" -ge 2 ] || usage; output=$2; shift 2 ;;
    --version) [ "$#" -ge 2 ] || usage; version=$2; shift 2 ;;
    *) usage ;;
  esac
done

[ -n "$output" ] || usage
case "$version" in ''|*[!A-Za-z0-9.+:~_-]*) printf 'invalid version\n' >&2; exit 1;; esac

ui="$root/pc/pc-gateway/ui"
gateway="$root/pc/pc-gateway"
[ "$(node -p "require('$ui/package.json').version")" = "$version" ] || {
  printf 'desktop package version must match unified package version\n' >&2
  exit 1
}

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT INT TERM
mkdir -p "$work/gateway" "$work/desktop" "$output"

(
  cd "$ui"
  npm test
  npm run check
  rm -rf dist
  npm run dist
)

base="$ui/dist/agentcall-desktop-${version}-amd64.deb"
[ -f "$base" ] || { printf 'missing desktop Debian base: %s\n' "$base" >&2; exit 1; }

(
  cd "$root"
  packaging/linux/build-deb.sh \
    --gateway-source "$gateway" \
    --output "$work/gateway" \
    --version "$version"
)

gateway_deb="$work/gateway/agentcall-gatewayd_${version}_all.deb"
[ -f "$gateway_deb" ] || { printf 'missing gateway Debian payload\n' >&2; exit 1; }

dpkg-deb --raw-extract "$base" "$work/desktop"
dpkg-deb --extract "$gateway_deb" "$work/gateway-root"
cp -a "$work/gateway-root/." "$work/desktop/"
mkdir -p "$work/desktop/etc/agentcall"
control="$work/desktop/DEBIAN/control"
cat > "$control" <<EOF
Package: agentcall-desktop
Version: $version
Architecture: amd64
Section: comm
Priority: optional
Maintainer: sidinsearch <siddhushinde788@gmail.com>
Homepage: https://github.com/sidinsearch/AgentCall
Depends: libgtk-3-0, libnss3, libasound2, nodejs (>= 20), python3, android-tools-adb, ffmpeg
Recommends: libappindicator3-1
Provides: agentcall-gatewayd (= $version)
Conflicts: agentcall-gatewayd
Replaces: agentcall-gatewayd
Description: Complete USB-only AgentCall desktop cellular gateway
 One installable desktop application containing the Electron operator UI,
 supervised gateway daemon, stdio MCP launcher, systemd unit, enrollment,
 health, backup and recovery helpers. The UI remains unprivileged and talks
 to gatewayd over the local group-restricted Unix socket.
EOF

postinst="$work/desktop/DEBIAN/postinst"
[ -f "$postinst" ] && grep -Eq '^#!.*/(ba)?sh$' "$postinst" || {
  printf 'unexpected electron postinst format\n' >&2
  exit 1
}
if grep -Eq '^[[:space:]]*exit([[:space:]]|$)' "$postinst"; then
  printf 'electron postinst contains an early exit\n' >&2
  exit 1
fi
cat >> "$postinst" <<'EOF'

# Provision the dedicated daemon and leave it enabled and running, or waiting
# truthfully for a phone. gatewayd alone creates private controller/salt state.
set -e
systemd-sysusers /usr/lib/sysusers.d/agentcall.conf
chown root:agentcall /etc/agentcall
chmod 0750 /etc/agentcall
systemd-tmpfiles --create /usr/lib/tmpfiles.d/agentcall.conf

# Preserve a positively identified legacy manual-pairing override before taking
# it out of the active environment path. Unknown administrator overrides and an
# existing rollback copy are never changed.
legacy_env=/etc/agentcall/gateway.env
legacy_backup=/etc/agentcall/gateway.env.pre-zero-touch
if [ -f "$legacy_env" ] && [ ! -L "$legacy_env" ] \
    && [ "$(stat -c '%u:%G:%a:%h' "$legacy_env")" = '0:agentcall:640:1' ] \
    && [ ! -e "$legacy_backup" ] && [ ! -L "$legacy_backup" ] \
    && awk '
      BEGIN { valid = 1; legacy = 0 }
      /^[[:space:]]*($|#)/ { next }
      /^(AGENTCALL_DEVICE_SERIAL|AGENTCALL_DEVICE_FINGERPRINT|ADB_VENDOR_KEYS)=.+/ { legacy = 1; next }
      /^(AGENTCALL_DEVICE_SERIAL|AGENTCALL_DEVICE_FINGERPRINT|ADB_VENDOR_KEYS|AGENTCALL_CONTROLLER_CREDENTIAL_FILE|AGENTCALL_CONTROLLER_SECRET_FILE|AGENTCALL_REDACTION_SALT_FILE)=/ { next }
      { valid = 0 }
      END { exit !(valid && legacy) }
    ' "$legacy_env"; then
  legacy_tmp=$legacy_backup.tmp.$$
  trap 'rm -f "$legacy_tmp"' EXIT HUP INT TERM
  install -o root -g root -m 0600 "$legacy_env" "$legacy_tmp"
  sync "$legacy_tmp"
  mv "$legacy_tmp" "$legacy_backup"
  sync -d /etc/agentcall
  rm "$legacy_env"
  sync -d /etc/agentcall
  trap - EXIT HUP INT TERM
fi

if command -v udevadm >/dev/null 2>&1; then
  udevadm control --reload-rules
  for product in 4ee2 4ee7; do
    udevadm trigger --subsystem-match=usb --attr-match=idVendor=18d1 --attr-match=idProduct=$product
  done
fi

invoking=${SUDO_USER:-}
[ -n "$invoking" ] || invoking=$(logname 2>/dev/null || true)
case "$invoking" in ''|root) ;; *)
  /usr/lib/agentcall/bin/agentcall-enroll-operator "$invoking" >/dev/null 2>&1 || true
;; esac

systemctl daemon-reload
systemctl enable agentcall-gatewayd.service
systemctl restart agentcall-gatewayd.service
exit 0
EOF

cat > "$work/desktop/DEBIAN/prerm" <<'EOF'
#!/bin/sh
set -e
if [ "$1" = remove ] || [ "$1" = deconfigure ] || [ "$1" = upgrade ]; then
  systemctl stop agentcall-gatewayd.service >/dev/null 2>&1 || true
fi
exit 0
EOF

cat >> "$work/desktop/DEBIAN/postrm" <<'EOF'

# Preserve /etc/agentcall and /var/lib/agentcall. Purge remains an explicit
# administrator action so removal cannot silently destroy credentials/history.
systemctl daemon-reload >/dev/null 2>&1 || true
EOF

chmod 0644 "$control"
chmod 0755 "$work/desktop/DEBIAN/postinst" "$work/desktop/DEBIAN/prerm" "$work/desktop/DEBIAN/postrm"

# electron-builder's checksum manifest predates the merged gateway payload.
# Regenerate it from the final package root.
(
  cd "$work/desktop"
  find . -path ./DEBIAN -prune -o -type f -print0 \
    | sort -z \
    | xargs -0 md5sum \
    | sed 's#  \./#  #' > DEBIAN/md5sums
)
chmod 0644 "$work/desktop/DEBIAN/md5sums"

# Normalize only the merged service payload. Electron's base package metadata
# is retained exactly as produced by electron-builder.
epoch=${SOURCE_DATE_EPOCH:-0}
find "$work/desktop/usr/lib/agentcall" \
     "$work/desktop/usr/lib/systemd/system/agentcall-gatewayd.service" \
     "$work/desktop/usr/lib/sysusers.d/agentcall.conf" \
     "$work/desktop/usr/lib/tmpfiles.d/agentcall.conf" \
     "$work/desktop/usr/share/agentcall" \
     -exec touch -h -d "@$epoch" {} +

final="$output/agentcall-desktop-${version}-amd64.deb"
dpkg-deb --root-owner-group --build "$work/desktop" "$final" >/dev/null
dpkg-deb --contents "$final" > "$final.contents.txt"
dpkg-deb --info "$final" > "$final.info.txt"
sha256sum "$final" > "$final.sha256"
printf '%s\n' "$final"
