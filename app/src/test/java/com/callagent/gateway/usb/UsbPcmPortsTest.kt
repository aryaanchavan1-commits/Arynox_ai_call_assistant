package com.callagent.gateway.usb

import com.callagent.gateway.audio.AudioBridgeContract
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.assertThrows
import org.junit.Test

class UsbPcmPortsTest {
    @Test
    fun `captured shorts become exact little endian USB PCM`() {
        var sent: ByteArray? = null
        val sink = UsbPcmDownlinkSink { payload -> sent = payload.copyOf(); true }
        val samples = ShortArray(AudioBridgeContract.SAMPLES_PER_FRAME) { index ->
            when (index) { 0 -> 0x1234; 1 -> -2; else -> 0 }
        }
        assertTrue(sink.onFrame(samples, samples.size))
        assertEquals(AudioBridgeContract.BYTES_PER_FRAME, sent!!.size)
        assertArrayEquals(byteArrayOf(0x34, 0x12, 0xfe.toByte(), 0xff.toByte()), sent!!.copyOfRange(0, 4))
        assertFalse(sink.onFrame(samples, samples.size - 1))
    }

    @Test
    fun `queued little endian USB PCM becomes shorts and consumes frame`() {
        val queue = FrameQueue(2)
        val bytes = ByteArray(PcmContract.BYTES_PER_FRAME)
        bytes[0] = 0x34
        bytes[1] = 0x12
        bytes[2] = 0xfe.toByte()
        bytes[3] = 0xff.toByte()
        assertTrue(queue.offer(Frame(FrameKind.PCM, FrameDirection.HOST_TO_DEVICE, 1, 1, 1, 0, bytes)))
        val source = UsbPcmUplinkSource { destination -> queue.pollInto(destination) }
        val output = ShortArray(AudioBridgeContract.SAMPLES_PER_FRAME)
        assertEquals(output.size, source.pollInto(output, 0))
        assertEquals(0x1234.toShort(), output[0])
        assertEquals((-2).toShort(), output[1])
        assertEquals(0, queue.metrics.depth)
        assertEquals(-1, source.pollInto(output, 0))
    }

    @Test
    fun `downlink scratch is zeroized when sending fails and disposed port cannot transmit`() {
        var sends = 0
        val sink = UsbPcmDownlinkSink { sends++; false }
        val samples = ShortArray(AudioBridgeContract.SAMPLES_PER_FRAME) { 0x1234 }

        assertFalse(sink.onFrame(samples, samples.size))
        assertTrue(sink.scratchIsZeroizedForTest())
        sink.dispose()
        assertFalse(sink.onFrame(samples, samples.size))
        assertEquals(1, sends)
        assertTrue(sink.scratchIsZeroizedForTest())
    }

    @Test
    fun `uplink scratch is zeroized when poll throws and disposed port cannot poll`() {
        var polls = 0
        val source = UsbPcmUplinkSource { destination ->
            polls++
            destination.fill(0x55)
            throw IllegalStateException("poll failed")
        }
        val output = ShortArray(AudioBridgeContract.SAMPLES_PER_FRAME)

        assertThrows(IllegalStateException::class.java) { source.pollInto(output, 0) }
        assertTrue(source.scratchIsZeroizedForTest())
        source.dispose()
        assertEquals(-1, source.pollInto(output, 0))
        assertEquals(1, polls)
        assertTrue(source.scratchIsZeroizedForTest())
    }
}
