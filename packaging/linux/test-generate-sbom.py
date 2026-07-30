#!/usr/bin/env python3
import json
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
GENERATOR = ROOT / "packaging/linux/generate-sbom.py"


class GenerateSbomTest(unittest.TestCase):
    def test_generates_deterministic_cyclonedx_from_locked_packages(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            package_json = tmp_path / "package.json"
            lock_json = tmp_path / "package-lock.json"
            output_a = tmp_path / "a.json"
            output_b = tmp_path / "b.json"
            package_json.write_text(json.dumps({
                "name": "example-gateway",
                "version": "1.2.3",
                "license": "AGPL-3.0-only",
            }))
            lock_json.write_text(json.dumps({
                "name": "example-gateway",
                "version": "1.2.3",
                "lockfileVersion": 3,
                "packages": {
                    "": {"name": "example-gateway", "version": "1.2.3"},
                    "node_modules/ws": {
                        "version": "8.21.1",
                        "integrity": "sha512-fixture",
                        "license": "MIT",
                    },
                },
            }))

            command = [
                "python3", str(GENERATOR),
                "--package", str(package_json),
                "--lock", str(lock_json),
                "--output", str(output_a),
            ]
            subprocess.run(command, check=True)
            command[-1] = str(output_b)
            subprocess.run(command, check=True)

            self.assertEqual(output_a.read_bytes(), output_b.read_bytes())
            sbom = json.loads(output_a.read_text())
            self.assertEqual("CycloneDX", sbom["bomFormat"])
            self.assertEqual("1.5", sbom["specVersion"])
            self.assertEqual("example-gateway", sbom["metadata"]["component"]["name"])
            self.assertEqual(
                [{"license": {"id": "AGPL-3.0-only"}}],
                sbom["metadata"]["component"]["licenses"],
            )
            self.assertEqual(1, len(sbom["components"]))
            ws = sbom["components"][0]
            self.assertEqual("ws", ws["name"])
            self.assertEqual("8.21.1", ws["version"])
            self.assertEqual("pkg:npm/ws@8.21.1", ws["purl"])
            self.assertEqual([{"license": {"id": "MIT"}}], ws["licenses"])

    def test_missing_project_license_is_explicit_noassertion(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            package_json = tmp_path / "package.json"
            lock_json = tmp_path / "package-lock.json"
            output = tmp_path / "sbom.json"
            package_json.write_text(json.dumps({"name": "private-app", "version": "0.1.0"}))
            lock_json.write_text(json.dumps({
                "packages": {"": {"name": "private-app", "version": "0.1.0"}},
            }))
            completed = subprocess.run([
                "python3", str(GENERATOR),
                "--package", str(package_json),
                "--lock", str(lock_json),
                "--output", str(output),
            ], check=True, capture_output=True, text=True)

            sbom = json.loads(output.read_text())
            self.assertEqual(
                [{"license": {"name": "NOASSERTION"}}],
                sbom["metadata"]["component"]["licenses"],
            )
            self.assertIn("PROJECT_LICENSE_MISSING", completed.stderr)


if __name__ == "__main__":
    unittest.main()
