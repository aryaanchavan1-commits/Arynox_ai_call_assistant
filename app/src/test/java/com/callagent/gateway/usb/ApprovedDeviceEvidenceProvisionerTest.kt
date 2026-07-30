package com.callagent.gateway.usb

import com.callagent.gateway.FileApprovedDeviceEvidenceProvider
import java.nio.file.FileSystems
import java.nio.file.Files
import java.nio.file.attribute.PosixFilePermission
import java.time.LocalDate
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Test

class ApprovedDeviceEvidenceProvisionerTest {
    private val system = "lineage/miatoll/miatoll:15/AP3A.240905.015.A2/observed:userdebug/dev-keys"
    private val vendor = "POCO/gram_in/gram:12/RKQ1.211019.001/V14.0.5.0.SJPINXM:user/release-keys"
    private val fixtureToday = { LocalDate.of(2026, 7, 21) }

    @Before
    fun requireUnixSecurityAttributes() {
        assumeTrue(FileSystems.getDefault().supportedFileAttributeViews().contains("unix"))
    }

    @Test fun `authenticated payload is atomically installed owner-only and read back`() {
        val dir = Files.createTempDirectory("evidence-provision")
        val target = dir.resolve(FileApprovedDeviceEvidenceProvider.FILE_NAME)
        val uid = currentUid(dir)
        val provisioner = ApprovedDeviceEvidenceProvisioner(target, uid, today = fixtureToday)

        assertTrue(provisioner.provision(command()))
        assertTrue(Files.isRegularFile(target))
        assertEquals(
            setOf(PosixFilePermission.OWNER_READ, PosixFilePermission.OWNER_WRITE),
            Files.getPosixFilePermissions(target),
        )
        assertFalse(Files.list(dir).use { stream -> stream.anyMatch { it.fileName.toString().endsWith(".tmp") } })
        val read = FileApprovedDeviceEvidenceProvider(target, uid) { LocalDate.of(2026, 7, 21) }.read()
        assertEquals(system, read?.observedSystemFingerprint)
        assertEquals(vendor, read?.observedVendorFingerprint)
    }

    @Test fun `strict command parser admits only complete bounded provisioning payload`() {
        val parsed = CommandParser.parse(
            """{"command":"provision_device_evidence","idempotencyKey":"p1","observedSystemFingerprint":"$system","observedVendorFingerprint":"$vendor","attestedOn":"2026-07-21","attestedSystemDescription":"Android 15 API 35 custom Lineage userdebug system"}"""
                .toByteArray(),
        )
        assertTrue(parsed is GatewayCommand.ProvisionDeviceEvidence)
        try {
            CommandParser.parse(
                """{"command":"provision_device_evidence","idempotencyKey":"p2","observedSystemFingerprint":"$system","observedVendorFingerprint":"$vendor","attestedOn":"2026-07-21","attestedSystemDescription":"ok","source":"externally_provisioned"}"""
                    .toByteArray(),
            )
            throw AssertionError("controller must not choose source")
        } catch (_: CommandProtocolException) {}
    }

    @Test fun `invalid or out of policy payload cannot replace prior evidence`() {
        val dir = Files.createTempDirectory("evidence-provision-invalid")
        val target = dir.resolve(FileApprovedDeviceEvidenceProvider.FILE_NAME)
        val provisioner = ApprovedDeviceEvidenceProvisioner(target, currentUid(dir), today = fixtureToday)
        assertTrue(provisioner.provision(command()))
        val before = Files.readAllBytes(target)

        assertFalse(provisioner.provision(command(description = "x\nforged")))
        assertFalse(provisioner.provision(command(date = "2026-07-22")))
        assertFalse(provisioner.provision(command(system = "x".repeat(1025))))
        assertTrue(before.contentEquals(Files.readAllBytes(target)))
    }

    @Test fun `writer refuses noncanonical target path`() {
        val dir = Files.createTempDirectory("evidence-provision-path")
        val target = dir.resolve("other.json")
        assertFalse(ApprovedDeviceEvidenceProvisioner(target, currentUid(dir)).provision(command()))
        assertNull(Files.list(dir).use { stream -> stream.findFirst().orElse(null) })
    }

