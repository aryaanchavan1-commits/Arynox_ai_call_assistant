#!/usr/bin/env python3
"""Derive one APK signer digest and atomically write canonical release manifests."""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import struct
import subprocess
import sys
import tempfile
import zipfile

MAGIC = b"APK Sig Block 42"
V2_BLOCK_ID = 0x7109871A
V3_BLOCK_ID = 0xF05368C0
V31_BLOCK_ID = 0x1B93AD61
SIGNATURE_IDS = frozenset((V2_BLOCK_ID, V3_BLOCK_ID, V31_BLOCK_ID))
DEFAULT_OUTPUTS = (
    Path("protocol/matched-artifact.properties"),
    Path("app/src/main/res/raw/matched_artifact.properties"),
    Path("packaging/linux/matched-artifact.properties"),
)
MAX_APK_BYTES = 2 * 1024 * 1024 * 1024
INCOMPLETE_MARKER = Path("protocol/.matched-artifact-transaction-incomplete")
DESKTOP_PACKAGE_JSON = Path("pc/pc-gateway/ui/package.json")

class ManifestBuildError(Exception):
    pass

def checked_slice(data, start, length, label):
    if start < 0 or length < 0 or start > len(data) or length > len(data) - start:
        raise ManifestBuildError(f"malformed {label}")
    return data[start:start + length]

def u32(data, at, label):
    return struct.unpack("<I", checked_slice(data, at, 4, label))[0]

def u64(data, at, label):
    return struct.unpack("<Q", checked_slice(data, at, 8, label))[0]

def length_prefixed(data, at, end, label):
    if end < 0 or end > len(data) or at < 0 or at > end or end - at < 4:
        raise ManifestBuildError(f"malformed {label}")
    size = u32(data, at, label)
    start = at + 4
    if size > end - start:
        raise ManifestBuildError(f"malformed {label}")
    return checked_slice(data, start, size, label), start + size

def exactly_one_sequence(data, label):
    item, at = length_prefixed(data, 0, len(data), label)
    if at != len(data):
        raise ManifestBuildError(f"multiple {label}")
    return item

def finish_signed_data(data, at, block_id):
    if at == len(data):
        return
    if block_id == V2_BLOCK_ID:
        # Build Tools v2 signers may append one empty reserved LP element.
        reserved, at = length_prefixed(data, at, len(data), "reserved signed data")
        if reserved or at != len(data):
            raise ManifestBuildError("malformed signed data")
        return
    raise ManifestBuildError("malformed signed data")

def signer_certificate(value, block_id):
    signers = exactly_one_sequence(value, "signers")
    signer = exactly_one_sequence(signers, "signer")
    signed_data, signer_at = length_prefixed(signer, 0, len(signer), "signed data")
    if block_id == V3_BLOCK_ID:
        checked_slice(signer, signer_at, 8, "SDK range")
        signer_at += 8
    elif block_id == V31_BLOCK_ID:
        checked_slice(signer, signer_at, 4, "SDK range")
        signer_at += 4
    _, signer_at = length_prefixed(signer, signer_at, len(signer), "signatures")
    _, signer_at = length_prefixed(signer, signer_at, len(signer), "public key")
    if signer_at != len(signer):
        raise ManifestBuildError("malformed signer")
    _, pos = length_prefixed(signed_data, 0, len(signed_data), "digests")
    certificates, pos = length_prefixed(signed_data, pos, len(signed_data), "certificates")
    if block_id == V3_BLOCK_ID:
        checked_slice(signed_data, pos, 8, "SDK range")
        pos += 8
    elif block_id == V31_BLOCK_ID:
        checked_slice(signed_data, pos, 4, "minimum SDK")
        pos += 4
    _, pos = length_prefixed(signed_data, pos, len(signed_data), "attributes")
    finish_signed_data(signed_data, pos, block_id)
    certificate = exactly_one_sequence(certificates, "certificates")
    if not certificate:
        raise ManifestBuildError("missing certificate")
    return certificate

