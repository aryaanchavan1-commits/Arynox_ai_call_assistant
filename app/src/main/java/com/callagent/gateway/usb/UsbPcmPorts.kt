package com.callagent.gateway.usb

import com.callagent.gateway.audio.AudioBridgeContract
import com.callagent.gateway.audio.FrameSink
import com.callagent.gateway.audio.FrameSource

/** Converts captured 16-bit samples into canonical PCM16LE USB frames. */
class UsbPcmDownlinkSink(
    private val send: (ByteArray) -> Boolean,
) : FrameSink {
    private val payload = ByteArray(AudioBridgeContract.BYTES_PER_FRAME)
    private var disposed = false

    @Synchronized
    override fun onFrame(frame: ShortArray, sampleCount: Int): Boolean {
        if (disposed) return false
        if (sampleCount != AudioBridgeContract.SAMPLES_PER_FRAME || frame.size < sampleCount) return false
        return try {
            for (index in 0 until sampleCount) {
                val sample = frame[index].toInt()
                payload[index * 2] = (sample and 0xff).toByte()
                payload[index * 2 + 1] = ((sample ushr 8) and 0xff).toByte()
            }
            send(payload)
        } finally {
            payload.fill(0)
        }
    }

    @Synchronized fun dispose() { disposed = true; payload.fill(0) }
    @Synchronized internal fun scratchIsZeroizedForTest(): Boolean = payload.all { it == 0.toByte() }
}

/** Converts canonical queued PCM16LE USB frames into Telephony Tx samples. */
class UsbPcmUplinkSource(
    private val pollBytes: (ByteArray) -> Boolean,
) : FrameSource {
    private val payload = ByteArray(AudioBridgeContract.BYTES_PER_FRAME)
    private var disposed = false

    @Synchronized
    override fun pollInto(dst: ShortArray, offset: Int): Int {
        if (disposed) return -1
        if (offset < 0 || dst.size - offset < AudioBridgeContract.SAMPLES_PER_FRAME) return -1
        return try {
            if (!pollBytes(payload)) return -1
            for (index in 0 until AudioBridgeContract.SAMPLES_PER_FRAME) {
                val low = payload[index * 2].toInt() and 0xff
                val high = payload[index * 2 + 1].toInt()
                dst[offset + index] = ((high shl 8) or low).toShort()
            }
            AudioBridgeContract.SAMPLES_PER_FRAME
        } finally {
            payload.fill(0)
        }
    }

    @Synchronized fun dispose() { disposed = true; payload.fill(0) }
    @Synchronized internal fun scratchIsZeroizedForTest(): Boolean = payload.all { it == 0.toByte() }
}
