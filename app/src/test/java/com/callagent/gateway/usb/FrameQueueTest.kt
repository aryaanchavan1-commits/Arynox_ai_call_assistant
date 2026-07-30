package com.callagent.gateway.usb

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * RED-GREEN tests for [FrameQueue]: a strictly bounded frame buffer with an
 * explicit overflow policy, live metrics, fixed queue capacity, and
 * zeroization of discarded/released PCM audio payloads under explicit
 * ownership semantics.
 *
 * Ownership model under test:
 *  - [FrameQueue.poll] returns a frame whose PCM payload is still the usable,
 *    non-zero audio the producer offered (zeroization does NOT happen on
 *    dequeue — the consumer needs the data).
 *  - The consumer calls [FrameQueue.release] when done, which zeroizes the PCM
 *    payload in place so audio samples do not linger.
 *  - [FrameQueue.pollInto] copies the payload into a caller-supplied buffer and
 *    zeroizes the slot immediately, so the queue never hands out a reference it
 *    also still considers live.
 *  - Discarded frames (DROP_OLDEST / DROP_NEWEST / clear) are zeroized.
 */
class FrameQueueTest {

    private fun pcmFrame(seq: Int, seed: Byte = 0): Frame = Frame(
        kind = FrameKind.PCM,
        direction = FrameDirection.DEVICE_TO_HOST,
        sessionId = 1,
        sequence = seq.toLong(),
        timestampMicros = seq.toLong() * 20_000L,
        flags = 0,
        payload = ByteArray(PcmContract.BYTES_PER_FRAME) { (seed + it.toByte()).toByte() }
    )

    private fun ctrlFrame(seq: Int): Frame = Frame(
        kind = FrameKind.CONTROL,
        direction = FrameDirection.HOST_TO_DEVICE,
        sessionId = 1,
        sequence = seq.toLong(),
        timestampMicros = 0L,
        flags = 0,
        payload = byteArrayOf(seq.toByte())
    )

    private fun allZero(a: ByteArray): Boolean = a.all { it == 0.toByte() }

    // ---- bounded capacity / no unbounded allocation ----

    @Test
    fun `capacity is fixed and enforced`() {
        val q = FrameQueue(capacity = 2)
        assertTrue(q.offer(pcmFrame(0)))
        assertTrue(q.offer(pcmFrame(1)))
        assertEquals(2, q.metrics.depth)
        assertEquals(2, q.metrics.enqueued)
        assertEquals(0, q.metrics.dropped)
    }

    @Test
    fun `capacity must be positive`() {
        assertThrows(IllegalArgumentException::class.java) { FrameQueue(capacity = 0) }
        assertThrows(IllegalArgumentException::class.java) { FrameQueue(capacity = -1) }
    }

    @Test
    fun `REJECT policy drops nothing and rejects the overflow frame`() {
        val q = FrameQueue(capacity = 1, overflow = OverflowPolicy.REJECT)
        assertTrue(q.offer(pcmFrame(0)))
        val accepted = q.offer(pcmFrame(1))
        assertFalse("REJECT must not accept beyond capacity", accepted)
        assertEquals(1, q.metrics.depth)
        assertEquals(1, q.metrics.enqueued)
        assertEquals(1, q.metrics.dropped)
    }

    @Test
    fun `DROP_OLDEST evicts head and accepts new frame`() {
        val q = FrameQueue(capacity = 1, overflow = OverflowPolicy.DROP_OLDEST)
        assertTrue(q.offer(pcmFrame(0)))
        assertTrue(q.offer(pcmFrame(1)))
        assertEquals(1, q.metrics.depth)
        assertEquals(2, q.metrics.enqueued)
        assertEquals(1, q.metrics.dropped)
        // Head is now frame 1; frame 0 was evicted.
        assertEquals(1L, q.peek()!!.sequence)
    }

