#!/usr/bin/env python3
"""Generate a deterministic CycloneDX SBOM from npm package + lock files."""

import argparse
import json
import sys
from pathlib import Path
from urllib.parse import quote


def license_entry(value):
    if not value:
        return {"license": {"name": "NOASSERTION"}}
    return {"license": {"id": value}}


def package_name(path, package):
    name = package.get("name")
    if name:
        return name
    return path.removeprefix("node_modules/").split("/node_modules/")[-1]


def purl(name, version):
    encoded = "/".join(quote(part, safe="") for part in name.split("/"))
    return f"pkg:npm/{encoded}@{quote(version, safe='')}"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--package", required=True, type=Path)
    parser.add_argument("--lock", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()

    package = json.loads(args.package.read_text(encoding="utf-8"))
    lock = json.loads(args.lock.read_text(encoding="utf-8"))
    project_license = package.get("license")
    if not project_license:
        print("PROJECT_LICENSE_MISSING", file=sys.stderr)

    components = []
    for path, locked in sorted(lock.get("packages", {}).items()):
        if path == "" or "version" not in locked:
            continue
        name = package_name(path, locked)
        version = str(locked["version"])
        component = {
            "type": "library",
            "bom-ref": purl(name, version),
            "name": name,
            "version": version,
            "purl": purl(name, version),
            "licenses": [license_entry(locked.get("license"))],
        }
        integrity = locked.get("integrity")
        if integrity:
            component["properties"] = [{"name": "npm:integrity", "value": integrity}]
        components.append(component)

    name = package["name"]
    version = str(package["version"])
    document = {
        "bomFormat": "CycloneDX",
        "specVersion": "1.5",
        "version": 1,
        "metadata": {
            "component": {
                "type": "application",
                "bom-ref": purl(name, version),
                "name": name,
                "version": version,
                "purl": purl(name, version),
                "licenses": [license_entry(project_license)],
            },
            "tools": [{
                "vendor": "agentcall",
                "name": "generate-sbom.py",
                "version": "1",
            }],
        },
        "components": components,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(document, indent=2, sort_keys=True, ensure_ascii=True) + "\n",
        encoding="utf-8",
    )


if __name__ == "__main__":
    main()
