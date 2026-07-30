package com.callagent.gateway.usb

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class ControllerBootstrapProtocolTest {
    private val identity = ControllerBootstrapProtocol.Identity(
        adbSerial = "0123456789ABCDEF",
        systemFingerprint = "lineage/gram/gram:15/AP3A/test:user/release-keys",
        vendorFingerprint = "vendor/gram/gram:15/AP3A/test:user/release-keys",
        packageName = "com.callagent.gateway",
        versionCode = "330",
        signingCertificateSha256 = "11".repeat(32),
        artifactManifestSha256 = "22".repeat(32),
        desktopBootstrapVersion = "1",
    )

    @Test
    fun `fixed client hello round trips and transcript binds every identity field`() {
        val hello = ControllerBootstrapProtocol.ClientHello(ByteArray(32) { it.toByte() }, ByteArray(32) { (it + 32).toByte() }, identity)
        val encoded = ControllerBootstrapProtocol.encodeClientHello(hello)
        val decoded = ControllerBootstrapProtocol.decodeClientHello(encoded)

        assertEquals(hello, decoded)
        assertTrue(encoded.size <= ControllerBootstrapProtocol.MAX_FRAME_BYTES)
        val transcript = ControllerBootstrapProtocol.canonicalTranscript(
            decoded,
            ByteArray(32) { (it + 64).toByte() },
            ByteArray(32) { (it + 96).toByte() },
        )
        identity.orderedValues().forEach { value ->
            assertTrue("transcript omitted $value", transcript.toString(Charsets.ISO_8859_1).contains(value))
        }
    }

    @Test
    fun `unknown version trailing bytes oversized fields and malformed public key fail closed`() {
        val valid = ControllerBootstrapProtocol.encodeClientHello(
            ControllerBootstrapProtocol.ClientHello(ByteArray(32), ByteArray(32) { 7 }, identity),
        )
        listOf(
            valid.copyOf().also { it[4] = 2 },
            valid + byteArrayOf(0),
            ControllerBootstrapProtocol.encodeClientHello(
                ControllerBootstrapProtocol.ClientHello(ByteArray(32), ByteArray(32), identity.copy(adbSerial = "x".repeat(513))),
                permitInvalidForTest = true,
            ),
        ).forEach { malformed ->
            try {
                ControllerBootstrapProtocol.decodeClientHello(malformed)
                fail("malformed hello must fail")
            } catch (_: BootstrapProtocolException) {
                // expected
            }
        }
    }

    @Test
    fun `x25519 and hkdf match RFC vectors`() {
        val alicePrivate = hex("77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a")
        val bobPublic = hex("de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f")
        val expectedShared = hex("4a5d9d5ba4ce2dE1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742")
        assertArrayEquals(expectedShared, ControllerBootstrapCrypto.x25519(alicePrivate, bobPublic))

        val ikm = hex("0b".repeat(22))
        val salt = hex("000102030405060708090a0b0c")
        val info = hex("f0f1f2f3f4f5f6f7f8f9")
        assertArrayEquals(
            hex("3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf"),
            ControllerBootstrapCrypto.hkdfSha256(ikm, salt, info, 32),
        )
    }

    @Test
    fun `lease admits shell once expires and stale generation cannot complete`() {
        var now = 1_000L
        val lease = BootstrapClaimLease(nowMillis = { now })
        val first = lease.claim(peerUid = 2000)
        assertFalse(lease.tryClaim(peerUid = 2000).accepted)
        assertFalse(lease.tryClaim(peerUid = 0).accepted)
        assertTrue(lease.isCurrent(first.generation))

        now += BootstrapClaimLease.DEADLINE_MILLIS + 1
        assertFalse(lease.isCurrent(first.generation))
        val second = lease.claim(peerUid = 2000)
        assertTrue(second.generation > first.generation)
        assertFalse(lease.complete(first.generation))
        assertTrue(lease.complete(second.generation))
    }

    private fun hex(value: String): ByteArray = value.chunked(2).map { it.toInt(16).toByte() }.toByteArray()
}
