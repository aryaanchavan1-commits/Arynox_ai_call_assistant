package com.callagent.gateway.usb

/**
 * Stateless big-endian codec for [Frame].
 *
 * Wire layout (all multi-byte fields big-endian, fixed 24-byte header):
 *   off 0  magic "G2"
 *   off 2  version
 *   off 3  kind
 *   off 4  direction
 *   off 5  flags (u8)
 *   off 6  sessionId (u32, unsigned)
 *   off 10 sequence (u32, unsigned)
 *   off 14 timestampMicros (u64, monotonic, 64-bit — no 49-day wrap)
 *   off 22 payloadLen (u16)
 *   off 24 payload
 *
 * Encode rejects: payload above [MAX_PAYLOAD_SIZE], unknown/reserved flag bits,
 * and any [Frame] construction invariant (PCM == 640 bytes, u32 ranges, etc.).
 *
 * [decodeExact] rejects: too-short, bad magic, unknown version/kind/direction,
 * reserved flag bits, payloadLen above [MAX_PAYLOAD_SIZE], truncated payload,
 * AND trailing bytes (the buffer must hold exactly one frame). For socket
 * buffers that may concatenate or split frames, use [StreamingFrameDecoder].
 *
 * Direction rules for CONTROL/EVENT/PCM are intentionally NOT validated here;
 * that semantic check belongs to the session layer (which knows host/device
 * roles). The codec only validates syntactic wire well-formedness.
 */
object FrameCodec {

    const val VERSION: Byte = 1
    const val HEADER_SIZE: Int = 24

    /**
     * Upper bound on any single payload. PCM quanta are 640 bytes; control/event
     * payloads stay small. A forged payloadLen above this (still expressible in
     * u16) is rejected as oversize, capping decode-time allocations.
     */
    const val MAX_PAYLOAD_SIZE: Int = 4096

    private val MAGIC_0: Byte = 'G'.code.toByte()
    private val MAGIC_1: Byte = '2'.code.toByte()

    fun encode(f: Frame): ByteArray {
        // Re-check flag validity here too: a Frame constructed via reflection or a
        // future builder must not smuggle reserved bits onto the wire.
        require(FrameFlags.isValid(f.flags)) { "unknown flag bits: 0x%02X".format(f.flags) }
        require(f.payload.size <= MAX_PAYLOAD_SIZE) {
            "payload exceeds MAX_PAYLOAD_SIZE $MAX_PAYLOAD_SIZE: ${f.payload.size}"
        }
        val out = ByteArray(HEADER_SIZE + f.payload.size)
        out[0] = MAGIC_0
        out[1] = MAGIC_1
        out[2] = VERSION
        out[3] = f.kind.code
        out[4] = f.direction.code
        out[5] = (f.flags and 0xFF).toByte()
        writeU32(out, 6, f.sessionId)
        writeU32(out, 10, f.sequence)
        writeU64(out, 14, f.timestampMicros)
        writeU16(out, 22, f.payload.size)
        System.arraycopy(f.payload, 0, out, HEADER_SIZE, f.payload.size)
        return out
    }

    /**
     * Decode exactly one frame from [bytes]. The buffer must contain precisely
     * one frame's worth of bytes — any trailing bytes are rejected so a
     * concatenated socket buffer is never ambiguously accepted as a single
     * frame. For streaming/partial input use [StreamingFrameDecoder].
     */
    fun decodeExact(bytes: ByteArray): Frame {
        if (bytes.size < HEADER_SIZE) throw malformed("short header: ${bytes.size} < $HEADER_SIZE")
        val frame = decodeOne(bytes, 0)
        val end = frameEnd(bytes, 0)
        if (end != bytes.size) throw malformed("trailing bytes: ${bytes.size - end} after frame at 0")
        return frame
    }

