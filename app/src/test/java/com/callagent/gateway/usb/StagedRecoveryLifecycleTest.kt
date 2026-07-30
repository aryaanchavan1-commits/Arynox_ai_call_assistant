package com.callagent.gateway.usb

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class StagedRecoveryLifecycleTest {
    private class Storage : TransactionalControllerSecretStorage {
        var committed: ByteArray? = null
        var staged: ByteArray? = null
        override fun read() = committed?.copyOf()
        override fun write(secret: ByteArray) { committed = secret.copyOf() }
        override fun clear() { committed = null; clearStaged() }
        override fun readStaged() = staged?.copyOf()
        override fun writeStaged(secret: ByteArray) { staged = secret.copyOf() }
        override fun commitStaged() { committed = checkNotNull(staged).copyOf(); clearStaged() }
        override fun clearStaged() { staged?.fill(0); staged = null }
    }

    @Test
    fun `restart recovers durable staging and commits only after exact operational G2`() {
        var now = 10_000L
        val storage = Storage().apply { staged = ByteArray(32) { 7 } }
        val store = ControllerEnrollmentStore(storage)
        val lifecycle = StagedRecoveryLifecycle(store, nowMillis = { now }, commitTimeoutMillis = 5_000L)

        assertEquals(StagedRecoveryLifecycle.StartAction.RECOVER_OPERATIONAL_G2, lifecycle.start())
        assertTrue(lifecycle.onOperationalG2AuthenticatedAndCommit(ByteArray(32) { 7 }))
        assertEquals(ControllerEnrollmentState.COMMITTED, store.state())
    }

    @Test
    fun `wrong G2 fails closed and revokes staging`() {
        val storage = Storage().apply { staged = ByteArray(32) { 8 } }
        val store = ControllerEnrollmentStore(storage)
        val lifecycle = StagedRecoveryLifecycle(store, nowMillis = { 10_000L }, commitTimeoutMillis = 5_000L)
        lifecycle.start()
        assertFalse(lifecycle.onOperationalG2AuthenticatedAndCommit(ByteArray(32) { 7 }))
        assertEquals(ControllerEnrollmentState.EMPTY, store.state())
    }

    @Test
    fun `operational G2 after bounded recovery window revokes staging`() {
        var now = 1_000L
        val storage = Storage().apply { staged = ByteArray(32) { 9 } }
        val store = ControllerEnrollmentStore(storage)
        val lifecycle = StagedRecoveryLifecycle(store, nowMillis = { now }, commitTimeoutMillis = 5_000L)
        lifecycle.start()
        now += 5_001L
        assertFalse(lifecycle.onOperationalG2AuthenticatedAndCommit(ByteArray(32) { 9 }))
        assertEquals(ControllerEnrollmentState.EMPTY, store.state())
    }

    @Test
    fun `matching operational G2 commits and stop revokes otherwise`() {
        val storage = Storage().apply { staged = ByteArray(32) { 3 } }
        val store = ControllerEnrollmentStore(storage)
        val lifecycle = StagedRecoveryLifecycle(store, nowMillis = { 20_000L }, commitTimeoutMillis = 5_000L)
        lifecycle.start()
        assertTrue(lifecycle.onOperationalG2AuthenticatedAndCommit(ByteArray(32) { 3 }))
        assertEquals(ControllerEnrollmentState.COMMITTED, store.state())

        storage.committed = null
        storage.staged = ByteArray(32) { 4 }
        val stopped = StagedRecoveryLifecycle(store)
        stopped.start()
        stopped.stop()
        assertEquals(ControllerEnrollmentState.EMPTY, store.state())
    }
}
