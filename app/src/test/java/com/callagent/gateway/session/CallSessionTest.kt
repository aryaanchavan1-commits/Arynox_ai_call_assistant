package com.callagent.gateway.session

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * RED-GREEN tests for [CallSession], the USB↔cellular call-agent FSM.
 *
 * The reducer is pure: (state, command) -> (state', effects) | reject.
 * Tests assert states, effect lists, idempotency, media gating, USB-loss
 * policies, the single teardown path, and typed (non-throw) rejections.
 */
class CallSessionTest {

    private val key = "dial-1"

    // ---- construction ----

    @Test
    fun `new session starts idle with no legs and no media`() {
        val s = CallSession.create(sessionId = 1)
        assertEquals(CallState.IDLE, s.state)
        assertEquals(1, s.sessionId)
        assertNull(s.dialKey)
        assertFalse(s.cellularActive)
        assertFalse(s.usbMediaReady)
    }

    // ---- inbound flow ----

    @Test
    fun `inbound - start rings and notifies agent`() {
        val s = CallSession.create(1).reduce(CallCommand.StartInbound(key))
        requireAccepted(s) { (next, effects) ->
            assertEquals(CallState.RINGING, next.state)
            assertEquals(key, next.dialKey)
            assertEquals(listOf(CallEffect.NotifyAgentInbound(key)), effects)
        }
    }

    @Test
    fun `inbound - acknowledge answers agent and stays ringing until cellular active`() {
        val s = CallSession.create(1).accept(CallCommand.StartInbound(key))
            .reduce(CallCommand.AcknowledgeInbound(key))
        requireAccepted(s) { (next, effects) ->
            assertEquals(CallState.RINGING, next.state)
            assertEquals(listOf(CallEffect.AnswerAgent(key)), effects)
        }
    }

    @Test
    fun `inbound - activate cellular moves to ACTIVE_NO_MEDIA when usb not ready`() {
        val s = CallSession.create(1)
            .accept(CallCommand.StartInbound(key))
            .accept(CallCommand.AcknowledgeInbound(key))
            .reduce(CallCommand.ActivateCellular(key))
        requireAccepted(s) { (next, _) ->
            assertEquals(CallState.ACTIVE_NO_MEDIA, next.state)
            assertTrue(next.cellularActive)
            assertFalse(next.usbMediaReady)
        }
    }

    @Test
    fun `inbound - usb ready after cellular moves to STREAMING`() {
        val s = CallSession.create(1)
            .accept(CallCommand.StartInbound(key))
            .accept(CallCommand.AcknowledgeInbound(key))
            .accept(CallCommand.ActivateCellular(key))
            .reduce(CallCommand.StartUsbMedia(key))
        requireAccepted(s) { (next, effects) ->
            assertEquals(CallState.STREAMING, next.state)
            assertTrue(next.cellularActive)
            assertTrue(next.usbMediaReady)
            assertEquals(listOf(CallEffect.BeginUsbStreaming(key)), effects)
        }
    }

    // ---- outbound flow ----

    @Test
    fun `outbound - start moves to DIALING and dials agent`() {
        val s = CallSession.create(1).reduce(CallCommand.StartOutbound(key))
        requireAccepted(s) { (next, effects) ->
            assertEquals(CallState.DIALING, next.state)
            assertEquals(listOf(CallEffect.DialAgent(key)), effects)
        }
    }

    @Test
    fun `outbound - dial then activate cellular then usb reaches STREAMING`() {
        val s = CallSession.create(1)
            .accept(CallCommand.StartOutbound(key))
            .accept(CallCommand.DialOutbound(key))
            .accept(CallCommand.ActivateCellular(key))
            .reduce(CallCommand.StartUsbMedia(key))
        requireAccepted(s) { (next, _) -> assertEquals(CallState.STREAMING, next.state) }
    }

    // ---- media gating: media never starts before cellular active ----

    @Test
    fun `start usb media before cellular active is rejected`() {
        val s = CallSession.create(1)
            .accept(CallCommand.StartOutbound(key))
            .reduce(CallCommand.StartUsbMedia(key))
        assertTrue("must reject media before cellular active", s is CallReject)
        assertTrue(s is CallReject.NoActiveCall)
    }

    @Test
    fun `streaming requires both cellular and usb ready`() {
        // cellular active but usb not ready => ACTIVE_NO_MEDIA, not STREAMING
        val noMedia = CallSession.create(1)
            .accept(CallCommand.StartOutbound(key))
            .accept(CallCommand.DialOutbound(key))
            .accept(CallCommand.ActivateCellular(key))
        assertEquals(CallState.ACTIVE_NO_MEDIA, noMedia.state)
        assertFalse(noMedia.usbMediaReady)
    }

    // ---- idempotency ----

    @Test
    fun `duplicate start inbound with same key replays no-op`() {
        val s1 = CallSession.create(1).accept(CallCommand.StartInbound(key))
        val s2 = s1.reduce(CallCommand.StartInbound(key))
        requireAccepted(s2) { (next, effects) ->
            assertEquals(s1, next) // unchanged
            assertTrue(effects.isEmpty())
        }
    }

    @Test
    fun `different dial key while non-idle is rejected with NotIdle`() {
        val s = CallSession.create(1).accept(CallCommand.StartInbound(key))
        val r = s.reduce(CallCommand.StartInbound("dial-2"))
        assertTrue(r is CallReject.NotIdle)
        assertEquals(CallState.RINGING, (r as CallReject.NotIdle).state)
        assertEquals("dial-2", r.attemptedKey)
    }

    @Test
    fun `duplicate acknowledge with same key is no-op`() {
        val s = CallSession.create(1)
            .accept(CallCommand.StartInbound(key))
            .accept(CallCommand.AcknowledgeInbound(key))
            .reduce(CallCommand.AcknowledgeInbound(key))
        requireAccepted(s) { (next, effects) ->
            assertEquals(CallState.RINGING, next.state)
            assertTrue(effects.isEmpty())
        }
    }

    @Test
    fun `duplicate activate cellular is idempotent`() {
        val s = CallSession.create(1)
            .accept(CallCommand.StartOutbound(key))
            .accept(CallCommand.DialOutbound(key))
            .accept(CallCommand.ActivateCellular(key))
            .reduce(CallCommand.ActivateCellular(key))
        requireAccepted(s) { (next, effects) ->
            assertEquals(CallState.ACTIVE_NO_MEDIA, next.state)
            assertTrue(effects.isEmpty())
        }
    }

    // ---- USB loss policy ----

    @Test
    fun `usb loss preserve keeps cellular call in ACTIVE_NO_MEDIA`() {
        val streaming = CallSession.create(1)
            .accept(CallCommand.StartOutbound(key))
            .accept(CallCommand.DialOutbound(key))
            .accept(CallCommand.ActivateCellular(key))
            .accept(CallCommand.StartUsbMedia(key))
        assertEquals(CallState.STREAMING, streaming.state)
        val r = streaming.reduce(CallCommand.StopUsbMedia(key, UsbLossPolicy.PreserveCellularCall))
        requireAccepted(r) { (next, effects) ->
            assertEquals(CallState.ACTIVE_NO_MEDIA, next.state)
            assertTrue(next.cellularActive)
            assertFalse(next.usbMediaReady)
            assertEquals(listOf(CallEffect.StopUsbStreaming(key)), effects)
        }
    }

    @Test
    fun `usb loss hangup tears down cellular call`() {
        val streaming = CallSession.create(1)
            .accept(CallCommand.StartOutbound(key))
            .accept(CallCommand.DialOutbound(key))
            .accept(CallCommand.ActivateCellular(key))
            .accept(CallCommand.StartUsbMedia(key))
        val r = streaming.reduce(CallCommand.StopUsbMedia(key, UsbLossPolicy.HangUpCellularCall))
        requireAccepted(r) { (next, effects) ->
            assertEquals(CallState.TEARING_DOWN, next.state)
            assertFalse(next.usbMediaReady)
            assertTrue(effects.contains(CallEffect.StopUsbStreaming(key)))
            assertTrue(effects.contains(CallEffect.HangUpCellularCall(key)))
        }
    }

    @Test
    fun `usb loss on non-streaming non-active is rejected`() {
        val s = CallSession.create(1).accept(CallCommand.StartOutbound(key))
        val r = s.reduce(CallCommand.StopUsbMedia(key, UsbLossPolicy.PreserveCellularCall))
        assertTrue(r is CallReject.NotStreaming)
    }

    // ---- single teardown path ----

    @Test
    fun `end call from streaming goes to TEARING_DOWN with hangup and release`() {
        val streaming = CallSession.create(1)
            .accept(CallCommand.StartOutbound(key))
            .accept(CallCommand.DialOutbound(key))
            .accept(CallCommand.ActivateCellular(key))
            .accept(CallCommand.StartUsbMedia(key))
        val r = streaming.reduce(CallCommand.EndCall(key))
        requireAccepted(r) { (next, effects) ->
            assertEquals(CallState.TEARING_DOWN, next.state)
            assertTrue(effects.contains(CallEffect.StopUsbStreaming(key)))
            assertTrue(effects.contains(CallEffect.HangUpCellularCall(key)))
            assertTrue(effects.contains(CallEffect.ReleaseAgent(key)))
        }
    }

    @Test
    fun `end call is idempotent during teardown`() {
        val streaming = CallSession.create(1)
            .accept(CallCommand.StartOutbound(key))
            .accept(CallCommand.DialOutbound(key))
            .accept(CallCommand.ActivateCellular(key))
            .accept(CallCommand.StartUsbMedia(key))
        val tearing = streaming.accept(CallCommand.EndCall(key))
        val r = tearing.reduce(CallCommand.EndCall(key))
        requireAccepted(r) { (next, effects) ->
            assertEquals(CallState.TEARING_DOWN, next.state)
            assertTrue(effects.isEmpty())
        }
    }

    @Test
    fun `end call on idle is rejected`() {
        val r = CallSession.create(1).reduce(CallCommand.EndCall(key))
        assertTrue(r is CallReject.AlreadyIdle)
    }

    @Test
    fun `recover from teardown returns to IDLE`() {
        val streaming = CallSession.create(1)
            .accept(CallCommand.StartOutbound(key))
            .accept(CallCommand.DialOutbound(key))
            .accept(CallCommand.ActivateCellular(key))
            .accept(CallCommand.StartUsbMedia(key))
            .accept(CallCommand.EndCall(key))
        val r = streaming.reduce(CallCommand.RecoverFromError(key))
        requireAccepted(r) { (next, effects) ->
            assertEquals(CallState.IDLE, next.state)
            assertNull(next.dialKey)
            assertTrue(effects.contains(CallEffect.ReleaseAgent(key)))
        }
    }

    @Test
    fun `recover from non-error is rejected`() {
        val r = CallSession.create(1).reduce(CallCommand.RecoverFromError(key))
        assertTrue(r is CallReject.NotInError)
    }

    // ---- rejections are typed, not exceptions ----

    @Test
    fun `acknowledge on idle is rejected not thrown`() {
        val r = CallSession.create(1).reduce(CallCommand.AcknowledgeInbound(key))
        assertTrue(r is CallReject.NotRinging)
    }

    @Test
    fun `dial outbound on idle is rejected not thrown`() {
        val r = CallSession.create(1).reduce(CallCommand.DialOutbound(key))
        assertTrue(r is CallReject.NotDialing)
    }

    @Test
    fun `start inbound while ringing with different key is rejected not thrown`() {
        val s = CallSession.create(1).accept(CallCommand.StartInbound(key))
        val r = s.reduce(CallCommand.StartInbound("other"))
        assertTrue(r is CallReject.NotIdle)
    }

    // ---- helpers ----

    /** Apply a command that must be Accepted and return the next session. */
    private fun CallSession.accept(cmd: CallCommand): CallSession {
        val r = reduce(cmd)
        assertTrue("expected Accepted, got $r", r is Accepted)
        return (r as Accepted).session
    }

    private inline fun requireAccepted(result: CallResult, block: (Accepted) -> Unit) {
        assertTrue("expected Accepted, got $result", result is Accepted)
        block(result as Accepted)
    }
}