def extract_certificate(apk):
    if not apk or len(apk) > MAX_APK_BYTES:
        raise ManifestBuildError("invalid APK size")
    search_start = max(0, len(apk) - (0xffff + 22))
    eocd = apk.rfind(b"PK\x05\x06", search_start)
    if eocd < 0 or eocd + 22 > len(apk):
        raise ManifestBuildError("missing EOCD")
    comment_size = struct.unpack("<H", checked_slice(apk, eocd + 20, 2, "EOCD"))[0]
    if eocd + 22 + comment_size != len(apk):
        raise ManifestBuildError("malformed EOCD")
    if checked_slice(apk, eocd + 4, 4, "EOCD") != b"\x00\x00\x00\x00":
        raise ManifestBuildError("multi-disk APK unsupported")
    central_size = u32(apk, eocd + 12, "EOCD")
    central = u32(apk, eocd + 16, "EOCD")
    if central_size == 0xffffffff or central < 32 or central > eocd or central_size != eocd - central:
        raise ManifestBuildError("invalid central directory")
    footer = checked_slice(apk, central - 24, 24, "signing block footer")
    size = struct.unpack_from("<Q", footer, 0)[0]
    if footer[8:] != MAGIC or size < 24 or size > central - 8:
        raise ManifestBuildError("missing signing block")
    start = central - (size + 8)
    if u64(apk, start, "signing block header") != size:
        raise ManifestBuildError("signing block size mismatch")
    pairs_end = central - 24
    at = start + 8
    certificates = []
    seen_ids = set()
    while at < pairs_end:
        if pairs_end - at < 12:
            raise ManifestBuildError("malformed signing pair")
        pair_size = u64(apk, at, "signing pair")
        if pair_size < 4 or pair_size > pairs_end - at - 8:
            raise ManifestBuildError("malformed signing pair")
        pair_id = u32(apk, at + 8, "signing pair")
        value = checked_slice(apk, at + 12, pair_size - 4, "signing pair")
        if pair_id in SIGNATURE_IDS:
            if pair_id in seen_ids:
                raise ManifestBuildError("duplicate signer block")
            seen_ids.add(pair_id)
            certificates.append(signer_certificate(value, pair_id))
        at += 8 + pair_size
    if at != pairs_end or not certificates:
        raise ManifestBuildError("missing signer block")
    if any(certificate != certificates[0] for certificate in certificates[1:]):
        raise ManifestBuildError("inconsistent signer certificates")
    return certificates[0]

