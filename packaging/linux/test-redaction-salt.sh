#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
validator=$root/packaging/linux/bin/agentcall-validate-redaction-salt
preflight=$root/packaging/linux/bin/agentcall-preflight

python3 -c 'import ast, pathlib, sys; ast.parse(pathlib.Path(sys.argv[1]).read_text())' "$validator"
grep -F '/usr/lib/agentcall/bin/agentcall-validate-redaction-salt "$AGENTCALL_REDACTION_SALT_FILE"' "$preflight" >/dev/null

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT INT TERM
accept() { "$validator" "$1" >/dev/null 2>&1 || { printf 'expected accepted salt: %s\n' "$1" >&2; exit 1; }; }
reject() { if "$validator" "$1" >/dev/null 2>&1; then printf 'expected rejected salt: %s\n' "$1" >&2; exit 1; fi; }

python3 - "$tmp" <<'PY'
from pathlib import Path
import sys
p=Path(sys.argv[1])
(p/'min').write_bytes(b'x'*16)
(p/'min-lf').write_bytes(b'x'*16+b'\n')
(p/'max').write_bytes(b'x'*4096)
(p/'max-lf').write_bytes(b'x'*4096+b'\n')
(p/'short-lf').write_bytes(b'x'*15+b'\n')
(p/'long').write_bytes(b'x'*4097)
(p/'embedded-lf').write_bytes(b'valid-redaction\nsalt')
(p/'embedded-cr').write_bytes(b'valid-redaction\rsalt')
(p/'invalid-utf8').write_bytes(b'x'*16+b'\xff')
PY
accept "$tmp/min"
accept "$tmp/min-lf"
accept "$tmp/max"
accept "$tmp/max-lf"
reject "$tmp/short-lf"
reject "$tmp/long"
reject "$tmp/embedded-lf"
reject "$tmp/embedded-cr"
reject "$tmp/invalid-utf8"
printf 'redaction-salt-package-ok\n'
