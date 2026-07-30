package com.callagent.gateway.usb

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class GenerationOwnershipTest {
    @Test
    fun `gateway starts only when every visible permission is granted`() {
        assertTrue(GatewayPermissionGate.mayStart(listOf(true, true, true)))
        assertFalse(GatewayPermissionGate.mayStart(listOf(true, false, true)))
        assertFalse(GatewayPermissionGate.mayStart(emptyList()))
    }

    @Test
    fun `stale disconnect cannot deauthorize replacement generation`() {
        val owner = ConnectionGenerationOwner()
        assertTrue(owner.connected(1L))
        assertTrue(owner.connected(2L))
        assertFalse(owner.disconnected(1L))
        assertEquals(2L, owner.current())
        assertTrue(owner.disconnected(2L))
        assertNull(owner.current())
    }

    @Test
    fun `outbound queue rejects and zeroizes stale generation pcm`() {
        val queue = GenerationOutboundQueue(capacity = 2)
        queue.activate(1L)
        val stale = ByteArray(PcmContract.BYTES_PER_FRAME) { 7 }
        assertTrue(queue.offer(1L, FrameKind.PCM, stale, 1L))
        queue.activate(2L)
        assertNull(queue.poll(2L))
        assertArrayEquals(ByteArray(PcmContract.BYTES_PER_FRAME), queue.lastDiscardedPayloadForTest())
    }

    @Test
    fun `stale downlink consumer cannot consume replacement generation pcm`() {
        val queue = GenerationDownlinkQueue(capacity = 2)
        queue.activate(1L)
        assertTrue(queue.offer(1L, pcmFrame(seed = 1)))
        queue.activate(2L)
        assertTrue(queue.offer(2L, pcmFrame(seed = 2)))

        val staleDestination = ByteArray(PcmContract.BYTES_PER_FRAME) { 9 }
        assertFalse(queue.pollInto(1L, staleDestination))
        assertArrayEquals(ByteArray(PcmContract.BYTES_PER_FRAME) { 9 }, staleDestination)

        val currentDestination = ByteArray(PcmContract.BYTES_PER_FRAME)
        assertTrue(queue.pollInto(2L, currentDestination))
        assertArrayEquals(pcmFrame(seed = 2).payload, currentDestination)
        assertArrayEquals(ByteArray(PcmContract.BYTES_PER_FRAME), queue.lastDiscardedPayloadForTest())
    }

    private fun pcmFrame(seed: Int) = Frame(
        kind = FrameKind.PCM,
        direction = FrameDirection.HOST_TO_DEVICE,
        sessionId = 1L,
        sequence = seed.toLong(),
        timestampMicros = 0L,
        flags = FrameFlags.NONE,
        payload = ByteArray(PcmContract.BYTES_PER_FRAME) { (it + seed).toByte() },
    )
}