def descriptor_bound_read(path, maximum=MAX_APK_BYTES):
    """Read one bounded regular-file snapshot without following any path symlink."""
    path = Path(path)
    parts = path.parts
    if not parts or any(part == ".." for part in parts):
        raise ManifestBuildError("input rejected")
    if os.name == "nt":
        candidate = path.absolute()
        try:
            for component in (*reversed(candidate.parents), candidate):
                if component == candidate.anchor:
                    continue
                facts = os.lstat(component)
                if facts.st_file_attributes & stat.FILE_ATTRIBUTE_REPARSE_POINT:
                    raise ManifestBuildError("input rejected")
            before = os.lstat(candidate)
            if not stat.S_ISREG(before.st_mode) or before.st_size <= 0 or before.st_size > maximum:
                raise ManifestBuildError("input rejected")
            file_fd = os.open(candidate, os.O_RDONLY | getattr(os, "O_BINARY", 0))
            try:
                facts = os.fstat(file_fd)
                if (facts.st_dev, facts.st_ino, facts.st_size) != (before.st_dev, before.st_ino, before.st_size):
                    raise ManifestBuildError("input changed before reading")
                data = bytearray()
                while len(data) < facts.st_size:
                    chunk = os.read(file_fd, min(1024 * 1024, facts.st_size - len(data)))
                    if not chunk:
                        raise ManifestBuildError("short input read")
                    data.extend(chunk)
                if os.read(file_fd, 1):
                    raise ManifestBuildError("input changed while reading")
                return bytes(data)
            finally:
                os.close(file_fd)
        except OSError as error:
            raise ManifestBuildError("input rejected") from error
    directory_flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0)
    file_flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    directory_fd = None
    file_fd = None
    try:
        if path.is_absolute():
            directory_fd = os.open("/", directory_flags)
            components = parts[1:]
        else:
            directory_fd = os.open(".", directory_flags)
            components = parts
        if not components or components[-1] in ("", "."):
            raise ManifestBuildError("input rejected")
        for component in components[:-1]:
            if component in ("", "."):
                continue
            next_fd = os.open(component, directory_flags, dir_fd=directory_fd)
            os.close(directory_fd)
            directory_fd = next_fd
        file_fd = os.open(components[-1], file_flags, dir_fd=directory_fd)
        facts = os.fstat(file_fd)
        if not stat.S_ISREG(facts.st_mode) or facts.st_size <= 0 or facts.st_size > maximum:
            raise ManifestBuildError("input rejected")
        data = bytearray()
        while len(data) < facts.st_size:
            chunk = os.read(file_fd, min(1024 * 1024, facts.st_size - len(data)))
            if not chunk:
                raise ManifestBuildError("short input read")
            data.extend(chunk)
        if os.read(file_fd, 1):
            raise ManifestBuildError("input changed while reading")
        return bytes(data)
    except OSError as error:
        raise ManifestBuildError("input rejected") from error
    finally:
        if file_fd is not None:
            os.close(file_fd)
        if directory_fd is not None:
            os.close(directory_fd)


def desktop_package_version(path=DESKTOP_PACKAGE_JSON):
    try:
        package = json.loads(descriptor_bound_read(path, 1024 * 1024).decode("utf-8"))
    except (UnicodeError, json.JSONDecodeError) as error:
        raise ManifestBuildError("desktop package metadata rejected") from error
    if package.get("name") != "agentcall-desktop" or package.get("version") != "0.2.5":
        raise ManifestBuildError("desktop package identity mismatch")
    return package["version"]


def find_apksigner():
    direct = shutil.which("apksigner")
    if direct:
        return Path(direct)
    candidates = []
    for sdk in filter(None, (os.environ.get("ANDROID_SDK_ROOT"), os.environ.get("ANDROID_HOME"), str(Path.home() / "Android/Sdk"))):
        build_tools = Path(sdk) / "build-tools"
        if build_tools.is_dir():
            names = ("apksigner.bat", "apksigner") if os.name == "nt" else ("apksigner",)
            for name in names:
                candidates.extend(
                    path for path in build_tools.glob(f"*/{name}")
                    if path.is_file() and (os.name == "nt" or os.access(path, os.X_OK))
                )
    if not candidates:
        raise ManifestBuildError("SDK apksigner is required")
    return sorted(candidates)[-1]


