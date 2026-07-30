package com.callagent.gateway.usb

import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.charset.CodingErrorAction
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.text.Normalizer

/** Side-by-side bootstrap-v2 transcript codec. It is intentionally not wired to the v1 lifecycle. */
object ControllerBootstrapProtocolV2 {
    const val MAX_MESSAGE_BYTES = 4096
    private const val VERSION = 2
    private const val TRANSCRIPT = 1
    private val MAGIC = "G2B2".toByteArray(StandardCharsets.US_ASCII)

    data class Identity(
        val adbSerial: String, val product: String, val device: String, val api: Int,
        val systemFingerprint: String, val vendorFingerprint: String, val packageName: String,
        val versionCode: Int, val signingCertificateSha256: ByteArray, val matchedManifestSha256: ByteArray,
        val desktopBootstrapVersion: Int, val desktopPackageVersion: String,
    ) {
        override fun equals(other: Any?): Boolean = other is Identity && adbSerial == other.adbSerial && product == other.product && device == other.device && api == other.api && systemFingerprint == other.systemFingerprint && vendorFingerprint == other.vendorFingerprint && packageName == other.packageName && versionCode == other.versionCode && signingCertificateSha256.contentEquals(other.signingCertificateSha256) && matchedManifestSha256.contentEquals(other.matchedManifestSha256) && desktopBootstrapVersion == other.desktopBootstrapVersion && desktopPackageVersion == other.desktopPackageVersion
        override fun hashCode(): Int = 31 * adbSerial.hashCode() + signingCertificateSha256.contentHashCode()
    }

    data class Transcript(
        val desktopNonce: ByteArray, val phoneNonce: ByteArray,
        val desktopPublicKey: ByteArray, val phonePublicKey: ByteArray, val identity: Identity,
    ) {
        override fun equals(other: Any?): Boolean = other is Transcript && desktopNonce.contentEquals(other.desktopNonce) && phoneNonce.contentEquals(other.phoneNonce) && desktopPublicKey.contentEquals(other.desktopPublicKey) && phonePublicKey.contentEquals(other.phonePublicKey) && identity == other.identity
        override fun hashCode(): Int = 31 * desktopNonce.contentHashCode() + identity.hashCode()
    }

    class IdentityExpectation(private val expected: Identity) {
        fun matches(actual: Identity): Boolean =
            expected.adbSerial == actual.adbSerial && expected.product == actual.product &&
                expected.device == actual.device && expected.api == actual.api &&
                expected.systemFingerprint == actual.systemFingerprint &&
                expected.vendorFingerprint == actual.vendorFingerprint &&
                expected.packageName == actual.packageName && expected.versionCode == actual.versionCode &&
                MessageDigest.isEqual(expected.signingCertificateSha256, actual.signingCertificateSha256) &&
                MessageDigest.isEqual(expected.matchedManifestSha256, actual.matchedManifestSha256) &&
                expected.desktopBootstrapVersion == actual.desktopBootstrapVersion &&
                expected.desktopPackageVersion == actual.desktopPackageVersion
    }

    fun encodeTranscript(value: Transcript): ByteArray {
        validate(value)
        val out = ByteArrayOutputStream()
        out.write(MAGIC); out.write(VERSION); out.write(TRANSCRIPT); u16(out, 0)
        out.write(value.desktopNonce); out.write(value.phoneNonce); out.write(value.desktopPublicKey); out.write(value.phonePublicKey)
        text(out, value.identity.adbSerial, 128); text(out, value.identity.product, 128); text(out, value.identity.device, 128)
        u32(out, value.identity.api); text(out, value.identity.systemFingerprint, 512); text(out, value.identity.vendorFingerprint, 512)
        text(out, value.identity.packageName, 255); u32(out, value.identity.versionCode)
        out.write(value.identity.signingCertificateSha256); out.write(value.identity.matchedManifestSha256)
        u32(out, value.identity.desktopBootstrapVersion); text(out, value.identity.desktopPackageVersion, 64)
        return out.toByteArray().also { require(it.size <= MAX_MESSAGE_BYTES) { "v2 transcript exceeds limit" } }
    }

