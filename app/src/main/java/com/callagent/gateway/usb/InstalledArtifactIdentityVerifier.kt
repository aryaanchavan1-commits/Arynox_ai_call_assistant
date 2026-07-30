package com.callagent.gateway.usb

import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import java.security.MessageDigest

object InstalledArtifactIdentityVerifier {
    data class BuildFacts(val product: String, val device: String, val api: Int, val systemFingerprint: String, val vendorFingerprint: String)
    data class PackageFacts(val packageName: String, val versionCode: Long, val currentSignerSha256: List<ByteArray>)

    fun verify(claim: ControllerBootstrapProtocolV2.Identity, manifest: MatchedArtifactManifest, manifestDigest: ByteArray, installed: PackageFacts, build: BuildFacts): Boolean {
        val signers = installed.currentSignerSha256
        if (!nonzeroDigest(manifestDigest) || !nonzeroDigest(claim.matchedManifestSha256) || !nonzeroDigest(claim.signingCertificateSha256) || !nonzeroDigest(manifest.androidSigningCertificateSha256) || signers.size != 1 || !nonzeroDigest(signers[0])) return false
        val runtimeSigner = signers[0]
        return claim.adbSerial.isNotEmpty() && claim.product == build.product && claim.device == build.device && claim.api == build.api &&
            claim.systemFingerprint == build.systemFingerprint && claim.vendorFingerprint == build.vendorFingerprint &&
            claim.packageName == installed.packageName && installed.packageName == manifest.androidPackageName &&
            claim.versionCode.toLong() == installed.versionCode && installed.versionCode == manifest.androidVersionCode &&
            MessageDigest.isEqual(claim.signingCertificateSha256, runtimeSigner) && MessageDigest.isEqual(runtimeSigner, manifest.androidSigningCertificateSha256) &&
            MessageDigest.isEqual(claim.matchedManifestSha256, manifestDigest) && claim.desktopBootstrapVersion == manifest.bootstrapProtocolVersion &&
            claim.desktopPackageVersion == manifest.desktopPackageVersion
    }

    private fun nonzeroDigest(value: ByteArray): Boolean = value.size == 32 && value.any { it.toInt() != 0 }
}

class AndroidInstalledPackageFactsAdapter(private val reader: (String) -> RawPackageFacts?) {
    data class RawPackageFacts(val packageName: String, val versionCode: Long, val currentSignerCertificates: List<ByteArray>)

    fun read(packageName: String): InstalledArtifactIdentityVerifier.PackageFacts? = reader(packageName)?.let { raw ->
        InstalledArtifactIdentityVerifier.PackageFacts(raw.packageName, raw.versionCode, raw.currentSignerCertificates.map { MessageDigest.getInstance("SHA-256").digest(it) })
    }

    companion object {
        fun from(context: Context): AndroidInstalledPackageFactsAdapter = AndroidInstalledPackageFactsAdapter { packageName ->
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                    val info = context.packageManager.getPackageInfo(packageName, PackageManager.GET_SIGNING_CERTIFICATES)
                    val certificates = info.signingInfo?.apkContentsSigners?.map { it.toByteArray() } ?: emptyList()
                    RawPackageFacts(info.packageName, info.longVersionCode, certificates)
                } else {
                    @Suppress("DEPRECATION")
                    val info = context.packageManager.getPackageInfo(packageName, PackageManager.GET_SIGNATURES)
                    @Suppress("DEPRECATION")
                    val certificates = info.signatures?.map { it.toByteArray() } ?: emptyList()
                    @Suppress("DEPRECATION")
                    RawPackageFacts(info.packageName, info.versionCode.toLong(), certificates)
                }
            } catch (_: PackageManager.NameNotFoundException) { null }
        }

        fun buildFacts(vendorFingerprint: String): InstalledArtifactIdentityVerifier.BuildFacts = InstalledArtifactIdentityVerifier.BuildFacts(Build.PRODUCT, Build.DEVICE, Build.VERSION.SDK_INT, Build.FINGERPRINT, vendorFingerprint)
    }
}
