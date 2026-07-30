package com.callagent.gateway.dialer

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class DialerCallStateTest {
    @Test
    fun `incoming call exposes full local number and answer controls`() {
        val state = DialerCallState.idle().incoming("call-1", "+919876543210")
        assertEquals("+919876543210", state.number)
        assertEquals(DialerCallState.Phase.RINGING, state.phase)
        assertTrue(state.canAnswer)
        assertTrue(state.canReject)
        assertFalse(state.canHangup)
    }

    @Test
    fun `outgoing and active calls expose correct controls`() {
        val dialing = DialerCallState.idle().outgoing("call-2", "+12025550123")
        assertEquals(DialerCallState.Direction.OUTGOING, dialing.direction)
        assertEquals(DialerCallState.Phase.DIALING, dialing.phase)
        assertTrue(dialing.canHangup)

        val active = dialing.change(DialerCallState.Phase.ACTIVE)
        assertTrue(active.canHangup)
        assertFalse(active.canAnswer)
    }

    @Test
    fun `ended call clears all mutation controls`() {
        val ended = DialerCallState.idle()
            .incoming("call-3", "+441234567890")
            .change(DialerCallState.Phase.ENDED)
        assertFalse(ended.canAnswer)
        assertFalse(ended.canReject)
        assertFalse(ended.canHangup)
    }
}
