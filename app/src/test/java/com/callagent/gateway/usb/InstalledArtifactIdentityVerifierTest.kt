package com.callagent.gateway.usb

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class InstalledArtifactIdentityVerifierTest {
    private val signer = ByteArray(32) { 0x55 }
    private val manifest = MatchedArtifactManifest(
        schemaVersion = 1,
        bootstrapProtocolVersion = 1,
        desktopPackageVersion = "1.0.0",
        androidPackageName = "com.callagent.gateway",
        androidVersionCode = 332,
        androidSigningCertificateSha256 = signer,
    )
    private val build = InstalledArtifactIdentityVerifier.BuildFacts(
        product = "synthetic_product",
        device = "synthetic_device",
        api = 35,
        systemFingerprint = "synthetic/system/device:15/AP3A/public:user/release-keys",
        vendorFingerprint = "synthetic/vendor/device:15/AP3A/public:user/release-keys",
    )
    private val installed = InstalledArtifactIdentityVerifier.PackageFacts(
        packageName = "com.callagent.gateway",
        versionCode = 332,
        currentSignerSha256 = listOf(signer),
    )
    private val claim = ControllerBootstrapProtocolV2.Identity(
        adbSerial = "SYNTHETIC-ADB-0001",
        product = build.product,
        device = build.device,
        api = build.api,
        systemFingerprint = build.systemFingerprint,
        vendorFingerprint = build.vendorFingerprint,
        packageName = installed.packageName,
        versionCode = installed.versionCode.toInt(),
        signingCertificateSha256 = signer,
        matchedManifestSha256 = ByteArray(32) { 0x66 },
        desktopBootstrapVersion = 1,
        desktopPackageVersion = manifest.desktopPackageVersion,
    )

    @Test
    fun `accepts only exact installed build package signer manifest and claim tuple`() {
        assertTrue(InstalledArtifactIdentityVerifier.verify(claim, manifest, ByteArray(32) { 0x66 }, installed, build))
        assertFalse(InstalledArtifactIdentityVerifier.verify(claim.copy(product = "drift"), manifest, ByteArray(32) { 0x66 }, installed, build))
        assertFalse(InstalledArtifactIdentityVerifier.verify(claim.copy(device = "drift"), manifest, ByteArray(32) { 0x66 }, installed, build))
        assertFalse(InstalledArtifactIdentityVerifier.verify(claim.copy(api = 34), manifest, ByteArray(32) { 0x66 }, installed, build))
        assertFalse(InstalledArtifactIdentityVerifier.verify(claim.copy(systemFingerprint = "drift"), manifest, ByteArray(32) { 0x66 }, installed, build))
        assertFalse(InstalledArtifactIdentityVerifier.verify(claim.copy(vendorFingerprint = "drift"), manifest, ByteArray(32) { 0x66 }, installed, build))
        assertFalse(InstalledArtifactIdentityVerifier.verify(claim.copy(packageName = "drift"), manifest, ByteArray(32) { 0x66 }, installed, build))
        assertFalse(InstalledArtifactIdentityVerifier.verify(claim.copy(versionCode = 329), manifest, ByteArray(32) { 0x66 }, installed, build))
        assertFalse(InstalledArtifactIdentityVerifier.verify(claim.copy(signingCertificateSha256 = ByteArray(32) { 1 }), manifest, ByteArray(32) { 0x66 }, installed, build))
        assertFalse(InstalledArtifactIdentityVerifier.verify(claim.copy(matchedManifestSha256 = ByteArray(32) { 1 }), manifest, ByteArray(32) { 0x66 }, installed, build))
        assertFalse(InstalledArtifactIdentityVerifier.verify(claim.copy(desktopBootstrapVersion = 2), manifest, ByteArray(32) { 0x66 }, installed, build))
        assertFalse(InstalledArtifactIdentityVerifier.verify(claim.copy(desktopPackageVersion = "0.2.2"), manifest, ByteArray(32) { 0x66 }, installed, build))
    }

    @Test
    fun `rejects missing multiple malformed and mismatched runtime signers`() {
        assertFalse(InstalledArtifactIdentityVerifier.verify(claim, manifest, ByteArray(32) { 0x66 }, installed.copy(currentSignerSha256 = emptyList()), build))
        assertFalse(InstalledArtifactIdentityVerifier.verify(claim, manifest, ByteArray(32) { 0x66 }, installed.copy(currentSignerSha256 = listOf(signer, signer)), build))
        assertFalse(InstalledArtifactIdentityVerifier.verify(claim, manifest, ByteArray(32) { 0x66 }, installed.copy(currentSignerSha256 = listOf(ByteArray(31))), build))
        assertFalse(InstalledArtifactIdentityVerifier.verify(claim, manifest, ByteArray(32) { 0x66 }, installed.copy(currentSignerSha256 = listOf(ByteArray(32) { 1 })), build))
        assertFalse(InstalledArtifactIdentityVerifier.verify(claim.copy(signingCertificateSha256 = ByteArray(31)), manifest, ByteArray(32) { 0x66 }, installed, build))
        assertFalse(InstalledArtifactIdentityVerifier.verify(claim, manifest.copy(androidSigningCertificateSha256 = ByteArray(31)), ByteArray(32) { 0x66 }, installed, build))
        assertFalse(InstalledArtifactIdentityVerifier.verify(claim.copy(signingCertificateSha256 = ByteArray(32)), manifest, ByteArray(32) { 0x66 }, installed, build))
        assertFalse(InstalledArtifactIdentityVerifier.verify(claim.copy(matchedManifestSha256 = ByteArray(32)), manifest, ByteArray(32) { 0x66 }, installed, build))
        assertFalse(InstalledArtifactIdentityVerifier.verify(claim, manifest, ByteArray(32), installed, build))
        assertFalse(InstalledArtifactIdentityVerifier.verify(claim, manifest, ByteArray(32) { 0x66 }, installed.copy(currentSignerSha256 = listOf(ByteArray(32))), build))
    }
}
