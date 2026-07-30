package com.callagent.gateway.usb

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class StagedControllerEnrollmentTest {
    private class MemoryTransactionalStorage : TransactionalControllerSecretStorage {
        var committed: ByteArray? = null
        var staged: ByteArray? = null
        var failReadBack = false

        override fun read(): ByteArray? = committed?.copyOf()
        override fun write(secret: ByteArray) { committed = secret.copyOf() }
        override fun clear() { committed?.fill(0); committed = null; clearStaged() }
        override fun readStaged(): ByteArray? = if (failReadBack) ByteArray(31) else staged?.copyOf()
        override fun writeStaged(secret: ByteArray) { staged = secret.copyOf() }
        override fun commitStaged() {
            check(committed == null)
            committed = checkNotNull(staged).copyOf()
            clearStaged()
        }
        override fun clearStaged() { staged?.fill(0); staged = null }
    }

    @Test
    fun `bootstrap key remains staged until matching G2 proof commits it`() {
        val storage = MemoryTransactionalStorage()
        val store = ControllerEnrollmentStore(storage)
        val key = ByteArray(32) { (it + 1).toByte() }

        store.stage(key)
        assertNull(store.load())
        assertArrayEquals(key, store.loadStaged())
        assertEquals(ControllerEnrollmentState.STAGED, store.state())

        assertTrue(store.commitStagedAfterG2(key))
        assertArrayEquals(key, store.load())
        assertNull(store.loadStaged())
        assertEquals(ControllerEnrollmentState.COMMITTED, store.state())
    }

    @Test
    fun `wrong G2 key and staged readback failure clear staging without committing`() {
        val storage = MemoryTransactionalStorage()
        val store = ControllerEnrollmentStore(storage)
        val key = ByteArray(32) { 4 }
        store.stage(key)

        assertTrue(!store.commitStagedAfterG2(ByteArray(32) { 5 }))
        assertNull(store.load())
        assertNull(store.loadStaged())

        storage.failReadBack = true
        try {
            store.stage(key)
            fail("invalid staged readback must fail")
        } catch (_: IllegalStateException) {
            assertNull(storage.committed)
            assertNull(storage.staged)
        }
    }

    @Test
    fun `committed plus staged durable records require explicit reset`() {
        val storage = MemoryTransactionalStorage().apply {
            committed = ByteArray(32) { 1 }
            staged = ByteArray(32) { 2 }
        }
        val store = ControllerEnrollmentStore(storage)

        assertEquals(ControllerEnrollmentState.ASYMMETRIC_RESET_REQUIRED, store.state())
        try {
            store.load()
            fail("asymmetric state must fail closed")
        } catch (expected: IllegalStateException) {
            assertTrue(expected.message!!.contains("reset"))
        }
        store.resetAsymmetricState()
        assertEquals(ControllerEnrollmentState.EMPTY, store.state())
    }
}
