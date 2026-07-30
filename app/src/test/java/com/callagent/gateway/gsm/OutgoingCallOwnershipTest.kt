package com.callagent.gateway.gsm

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class OutgoingCallOwnershipTest {
    @Test
    fun `only matching normalized destination can claim pending gateway dial`() {
        val ownership = OutgoingCallOwnership()
        assertTrue(ownership.arm("+15555550100"))
        assertFalse(ownership.claim(Any(), "+15555550101"))
        val call = Any()
        assertTrue(ownership.claim(call, "+1 (555) 555-0100"))
        assertTrue(ownership.isOwned(call))
        assertFalse(ownership.isOwned(Any()))
    }

    @Test
    fun `second dial is rejected while pending or owned and removal permits next dial`() {
        val ownership = OutgoingCallOwnership()
        assertTrue(ownership.arm("+15555550100"))
        assertFalse(ownership.arm("+15555550101"))
        val first = Any()
        assertTrue(ownership.claim(first, "+15555550100"))
        assertFalse(ownership.arm("+15555550101"))
        ownership.release(first)
        assertTrue(ownership.arm("+15555550101"))
    }

    @Test
    fun `rejected launch clears pending owner without affecting owned call`() {
        val ownership = OutgoingCallOwnership()
        assertTrue(ownership.arm("+15555550100"))
        ownership.rejectPending()
        assertTrue(ownership.arm("+15555550101"))
        val call = Any()
        assertTrue(ownership.claim(call, "+15555550101"))
        ownership.rejectPending()
        assertTrue(ownership.isOwned(call))
    }
}