def verified_signer_digest(apk, apksigner=None):
    """Cryptographically verify the exact descriptor snapshot and cross-check its structural signer."""
    apksigner = Path(apksigner) if apksigner is not None else find_apksigner()
    if not apksigner.is_file() or (os.name != "nt" and not os.access(apksigner, os.X_OK)):
        raise ManifestBuildError("SDK apksigner is required")
    structural = hashlib.sha256(extract_certificate(apk)).digest()
    with tempfile.TemporaryDirectory(prefix="agentcall-apk-verify-") as directory:
        snapshot = Path(directory) / "candidate.apk"
        fd = os.open(snapshot, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "wb") as output:
            output.write(apk)
            output.flush()
            os.fsync(output.fileno())
        result = subprocess.run(
            [str(apksigner), "verify", "--verbose", "--print-certs", str(snapshot)],
            capture_output=True,
            text=True,
            check=False,
        )
    if result.returncode != 0:
        raise ManifestBuildError("APK signature verification failed")
    signer_digests = []
    explicit_signers = set()
    declared_signers = None
    legacy_digest_line = re.compile(
        r"\s*Signer #([1-9]\d*) certificate SHA-256 digest:\s*([0-9A-Fa-f:]+)\s*",
    )
    scheme_digest_line = re.compile(
        r"\s*V[234](?:\.\d+)? Signer(?: #([1-9]\d*))?: certificate SHA-256 digest:\s*"
        r"([0-9A-Fa-f:]+)\s*",
    )
    signer_count_line = re.compile(r"\s*Number of signers:\s*(\d+)\s*")
    for line in f"{result.stdout}\n{result.stderr}".splitlines():
        count_match = signer_count_line.fullmatch(line)
        if count_match:
            count = int(count_match.group(1))
            if declared_signers is not None and declared_signers != count:
                raise ManifestBuildError("invalid apksigner output")
            declared_signers = count
            continue
        match = legacy_digest_line.fullmatch(line)
        if match:
            explicit_signers.add(int(match.group(1)))
        else:
            match = scheme_digest_line.fullmatch(line)
            if match and match.group(1):
                explicit_signers.add(int(match.group(1)))
        if not match:
            continue
        value = match.group(2).replace(":", "").lower()
        if len(value) != 64:
            raise ManifestBuildError("invalid apksigner output")
        signer_digests.append(bytes.fromhex(value))
    if declared_signers not in (None, 1) or explicit_signers not in (set(), {1}):
        raise ManifestBuildError("APK signer set rejected")
    if not signer_digests or len(set(signer_digests)) != 1:
        raise ManifestBuildError("APK signer set rejected")
    if signer_digests[0] != structural:
        raise ManifestBuildError("APK signer mismatch")
    return structural


def verify_final_embedded_manifest(apk, expected):
    with tempfile.TemporaryFile() as handle:
        handle.write(apk)
        handle.seek(0)
        try:
            with zipfile.ZipFile(handle) as archive:
                names = [name for name in archive.namelist() if name == "res/raw/matched_artifact.properties"]
                if len(names) != 1 or archive.read(names[0]) != expected:
                    raise ManifestBuildError("final embedded manifest mismatch")
        except (OSError, zipfile.BadZipFile, KeyError) as error:
            raise ManifestBuildError("final embedded manifest rejected") from error


def canonical_manifest(digest, desktop_version="0.2.5"):
    if len(digest) != 32 or not any(digest):
        raise ManifestBuildError("invalid signer digest")
    if desktop_version != "0.2.5":
        raise ManifestBuildError("desktop package identity mismatch")
    return (f"schemaVersion=1\nbootstrapProtocolVersion=1\ndesktopPackageVersion={desktop_version}\n"
            "androidPackageName=com.callagent.gateway\nandroidVersionCode=332\n"
            f"androidSigningCertificateSha256={digest.hex()}\n").encode("ascii")

