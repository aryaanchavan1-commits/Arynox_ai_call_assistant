package com.callagent.gateway

import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.Path
import java.nio.file.attribute.BasicFileAttributes
import java.time.LocalDate
import java.time.temporal.ChronoUnit

/** Qualification evidence provisioned outside the app and consumed read-only. */
data class ApprovedDeviceEvidence(
    val observedSystemFingerprint: String,
    val observedVendorFingerprint: String,
    val attestedOn: String,
    val attestedSystemDescription: String,
    val source: Source,
) {
    enum class Source { EXTERNALLY_PROVISIONED }
}

fun interface ApprovedDeviceEvidenceProvider {
    fun read(): ApprovedDeviceEvidence?
}

/** Strict reader for the single owner-only evidence artifact in app-private storage. */
class FileApprovedDeviceEvidenceProvider(
    private val path: Path,
    private val expectedOwnerUid: Int,
    private val today: () -> LocalDate = { LocalDate.now() },
) : ApprovedDeviceEvidenceProvider {
    override fun read(): ApprovedDeviceEvidence? {
        return try {
        if (path.fileName?.toString() != FILE_NAME) return null
        val attributes = Files.readAttributes(
            path,
            BasicFileAttributes::class.java,
            LinkOption.NOFOLLOW_LINKS,
        )
        if (!attributes.isRegularFile || attributes.isSymbolicLink || attributes.size() > MAX_BYTES) return null
        val mode = (Files.getAttribute(path, "unix:mode", LinkOption.NOFOLLOW_LINKS) as? Number)?.toInt()
            ?: return null
        val ownerUid = (Files.getAttribute(path, "unix:uid", LinkOption.NOFOLLOW_LINKS) as? Number)?.toInt()
            ?: return null
        if (ownerUid != expectedOwnerUid || mode and 0x1ff != 0x180) return null

        val bytes = Files.readAllBytes(path)
        if (bytes.size > MAX_BYTES) return null
        val values = StrictStringObjectParser(String(bytes, StandardCharsets.UTF_8)).parse() ?: return null
        if (values.keys != REQUIRED_KEYS) return null
        if (values.getValue("source") != SOURCE_VALUE) return null

        val dateText = values.getValue("attestedOn")
        val date = LocalDate.parse(dateText)
        val age = ChronoUnit.DAYS.between(date, today())
        if (age !in 0..MAX_AGE_DAYS) return null
        fun bounded(key: String, max: Int): String? = values.getValue(key).takeIf { it.isNotBlank() && it.length <= max }

        ApprovedDeviceEvidence(
            observedSystemFingerprint = bounded("observedSystemFingerprint", MAX_FINGERPRINT_CHARS) ?: return null,
            observedVendorFingerprint = bounded("observedVendorFingerprint", MAX_FINGERPRINT_CHARS) ?: return null,
            attestedOn = dateText,
            attestedSystemDescription = bounded("attestedSystemDescription", MAX_DESCRIPTION_CHARS) ?: return null,
            source = ApprovedDeviceEvidence.Source.EXTERNALLY_PROVISIONED,
        )
        } catch (_: Exception) {
            null
        }
    }

    companion object {
        const val FILE_NAME = "approved-device-evidence.json"
        const val MAX_BYTES = 4096
        private const val MAX_AGE_DAYS = 7L
        private const val MAX_FINGERPRINT_CHARS = 1024
        private const val MAX_DESCRIPTION_CHARS = 512
        private const val SOURCE_VALUE = "externally_provisioned"
        private val REQUIRED_KEYS = setOf(
            "observedSystemFingerprint",
            "observedVendorFingerprint",
            "attestedOn",
            "attestedSystemDescription",
            "source",
        )
    }
}

/** Minimal JSON string-object parser: rejects duplicate keys, escapes, scalars and trailing data. */
private class StrictStringObjectParser(private val input: String) {
    private var offset = 0

    fun parse(): Map<String, String>? {
        skipWhitespace()
        if (!take('{')) return null
        val result = linkedMapOf<String, String>()
        skipWhitespace()
        if (take('}')) return result.takeIf { atEnd() }
        while (true) {
            val key = string() ?: return null
            skipWhitespace()
            if (!take(':')) return null
            val value = string() ?: return null
            if (result.put(key, value) != null) return null
            skipWhitespace()
            if (take('}')) return result.takeIf { atEnd() }
            if (!take(',')) return null
        }
    }

    private fun string(): String? {
        skipWhitespace()
        if (!take('"')) return null
        val start = offset
        while (offset < input.length && input[offset] != '"') {
            val char = input[offset]
            if (char == '\\' || char.code < 0x20) return null
            offset++
        }
        if (offset >= input.length) return null
        return input.substring(start, offset).also { offset++ }
    }

    private fun skipWhitespace() {
        while (offset < input.length && input[offset] in " \n\r\t") offset++
    }

    private fun take(expected: Char): Boolean {
        skipWhitespace()
        if (offset >= input.length || input[offset] != expected) return false
        offset++
        return true
    }

    private fun atEnd(): Boolean {
        skipWhitespace()
        return offset == input.length
    }
}