    @Test
    fun `DROP_NEWEST refuses new frame and keeps head`() {
        val q = FrameQueue(capacity = 1, overflow = OverflowPolicy.DROP_NEWEST)
        assertTrue(q.offer(pcmFrame(0)))
        assertFalse(q.offer(pcmFrame(1)))
        assertEquals(1, q.metrics.depth)
        assertEquals(0L, q.peek()!!.sequence)
    }

    // ---- explicit ownership: poll returns usable NONZERO data ----

    @Test
    fun `poll returns nonzero PCM - zeroization is NOT applied on dequeue`() {
        val q = FrameQueue(capacity = 2)
        val offered = pcmFrame(5, seed = 0x11)
        assertTrue(q.offer(offered))
        val got = q.poll()
        assertNotNull(got)
        assertEquals(5L, got!!.sequence)
        assertFalse("PCM must survive dequeue as usable audio", allZero(got.payload))
        // First sample must be the seed, not zero.
        assertEquals(0x11.toByte(), got.payload[0])
    }

    @Test
    fun `poll twice yields both frames intact in order`() {
        val q = FrameQueue(capacity = 2)
        assertTrue(q.offer(pcmFrame(0, seed = 0x10)))
        assertTrue(q.offer(pcmFrame(1, seed = 0x20)))
        val a = q.poll()!!
        val b = q.poll()!!
        assertEquals(0L, a.sequence)
        assertEquals(1L, b.sequence)
        assertEquals(0x10.toByte(), a.payload[0])
        assertEquals(0x20.toByte(), b.payload[0])
        assertNull(q.poll())
        assertEquals(0, q.metrics.depth)
    }

    @Test
    fun `poll on empty returns null`() {
        val q = FrameQueue(capacity = 1)
        assertNull(q.poll())
    }

    // ---- release(frame) zeroizes after the consumer is done ----

    @Test
    fun `release zeroizes the PCM payload of a polled frame`() {
        val q = FrameQueue(capacity = 1)
        assertTrue(q.offer(pcmFrame(3, seed = 0x33)))
        val got = q.poll()!!
        assertFalse(allZero(got.payload))
        q.release(got)
        assertTrue("release must zeroize PCM audio", allZero(got.payload))
    }

    @Test
    fun `release on non-PCM frame leaves payload intact`() {
        val q = FrameQueue(capacity = 1)
        val c = ctrlFrame(9)
        q.offer(c)
        val got = q.poll()!!
        assertEquals(9.toByte(), got.payload[0])
        q.release(got)
        // Non-PCM payloads are never zeroized.
        assertEquals(9.toByte(), got.payload[0])
    }

    @Test
    fun `release is idempotent`() {
        val q = FrameQueue(capacity = 1)
        q.offer(pcmFrame(1, seed = 0x01))
        val got = q.poll()!!
        q.release(got)
        q.release(got) // must not throw
        assertTrue(allZero(got.payload))
    }

    @Test
    fun `pollInto copies into caller buffer and zeroizes the slot`() {
        val q = FrameQueue(capacity = 1)
        assertTrue(q.offer(pcmFrame(7, seed = 0x44)))
        val dest = ByteArray(PcmContract.BYTES_PER_FRAME)
        val ok = q.pollInto(dest)
        assertTrue(ok)
        // Caller buffer received the usable audio.
        assertEquals(0x44.toByte(), dest[0])
        assertFalse(allZero(dest))
        assertEquals(0, q.metrics.depth)
        // Slot is drained; queue no longer holds the frame.
        assertNull(q.peek())
    }

    @Test
    fun `pollInto on empty returns false and leaves buffer untouched`() {
        val q = FrameQueue(capacity = 1)
        val dest = ByteArray(PcmContract.BYTES_PER_FRAME) { 0x7F }
        val ok = q.pollInto(dest)
        assertFalse(ok)
        assertEquals(0x7F.toByte(), dest[0])
    }

    @Test
    fun `pollInto rejects undersized destination buffer`() {
        val q = FrameQueue(capacity = 1)
        q.offer(pcmFrame(0))
        val tooSmall = ByteArray(PcmContract.BYTES_PER_FRAME - 1)
        assertThrows(IllegalArgumentException::class.java) { q.pollInto(tooSmall) }
        // Frame still in queue (not consumed).
        assertEquals(1, q.metrics.depth)
    }

