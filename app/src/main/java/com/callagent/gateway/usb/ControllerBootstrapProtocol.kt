package com.callagent.gateway.usb

import androidx.annotation.RequiresApi
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.charset.CodingErrorAction
import java.nio.charset.StandardCharsets
import java.security.KeyFactory
import java.security.MessageDigest
import java.security.spec.PKCS8EncodedKeySpec
import java.security.spec.X509EncodedKeySpec
import java.util.Arrays
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

class BootstrapProtocolException(message: String) : Exception(message)

/** Fixed, bounded bootstrap-v1 codec shared with the desktop implementation. */
object ControllerBootstrapProtocol {
    const val MAX_FRAME_BYTES = 4096
    const val NONCE_BYTES = 32
    const val PUBLIC_KEY_BYTES = 32
    const val CONTROLLER_KEY_BYTES = 32
    private const val MAX_TEXT_BYTES = 512
    private const val VERSION: Int = 1
    private const val CLIENT_HELLO: Int = 1
    private val MAGIC = byteArrayOf('G'.code.toByte(), '2'.code.toByte(), 'B'.code.toByte(), '1'.code.toByte())

    data class Identity(
        val adbSerial: String,
        val systemFingerprint: String,
        val vendorFingerprint: String,
        val packageName: String,
        val versionCode: String,
        val signingCertificateSha256: String,
        val artifactManifestSha256: String,
        val desktopBootstrapVersion: String,
    ) {
        fun orderedValues(): List<String> = listOf(
            adbSerial, systemFingerprint, vendorFingerprint, packageName, versionCode,
            signingCertificateSha256, artifactManifestSha256, desktopBootstrapVersion,
        )
    }

    class ClientHello(nonce: ByteArray, publicKey: ByteArray, val identity: Identity) {
        val nonce = nonce.copyOf()
        val publicKey = publicKey.copyOf()

        override fun equals(other: Any?): Boolean = other is ClientHello &&
            nonce.contentEquals(other.nonce) && publicKey.contentEquals(other.publicKey) && identity == other.identity
        override fun hashCode(): Int = 31 * nonce.contentHashCode() + 31 * publicKey.contentHashCode() + identity.hashCode()
    }

    fun encodeClientHello(hello: ClientHello, permitInvalidForTest: Boolean = false): ByteArray {
        if (!permitInvalidForTest) validateHello(hello)
        val out = ByteArrayOutputStream()
        out.write(MAGIC)
        out.write(VERSION)
        out.write(CLIENT_HELLO)
        out.write(byteArrayOf(0, 0))
        out.write(hello.nonce)
        out.write(hello.publicKey)
        hello.identity.orderedValues().forEach { writeText(out, it) }
        return out.toByteArray().also {
            if (!permitInvalidForTest && it.size > MAX_FRAME_BYTES) throw IllegalArgumentException("bootstrap frame exceeds limit")
        }
    }

    @Throws(BootstrapProtocolException::class)
    fun decodeClientHello(frame: ByteArray): ClientHello {
        if (frame.size !in 1..MAX_FRAME_BYTES) fail("invalid bootstrap frame length")
        val input = ByteBuffer.wrap(frame).order(ByteOrder.BIG_ENDIAN)
        if (input.remaining() < 72) fail("truncated client hello")
        val magic = ByteArray(4).also(input::get)
        if (!MessageDigest.isEqual(MAGIC, magic)) fail("invalid bootstrap magic")
        if (input.get().toInt() and 0xff != VERSION) fail("unsupported bootstrap version")
        if (input.get().toInt() and 0xff != CLIENT_HELLO) fail("unexpected bootstrap message")
        if (input.short.toInt() != 0) fail("reserved bootstrap bits set")
        val nonce = ByteArray(NONCE_BYTES).also(input::get)
        val publicKey = ByteArray(PUBLIC_KEY_BYTES).also(input::get)
        val values = ArrayList<String>(8)
        repeat(8) { values += readText(input) }
        if (input.hasRemaining()) fail("trailing bootstrap bytes")
        val hello = ClientHello(
            nonce,
            publicKey,
            Identity(values[0], values[1], values[2], values[3], values[4], values[5], values[6], values[7]),
        )
        try { validateHello(hello) } catch (e: IllegalArgumentException) { fail(e.message ?: "invalid client hello") }
        return hello
    }

    fun canonicalTranscript(client: ClientHello, serverNonce: ByteArray, serverPublicKey: ByteArray): ByteArray {
        require(serverNonce.size == NONCE_BYTES && serverPublicKey.size == PUBLIC_KEY_BYTES)
        val out = ByteArrayOutputStream()
        out.write("agentcall/controller-bootstrap/transcript/v1".toByteArray(StandardCharsets.US_ASCII))
        val clientBytes = encodeClientHello(client)
        writeU16(out, clientBytes.size)
        out.write(clientBytes)
        out.write(serverNonce)
        out.write(serverPublicKey)
        return out.toByteArray()
    }

    private fun validateHello(hello: ClientHello) {
        require(hello.nonce.size == NONCE_BYTES) { "nonce must be 32 bytes" }
        require(hello.publicKey.size == PUBLIC_KEY_BYTES && hello.publicKey.any { it.toInt() != 0 }) {
            "public key must be a non-zero 32-byte value"
        }
        hello.identity.orderedValues().forEach { value ->
            val bytes = value.toByteArray(StandardCharsets.UTF_8)
            require(bytes.isNotEmpty() && bytes.size <= MAX_TEXT_BYTES && '\u0000' !in value) { "invalid identity field" }
        }
    }

