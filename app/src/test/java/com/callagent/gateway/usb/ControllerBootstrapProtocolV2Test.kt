package com.callagent.gateway.usb

import java.io.File
import java.util.Properties
import org.junit.Assert.*
import org.junit.Test

class ControllerBootstrapProtocolV2Test {
    private val identity = ControllerBootstrapProtocolV2.Identity("SYNTHETIC-ADB-0001", "synthetic_product", "synthetic_device", 35, "synthetic/system/device:15/AP3A/public:user/release-keys", "synthetic/vendor/device:15/AP3A/public:user/release-keys", "com.callagent.gateway", 332, ByteArray(32) { 0x55 }, ByteArray(32) { 0x66 }, 2, "0.2.5")
    private val transcript = ControllerBootstrapProtocolV2.Transcript(ByteArray(32) { (it + 1).toByte() }, ByteArray(32) { (it + 33).toByte() }, ByteArray(32) { (it + 65).toByte() }, ByteArray(32) { (it + 97).toByte() }, identity)

    @Test fun `shared positive vector is exact and round trips`() {
        val expected = properties("bootstrap-v2-vectors.properties").getProperty("positive.transcript.hex")
        val encoded = ControllerBootstrapProtocolV2.encodeTranscript(transcript)
        assertEquals(expected, encoded.hex())
        assertEquals(transcript, ControllerBootstrapProtocolV2.decodeTranscript(encoded))
    }

    @Test fun `shared mutation corpus is strict complete and non-vacuous`() {
        val corpus = properties("bootstrap-v2-negative.properties")
        val expectedNames = setOf(
            "unknownVersion", "unknownType", "reserved", "trailing", "truncated", "overlongAdbSerial",
            "malformedUtf8", "noncanonicalUtf8", "zeroDesktopNonce", "zeroPhoneNonce", "zeroDesktopKey",
            "zeroPhoneKey", "nonceReflection", "keyReflection", "productDrift", "deviceDrift", "apiDrift",
            "systemFingerprintDrift", "vendorFingerprintDrift", "packageDrift", "versionDrift", "signerDrift",
            "manifestDrift", "downgrade", "desktopPackageDrift", "adbSerialDrift",
        )
        assertEquals(expectedNames, corpus.stringPropertyNames())
        val valid = ControllerBootstrapProtocolV2.encodeTranscript(transcript)
        val ran = mutableSetOf<String>()
        corpus.stringPropertyNames().sorted().forEach { name ->
            val spec = corpus.getProperty(name)
            if (spec.startsWith("identity:")) {
                val drift = mutateIdentity(spec)
                assertNotEquals(identity, drift)
                if (name == "downgrade") {
                    assertTrue(runCatching { ControllerBootstrapProtocolV2.encodeTranscript(transcript.copy(identity = drift)) }.isFailure)
                } else {
                    val changed = ControllerBootstrapProtocolV2.encodeTranscript(transcript.copy(identity = drift))
                    assertFalse(valid.contentEquals(changed))
                    assertFailsBootstrap(name) { ControllerBootstrapProtocolV2.decodeTranscript(changed, ControllerBootstrapProtocolV2.IdentityExpectation(identity)) }
                }
            } else {
                val changed = mutate(valid, spec)
                assertFalse("$name mutation did not change bytes", valid.contentEquals(changed))
                assertFailsBootstrap(name) { ControllerBootstrapProtocolV2.decodeTranscript(changed) }
            }
            assertTrue("duplicate corpus case $name", ran.add(name))
        }
        assertEquals(expectedNames, ran)
    }

    private fun mutateIdentity(spec: String): ControllerBootstrapProtocolV2.Identity {
        val parts = spec.split(':')
        require(parts.size == 2 && parts[0] == "identity")
        return when (parts[1]) {
            "adbSerial" -> identity.copy(adbSerial = "drift")
            "product" -> identity.copy(product = "drift")
            "device" -> identity.copy(device = "drift")
            "api" -> identity.copy(api = 34)
            "systemFingerprint" -> identity.copy(systemFingerprint = "drift")
            "vendorFingerprint" -> identity.copy(vendorFingerprint = "drift")
            "packageName" -> identity.copy(packageName = "drift")
            "versionCode" -> identity.copy(versionCode = 329)
            "signingCertificateSha256" -> identity.copy(signingCertificateSha256 = ByteArray(32) { 1 })
            "matchedManifestSha256" -> identity.copy(matchedManifestSha256 = ByteArray(32) { 1 })
            "desktopBootstrapVersion" -> identity.copy(desktopBootstrapVersion = 1)
            "desktopPackageVersion" -> identity.copy(desktopPackageVersion = "0.2.2")
            else -> throw IllegalArgumentException("unknown identity operation")
        }
    }

