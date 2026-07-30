package com.callagent.gateway

import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.FileSystems
import java.nio.file.Path
import java.nio.file.attribute.PosixFilePermission
import java.time.LocalDate
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Test

class ApprovedDeviceEvidenceProviderTest {
    private val today = LocalDate.of(2026, 7, 21)

    @Before
    fun requireUnixSecurityAttributes() {
        assumeTrue(FileSystems.getDefault().supportedFileAttributeViews().contains("unix"))
    }

    private fun json(
        system: String = "lineage/miatoll/miatoll:15/AP3A/observed:userdebug/dev-keys",
        vendor: String = DeviceSelector.APPROVED_GRAM_VENDOR_FINGERPRINT,
        date: String = "2026-07-20",
        source: String = "externally_provisioned",
    ) = """{"observedSystemFingerprint":"$system","observedVendorFingerprint":"$vendor","attestedOn":"$date","attestedSystemDescription":"Android 15 API 35 custom Lineage userdebug system","source":"$source"}"""

    private fun provision(contents: String = json()): Path {
        val dir = Files.createTempDirectory("approved-device-evidence")
        val file = dir.resolve(FileApprovedDeviceEvidenceProvider.FILE_NAME)
        Files.write(file, contents.toByteArray(StandardCharsets.UTF_8))
        try {
            Files.setPosixFilePermissions(file, setOf(PosixFilePermission.OWNER_READ, PosixFilePermission.OWNER_WRITE))
        } catch (_: UnsupportedOperationException) {
            // Provider still exercises all non-POSIX checks on such hosts.
        }
        return file
    }

    private fun ownerUid(path: Path): Int =
        (Files.getAttribute(path, "unix:uid") as Number).toInt()

    private fun provider(
        path: Path,
        date: () -> LocalDate = { today },
        uid: Int = ownerUid(path),
    ) = FileApprovedDeviceEvidenceProvider(path, uid, date)

    @Test fun absentFileRejects() {
        val file = Files.createTempDirectory("approved-device-evidence")
            .resolve(FileApprovedDeviceEvidenceProvider.FILE_NAME)
        assertNull(FileApprovedDeviceEvidenceProvider(file, 0) { today }.read())
    }

    @Test fun independentlyProvisionedMatchingEvidenceReads() {
        val file = provision()
        assertEquals(ApprovedDeviceEvidence.Source.EXTERNALLY_PROVISIONED, provider(file).read()?.source)
    }

    @Test fun malformedOrExtraKeysReject() {
        provision("{}").also { assertNull(provider(it).read()) }
        provision(json().dropLast(1) + ",\"extra\":true}").also { assertNull(provider(it).read()) }
    }

    @Test fun staleFutureAndWrongSourceReject() {
        provision(json(date = "2026-06-20")).also { assertNull(provider(it).read()) }
        provision(json(date = "2026-07-22")).also { assertNull(provider(it).read()) }
        provision(json(source = "app_default")).also { assertNull(provider(it).read()) }
    }

    @Test fun oversizedFileRejects() {
        provision(" ".repeat(FileApprovedDeviceEvidenceProvider.MAX_BYTES + 1))
            .also { assertNull(provider(it).read()) }
    }

    @Test fun symlinkRejects() {
        val target = provision()
        val link = Files.createTempDirectory("approved-device-evidence-link")
            .resolve(FileApprovedDeviceEvidenceProvider.FILE_NAME)
        try { Files.createSymbolicLink(link, target) } catch (_: Exception) { assumeTrue(false) }
        assertNull(FileApprovedDeviceEvidenceProvider(link, ownerUid(target)) { today }.read())
    }

    @Test fun nonCanonicalFilenameRejects() {
        val canonical = provision()
        assertNull(
            FileApprovedDeviceEvidenceProvider(
                canonical.resolveSibling("default.json"),
                ownerUid(canonical),
            ) { today }.read(),
        )
    }

    @Test fun groupOrWorldAccessibleFileRejectsOnPosix() {
        val file = provision()
        try {
            Files.setPosixFilePermissions(
                file,
                setOf(PosixFilePermission.OWNER_READ, PosixFilePermission.GROUP_READ),
            )
        } catch (_: UnsupportedOperationException) { assumeTrue(false) }
        assertNull(provider(file).read())
    }

    @Test fun exactOwnerAndModeAreRequiredOnPosix() {
        val file = provision()
        assertNull(provider(file, uid = ownerUid(file) + 1).read())
        for (permissions in listOf(
            setOf(PosixFilePermission.OWNER_READ),
            setOf(PosixFilePermission.OWNER_READ, PosixFilePermission.OWNER_EXECUTE),
            setOf(
                PosixFilePermission.OWNER_READ,
                PosixFilePermission.OWNER_WRITE,
                PosixFilePermission.OWNER_EXECUTE,
            ),
        )) {
            try { Files.setPosixFilePermissions(file, permissions) } catch (_: UnsupportedOperationException) {
                assumeTrue(false)
            }
            assertNull(provider(file).read())
        }
    }

    @Test fun freshnessIsEvaluatedOnEveryRead() {
        val file = provision(json(date = "2026-07-14"))
        var current = LocalDate.of(2026, 7, 21)
        val provider = provider(file, date = { current })
        assertEquals(ApprovedDeviceEvidence.Source.EXTERNALLY_PROVISIONED, provider.read()?.source)
        current = LocalDate.of(2026, 7, 22)
        assertNull(provider.read())
    }
}
