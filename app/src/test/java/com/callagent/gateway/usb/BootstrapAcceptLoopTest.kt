package com.callagent.gateway.usb

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class BootstrapAcceptLoopTest {
    private class Client(override val uid: Int, override val gid: Int, val malformed: Boolean = false) : BootstrapPeer {
        var closed = false
        override fun close() { closed = true }
    }

    @Test
    fun `rejected and malformed peers do not consume listener and one valid claim succeeds`() {
        val clients = ArrayDeque(listOf(Client(2000, 0), Client(2000, 2000, malformed = true), Client(2000, 2000)))
        val handled = mutableListOf<Client>()
        val window = BootstrapAuthorizationWindow(1_000L, nowMillis = { 1_001L })

        val succeeded = BootstrapAcceptLoop(window).run(accept = { clients.removeFirstOrNull() }) { peer, _ ->
            val client = peer as Client
            handled += client
            if (client.malformed) error("malformed")
        }

        assertTrue(succeeded)
        assertEquals(2, handled.size)
        assertTrue(clients.isEmpty())
        assertTrue(handled.all { it.closed })
    }
}
