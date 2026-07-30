package com.callagent.gateway.usb

import java.security.MessageDigest
import java.util.Locale

data class MatchedArtifactManifest(
    val schemaVersion: Int,
    val bootstrapProtocolVersion: Int,
    val desktopPackageVersion: String,
    val androidPackageName: String,
    val androidVersionCode: Long,
    val androidSigningCertificateSha256: ByteArray,
) {
    companion object {
        private val keys = listOf("schemaVersion", "bootstrapProtocolVersion", "desktopPackageVersion", "androidPackageName", "androidVersionCode", "androidSigningCertificateSha256")
        private val hex = Regex("[0-9a-f]{64}")

        fun parse(bytes: ByteArray): MatchedArtifactManifest {
            require(bytes.isNotEmpty() && bytes.last() == '\n'.code.toByte()) { "manifest must end with LF" }
            require(bytes.all { it == '\n'.code.toByte() || it.toInt() in 0x20..0x7e }) { "manifest must be strict ASCII" }
            val lines = bytes.toString(Charsets.US_ASCII).dropLast(1).split('\n')
            require(lines.size == keys.size) { "manifest field count is invalid" }
            val values = lines.mapIndexed { index, line ->
                require(line.count { it == '=' } == 1 && line.substringBefore('=') == keys[index]) { "manifest field order is invalid" }
                line.substringAfter('=').also { require(it.isNotEmpty()) { "manifest value is empty" } }
            }
            require(values[0] == "1" && values[1] == "1") { "manifest schema is unsupported" }
            require(Regex("(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)").matches(values[2])) { "desktop package version is invalid" }
            require(values[2] == "0.2.5" && values[3] == "com.callagent.gateway" && values[4] == "332") { "manifest release identity is unsupported" }
            require(hex.matches(values[5]) && values[5].any { it != '0' }) { "signer digest is invalid" }
            val versionCode = values[4].toLongOrNull()
            require(versionCode != null && versionCode > 0) { "Android version is invalid" }
            return MatchedArtifactManifest(1, 1, values[2], values[3], versionCode, values[5].hexBytes())
        }

        fun sha256(bytes: ByteArray): ByteArray = MessageDigest.getInstance("SHA-256").digest(bytes)
        private fun String.hexBytes() = chunked(2).map { it.toInt(16).toByte() }.toByteArray()
    }

    override fun equals(other: Any?): Boolean = other is MatchedArtifactManifest && schemaVersion == other.schemaVersion && bootstrapProtocolVersion == other.bootstrapProtocolVersion && desktopPackageVersion == other.desktopPackageVersion && androidPackageName == other.androidPackageName && androidVersionCode == other.androidVersionCode && MessageDigest.isEqual(androidSigningCertificateSha256, other.androidSigningCertificateSha256)
    override fun hashCode(): Int = 31 * androidVersionCode.hashCode() + androidSigningCertificateSha256.contentHashCode()
}
