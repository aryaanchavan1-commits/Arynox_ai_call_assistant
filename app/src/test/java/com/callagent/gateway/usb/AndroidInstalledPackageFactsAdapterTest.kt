package com.callagent.gateway.usb

import java.security.MessageDigest
import org.junit.Assert.*
import org.junit.Test

class AndroidInstalledPackageFactsAdapterTest {
    @Test fun `adapter hashes exactly one current signing certificate`() {
        val cert = byteArrayOf(1, 2, 3, 4)
        val adapter = AndroidInstalledPackageFactsAdapter { AndroidInstalledPackageFactsAdapter.RawPackageFacts("com.callagent.gateway", 330, listOf(cert)) }
        val facts = adapter.read("com.callagent.gateway")!!
        assertEquals(330L, facts.versionCode)
        assertArrayEquals(MessageDigest.getInstance("SHA-256").digest(cert), facts.currentSignerSha256.single())
    }

    @Test fun `adapter preserves missing and multiple signer state`() {
        for (certs in listOf(emptyList(), listOf(byteArrayOf(1), byteArrayOf(2)))) {
            val facts = AndroidInstalledPackageFactsAdapter { AndroidInstalledPackageFactsAdapter.RawPackageFacts("com.callagent.gateway", 330, certs) }.read("com.callagent.gateway")!!
            assertEquals(certs.size, facts.currentSignerSha256.size)
        }
        assertNull(AndroidInstalledPackageFactsAdapter { null }.read("missing"))
    }
}
