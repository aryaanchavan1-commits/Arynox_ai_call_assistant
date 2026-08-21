#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT INT TERM
version=$(node -p "require('$root/pc/pc-gateway/ui/package.json').version")
deb=

if [ "$#" -gt 0 ]; then
  [ "$#" -eq 2 ] && [ "$1" = --deb ] || {
    printf 'usage: %s [--deb PATH]\n' "$0" >&2
    exit 2
  }
  deb=$2
else
  "$root/packaging/linux/build-unified-desktop-deb.sh" \
    --output "$tmp/out" \
    --version "$version" >/dev/null
  deb="$tmp/out/agentcall-desktop-${version}-amd64.deb"
fi

[ -f "$deb" ]
[ "$(dpkg-deb --field "$deb" Package)" = agentcall-desktop ]
[ "$(dpkg-deb --field "$deb" Version)" = "$version" ]
[ "$(dpkg-deb --field "$deb" Architecture)" = amd64 ]

depends=$(dpkg-deb --field "$deb" Depends)
printf '%s\n' "$depends" | grep -F 'nodejs (>= 20)' >/dev/null
printf '%s\n' "$depends" | grep -F 'android-tools-adb' >/dev/null
printf '%s\n' "$depends" | grep -F 'ffmpeg' >/dev/null
if printf '%s\n' "$depends" | grep -F 'agentcall-gatewayd' >/dev/null; then
  printf 'unified desktop must not depend on the old split gateway package\n' >&2
  exit 1
fi

[ "$(dpkg-deb --field "$deb" Provides)" = "agentcall-gatewayd (= $version)" ]
[ "$(dpkg-deb --field "$deb" Replaces)" = agentcall-gatewayd ]
[ "$(dpkg-deb --field "$deb" Conflicts)" = agentcall-gatewayd ]

dpkg-deb --extract "$deb" "$tmp/root"
dpkg-deb --control "$deb" "$tmp/control"

cr=$(printf '\r')
if grep -rIl "$cr" \
    "$tmp/root/usr/lib/agentcall/bin" \
    "$tmp/root/usr/lib/systemd/system" \
    "$tmp/root/usr/lib/udev/rules.d" \
    "$tmp/root/usr/lib/sysusers.d" \
    "$tmp/root/usr/lib/tmpfiles.d" \
    "$tmp/root/usr/share/doc/agentcall-gatewayd" \
    "$tmp/root/usr/share/agentcall"; then
  printf 'Linux package contains CRLF service payloads\n' >&2
  exit 1
fi

test -x "$tmp/root/opt/Arynox AI Call Assistant/agentcall-desktop"
grep -F "update-alternatives --install '/usr/bin/agentcall-desktop'" "$tmp/control/postinst" >/dev/null
test -L "$tmp/root/usr/bin/agentcall-gatewayd"
test -L "$tmp/root/usr/bin/agentcall-mcp"
test -x "$tmp/root/usr/lib/agentcall/bin/agentcall-gatewayd"
test -x "$tmp/root/usr/lib/agentcall/bin/agentcall-mcp"
test -x "$tmp/root/usr/lib/agentcall/bin/agentcall-enroll-operator"
test -L "$tmp/root/usr/bin/agentcall-enroll-operator"
for command in mcp health logs recorder-health backup-state restore-state enroll-operator; do
  test -L "$tmp/root/usr/bin/agentcall-$command"
  [ "$(readlink "$tmp/root/usr/bin/agentcall-$command")" = "/usr/lib/agentcall/bin/agentcall-$command" ]