def atomic_write(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as output:
            output.write(data)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
    except BaseException:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass
        raise

def fsync_directory(path):
    if os.name == "nt":
        return
    fd = os.open(os.fspath(path), os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def publish_transaction(outputs, data, marker=INCOMPLETE_MARKER):
    """Publish all canonical outputs or restore every pre-transaction byte string."""
    outputs = tuple(Path(path) for path in outputs)
    marker = Path(marker)
    if not outputs or len(set(outputs)) != len(outputs):
        raise ManifestBuildError("invalid manifest destinations")
    if marker.exists():
        raise ManifestBuildError("incomplete manifest transaction")
    for path in outputs:
        path.parent.mkdir(parents=True, exist_ok=True)
        if path.is_symlink() or (path.exists() and not path.is_file()):
            raise ManifestBuildError("manifest destination rejected")
    marker.parent.mkdir(parents=True, exist_ok=True)
    atomic_write(marker, b"incomplete\n")
    fsync_directory(marker.parent)
    staged = []
    backups = []
    existed = []
    original_modes = []
    try:
        for path in outputs:
            existed.append(path.exists())
            original_modes.append(stat.S_IMODE(path.stat().st_mode) if path.exists() else None)
            backup_fd, backup_name = tempfile.mkstemp(prefix=f".{path.name}.backup.", dir=path.parent)
            with os.fdopen(backup_fd, "wb") as backup:
                if path.exists():
                    backup.write(descriptor_bound_read(path))
                    if hasattr(os, "fchmod"):
                        os.fchmod(backup.fileno(), original_modes[-1])
                backup.flush()
                os.fsync(backup.fileno())
            backups.append(Path(backup_name))
            stage_fd, stage_name = tempfile.mkstemp(prefix=f".{path.name}.stage.", dir=path.parent)
            with os.fdopen(stage_fd, "wb") as stage:
                stage.write(data)
                if hasattr(os, "fchmod"):
                    os.fchmod(stage.fileno(), 0o644)
                stage.flush()
                os.fsync(stage.fileno())
            staged.append(Path(stage_name))
        if any(descriptor_bound_read(path) != data for path in staged):
            raise ManifestBuildError("staged manifest validation failed")
        for stage, destination in zip(staged, outputs):
            os.replace(stage, destination)
        for directory in {path.parent for path in outputs}:
            fsync_directory(directory)
        marker.unlink()
        fsync_directory(marker.parent)
    except BaseException as error:
        for destination, backup, was_present in zip(outputs, backups, existed):
            try:
                if was_present:
                    os.replace(backup, destination)
                else:
                    destination.unlink(missing_ok=True)
            except OSError:
                pass
        for directory in {path.parent for path in outputs}:
            try:
                fsync_directory(directory)
            except OSError:
                pass
        if isinstance(error, ManifestBuildError):
            raise
        raise ManifestBuildError("manifest transaction failed") from error
    finally:
        for path in staged + backups:
            path.unlink(missing_ok=True)


def frozen_manifest():
    if INCOMPLETE_MARKER.exists():
        raise ManifestBuildError("incomplete manifest transaction")
    values = [descriptor_bound_read(path, 16 * 1024) for path in DEFAULT_OUTPUTS]
    if any(value != values[0] for value in values[1:]):
        raise ManifestBuildError("canonical manifest outputs differ")
    return values[0]


def manifest_signer_digest(manifest):
    prefix = b"androidSigningCertificateSha256="
    matches = [line[len(prefix):] for line in manifest.splitlines() if line.startswith(prefix)]
    if len(matches) != 1 or len(matches[0]) != 64 or any(byte not in b"0123456789abcdef" for byte in matches[0]):
        raise ManifestBuildError("canonical manifest signer rejected")
    return bytes.fromhex(matches[0].decode("ascii"))


def prepare_manifest(apk_path):
    apk = descriptor_bound_read(apk_path)
    manifest = canonical_manifest(verified_signer_digest(apk), desktop_package_version())
    publish_transaction(DEFAULT_OUTPUTS, manifest)


def verify_final(apk_path):
    apk = descriptor_bound_read(apk_path)
    manifest = frozen_manifest()
    if verified_signer_digest(apk) != manifest_signer_digest(manifest):
        raise ManifestBuildError("final signer does not match frozen manifest")
    verify_final_embedded_manifest(apk, manifest)


def main(argv):
    if not argv:
        prepare_manifest(Path("app/build/outputs/apk/debug/app-debug.apk"))
    elif len(argv) == 2 and argv[0] == "--prepare":
        prepare_manifest(Path(argv[1]))
    elif len(argv) == 2 and argv[0] == "--verify-final":
        verify_final(Path(argv[1]))
    else:
        raise ManifestBuildError("invalid arguments")

if __name__ == "__main__":
    try:
        main(sys.argv[1:])
    except ManifestBuildError as error:
        # ManifestBuildError messages are deliberately bounded constants that
        # identify the failed invariant without including paths, tool output,
        # certificate bytes, or other environment data.
        print(f"manifest generation failed: {error}", file=sys.stderr)
        raise SystemExit(1)
    except Exception:
        print("manifest generation failed: unexpected internal error", file=sys.stderr)
        raise SystemExit(1)
