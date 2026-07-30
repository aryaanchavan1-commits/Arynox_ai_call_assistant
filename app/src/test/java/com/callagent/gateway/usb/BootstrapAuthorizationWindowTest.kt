package com.callagent.gateway.usb

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class BootstrapAuthorizationWindowTest {
    @Test
    fun `only shell uid and gid claim once while foreground start window remains open`() {
        var now = 1_000L
        val window = BootstrapAuthorizationWindow(openedAtMillis = now, nowMillis = { now }, durationMillis = 30_000L)

        assertFalse(window.tryClaim(uid = 2000, gid = 0).accepted)
        assertFalse(window.tryClaim(uid = 0, gid = 2000).accepted)
        val first = window.tryClaim(uid = 2000, gid = 2000)
        assertTrue(first.accepted)
        assertFalse(window.tryClaim(uid = 2000, gid = 2000).accepted)

        window.release(first.generation)
        assertTrue(window.tryClaim(uid = 2000, gid = 2000).accepted)
        now += 30_001L
        assertFalse(window.tryClaim(uid = 2000, gid = 2000).accepted)
    }

    @Test
    fun `forwarded loopback tunnel has one bounded in-flight claim`() {
        var now = 5_000L
        val window = BootstrapAuthorizationWindow(openedAtMillis = now, nowMillis = { now }, durationMillis = 30_000L)
        val first = window.tryClaimForwardedTunnel()
        assertTrue(first.accepted)
        assertFalse(window.tryClaimForwardedTunnel().accepted)
        window.release(first.generation)
        assertTrue(window.tryClaimForwardedTunnel().accepted)
        now += 30_001L
        assertFalse(window.tryClaimForwardedTunnel().accepted)
    }
}
