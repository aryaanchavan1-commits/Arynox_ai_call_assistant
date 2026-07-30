package com.callagent.gateway.dialer

import java.io.ByteArrayInputStream
import java.security.MessageDigest
import org.junit.Assert.assertThrows
import org.junit.Test

class RecordingCopyVerifierTest {
    @Test fun `accepts only a destination copy with the expected size and sha256`() {
        val bytes = ByteArray(9_000) { (it % 251).toByte() }
        val sha256 = MessageDigest.getInstance("SHA-256")
            .digest(bytes)
            .joinToString("") { "%02x".format(it) }

        RecordingCopyVerifier.verify(ByteArrayInputStream(bytes), bytes.size.toLong(), sha256)

        assertThrows(IllegalStateException::class.java) {
            RecordingCopyVerifier.verify(ByteArrayInputStream(bytes.copyOf(bytes.size - 1)), bytes.size.toLong(), sha256)
        }
        val corrupt = bytes.copyOf().also { it[it.lastIndex] = (it.last() + 1).toByte() }
        assertThrows(IllegalStateException::class.java) {
            RecordingCopyVerifier.verify(ByteArrayInputStream(corrupt), bytes.size.toLong(), sha256)
        }
    }
}