    @Test fun `strict read back rejects a target not owned by expected app uid`() {
        val dir = Files.createTempDirectory("evidence-provision-owner")
        val target = dir.resolve(FileApprovedDeviceEvidenceProvider.FILE_NAME)
        val actualUid = currentUid(dir)

        assertFalse(ApprovedDeviceEvidenceProvisioner(target, actualUid + 1, today = fixtureToday).provision(command()))
        assertTrue(Files.isRegularFile(target))
        assertNull(FileApprovedDeviceEvidenceProvider(target, actualUid + 1) { LocalDate.of(2026, 7, 21) }.read())
    }

    @Test fun `writer refuses an existing target symlink without replacing its destination`() {
        val dir = Files.createTempDirectory("evidence-provision-target-link")
        val outside = Files.createTempFile("evidence-provision-outside", ".json")
        val original = "outside-do-not-replace".toByteArray()
        Files.write(outside, original)
        val target = dir.resolve(FileApprovedDeviceEvidenceProvider.FILE_NAME)
        Files.createSymbolicLink(target, outside)

        assertFalse(ApprovedDeviceEvidenceProvisioner(target, currentUid(dir)).provision(command()))
        assertTrue(Files.isSymbolicLink(target))
        assertTrue(original.contentEquals(Files.readAllBytes(outside)))
    }

    @Test fun `writer refuses a symlink parent`() {
        val realParent = Files.createTempDirectory("evidence-provision-real-parent")
        val linkRoot = Files.createTempDirectory("evidence-provision-link-root")
        val linkedParent = linkRoot.resolve("files")
        Files.createSymbolicLink(linkedParent, realParent)
        val target = linkedParent.resolve(FileApprovedDeviceEvidenceProvider.FILE_NAME)

        assertFalse(ApprovedDeviceEvidenceProvisioner(target, currentUid(realParent)).provision(command()))
        assertNull(Files.list(realParent).use { stream -> stream.findFirst().orElse(null) })
    }

    @Test fun `repeated identical provisioning is idempotent and remains strict`() {
        val dir = Files.createTempDirectory("evidence-provision-repeat")
        val target = dir.resolve(FileApprovedDeviceEvidenceProvider.FILE_NAME)
        val provisioner = ApprovedDeviceEvidenceProvisioner(target, currentUid(dir), system, vendor) {
            LocalDate.of(2026, 7, 21)
        }

        assertTrue(provisioner.provision(command()))
        val first = Files.readAllBytes(target)
        assertTrue(provisioner.provision(command()))
        assertTrue(first.contentEquals(Files.readAllBytes(target)))
        assertEquals(
            setOf(PosixFilePermission.OWNER_READ, PosixFilePermission.OWNER_WRITE),
            Files.getPosixFilePermissions(target),
        )
    }

    @Test fun `identity preconditions reject before creating evidence`() {
        val dir = Files.createTempDirectory("evidence-provision-precondition")
        val target = dir.resolve(FileApprovedDeviceEvidenceProvider.FILE_NAME)
        val provisioner = ApprovedDeviceEvidenceProvisioner(target, currentUid(dir), system, vendor) {
            LocalDate.of(2026, 7, 21)
        }

        assertFalse(provisioner.provision(command(system = "wrong-system")))
        assertFalse(provisioner.provision(command(vendor = "wrong-vendor")))
        assertFalse(Files.exists(target))
    }

    private fun command(
        system: String = this.system,
        vendor: String = this.vendor,
        date: String = "2026-07-21",
        description: String = "Android 15 API 35 custom Lineage userdebug system",
    ) = GatewayCommand.ProvisionDeviceEvidence(
        idempotencyKey = "provision-1",
        observedSystemFingerprint = system,
        observedVendorFingerprint = vendor,
        attestedOn = date,
        attestedSystemDescription = description,
    )

    private fun currentUid(path: java.nio.file.Path): Int =
        (Files.getAttribute(path, "unix:uid") as Number).toInt()
}