done
test -f "$tmp/root/usr/lib/agentcall/pc-gateway/src/gatewayd.js"
test -f "$tmp/root/usr/lib/agentcall/pc-gateway/src/provider-speech-test.js"
grep -F "action:provider-test" "$tmp/root/opt/Arynox AI Call Assistant/resources/app.asar.unpacked/electron/preload.cjs" >/dev/null 2>&1 || {
  # Electron normally packs preload into app.asar; inspect it without extracting files.
  node - "$root/pc/pc-gateway/ui/node_modules/@electron/asar" \
    "$tmp/root/opt/Arynox AI Call Assistant/resources/app.asar" "$tmp/preload.cjs" <<'NODE'
const [modulePath, archivePath, outputPath] = process.argv.slice(2);
const { writeFileSync } = require('node:fs');
const { extractFile } = require(modulePath);
writeFileSync(outputPath, extractFile(archivePath, 'electron/preload.cjs'));
NODE
  grep -F "action:provider-test" "$tmp/preload.cjs" >/dev/null
}
test -f "$tmp/root/usr/lib/systemd/system/agentcall-gatewayd.service"
test -f "$tmp/root/usr/lib/sysusers.d/agentcall.conf"
test -f "$tmp/root/usr/lib/tmpfiles.d/agentcall.conf"
tmpfiles="$tmp/root/usr/lib/tmpfiles.d/agentcall.conf"
grep -Fx 'd /var/lib/agentcall/adb 0700 agentcall agentcall -' "$tmpfiles" >/dev/null
grep -Fx 'd /var/lib/agentcall/controller 0700 agentcall agentcall -' "$tmpfiles" >/dev/null

# The daemon gets access only to the exact qualified POCO M2 Pro ADB USB
# identity, never broad plugdev membership or a world-writable USB node.
udev_rule="$tmp/root/usr/lib/udev/rules.d/70-agentcall-poco-m2-pro.rules"
test -f "$udev_rule"
grep -Fx 'SUBSYSTEM=="usb", ENV{DEVTYPE}=="usb_device", ATTR{idVendor}=="18d1", ATTR{idProduct}=="4ee2", GROUP="agentcall", MODE="0660", TAG+="uaccess"' "$udev_rule" >/dev/null
grep -Fx 'SUBSYSTEM=="usb", ENV{DEVTYPE}=="usb_device", ATTR{idVendor}=="18d1", ATTR{idProduct}=="4ee7", GROUP="agentcall", MODE="0660", TAG+="uaccess"' "$udev_rule" >/dev/null
test "$(grep -c '^SUBSYSTEM=="usb"' "$udev_rule")" -eq 2
if grep -E 'MODE="0666"|GROUP="plugdev"' "$udev_rule"; then
  printf 'qualified phone udev rule must remain exact and group-restricted\n' >&2
  exit 1
fi

# Systemd supplies safe first-run defaults and then applies the optional
# administrator override. Matched release identity comes from the packaged
# canonical manifest rather than duplicated environment fields.
service="$tmp/root/usr/lib/systemd/system/agentcall-gatewayd.service"
grep -Fx 'Environment=AGENTCALL_MATCHED_ARTIFACT_FILE=/usr/share/agentcall/protocol/matched-artifact.properties' "$service" >/dev/null
grep -Fx 'Environment=AGENTCALL_CONTROLLER_SECRET_FILE=/var/lib/agentcall/controller/controller.key' "$service" >/dev/null
grep -Fx 'Environment=AGENTCALL_REDACTION_SALT_FILE=/var/lib/agentcall/redaction-salt' "$service" >/dev/null
grep -Fx 'EnvironmentFile=-/etc/agentcall/gateway.env' "$service" >/dev/null
launcher="$tmp/root/usr/lib/agentcall/bin/agentcall-gatewayd"
grep -F 'unset ADB_VENDOR_KEYS AGENTCALL_DEVICE_SERIAL AGENTCALL_DEVICE_FINGERPRINT' "$launcher" >/dev/null

test -f "$tmp/root/usr/share/doc/agentcall-gatewayd/gateway.env.example"
example="$tmp/root/usr/share/doc/agentcall-gatewayd/gateway.env.example"
grep -Fx 'AGENTCALL_ADB_HOME=/var/lib/agentcall/adb' "$example" >/dev/null
grep -Fx 'AGENTCALL_ADB_SERVER_SOCKET=tcp:127.0.0.1:15037' "$example" >/dev/null
grep -Fx 'AGENTCALL_CONTROLLER_SECRET_FILE=/var/lib/agentcall/controller/controller.key' "$example" >/dev/null
grep -F 'authenticated bootstrap protocol' "$example" >/dev/null
if grep -E '^(ADB_VENDOR_KEYS|AGENTCALL_DEVICE_SERIAL|AGENTCALL_DEVICE_FINGERPRINT)=|credential shown once' "$example"; then
  printf 'packaged example still instructs legacy manual pairing\n' >&2
  exit 1
