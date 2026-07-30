package com.callagent.gateway.usb

import com.callagent.gateway.audio.AudioBridgeController
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AudioBridgeStartResultTest {
    @Test
    fun `started outcome is active only while coordinator still owns the bridge`() {
        assertTrue(
            AudioBridgeStartResult.isActive(
                AudioBridgeController.Outcome.STARTED,
                coordinatorRunning = true,
            ),
        )
        assertFalse(
            AudioBridgeStartResult.isActive(
                AudioBridgeController.Outcome.STARTED,
                coordinatorRunning = false,
            ),
        )
    }

    @Test
    fun `already running outcome also requires current coordinator ownership`() {
        assertTrue(
            AudioBridgeStartResult.isActive(
                AudioBridgeController.Outcome.ALREADY_RUNNING,
                coordinatorRunning = true,
            ),
        )
        assertFalse(
            AudioBridgeStartResult.isActive(
                AudioBridgeController.Outcome.ALREADY_RUNNING,
                coordinatorRunning = false,
            ),
        )
    }
}
