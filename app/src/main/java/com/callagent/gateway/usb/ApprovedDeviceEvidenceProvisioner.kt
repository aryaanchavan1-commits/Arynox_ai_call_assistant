package com.callagent.gateway.usb

import com.callagent.gateway.FileApprovedDeviceEvidenceProvider
import java.nio.ByteBuffer
import java.nio.channels.FileChannel
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.Path
import java.nio.file.StandardCopyOption
import java.nio.file.StandardOpenOption
import java.nio.file.attribute.PosixFilePermission
import java.time.LocalDate
import java.time.format.DateTimeParseException

/** Narrow sink reachable only after controller mutual authentication and exact command parsing. */
class ApprovedDeviceEvidenceProvisioner(
    private val target: Path,
    private val expectedUid: Int,
    private val expectedSystemFingerprint: String? = null,
    private val expectedVendorFingerprint: String? = null,
    private val today: () -> LocalDate = { LocalDate.now() },
) {
    fun provision(command: GatewayCommand.ProvisionDeviceEvidence): Boolean {
        if (target.fileName?.toString() != FileApprovedDeviceEvidenceProvider.FILE_NAME) return false
        if (target != target.toAbsolutePath().normalize()) return false
        if (expectedSystemFingerprint != null && command.observedSystemFingerprint != expectedSystemFingerprint) return false
        if (expectedVendorFingerprint != null && command.observedVendorFingerprint != expectedVendorFingerprint) return false
        val date = try { LocalDate.parse(command.attestedOn) } catch (_: DateTimeParseException) { return false }
        if (date != today()) return false
        val values = listOf(
            command.observedSystemFingerprint to 1024,
            command.observedVendorFingerprint to 1024,
            command.attestedSystemDescription to 512,
        )
        if (values.any { (value, max) -> value.isBlank() || value.length > max || !safeJsonString(value) }) return false

        val json = "{\"observedSystemFingerprint\":\"${command.observedSystemFingerprint}\"," +
            "\"observedVendorFingerprint\":\"${command.observedVendorFingerprint}\"," +
            "\"attestedOn\":\"${command.attestedOn}\"," +
            "\"attestedSystemDescription\":\"${command.attestedSystemDescription}\"," +
            "\"source\":\"externally_provisioned\"}"
        val bytes = json.toByteArray(StandardCharsets.UTF_8)
        if (bytes.size > FileApprovedDeviceEvidenceProvider.MAX_BYTES) return false

        val parent = target.parent ?: return false
        var temporary: Path? = null
        return try {
            if (!Files.isDirectory(parent, LinkOption.NOFOLLOW_LINKS) || Files.isSymbolicLink(parent)) return false
            if (Files.exists(target, LinkOption.NOFOLLOW_LINKS) &&
                (!Files.isRegularFile(target, LinkOption.NOFOLLOW_LINKS) || Files.isSymbolicLink(target))) return false
            temporary = Files.createTempFile(parent, ".approved-device-evidence-", ".tmp")
            Files.setPosixFilePermissions(temporary, OWNER_ONLY)
            FileChannel.open(temporary, StandardOpenOption.WRITE, StandardOpenOption.TRUNCATE_EXISTING).use { channel ->
                val buffer = ByteBuffer.wrap(bytes)
                while (buffer.hasRemaining()) channel.write(buffer)
                channel.force(true)
            }
            Files.move(temporary, target, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
            temporary = null
            Files.setPosixFilePermissions(target, OWNER_ONLY)
            FileApprovedDeviceEvidenceProvider(target, expectedUid, today).read() != null
        } catch (_: Exception) {
            false
        } finally {
            temporary?.let { try { Files.deleteIfExists(it) } catch (_: Exception) {} }
            bytes.fill(0)
        }
    }

    private fun safeJsonString(value: String): Boolean =
        value.none { it == '\\' || it == '"' || it.code < 0x20 }

    private companion object {
        val OWNER_ONLY = setOf(PosixFilePermission.OWNER_READ, PosixFilePermission.OWNER_WRITE)
    }
}
