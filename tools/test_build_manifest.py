import os
from pathlib import Path
import struct
import tempfile
import unittest
from unittest import mock
import zipfile

from tools.build_manifest import (
    DEFAULT_OUTPUTS,
    INCOMPLETE_MARKER,
    ManifestBuildError,
    descriptor_bound_read,
    desktop_package_version,
    publish_transaction,
    signer_certificate,
    verified_signer_digest,
    verify_final_embedded_manifest,
)


V2_BLOCK_ID = 0x7109871A
V31_BLOCK_ID = 0x1B93AD61


def lp(value):
    return struct.pack("<I", len(value)) + value


class SecureInputTest(unittest.TestCase):
    def test_descriptor_bound_read_rejects_symlink(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            target = root / "target.apk"
            target.write_bytes(b"apk")
            link = root / "link.apk"
            link.symlink_to(target)
            with self.assertRaises(ManifestBuildError):
                descriptor_bound_read(link)

    def test_descriptor_bound_read_rejects_symlinked_parent(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            real = root / "real"
            real.mkdir()
            (real / "candidate.apk").write_bytes(b"apk")
            linked = root / "linked"
            linked.symlink_to(real, target_is_directory=True)
            with self.assertRaises(ManifestBuildError):
                descriptor_bound_read(linked / "candidate.apk")

    def test_descriptor_bound_read_returns_one_open_file_snapshot(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "candidate.apk"
            path.write_bytes(b"first")
            self.assertEqual(b"first", descriptor_bound_read(path))


class DesktopIdentityTest(unittest.TestCase):
    def test_desktop_version_is_derived_from_named_desktop_package(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "package.json"
            path.write_text('{"name":"agentcall-desktop","version":"1.0.0"}')
            self.assertEqual("1.0.0", desktop_package_version(path))
            path.write_text('{"name":"other-desktop","version":"1.0.0"}')
            with self.assertRaises(ManifestBuildError):
                desktop_package_version(path)


class ManifestTransactionTest(unittest.TestCase):
    def test_publish_is_all_or_nothing_at_every_replace_boundary(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            outputs = tuple(root / str(index) / path.name for index, path in enumerate(DEFAULT_OUTPUTS))
            marker = root / INCOMPLETE_MARKER.name
            for path in outputs:
                path.parent.mkdir(parents=True)
                path.write_bytes(b"old")
            real_replace = os.replace
            for failure_at in range(1, len(outputs) + 1):
                calls = 0
                def failing_replace(source, destination):
                    nonlocal calls
                    if ".stage." in Path(source).name:
                        calls += 1
                        if calls == failure_at:
                            raise OSError("injected replace failure")
                    return real_replace(source, destination)
                with mock.patch("tools.build_manifest.os.replace", side_effect=failing_replace):
                    with self.assertRaises(ManifestBuildError):
                        publish_transaction(outputs, b"new", marker)
                self.assertTrue(marker.exists())
                self.assertEqual([b"old"] * len(outputs), [path.read_bytes() for path in outputs])
                marker.unlink()

    def test_success_publishes_identical_bytes_with_public_modes_and_clears_marker(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            outputs = tuple(root / str(index) / path.name for index, path in enumerate(DEFAULT_OUTPUTS))
            marker = root / INCOMPLETE_MARKER.name
            previous_umask = os.umask(0o077)
            try:
                publish_transaction(outputs, b"canonical", marker)
            finally:
                os.umask(previous_umask)
            self.assertFalse(marker.exists())
            self.assertEqual([b"canonical"] * len(outputs), [path.read_bytes() for path in outputs])
            self.assertEqual([0o644] * len(outputs), [path.stat().st_mode & 0o777 for path in outputs])


class ApkAuthenticityTest(unittest.TestCase):
    def test_apksigner_is_mandatory_and_must_match_structural_certificate(self):
        apk = b"synthetic signed APK snapshot"
        certificate = b"sole current signer certificate"
        digest = __import__("hashlib").sha256(certificate).digest()
        with tempfile.TemporaryDirectory() as directory:
            apksigner = Path(directory) / "apksigner"
            apksigner.write_text("#!/bin/sh\nexit 0\n")
            apksigner.chmod(0o700)
            output = "Signer #1 certificate SHA-256 digest: " + digest.hex() + "\n"
            with mock.patch("tools.build_manifest.extract_certificate", return_value=certificate), mock.patch(
                "tools.build_manifest.subprocess.run",
                return_value=mock.Mock(returncode=0, stdout=output, stderr=""),
            ) as run:
                self.assertEqual(digest, verified_signer_digest(apk, apksigner))
                self.assertTrue(Path(run.call_args.args[0][-1]).name.endswith(".apk"))
            with mock.patch("tools.build_manifest.extract_certificate", return_value=certificate), mock.patch(
                "tools.build_manifest.subprocess.run",
                return_value=mock.Mock(
                    returncode=0,
                    stdout="",
                    stderr="  Signer #1 certificate SHA-256 digest: " + digest.hex().upper() + "\n",
                ),
            ):
                self.assertEqual(digest, verified_signer_digest(apk, apksigner))
            build_tools_37_output = (
                "Number of signers: 1\n"
                "V2 Signer: certificate SHA-256 digest: " + digest.hex() + "\n"
            )
            with mock.patch("tools.build_manifest.extract_certificate", return_value=certificate), mock.patch(
                "tools.build_manifest.subprocess.run",
                return_value=mock.Mock(returncode=0, stdout=build_tools_37_output, stderr=""),
            ):
                self.assertEqual(digest, verified_signer_digest(apk, apksigner))
            with mock.patch("tools.build_manifest.extract_certificate", return_value=certificate), mock.patch(
                "tools.build_manifest.subprocess.run",
                return_value=mock.Mock(
                    returncode=0,
                    stdout="Number of signers: 2\n"
                    "V2 Signer: certificate SHA-256 digest: " + digest.hex() + "\n",
                    stderr="",
                ),
            ):
                with self.assertRaises(ManifestBuildError):
                    verified_signer_digest(apk, apksigner)
            with mock.patch("tools.build_manifest.extract_certificate", return_value=certificate), mock.patch(
                "tools.build_manifest.subprocess.run",
                return_value=mock.Mock(returncode=0, stdout="Signer #1 certificate SHA-256 digest: " + (b"x" * 32).hex(), stderr=""),
            ):
                with self.assertRaises(ManifestBuildError):
                    verified_signer_digest(apk, apksigner)

    def test_final_apk_must_embed_exact_frozen_manifest(self):
        manifest = b"canonical manifest\n"
        with tempfile.TemporaryDirectory() as directory:
            apk = Path(directory) / "final.apk"
            with zipfile.ZipFile(apk, "w") as archive:
                archive.writestr("res/raw/matched_artifact.properties", manifest)
            verify_final_embedded_manifest(apk.read_bytes(), manifest)
            with self.assertRaises(ManifestBuildError):
                verify_final_embedded_manifest(apk.read_bytes(), b"different\n")


class SignedDataSuffixTest(unittest.TestCase):
    def check(self, suffix):
        certificate = b"synthetic certificate"
        signed_data = lp(b"digest") + lp(lp(certificate)) + lp(b"attribute") + suffix
        signer = lp(signed_data) + lp(b"signature") + lp(b"public key")
        self.assertEqual(certificate, signer_certificate(lp(lp(signer)), V2_BLOCK_ID))

    def test_accepts_three_canonical_fields_without_reserved_extension(self):
        self.check(b"")

    def test_accepts_one_empty_reserved_element(self):
        self.check(lp(b""))

    def test_accepts_canonical_v31_current_signer_layout(self):
        certificate = b"current signer certificate"
        min_sdk = struct.pack("<I", 33)
        rotation_attribute = lp(b"proof-of-rotation attribute")
        signed_data = lp(b"digest") + lp(lp(certificate)) + min_sdk + lp(rotation_attribute)
        signer = lp(signed_data) + min_sdk + lp(b"signature") + lp(b"public key")
        self.assertEqual(certificate, signer_certificate(lp(lp(signer)), V31_BLOCK_ID))

    def test_rejects_nonempty_reserved_extension(self):
        with self.assertRaises(ManifestBuildError):
            self.check(lp(b"reserved"))

    def test_rejects_two_reserved_elements(self):
        with self.assertRaises(ManifestBuildError):
            self.check(lp(b"") + lp(b""))

    def test_rejects_truncated_reserved_length(self):
        with self.assertRaises(ManifestBuildError):
            self.check(b"\x00\x00\x00")

    def test_rejects_other_trailing_bytes(self):
        with self.assertRaises(ManifestBuildError):
            self.check(lp(b"") + b"trailing")


if __name__ == "__main__":
    unittest.main()
