package com.callagent.gateway.audio

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Phase 1 - Pure JVM tests for the bidirectional data-flow contract
 * ([FrameSink] / [FrameSource]) and its composition with
 * [BoundedFrameBuffer].
 *
 * These prove the parent review's core correctness fix WITHOUT android.jar
 * mocks: the two directions are independent.  A captured Rx frame handed to a
 * [FrameSink] must never appear in the [FrameSource] consumed for Tx.  The old
 * bridge copied Rx straight into Tx (an echo loop); this test would have caught
 * it.
 */
class FramePortsTest {

    /**
     * Sink backed by a [BoundedFrameBuffer].  Copies the incoming frame into the
     * queue (the bridge reuses its capture buffer, so the sink must own its
     * copy).  Mirrors a real PC-bound downlink consumer.
     */
    private class QueuedFrameSink(
        private val q: BoundedFrameBuffer,
    ) : FrameSink {
        var received = 0
        override fun onFrame(frame: ShortArray, sampleCount: Int): Boolean {
            received++
            // Defensive copy: the bridge zeroes its buffer after this returns.
            q.offer(frame.copyOf())
            return true
        }
    }

    /**
     * Source backed by a [BoundedFrameBuffer], using the zero-copy [pollInto]
     * path - exactly how the bridge consumes uplink frames.
     */
    private class QueuedFrameSource(
        private val q: BoundedFrameBuffer,
    ) : FrameSource {
        var polled = 0
        override fun pollInto(dst: ShortArray, offset: Int): Int {
            val n = q.pollInto(dst, offset)
            if (n > 0) polled++
            return n
        }
    }

    private fun frame(v: Short) =
        ShortArray(AudioBridgeContract.SAMPLES_PER_FRAME) { v }

    @Test
    fun sinkAndSourceAreIndependentBuses() {
        // Two separate buffers = two separate directions.  Rx into the sink
        // must NEVER appear in the source consumed for Tx.
        val downlinkQ = BoundedFrameBuffer(capacityFrames = 4)
        val uplinkQ = BoundedFrameBuffer(capacityFrames = 4)
        val sink = QueuedFrameSink(downlinkQ)
        val source = QueuedFrameSource(uplinkQ)

        // Bridge reads an Rx frame and hands it to the sink (PC-bound).
        val rxBuf = frame(0x5A.toShort())
        sink.onFrame(rxBuf, AudioBridgeContract.SAMPLES_PER_FRAME)

        // Bridge then polls the uplink source for Tx (PC -> device).
        val txDst = ShortArray(AudioBridgeContract.SAMPLES_PER_FRAME)
        val n = source.pollInto(txDst, 0)

        // No uplink was offered, so nothing to inject.
        assertEquals(-1, n)
        assertEquals(1, sink.received)
        assertEquals(0, source.polled)
    }

    @Test
    fun rxFrameDoesNotLeakIntoTx() {
        // The echo-loop regression: an Rx frame handed to the sink must not be
        // readable from the source.  Both share NO state.
        val downlinkQ = BoundedFrameBuffer(capacityFrames = 4)
        val uplinkQ = BoundedFrameBuffer(capacityFrames = 4)
        val sink = QueuedFrameSink(downlinkQ)
        val source = QueuedFrameSource(uplinkQ)

        val rxBuf = frame(0x5A.toShort())
        sink.onFrame(rxBuf, AudioBridgeContract.SAMPLES_PER_FRAME)

        // Source must be empty even though a sink frame exists.
        val txDst = ShortArray(AudioBridgeContract.SAMPLES_PER_FRAME)
        assertEquals(-1, source.pollInto(txDst, 0))
        // And the sink's own queue holds exactly what was pushed.
        assertEquals(0x5A, downlinkQ.poll()!![0].toInt())
    }

    @Test
    fun sinkZeroCopyContractBridgesReuseBuffer() {
        // The bridge reuses one capture buffer: it hands it to the sink, the
        // sink copies, then the bridge zeroizes.  After zeroize the next read
        // is clean - no stale PCM from the previous frame.
        val sink = QueuedFrameSink(BoundedFrameBuffer(capacityFrames = 2))
        val bridgeBuf = frame(0x5A.toShort())
        sink.onFrame(bridgeBuf, AudioBridgeContract.SAMPLES_PER_FRAME)
        // Bridge zeroizes its buffer after the sink returns.
        bridgeBuf.fill(0)
        // Next frame is clean.
        bridgeBuf[0] = 0x77
        sink.onFrame(bridgeBuf, AudioBridgeContract.SAMPLES_PER_FRAME)
        assertEquals(2, sink.received)
        assertTrue(bridgeBuf.all { it == 0.toShort() || it == 0x77.toShort() })
    }

    @Test
    fun emptyUplinkBecomesSilenceToKeepTelephonyTrackContinuous() {
        val destination = frame(0x55.toShort())
        val source = FrameSource { _, _ -> -1 }

        assertEquals(false, UplinkFrameContinuity.pollOrSilence(source, destination))
        assertTrue(destination.all { it == 0.toShort() })
    }

    @Test
    fun availableUplinkReplacesSilenceWithOneExactFrame() {
        val destination = frame(0x55.toShort())
        val source = FrameSource { dst, offset ->
            dst.fill(0x33.toShort(), offset, offset + AudioBridgeContract.SAMPLES_PER_FRAME)
            AudioBridgeContract.SAMPLES_PER_FRAME
        }

        assertTrue(UplinkFrameContinuity.pollOrSilence(source, destination))
        assertTrue(destination.all { it == 0x33.toShort() })
    }
}
