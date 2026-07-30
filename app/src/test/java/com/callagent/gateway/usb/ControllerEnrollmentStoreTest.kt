package com.callagent.gateway.usb

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class ControllerEnrollmentStoreTest {
    private class MemoryStorage : ControllerSecretStorage {
        var value: ByteArray? = null

        override fun read(): ByteArray? = value?.copyOf()

        override fun write(secret: ByteArray) {
            value = secret.copyOf()
        }

        override fun clear() {
            value?.fill(0)
            value = null
        }
    }

    @Test
    fun `enrollment persists a defensive copy and refuses accidental overwrite`() {
        val storage = MemoryStorage()
        var generated = 0
        val store = ControllerEnrollmentStore(storage) {
            generated++
            ByteArray(32) { generated.toByte() }
        }

        val exported = store.enroll()
        assertTrue(store.isEnrolled())
        assertArrayEquals(ByteArray(32) { 1 }, exported)
        exported.fill(0)
        assertArrayEquals(ByteArray(32) { 1 }, store.load())

        try {
            store.enroll()
            fail("second enrollment must require explicit rotation")
        } catch (expected: IllegalStateException) {
            assertTrue(expected.message!!.contains("already enrolled"))
        }
    }

    @Test
    fun `rotation invalidates the old secret and revoke removes enrollment`() {
        val storage = MemoryStorage()
        var generated = 0
        val store = ControllerEnrollmentStore(storage) {
            generated++
            ByteArray(32) { generated.toByte() }
        }

        val old = store.enroll()
        val rotated = store.rotate()
        assertFalse(old.contentEquals(rotated))
        assertArrayEquals(rotated, store.load())
        assertNotEquals(old.toList(), storage.value!!.toList())

        store.revoke()
        assertFalse(store.isEnrolled())
        assertNull(store.load())
    }

    @Test
    fun `malformed generated or persisted secrets fail closed`() {
        val storage = MemoryStorage()
        val malformedGenerator = ControllerEnrollmentStore(storage) { ByteArray(31) }
        try {
            malformedGenerator.enroll()
            fail("short generated secret must fail")
        } catch (expected: IllegalStateException) {
            assertTrue(expected.message!!.contains("32 bytes"))
        }

        storage.value = ByteArray(33)
        val store = ControllerEnrollmentStore(storage) { ByteArray(32) }
        try {
            store.load()
            fail("malformed persisted secret must fail")
        } catch (expected: IllegalStateException) {
            assertTrue(expected.message!!.contains("32 bytes"))
        }
    }
}