    @Throws(BootstrapProtocolException::class)
    fun decodeTranscript(bytes: ByteArray, expectation: IdentityExpectation? = null): Transcript {
        if (bytes.size !in 1..MAX_MESSAGE_BYTES) fail("invalid v2 transcript length")
        val input = ByteBuffer.wrap(bytes).order(ByteOrder.BIG_ENDIAN)
        if (input.remaining() < 136) fail("truncated v2 transcript")
        val magic = ByteArray(4).also(input::get)
        if (!MessageDigest.isEqual(magic, MAGIC)) fail("invalid v2 magic")
        if (u8(input) != VERSION) fail("unsupported v2 version")
        if (u8(input) != TRANSCRIPT) fail("unexpected v2 message type")
        if (input.short.toInt() != 0) fail("reserved v2 bits set")
        val dn = fixed(input, 32); val pn = fixed(input, 32); val dk = fixed(input, 32); val pk = fixed(input, 32)
        val identity = Identity(text(input, 128), text(input, 128), text(input, 128), positiveU32(input), text(input, 512), text(input, 512), text(input, 255), positiveU32(input), fixed(input, 32), fixed(input, 32), positiveU32(input), text(input, 64))
        if (input.hasRemaining()) fail("trailing v2 bytes")
        val result = Transcript(dn, pn, dk, pk, identity)
        try { validate(result) } catch (e: IllegalArgumentException) { fail(e.message ?: "invalid v2 transcript") }
        if (expectation != null && !expectation.matches(identity)) fail("v2 identity mismatch")
        return result
    }

    private fun validate(value: Transcript) {
        listOf(value.desktopNonce, value.phoneNonce, value.desktopPublicKey, value.phonePublicKey).forEach { require(it.size == 32 && it.any { b -> b.toInt() != 0 }) { "nonce and key fields must be nonzero 32-byte values" } }
        require(!value.desktopNonce.contentEquals(value.phoneNonce)) { "nonce reflection" }
        require(!value.desktopPublicKey.contentEquals(value.phonePublicKey)) { "key reflection" }
        require(value.identity.api > 0 && value.identity.versionCode > 0 && value.identity.desktopBootstrapVersion == 2) { "invalid or downgraded fixed-width identity" }
        require(value.identity.signingCertificateSha256.size == 32 && value.identity.signingCertificateSha256.any { it.toInt() != 0 } && value.identity.matchedManifestSha256.size == 32 && value.identity.matchedManifestSha256.any { it.toInt() != 0 }) { "digests must be nonzero 32-byte values" }
        listOf(value.identity.adbSerial to 128, value.identity.product to 128, value.identity.device to 128, value.identity.systemFingerprint to 512, value.identity.vendorFingerprint to 512, value.identity.packageName to 255, value.identity.desktopPackageVersion to 64).forEach { (s, max) -> canonical(s, max) }
    }

    private fun canonical(value: String, max: Int): ByteArray {
        val encoded = try {
            val buffer = StandardCharsets.UTF_8.newEncoder()
                .onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT)
                .encode(java.nio.CharBuffer.wrap(value))
            ByteArray(buffer.remaining()).also(buffer::get)
        } catch (_: Exception) {
            throw IllegalArgumentException("text must be bounded canonical NFC UTF-8")
        }
        require(value.isNotEmpty() && encoded.size <= max && value.none { it.code < 0x20 || it.code == 0x7f } && Normalizer.isNormalized(value, Normalizer.Form.NFC)) { "text must be bounded canonical NFC UTF-8" }
        return encoded
    }
    private fun text(out: ByteArrayOutputStream, value: String, max: Int) { val b = canonical(value, max); u16(out, b.size); out.write(b) }
    private fun text(input: ByteBuffer, max: Int): String { if (input.remaining() < 2) fail("truncated text length"); val n = input.short.toInt() and 0xffff; if (n !in 1..max || n > input.remaining()) fail("invalid text length"); val b = ByteArray(n).also(input::get); val s = try { StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(b)).toString() } catch (_: Exception) { fail("malformed UTF-8") }; try { canonical(s, max) } catch (_: IllegalArgumentException) { fail("noncanonical UTF-8") }; return s }
    private fun fixed(input: ByteBuffer, n: Int): ByteArray { if (input.remaining() < n) fail("truncated fixed field"); return ByteArray(n).also(input::get) }
    private fun u8(input: ByteBuffer) = input.get().toInt() and 0xff
    private fun positiveU32(input: ByteBuffer): Int { if (input.remaining() < 4) fail("truncated integer"); val n = input.int; if (n <= 0) fail("invalid integer"); return n }
    private fun u16(out: ByteArrayOutputStream, n: Int) { out.write(n ushr 8); out.write(n) }
    private fun u32(out: ByteArrayOutputStream, n: Int) { require(n > 0); out.write(n ushr 24); out.write(n ushr 16); out.write(n ushr 8); out.write(n) }
    private fun fail(message: String): Nothing = throw BootstrapProtocolException(message)
}
