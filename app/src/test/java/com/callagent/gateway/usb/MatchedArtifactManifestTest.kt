package com.callagent.gateway.usb

import java.io.File
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class MatchedArtifactManifestTest {
    @Test
    fun `Android and Linux consume exact canonical device-neutral manifest bytes`() {
        val canonical = File("../protocol/matched-artifact.properties").readBytes()
        val android = File("src/main/res/raw/matched_artifact.properties").readBytes()
        val linux = File("../packaging/linux/matched-artifact.properties").readBytes()

        assertArrayEquals(canonical, android)
        assertArrayEquals(canonical, linux)
        val manifest = MatchedArtifactManifest.parse(canonical)
        assertEquals(1, manifest.schemaVersion)
        assertEquals(1, manifest.bootstrapProtocolVersion)
        assertEquals("1.0.1", manifest.desktopPackageVersion)
        assertEquals("com.callagent.gateway", manifest.androidPackageName)
        assertEquals(333L, manifest.androidVersionCode)
        assertEquals(32, manifest.androidSigningCertificateSha256.size)
        assertEquals(32, MatchedArtifactManifest.sha256(canonical).size)
    }

    @Test
    fun `manifest rejects unknown duplicate missing private and self-digest fields`() {
        val canonical = File("../protocol/matched-artifact.properties").readBytes()
        val forbidden = listOf(
            "adbSerial", "serial", "fingerprint", "controller", "salt", "credential",
            "artifactManifestSha256", "privateKey", "sharedSecret",
        )
        val text = canonical.toString(Charsets.US_ASCII)
        forbidden.forEach { assertFalse("manifest leaked $it", text.contains(it, ignoreCase = true)) }
        listOf(
            canonical + "unknown=value\n".toByteArray(),
            canonical + "schemaVersion=1\n".toByteArray(),
            canonical.toString(Charsets.US_ASCII).replace("schemaVersion=1\n", "").toByteArray(),
            canonical.toString(Charsets.US_ASCII).replace("androidVersionCode=333", "androidVersionCode=0333").toByteArray(),
            canonical.toString(Charsets.US_ASCII).replace("androidVersionCode=333", "androidVersionCode=999999999999999999999999").toByteArray(),
            canonical.toString(Charsets.US_ASCII).replace("desktopPackageVersion=1.0.1", "desktopPackageVersion=01.0.1").toByteArray(),
            canonical.toString(Charsets.US_ASCII).replace(Regex("androidSigningCertificateSha256=[0-9a-f]{64}"), "androidSigningCertificateSha256=${"0".repeat(64)}").toByteArray(),
        ).forEach { bytes ->
            assertTrue(runCatching { MatchedArtifactManifest.parse(bytes) }.isFailure)
        }
    }
}
