package com.callagent.gateway.usb

import java.io.File
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AndroidControllerSecretStorageSecurityTest {
    @Test
    fun `controller secret storage uses non-exportable Android Keystore AES GCM`() {
        val source = File("src/main/java/com/callagent/gateway/usb/AndroidControllerSecretStorage.kt")
        assertTrue("Android controller secret storage must exist", source.isFile)
        val text = source.readText()

        assertTrue(text.contains("AndroidKeyStore"))
        assertTrue(text.contains("KeyGenParameterSpec"))
        assertTrue(text.contains("KeyProperties.PURPOSE_ENCRYPT"))
        assertTrue(text.contains("KeyProperties.PURPOSE_DECRYPT"))
        assertTrue(text.contains("KeyProperties.BLOCK_MODE_GCM"))
        assertTrue(text.contains("KeyProperties.ENCRYPTION_PADDING_NONE"))
        assertTrue(text.contains("AES/GCM/NoPadding"))
        assertTrue(text.contains("MODE_PRIVATE"))
        assertTrue(text.contains("cipher.iv"))
        assertTrue(text.contains("GCMParameterSpec"))
    }

    @Test
    fun `preferences contain only versioned encrypted record and clear removes it`() {
        val source = File("src/main/java/com/callagent/gateway/usb/AndroidControllerSecretStorage.kt")
        assertTrue("Android controller secret storage must exist", source.isFile)
        val text = source.readText()

        assertTrue(text.contains("RECORD_VERSION"))
        assertTrue(text.contains("preferences.edit().putString(RECORD_KEY"))
        assertTrue(text.contains("preferences.edit().remove(RECORD_KEY"))
        assertFalse("plaintext secrets must not be written to preferences", text.contains("putString(\"controller_secret\""))
        assertFalse("storage must not log", text.contains("Log."))
        assertFalse("storage must not export through intents", text.contains("Intent("))
    }
}