fi
test -f "$tmp/root/usr/share/agentcall/protocol/g2-v1.properties"
test -f "$tmp/root/usr/share/agentcall/protocol/matched-artifact.properties"
cmp "$root/protocol/matched-artifact.properties" \
  "$tmp/root/usr/share/agentcall/protocol/matched-artifact.properties"
! grep -F 'REPLACE_WITH_' "$tmp/root/usr/share/doc/agentcall-gatewayd/gateway.env.example" >/dev/null
grep -F 'AGENTCALL_MATCHED_ARTIFACT_FILE' "$tmp/root/usr/lib/systemd/system/agentcall-gatewayd.service" >/dev/null
grep -F 'EnvironmentFile=-/etc/agentcall/gateway.env' "$tmp/root/usr/lib/systemd/system/agentcall-gatewayd.service" >/dev/null
grep -F 'zero_touch=true' "$tmp/root/usr/lib/agentcall/bin/agentcall-preflight" >/dev/null
grep -Fx 'MemoryDenyWriteExecute=no' "$tmp/root/usr/lib/systemd/system/agentcall-gatewayd.service" >/dev/null
grep -Fx 'DeviceAllow=char-usb_device rw' "$tmp/root/usr/lib/systemd/system/agentcall-gatewayd.service" >/dev/null
if grep -Fx 'MemoryDenyWriteExecute=yes' "$tmp/root/usr/lib/systemd/system/agentcall-gatewayd.service" >/dev/null; then
  printf 'Node gateway service cannot use MemoryDenyWriteExecute=yes\n' >&2
  exit 1
fi

# Installation must provision the service and leave it running or truthfully
# waiting for one phone-side Start. It may enroll only the verified invoking
# desktop operator through the hardened helper and must not create credentials.
if grep -E 'controller\.key|ssh-keygen|adb keygen|(^|[;&|[:space:]])usermod[[:space:]]' "$tmp/control/postinst"; then
  printf 'unsafe credential setup entered unified postinst\n' >&2
  exit 1
fi
grep -F 'systemd-sysusers' "$tmp/control/postinst" >/dev/null
grep -F 'chown root:agentcall /etc/agentcall' "$tmp/control/postinst" >/dev/null
grep -F 'chmod 0750 /etc/agentcall' "$tmp/control/postinst" >/dev/null
grep -F 'systemd-tmpfiles' "$tmp/control/postinst" >/dev/null
grep -F 'invoking=${SUDO_USER:-}' "$tmp/control/postinst" >/dev/null
grep -F '[ -n "$invoking" ] || invoking=$(logname 2>/dev/null || true)' "$tmp/control/postinst" >/dev/null
grep -F '/usr/lib/agentcall/bin/agentcall-enroll-operator "$invoking"' "$tmp/control/postinst" >/dev/null
grep -F 'set -e' "$tmp/control/postinst" >/dev/null
grep -F 'systemctl daemon-reload' "$tmp/control/postinst" >/dev/null
grep -F 'systemctl enable agentcall-gatewayd.service' "$tmp/control/postinst" >/dev/null
grep -F 'systemctl restart agentcall-gatewayd.service' "$tmp/control/postinst" >/dev/null
! grep -F 'systemctl try-restart agentcall-gatewayd.service' "$tmp/control/postinst" >/dev/null
! grep -E 'systemd-(sysusers|tmpfiles).*\|\| true|systemctl (daemon-reload|enable|restart|try-restart).*\|\| true' "$tmp/control/postinst" >/dev/null
grep -F 'gateway.env.pre-zero-touch' "$tmp/control/postinst" >/dev/null
grep -F 'AGENTCALL_DEVICE_SERIAL' "$tmp/control/postinst" >/dev/null
grep -F 'AGENTCALL_CONTROLLER_CREDENTIAL_FILE' "$tmp/control/postinst" >/dev/null
grep -F 'await chmod(this.socketPath, 0o660)' "$tmp/root/usr/lib/agentcall/pc-gateway/src/gateway-rpc.js" >/dev/null
grep -F 'systemctl stop agentcall-gatewayd.service' "$tmp/control/prerm" >/dev/null
grep -F 'Preserve /etc/agentcall and /var/lib/agentcall' "$tmp/control/postrm" >/dev/null

# The MCP launcher in the same package must reach the packaged server source.
node "$root/packaging/linux/test-packaged-mcp.mjs" "$tmp/root" >/dev/null

printf 'unified-desktop-package-ok\n'