    private fun writeText(out: ByteArrayOutputStream, value: String) {
        val bytes = value.toByteArray(StandardCharsets.UTF_8)
        writeU16(out, bytes.size)
        out.write(bytes)
    }

    private fun writeU16(out: ByteArrayOutputStream, value: Int) {
        out.write(value ushr 8 and 0xff)
        out.write(value and 0xff)
    }

    private fun readText(input: ByteBuffer): String {
        if (input.remaining() < 2) fail("truncated identity length")
        val length = input.short.toInt() and 0xffff
        if (length !in 1..MAX_TEXT_BYTES || length > input.remaining()) fail("invalid identity length")
        val bytes = ByteArray(length).also(input::get)
        return try {
            StandardCharsets.UTF_8.newDecoder()
                .onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT)
                .decode(ByteBuffer.wrap(bytes)).toString().also {
                    if ('\u0000' in it) fail("invalid identity value")
                }
        } catch (_: Exception) {
            fail("identity is not canonical UTF-8")
        } finally {
            Arrays.fill(bytes, 0)
        }
    }

    private fun fail(message: String): Nothing = throw BootstrapProtocolException(message)
}

/** Pure cryptographic primitives; callers own and clear all returned arrays. */
@RequiresApi(33)
object ControllerBootstrapCrypto {
    private val X25519_PRIVATE_PREFIX = byteArrayOf(
        0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06,
        0x03, 0x2b, 0x65, 0x6e, 0x04, 0x22, 0x04, 0x20,
    )
    private val X25519_PUBLIC_PREFIX = byteArrayOf(
        0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65,
        0x6e, 0x03, 0x21, 0x00,
    )

    fun x25519(privateKey: ByteArray, peerPublicKey: ByteArray): ByteArray {
        require(privateKey.size == 32 && peerPublicKey.size == 32)
        val factory = KeyFactory.getInstance("X25519")
        val encodedPrivate = X25519_PRIVATE_PREFIX + privateKey
        val encodedPublic = X25519_PUBLIC_PREFIX + peerPublicKey
        try {
            val agreement = javax.crypto.KeyAgreement.getInstance("X25519")
            agreement.init(factory.generatePrivate(PKCS8EncodedKeySpec(encodedPrivate)))
            agreement.doPhase(factory.generatePublic(X509EncodedKeySpec(encodedPublic)), true)
            return agreement.generateSecret().also { require(it.any { byte -> byte.toInt() != 0 }) { "invalid X25519 peer key" } }
        } finally {
            Arrays.fill(encodedPrivate, 0)
            Arrays.fill(encodedPublic, 0)
        }
    }

    fun hkdfSha256(ikm: ByteArray, salt: ByteArray, info: ByteArray, length: Int): ByteArray {
        require(length in 1..(255 * 32))
        val mac = Mac.getInstance("HmacSHA256")
        val effectiveSalt = if (salt.isEmpty()) ByteArray(32) else salt.copyOf()
        val prk = try {
            mac.init(SecretKeySpec(effectiveSalt, "HmacSHA256"))
            mac.doFinal(ikm)
        } finally {
            Arrays.fill(effectiveSalt, 0)
        }
        var previous = ByteArray(0)
        val output = ByteArrayOutputStream()
        try {
            var counter = 1
            while (output.size() < length) {
                mac.init(SecretKeySpec(prk, "HmacSHA256"))
                val next = mac.doFinal(previous + info + byteArrayOf(counter.toByte()))
                Arrays.fill(previous, 0)
                previous = next
                output.write(next)
                counter++
            }
            return output.toByteArray().copyOf(length)
        } finally {
            Arrays.fill(previous, 0)
            Arrays.fill(prk, 0)
        }
    }

    fun deriveControllerKey(shared: ByteArray, clientNonce: ByteArray, serverNonce: ByteArray, transcript: ByteArray): ByteArray {
        val salt = clientNonce + serverNonce
        val info = "agentcall/controller-bootstrap/v1".toByteArray(StandardCharsets.US_ASCII) + transcript
        return try {
            hkdfSha256(shared, salt, info, ControllerBootstrapProtocol.CONTROLLER_KEY_BYTES)
        } finally {
            Arrays.fill(salt, 0)
            Arrays.fill(info, 0)
        }
    }
}

/** One shell claimant per 30-second generation; stale callbacks cannot complete a replacement generation. */
class BootstrapClaimLease(private val nowMillis: () -> Long = System::currentTimeMillis) {
    data class Claim(val accepted: Boolean, val generation: Long = 0)
    private var generation = 0L
    private var claimedAt = 0L
    private var active = false

    @Synchronized fun tryClaim(peerUid: Int): Claim {
        expireLocked()
        if (peerUid != SHELL_UID || active) return Claim(false)
        generation++
        claimedAt = nowMillis()
        active = true
        return Claim(true, generation)
    }

    fun claim(peerUid: Int): Claim = tryClaim(peerUid).also { check(it.accepted) { "bootstrap claimant rejected" } }

    @Synchronized fun isCurrent(candidate: Long): Boolean {
        expireLocked()
        return active && candidate == generation
    }

    @Synchronized fun complete(candidate: Long): Boolean {
        if (!isCurrent(candidate)) return false
        active = false
        return true
    }

    @Synchronized fun cancel(candidate: Long) {
        if (candidate == generation) active = false
    }

    private fun expireLocked() {
        if (active && nowMillis() - claimedAt > DEADLINE_MILLIS) active = false
    }

    companion object {
        const val SHELL_UID = 2000
        const val DEADLINE_MILLIS = 30_000L
    }
}