    private fun assertFailsBootstrap(name: String, action: () -> Unit) {
        try { action(); fail(name) } catch (_: BootstrapProtocolException) { }
    }

    @Test fun `encoder rejects unpaired surrogates in every text identity field`() {
        for (surrogate in listOf("\uD800", "\uDC00")) {
            val invalidIdentities = listOf(
                identity.copy(adbSerial = surrogate),
                identity.copy(product = surrogate),
                identity.copy(device = surrogate),
                identity.copy(systemFingerprint = surrogate),
                identity.copy(vendorFingerprint = surrogate),
                identity.copy(packageName = surrogate),
                identity.copy(desktopPackageVersion = surrogate),
            )
            invalidIdentities.forEach { invalid ->
                val failure = runCatching {
                    ControllerBootstrapProtocolV2.encodeTranscript(transcript.copy(identity = invalid))
                }.exceptionOrNull()
                assertTrue("unpaired surrogate must be rejected", failure is IllegalArgumentException)
            }
        }
    }

    @Test fun `rejects identity drift zeros and reflection`() {
        val e = ControllerBootstrapProtocolV2.IdentityExpectation(identity)
        assertTrue(e.matches(identity))
        listOf(identity.copy(product = "drift"), identity.copy(device = "drift"), identity.copy(api = 34), identity.copy(systemFingerprint = "drift"), identity.copy(vendorFingerprint = "drift"), identity.copy(packageName = "drift"), identity.copy(versionCode = 329), identity.copy(signingCertificateSha256 = ByteArray(32) { 1 }), identity.copy(matchedManifestSha256 = ByteArray(32) { 1 }), identity.copy(desktopBootstrapVersion = 1), identity.copy(desktopPackageVersion = "0.2.2")).forEach { assertFalse(e.matches(it)) }
        listOf(
            transcript.copy(desktopNonce = ByteArray(32)), transcript.copy(phoneNonce = ByteArray(32)),
            transcript.copy(desktopPublicKey = ByteArray(32)), transcript.copy(phonePublicKey = ByteArray(32)),
            transcript.copy(phoneNonce = transcript.desktopNonce), transcript.copy(phonePublicKey = transcript.desktopPublicKey),
            transcript.copy(identity = identity.copy(signingCertificateSha256 = ByteArray(32))),
            transcript.copy(identity = identity.copy(matchedManifestSha256 = ByteArray(32))),
        ).forEach { assertTrue(runCatching { ControllerBootstrapProtocolV2.encodeTranscript(it) }.isFailure) }
    }

    private fun mutate(valid: ByteArray, spec: String): ByteArray {
        require(spec.isNotEmpty())
        var bytes = valid.copyOf()
        spec.split(';').forEach { operation ->
            val p = operation.split(':')
            fun decimal(index: Int): Int {
                require(index < p.size && Regex("0|[1-9][0-9]*").matches(p[index]))
                return p[index].toIntOrNull() ?: throw IllegalArgumentException("decimal overflow")
            }
            fun hex(index: Int): ByteArray {
                require(index < p.size && p[index].isNotEmpty() && p[index].length % 2 == 0 && Regex("[0-9a-f]+").matches(p[index]))
                return p[index].chunked(2).map { it.toInt(16).toByte() }.toByteArray()
            }
            when (p.firstOrNull()) {
                "set" -> { require(p.size == 3); val at = decimal(1); val value = hex(2); require(at <= bytes.size - value.size); value.copyInto(bytes, at) }
                "zero" -> { require(p.size == 3); val at = decimal(1); val count = decimal(2); require(count > 0 && at <= bytes.size - count); bytes.fill(0, at, at + count) }
                "copy" -> { require(p.size == 4); val from = decimal(1); val to = decimal(2); val count = decimal(3); require(count > 0 && from <= bytes.size - count && to <= bytes.size - count); bytes.copyOfRange(from, from + count).copyInto(bytes, to) }
                "append" -> { require(p.size == 2); val value = hex(1); require(bytes.size <= ControllerBootstrapProtocolV2.MAX_MESSAGE_BYTES - value.size); bytes += value }
                "truncate" -> { require(p.size == 2); val count = decimal(1); require(count > 0 && count < bytes.size); bytes = bytes.copyOf(bytes.size - count) }
                else -> throw IllegalArgumentException("unknown mutation operation")
            }
        }
        return bytes
    }
    private fun properties(name: String) = Properties().also { File("../protocol/$name").inputStream().use(it::load) }
    private fun ByteArray.hex() = joinToString("") { "%02x".format(it) }
}
