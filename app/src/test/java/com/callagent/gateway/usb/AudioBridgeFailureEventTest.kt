package com.callagent.gateway.usb

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class AudioBridgeFailureEventTest {
    @Test
    fun `encodes the exact bounded media failure event`() {
        val payload = AudioBridgeFailureEvent.encode(
            AudioBridgeFailure(callId = "call-1"),
        )

        assertEquals(
            "{\"event\":\"media_failure\",\"callId\":\"call-1\",\"reason\":\"audio_bridge_failed\"}",
            payload.toString(Charsets.UTF_8),
        )
    }

    @Test
    fun `rejects non opaque call identifiers before encoding`() {
        assertThrows(IllegalArgumentException::class.java) {
            AudioBridgeFailureEvent.encode(AudioBridgeFailure(callId = "bad\\\"id"))
        }
        assertThrows(IllegalArgumentException::class.java) {
            AudioBridgeFailureEvent.encode(AudioBridgeFailure(callId = "x".repeat(129)))
        }
    }
}
