package com.callagent.gateway.usb

import java.io.File
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class UsbGatewayRestartRecoveryTest {
    @Test
    fun `service recovers staged operational G2 before bootstrap and does not commit on G2 callback alone`() {
        val source = File("src/main/java/com/callagent/gateway/usb/UsbGatewayService.kt").readText()
        assertTrue(source.contains("ControllerEnrollmentState.STAGED -> startStagedRecovery"))
        assertTrue(source.contains("onOperationalG2AuthenticatedAndCommit"))
        assertFalse(source.contains("ControllerCommitAckServer"))
        val connected = source.substringAfter("private fun startG2FinalProof").substringBefore("private fun startEnrolledGateway")
        assertFalse(connected.contains("commitStagedAfterG2"))
    }
}
