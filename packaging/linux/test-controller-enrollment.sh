#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
preflight=$root/packaging/linux/bin/agentcall-preflight
env_example=$root/packaging/linux/config/gateway.env.example
builder=$root/packaging/linux/build-deb.sh
readme=$root/packaging/linux/README.md
install_doc=$root/docs/INSTALL.md

sh -n "$preflight"
sh -n "$builder"

grep -F 'rm -f "$root/usr/lib/agentcall/bin/agentcall-enroll-controller"' "$builder" >/dev/null
if grep -F 'ln -s /usr/lib/agentcall/bin/agentcall-enroll-controller' "$builder"; then
  printf 'manual controller enrollment command must not be packaged\n' >&2
  exit 1
fi
grep -Fx 'AGENTCALL_ADB_HOME=/var/lib/agentcall/adb' "$env_example" >/dev/null
grep -Fx 'AGENTCALL_ADB_SERVER_SOCKET=tcp:127.0.0.1:15037' "$env_example" >/dev/null
grep -Fx 'AGENTCALL_CONTROLLER_SECRET_FILE=/var/lib/agentcall/controller/controller.key' "$env_example" >/dev/null
grep -F 'authenticated bootstrap protocol' "$env_example" >/dev/null
grep -F 'No manual controller-enrollment command is shipped.' "$readme" >/dev/null
if grep -E '^(ADB_VENDOR_KEYS|AGENTCALL_DEVICE_SERIAL|AGENTCALL_DEVICE_FINGERPRINT)=|credential shown once|type that value' "$env_example" "$readme"; then
  printf 'manual pairing instructions must not be shipped\n' >&2
  exit 1
fi
grep -F 'No Arynox credential is displayed, copied or typed.' "$install_doc" >/dev/null
grep -F 'Package installation already enables and starts the offline-capable service.' "$install_doc" >/dev/null
if grep -E 'agentcall-enroll-controller|Enroll the Linux controller|AGENTCALL_DEVICE_SERIAL=EXACT|AGENTCALL_DEVICE_FINGERPRINT=EXACT|ADB_VENDOR_KEYS=/etc/agentcall/adbkey|credential once' "$install_doc"; then
  printf 'installation guide still instructs legacy manual pairing\n' >&2
  exit 1
fi
grep -F 'AGENTCALL_MODE:-hardware' "$preflight" >/dev/null
grep -F 'configuration directory must be owned by root:agentcall' "$preflight" >/dev/null
grep -F 'configuration directory mode must be exactly 0750' "$preflight" >/dev/null
grep -F 'AGENTCALL_REDACTION_SALT_FILE is required' "$preflight" >/dev/null
grep -F 'redaction salt must be a regular non-symlink file' "$preflight" >/dev/null
grep -F 'redaction salt must be owned by root:agentcall' "$preflight" >/dev/null
grep -F 'redaction salt mode must be exactly 0640' "$preflight" >/dev/null
grep -F 'controller secret must contain exactly 32 bytes' "$preflight" >/dev/null
! grep -F 'REPLACE_WITH_' "$env_example" >/dev/null
grep -F 'AGENTCALL_MATCHED_ARTIFACT_FILE' "$env_example" >/dev/null
grep -F 'zero_touch=false' "$preflight" >/dev/null
grep -F 'zero_touch=true' "$preflight" >/dev/null
grep -F 'controller credential state is unsafe' "$preflight" >/dev/null
! grep -F 'AGENTCALL_SIMULATOR' "$preflight" >/dev/null

printf 'zero-touch-controller-package-ok\n'
