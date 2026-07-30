#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
helper=$root/packaging/linux/bin/agentcall-enroll-operator
service=$root/packaging/linux/systemd/agentcall-gatewayd.service
tmpfiles=$root/packaging/linux/tmpfiles.d/agentcall.conf
builder=$root/packaging/linux/build-deb.sh
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT INT TERM

sh -n "$helper"
grep -F '[ "$(id -u)" -eq 0 ]' "$helper" >/dev/null
grep -F '[ "$#" -eq 1 ]' "$helper" >/dev/null
grep -F 'getent passwd' "$helper" >/dev/null
grep -F 'usermod -a -G agentcall' "$helper" >/dev/null
grep -F 'operator access becomes active after a new login session' "$helper" >/dev/null
for forbidden in 'controller.key' 'API_KEY' 'SECRET=' 'chpasswd ' '; passwd '; do
  if grep -F "$forbidden" "$helper" >/dev/null; then
    printf 'operator enrollment must not handle credentials\n' >&2
    exit 1
  fi
done

grep -Fx 'RuntimeDirectoryMode=0750' "$service" >/dev/null
grep -Fx 'd /run/agentcall 0750 agentcall agentcall -' "$tmpfiles" >/dev/null
grep -F 'agentcall-enroll-operator' "$builder" >/dev/null

mkdir "$scratch/bin"
cat > "$scratch/bin/id" <<'EOF'
#!/bin/sh
[ "$1" = -u ] && { printf '0\n'; exit 0; }
exit 1
EOF
cat > "$scratch/bin/getent" <<'EOF'
#!/bin/sh
printf 'getent must not run for an invalid user name\n' >&2
exit 99
EOF
chmod 0755 "$scratch/bin/id" "$scratch/bin/getent"
if PATH="$scratch/bin:$PATH" sh "$helper" -operator >"$scratch/invalid.out" 2>"$scratch/invalid.err"; then
  printf 'leading-dash operator name unexpectedly succeeded\n' >&2
  exit 1
fi
grep -F 'user name is invalid' "$scratch/invalid.err" >/dev/null
if grep -F 'getent must not run' "$scratch/invalid.err" >/dev/null; then
  printf 'invalid operator name reached NSS lookup\n' >&2
  exit 1
fi

if [ "$(id -u)" -eq 0 ]; then
  command -v setpriv >/dev/null 2>&1 || { printf 'setpriv is required for the non-root enrollment contract\n' >&2; exit 1; }
  cp "$helper" "$scratch/enroll"
  chmod 0755 "$scratch" "$scratch/enroll"
  setpriv --reuid=65534 --regid=65534 --clear-groups sh "$scratch/enroll" root >"$scratch/nonroot.out" 2>"$scratch/nonroot.err" && {
    printf 'unprivileged operator enrollment unexpectedly succeeded\n' >&2
    exit 1
  }
else
  sh "$helper" "$(id -un)" >"$scratch/nonroot.out" 2>"$scratch/nonroot.err" && {
    printf 'unprivileged operator enrollment unexpectedly succeeded\n' >&2
    exit 1
  }
fi
grep -F 'must run as root' "$scratch/nonroot.err" >/dev/null

printf 'operator-enrollment-package-ok\n'
