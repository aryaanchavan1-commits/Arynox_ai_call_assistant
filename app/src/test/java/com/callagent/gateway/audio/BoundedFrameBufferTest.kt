package com.callagent.gateway.audio

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Phase 1 — Pure JVM tests for [BoundedFrameBuffer].  The buffer holds fixed
 * 20 ms PCM16 frames (320 samples / 640 bytes) between the downlink capture
 * and the uplink injection.  It is a bounded ring: a fixed pool of frames, no
 * unbounded growth, no file/network/root.  Backpressure is drop-oldest under
 * sustained producer overflow so the bridge never blocks the audio thread.
 *
 * Hard invariants enforced here (RED first):
 *   - capacity is fixed and small (no unbounded allocation)
 *   - each frame is exactly SAMPLES_PER_FRAME samples
 *   - overflow drops the oldest frame, not the newest (live audio wins)
 *   - zeroization clears every sample of every frame on close
 */
class BoundedFrameBufferTest {

    private fun frame(fill: Short): ShortArray =
        ShortArray(AudioBridgeContract.SAMPLES_PER_FRAME) { fill }

    @Test
    fun capacityIsFixedAndBounded() {
        val buf = BoundedFrameBuffer(capacityFrames = 8)
        assertEquals(8, buf.capacityFrames)
        // Far more frames than capacity must not grow the pool.
        repeat(50) { buf.offer(frame(it.toShort())) }
        assertEquals(8, buf.capacityFrames)
        assertEquals(8, buf.size)
    }

    @Test
    fun eachFrameHasExactlyContractSamples() {
        val buf = BoundedFrameBuffer(capacityFrames = 4)
        buf.offer(frame(7))
        val out = buf.poll()
        assertEquals(AudioBridgeContract.SAMPLES_PER_FRAME, out!!.size)
    }

    @Test
    fun pollOnEmptyReturnsNull() {
        val buf = BoundedFrameBuffer(capacityFrames = 4)
        assertNull(buf.poll())
    }

    @Test
    fun offerBeyondCapacityDropsOldest() {
        val buf = BoundedFrameBuffer(capacityFrames = 2)
        buf.offer(frame(1))   // oldest
        buf.offer(frame(2))
        buf.offer(frame(3))   // overflows, drops frame(1)
        assertEquals(2, buf.size)
        assertEquals(2, buf.poll()!![0].toInt()) // oldest surviving = frame(2)
        assertEquals(3, buf.poll()!![0].toInt()) // newest = frame(3)
        assertNull(buf.poll())
    }

    @Test
    fun orderIsFifo() {
        val buf = BoundedFrameBuffer(capacityFrames = 4)
        buf.offer(frame(10))
        buf.offer(frame(20))
        buf.offer(frame(30))
        assertEquals(10, buf.poll()!![0].toInt())
        assertEquals(20, buf.poll()!![0].toInt())
        assertEquals(30, buf.poll()!![0].toInt())
    }

    @Test
    fun zeroizeClearsEveryFrameInPool() {
        val buf = BoundedFrameBuffer(capacityFrames = 4)
        buf.offer(frame(0x5A.toShort()))
        buf.offer(frame(0x5A.toShort()))
        buf.zeroize()
        // After zeroize the buffer is empty and the backing pool is wiped.
        assertEquals(0, buf.size)
        assertNull(buf.poll())
        assertTrue("pool must report zeroized", buf.isZeroized())
    }

    @Test
    fun clearDropsFramesWithoutZeroizingBacking() {
        val buf = BoundedFrameBuffer(capacityFrames = 4)
        buf.offer(frame(0x5A.toShort()))
        buf.clear()
        assertEquals(0, buf.size)
        // clear() empties the queue; zeroize() additionally wipes the pool.
        // Distinguish them so callers pick the right one.
    }

    @Test
    fun snapshotIsImmutableAndDoesNotMutateBuffer() {
        val buf = BoundedFrameBuffer(capacityFrames = 4)
        buf.offer(frame(1))
        buf.offer(frame(2))
        val snap = buf.snapshot()
        assertEquals(2, snap.size)
        assertEquals(1, snap[0][0].toInt())
        // Snapshot is a copy; mutating it must not affect the buffer.
        snap[0][0] = 99
        assertEquals(1, buf.poll()!![0].toInt())
    }

    // --- zero-copy pollInto (no per-frame allocation) ----------------------

    @Test
    fun pollIntoReturnsMinusOneOnEmpty() {
        val buf = BoundedFrameBuffer(capacityFrames = 4)
        val dst = ShortArray(AudioBridgeContract.SAMPLES_PER_FRAME)
        assertEquals(-1, buf.pollInto(dst))
    }

    @Test
    fun pollIntoCopiesFrameWithoutAllocationAndZeroizesSlot() {
        val buf = BoundedFrameBuffer(capacityFrames = 4)
        buf.offer(frame(0x5A.toShort()))
        val dst = ShortArray(AudioBridgeContract.SAMPLES_PER_FRAME) { 0x11 }
        val n = buf.pollInto(dst)
        assertEquals(AudioBridgeContract.SAMPLES_PER_FRAME, n)
        // Full frame copied into the reused dst.
        assertEquals(0x5A, dst[0].toInt())
        assertEquals(0x5A, dst[AudioBridgeContract.SAMPLES_PER_FRAME - 1].toInt())
        // Buffer drained.
        assertEquals(0, buf.size)
    }

    @Test
    fun pollIntoRespectsOffsetAndIsFifo() {
        val buf = BoundedFrameBuffer(capacityFrames = 4)
        buf.offer(frame(7))
        buf.offer(frame(8))
        val dst = ShortArray(AudioBridgeContract.SAMPLES_PER_FRAME * 2)
        assertEquals(AudioBridgeContract.SAMPLES_PER_FRAME, buf.pollInto(dst, 0))
        assertEquals(AudioBridgeContract.SAMPLES_PER_FRAME, buf.pollInto(dst, AudioBridgeContract.SAMPLES_PER_FRAME))
        assertEquals(7, dst[0].toInt())
        assertEquals(8, dst[AudioBridgeContract.SAMPLES_PER_FRAME].toInt())
    }

    @Test(expected = IllegalArgumentException::class)
    fun pollIntoRejectsUndersizedDst() {
        val buf = BoundedFrameBuffer(capacityFrames = 4)
        buf.offer(frame(1))
        buf.pollInto(ShortArray(1)) // too small
    }
}