    @Test
    fun `pollInto with exact-size buffer works`() {
        val q = FrameQueue(capacity = 1)
        q.offer(pcmFrame(0, seed = 0x55))
        val dest = ByteArray(PcmContract.BYTES_PER_FRAME)
        assertTrue(q.pollInto(dest))
        assertEquals(0x55.toByte(), dest[0])
    }

    // ---- discarded frames are zeroized ----

    @Test
    fun `DROP_OLDEST zeroizes evicted PCM payload`() {
        val q = FrameQueue(capacity = 1, overflow = OverflowPolicy.DROP_OLDEST)
        val evicted = pcmFrame(0, seed = 0x22)
        assertTrue(q.offer(evicted))
        assertTrue(q.offer(pcmFrame(1)))
        assertTrue("evicted frame's PCM must be zeroized", allZero(evicted.payload))
    }

    @Test
    fun `DROP_NEWEST zeroizes the refused frame`() {
        val q = FrameQueue(capacity = 1, overflow = OverflowPolicy.DROP_NEWEST)
        assertTrue(q.offer(pcmFrame(0)))
        val refused = pcmFrame(1, seed = 0x66)
        assertFalse(q.offer(refused))
        assertTrue("refused frame's PCM must be zeroized", allZero(refused.payload))
    }

    @Test
    fun `clear zeroizes all queued PCM payloads`() {
        val q = FrameQueue(capacity = 2)
        val a = pcmFrame(0, seed = 0x10)
        val b = pcmFrame(1, seed = 0x20)
        q.offer(a); q.offer(b)
        q.clear()
        assertEquals(0, q.metrics.depth)
        assertTrue(allZero(a.payload))
        assertTrue(allZero(b.payload))
    }

    @Test
    fun `peek returns head without removing or zeroizing`() {
        val q = FrameQueue(capacity = 1)
        val f = pcmFrame(2, seed = 0x77)
        q.offer(f)
        val head = q.peek()!!
        assertEquals(2L, head.sequence)
        assertEquals(1, q.metrics.depth)
        assertFalse(allZero(f.payload))
    }

    @Test
    fun `metrics accumulate across offers and polls`() {
        val q = FrameQueue(capacity = 2)
        q.offer(pcmFrame(0)); q.offer(pcmFrame(1)); q.offer(pcmFrame(2))
        assertEquals(3, q.metrics.offered)
        assertEquals(2, q.metrics.enqueued)
        assertEquals(1, q.metrics.dropped)
        q.poll()
        assertEquals(1, q.metrics.depth)
    }

    @Test
    fun `queue capacity never grows beyond construction value`() {
        val q = FrameQueue(capacity = 3)
        repeat(10) { q.offer(pcmFrame(it)) }
        // At most `capacity` frames held; the rest dropped.
        assertTrue(q.metrics.depth <= 3)
        assertEquals(3, q.metrics.depth)
        repeat(3) { assertNotNull(q.poll()) }
        assertNull(q.poll())
    }

    // ---- PCM payload identity: poll returns exactly 640 bytes ----

    @Test
    fun `poll returns exactly 640-byte PCM payload`() {
        val q = FrameQueue(capacity = 1)
        q.offer(pcmFrame(0))
        val got = q.poll()!!
        assertEquals(PcmContract.BYTES_PER_FRAME, got.payload.size)
    }

    @Test
    fun `pollInto copies exactly 640 bytes`() {
        val q = FrameQueue(capacity = 1)
        q.offer(pcmFrame(0, seed = 0x01))
        val dest = ByteArray(PcmContract.BYTES_PER_FRAME)
        q.pollInto(dest)
        assertArrayEquals(ByteArray(PcmContract.BYTES_PER_FRAME) { (0x01 + it.toByte()).toByte() }, dest)
    }
}
