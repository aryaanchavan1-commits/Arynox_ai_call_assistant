package com.callagent.gateway.usb

import java.io.File
import org.junit.Assert.assertTrue
import org.junit.Test

class UsbGatewayServiceAuthenticationSecurityTest {
    @Test
    fun `service loads enrollment before privileged bridge and listener construction`() {
        val source = File("src/main/java/com/callagent/gateway/usb/UsbGatewayService.kt").readText()
        val load = source.indexOf("enrollmentStore.state()")
        val bridge = source.indexOf("AndroidAudioBridge(this)")
        val operationalServer = source.indexOf("private fun startEnrolledGateway")

        assertTrue("service must load controller enrollment", load >= 0)
        assertTrue("enrollment must be loaded before audio bridge construction", load < bridge)
        assertTrue("enrollment must be resolved before operational listener construction", load < operationalServer)
        assertTrue("server must receive the enrolled secret", source.contains("enrollmentSecret = controllerSecret.copyOf()"))
        assertTrue("all post-load startup must run inside a clearing boundary", source.contains("startEnrolledGateway(controllerSecret)"))
        assertTrue("the outer startup boundary must clear the service-local secret", source.contains("controllerSecret.fill(0)"))
    }

    @Test
    fun `server clears its private enrollment copy on stop`() {
        val source = File("src/main/java/com/callagent/gateway/usb/UsbGatewayServer.kt").readText()
        assertTrue(source.contains("enrollmentSecret?.fill(0)"))
    }

    @Test
    fun `corrupt or asymmetric enrollment stops while missing enrollment enters isolated bootstrap`() {
        val source = File("src/main/java/com/callagent/gateway/usb/UsbGatewayService.kt").readText()
        assertTrue(source.contains("Controller enrollment reset required"))
        assertTrue(source.contains("ControllerEnrollmentState.EMPTY -> startBootstrapGateway(enrollmentStore)"))
        assertTrue(source.contains("stopGateway()"))
    }
}
