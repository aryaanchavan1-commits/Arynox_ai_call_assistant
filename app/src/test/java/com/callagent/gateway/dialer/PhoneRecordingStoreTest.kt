package com.callagent.gateway.dialer

import java.io.File
import java.nio.file.Files
import java.security.MessageDigest
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class PhoneRecordingStoreTest {
    private lateinit var root: File

    @Before fun setUp() { root = Files.createTempDirectory("phone-recordings").toFile() }
    @After fun tearDown() { root.deleteRecursively() }

    @Test fun `commits only an ordered complete artifact with matching digest`() {
        val bytes = ByteArray(9000) { (it % 251).toByte() }
        val digest = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
        val store = PhoneRecordingStore(root)

        store.begin("call-1", "conversation.wav", bytes.size.toLong(), digest, 10_000)
        store.append(bytes.copyOfRange(0, 4096))
        store.append(bytes.copyOfRange(4096, 8192))
        store.append(bytes.copyOfRange(8192, bytes.size))
        val entry = store.commit()

        assertEquals("call-1", entry.callId)
        assertEquals(10_000L, entry.durationMillis)
        assertArrayEquals(bytes, entry.file.readBytes())
        assertEquals(listOf("call-1"), store.list().map { it.callId })
    }

    @Test fun `digest mismatch removes partial and never exposes recording`() {
        val store = PhoneRecordingStore(root)
        store.begin("call-2", "conversation.wav", 3, "0".repeat(64), 0)
        store.append(byteArrayOf(1, 2, 3))
        assertThrows(IllegalStateException::class.java) { store.commit() }
        assertTrue(store.list().isEmpty())
        assertFalse(root.walkTopDown().any { it.name.endsWith(".part") })
    }

    @Test fun `rejects unsafe metadata overflow and chunks without a transfer`() {
        val store = PhoneRecordingStore(root)
        assertThrows(IllegalArgumentException::class.java) {
            store.begin("../escape", "conversation.wav", 3, "0".repeat(64), 0)
        }
        assertThrows(IllegalArgumentException::class.java) {
            store.begin("call-1", "remote.wav", 3, "0".repeat(64), 0)
        }
        assertThrows(IllegalStateException::class.java) { store.append(byteArrayOf(1)) }
        store.begin("call-1", "conversation.wav", 2, "0".repeat(64), 0)
        assertThrows(IllegalStateException::class.java) { store.append(byteArrayOf(1, 2, 3)) }
        store.abort()
        assertTrue(store.list().isEmpty())
    }
}
