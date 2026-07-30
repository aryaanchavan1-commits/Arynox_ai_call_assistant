package com.callagent.gateway.usb

/**
 * Streaming decoder for USB frames arriving in arbitrary socket buffer chunks.
 *
 * A real byte stream does not align frame boundaries to read() calls: one read
 * may return two concatenated frames, half a frame, or a frame split across
 * many reads. This decoder buffers incomplete input and emits whole [Frame]s
 * only once a full header + payload is available, so partial or concatenated
 * buffers are never ambiguously accepted as a single frame.
 *
 * Malformed input (bad magic, oversize declared length, etc.) throws
 * [FrameMalformedException] and leaves the buffer in an error state; discard
 * the decoder and start a new one after a stream error.
 *
 * ponytail: a growing buffer is fine here — it is bounded at any instant by
 * [FrameCodec.MAX_PAYLOAD_SIZE] + header per pending frame, and drained as
 * frames complete. A malicious peer declaring a huge payloadLen is rejected at
 * header-parse time (decodeExact), before any allocation grows to match it.
 */
class StreamingFrameDecoder {

    private var pending: ByteArray = EMPTY
    private var failed = false

    /**
     * Append [chunk] to the internal buffer and return every complete frame now
     * decodable from the front of the buffer, in arrival order.
     *
     * @throws FrameMalformedException if the buffered bytes cannot form a valid
     *   frame (bad magic, unknown version/kind/direction, reserved flags,
     *   oversize payloadLen, or a PCM payload that is not exactly one quantum).
     */
    fun feed(chunk: ByteArray): List<Frame> {
        check(!failed) { "StreamingFrameDecoder already failed; discard and recreate" }
        pending = append(pending, chunk)
        val buf = pending
        val out = ArrayList<Frame>(2)
        var offset = 0
        while (canDecode(buf, offset)) {
            val frame = decodeAt(buf, offset)
            out.add(frame)
            offset += FrameCodec.HEADER_SIZE + frame.payload.size
        }
        if (offset > 0) {
            pending = if (offset < buf.size) buf.copyOfRange(offset, buf.size) else EMPTY
        }
        return out
    }

    private fun canDecode(buf: ByteArray, offset: Int): Boolean {
        if (buf.size - offset < FrameCodec.HEADER_SIZE) return false
        val payloadLen = readU16(buf, offset + 22)
        // Fail fast on a forged/oversize declared length rather than waiting for
        // a payload that will never arrive (and would force a huge allocation).
        if (payloadLen > FrameCodec.MAX_PAYLOAD_SIZE) {
            failed = true
            throw malformed("oversize payloadLen $payloadLen")
        }
        return buf.size - offset >= FrameCodec.HEADER_SIZE + payloadLen
    }

    private fun decodeAt(buf: ByteArray, offset: Int): Frame {
        // Reuse the exact-frame codec path: slice the precise frame bytes so
        // decodeExact's validation (including trailing-byte rejection) applies
        // identically to streamed frames.
        val payloadLen = readU16(buf, offset + 22)
        val end = offset + FrameCodec.HEADER_SIZE + payloadLen
        val slice = buf.copyOfRange(offset, end)
        return try {
            FrameCodec.decodeExact(slice)
        } catch (e: FrameMalformedException) {
            failed = true
            throw e
        }
    }

    private fun readU16(buf: ByteArray, off: Int): Int =
        ((buf[off].toInt() and 0xFF) shl 8) or (buf[off + 1].toInt() and 0xFF)

    private fun append(head: ByteArray, tail: ByteArray): ByteArray {
        if (tail.isEmpty()) return head
        if (head.isEmpty()) return tail.copyOf()
        val out = ByteArray(head.size + tail.size)
        System.arraycopy(head, 0, out, 0, head.size)
        System.arraycopy(tail, 0, out, head.size, tail.size)
        return out
    }

    private companion object {
        val EMPTY: ByteArray = ByteArray(0)
    }
}