    /** Decode one frame starting at [offset], returning it plus the next offset. */
    private fun decodeOne(bytes: ByteArray, offset: Int): Frame {
        if (bytes.size - offset < HEADER_SIZE) throw malformed("short header at $offset")
        if (bytes[offset] != MAGIC_0 || bytes[offset + 1] != MAGIC_1) throw malformed("bad magic at $offset")
        if (bytes[offset + 2] != VERSION) throw malformed("unknown version 0x%02X".format(bytes[offset + 2]))

        val kind = FrameKind.fromCode(bytes[offset + 3])
        val direction = FrameDirection.fromCode(bytes[offset + 4])
        val flags = bytes[offset + 5].toInt() and 0xFF
        if (!FrameFlags.isValid(flags)) throw malformed("reserved flag bits: 0x%02X".format(flags))
        val sessionId = readU32(bytes, offset + 6)
        val sequence = readU32(bytes, offset + 10)
        val timestampMicros = readU64(bytes, offset + 14)
        val payloadLen = readU16(bytes, offset + 22)

        if (payloadLen > MAX_PAYLOAD_SIZE) throw malformed("oversize payloadLen $payloadLen")
        val payloadStart = offset + HEADER_SIZE
        if (bytes.size - payloadStart < payloadLen) {
            throw malformed("truncated payload: need $payloadLen have ${bytes.size - payloadStart}")
        }
        val payload = if (payloadLen == 0) ByteArray(0) else bytes.copyOfRange(payloadStart, payloadStart + payloadLen)

        return try {
            Frame(kind, direction, sessionId, sequence, timestampMicros, flags, payload)
        } catch (e: IllegalArgumentException) {
            throw malformed(e.message ?: "invalid frame")
        }
    }

    /** Byte offset immediately after the frame starting at [offset]. */
    private fun frameEnd(bytes: ByteArray, offset: Int): Int {
        val payloadLen = readU16(bytes, offset + 22)
        return offset + HEADER_SIZE + payloadLen
    }

    private fun writeU16(buf: ByteArray, off: Int, v: Int) {
        buf[off] = (v ushr 8).toByte()
        buf[off + 1] = v.toByte()
    }

    private fun writeU32(buf: ByteArray, off: Int, v: Long) {
        buf[off] = (v ushr 24).toByte()
        buf[off + 1] = (v ushr 16).toByte()
        buf[off + 2] = (v ushr 8).toByte()
        buf[off + 3] = v.toByte()
    }

    private fun writeU64(buf: ByteArray, off: Int, v: Long) {
        buf[off] = (v ushr 56).toByte()
        buf[off + 1] = (v ushr 48).toByte()
        buf[off + 2] = (v ushr 40).toByte()
        buf[off + 3] = (v ushr 32).toByte()
        buf[off + 4] = (v ushr 24).toByte()
        buf[off + 5] = (v ushr 16).toByte()
        buf[off + 6] = (v ushr 8).toByte()
        buf[off + 7] = v.toByte()
    }

    private fun readU16(buf: ByteArray, off: Int): Int =
        ((buf[off].toInt() and 0xFF) shl 8) or (buf[off + 1].toInt() and 0xFF)

    private fun readU32(buf: ByteArray, off: Int): Long =
        ((buf[off].toInt() and 0xFF).toLong() shl 24) or
            ((buf[off + 1].toInt() and 0xFF).toLong() shl 16) or
            ((buf[off + 2].toInt() and 0xFF).toLong() shl 8) or
            (buf[off + 3].toInt() and 0xFF).toLong()

    private fun readU64(buf: ByteArray, off: Int): Long =
        ((buf[off].toInt() and 0xFF).toLong() shl 56) or
            ((buf[off + 1].toInt() and 0xFF).toLong() shl 48) or
            ((buf[off + 2].toInt() and 0xFF).toLong() shl 40) or
            ((buf[off + 3].toInt() and 0xFF).toLong() shl 32) or
            ((buf[off + 4].toInt() and 0xFF).toLong() shl 24) or
            ((buf[off + 5].toInt() and 0xFF).toLong() shl 16) or
            ((buf[off + 6].toInt() and 0xFF).toLong() shl 8) or
            (buf[off + 7].toInt() and 0xFF).toLong()
}
