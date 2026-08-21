package com.callagent.gateway.usb

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class GatewayUiStateTest {
    @Test
    fun `automatic pairing is a visible waiting state and not an error`() {
        val state = GatewayUiState.initial().reduce(GatewayUiEvent.WaitingForPairing)
        assertEquals(GatewayUiState.Connection.LISTENING_USB, state.connection)
        assertFalse(state.desktopConnected)
        assertTrue(state.detail.contains("pairing", ignoreCase = true))
    }

    @Test
    fun `listener ready is not the same as desktop connected`() {
        val state = GatewayUiState.initial().reduce(GatewayUiEvent.ListenerStarted(27183))
        assertEquals(GatewayUiState.Connection.LISTENING_USB, state.connection)
        assertFalse(state.desktopConnected)
        assertEquals("Waiting for desktop over USB", state.connectionLabel)
    }

    @Test
    fun `desktop connection remains fail closed until all required gates are healthy`() {
        var state = GatewayUiState.initial()
        state = state.reduce(GatewayUiEvent.ListenerStarted(27183))
        state = state.reduce(GatewayUiEvent.DesktopConnected)
        state = state.reduce(GatewayUiEvent.DeviceQualified("POCO M2 Pro", "gram", "qualified"))
        state = state.reduce(GatewayUiEvent.TelecomReady)
        state = state.reduce(GatewayUiEvent.AudioReady(rx = true, tx = true))
        assertFalse(state.readyForArynoxs)
        assertEquals(GatewayUiState.Health.FAIL_CLOSED, state.recording)
        state = state.reduce(GatewayUiEvent.RecordingHealthy)
        assertTrue(state.readyForArynoxs)
        assertEquals("Desktop connected via USB", state.connectionLabel)
    }

    @Test
    fun `incoming calls expose explicit answer and reject controls without auto answer`() {
        val state = GatewayUiState.initial().reduce(GatewayUiEvent.IncomingCall("call-7", "•••• 0100"))
        assertEquals(GatewayUiState.CallPhase.RINGING, state.call.phase)
        assertTrue(state.call.canAnswer)
        assertTrue(state.call.canReject)
        assertFalse(state.call.autoAnswered)
    }

    @Test
    fun `disconnect clears readiness but preserves honest device qualification`() {
        val qualified = GatewayUiState.initial()
            .reduce(GatewayUiEvent.DeviceQualified("POCO M2 Pro", "gram", "qualified"))
            .reduce(GatewayUiEvent.DesktopConnected)
        val disconnected = qualified.reduce(GatewayUiEvent.DesktopDisconnected("ADB tunnel closed"))
        assertFalse(disconnected.desktopConnected)
        assertEquals("POCO M2 Pro", disconnected.device.model)
        assertEquals("ADB tunnel closed", disconnected.detail)
        assertEquals(GatewayUiState.Health.FAIL_CLOSED, disconnected.recording)
        assertEquals(GatewayUiState.Health.FAIL_CLOSED, disconnected.audioRx)
        assertEquals(GatewayUiState.Health.FAIL_CLOSED, disconnected.audioTx)
    }

    @Test
    fun `error fail closes desktop media readiness`() {
        val failed = GatewayUiState.initial()
            .reduce(GatewayUiEvent.DesktopConnected)
            .reduce(GatewayUiEvent.AudioReady(rx = true, tx = true))
            .reduce(GatewayUiEvent.RecordingHealthy)
            .reduce(GatewayUiEvent.Error("transport failed"))

        assertFalse(failed.desktopConnected)
        assertEquals(GatewayUiState.Health.FAIL_CLOSED, failed.recording)
        assertEquals(GatewayUiState.Health.FAIL_CLOSED, failed.audioRx)
        assertEquals(GatewayUiState.Health.FAIL_CLOSED, failed.audioTx)
    }
}
