package com.callagent.gateway.audio

import org.junit.Assert.assertEquals
import org.junit.Test

class AudioWorkerTerminationTest {
    @Test
    fun `downlink sink refusal is a media failure not a graceful stop`() {
        assertEquals(
            AudioWorkerTermination.Failure("downlink sink unavailable"),
            AudioWorkerTermination.fromDownlinkAccepted(false),
        )
    }

    @Test
    fun `accepted downlink frame keeps worker running`() {
        assertEquals(
            AudioWorkerTermination.Continue,
            AudioWorkerTermination.fromDownlinkAccepted(true),
        )
    }
}
