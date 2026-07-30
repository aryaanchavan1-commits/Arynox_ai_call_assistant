package com.callagent.gateway.usb

/**
 * Frame kind carried in the wire header byte at offset 3.
 *
 * CONTROL: host↔device command/ack. EVENT: device→host state notification.
 * PCM: media samples (device→host uplink, host→device downlink).
 * ARTIFACT: negotiated finalized-recording chunks (host→device only).
 *
 * Direction rules are a wire-level convention only: CONTROL is bidirectional,
 * EVENT is device→host, PCM carries its own direction byte, and ARTIFACT is
 * host→device. This layer does NOT
 * enforce control/event direction rules — that semantic validation belongs to
 * the session layer, which knows the host/device role of each peer.
 */
enum class FrameKind(val code: Byte) {
    CONTROL(0x01),
    EVENT(0x02),
    PCM(0x03),
    ARTIFACT(0x04);

    companion object {
        fun fromCode(code: Byte): FrameKind =
            values().firstOrNull { it.code == code } ?: throw malformed("unknown kind 0x%02X".format(code))
    }
}

/** Direction byte at offset 4. */
enum class FrameDirection(val code: Byte) {
    HOST_TO_DEVICE(0x01),
    DEVICE_TO_HOST(0x02);

    companion object {
        fun fromCode(code: Byte): FrameDirection =
            values().firstOrNull { it.code == code }
                ?: throw malformed("unknown direction 0x%02X".format(code))
    }
}

/**
 * Flag bits at offset 5. Combine via or; test via and. Only these bits are
 * defined; any other bit is reserved and rejected on both encode and decode so
 * forward/backward incompatibility surfaces as a typed error, not silent reuse.
 */
object FrameFlags {
    const val NONE: Int = 0
    /** Marks the last PCM frame in a stream before teardown. */
    const val END_OF_STREAM: Int = 1 shl 0
    /** Marks a frame as a retransmit / duplicate marker. */
    const val RETRANSMIT: Int = 1 shl 1

    /** All defined flag bits. Reserved bits must be zero. */
    const val MASK: Int = END_OF_STREAM or RETRANSMIT

    fun isValid(flags: Int): Boolean = (flags and MASK.inv()) == 0 && flags in 0..0xFF
}

/**
 * Decoded USB frame. Fields mirror the 24-byte header plus the payload bytes.
 *
 * Ownership: the constructor defensively copies [payload], so the caller may
 * mutate the source array after construction without affecting the frame. The
 * frame's [payload] is internally owned; treat it as read-only.
 *
 * Wire fields [sessionId], [sequence] are unsigned u32 carried as non-negative
 * [Long] (0 .. 2^32-1). [timestampMicros] is a 64-bit monotonic timestamp in
 * microseconds so it does not wrap in 49 days (2^63 µs ~ 292 years).
 *
 * NOTE: this is a regular class, not a data class. Equality is content-based
 * (every field including the payload), but [hashCode] deliberately excludes the
 * mutable [payload] array — hashing a mutable array would make hash-based
 * collections break if the array were ever mutated. Two frames with the same
 * metadata but different payloads therefore collide in hash but differ in
 * equality, which is correct and safe for HashSet/HashMap.
 */
class Frame(
    val kind: FrameKind,
    val direction: FrameDirection,
    val sessionId: Long,
    val sequence: Long,
    val timestampMicros: Long,
    val flags: Int,
    payload: ByteArray,
) {
    val payload: ByteArray = payload.copyOf()

    init {
        require(sessionId in 0..U32_MAX) { "sessionId out of u32 range: $sessionId" }
        require(sequence in 0..U32_MAX) { "sequence out of u32 range: $sequence" }
        require(timestampMicros >= 0) { "timestampMicros must be non-negative: $timestampMicros" }
        require(payload.size <= FrameCodec.MAX_PAYLOAD_SIZE) {
            "payload exceeds MAX_PAYLOAD_SIZE ${FrameCodec.MAX_PAYLOAD_SIZE}: ${payload.size}"
        }
        require(FrameFlags.isValid(flags)) { "unknown flag bits: 0x%02X".format(flags) }
        if (kind == FrameKind.PCM) {
            require(payload.size == PcmContract.BYTES_PER_FRAME) {
                "pcm payload must be ${PcmContract.BYTES_PER_FRAME} bytes, was ${payload.size}"
            }
        }
    }

    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (other !is Frame) return false
        return kind == other.kind &&
            direction == other.direction &&
            sessionId == other.sessionId &&
            sequence == other.sequence &&
            timestampMicros == other.timestampMicros &&
            flags == other.flags &&
            payload.contentEquals(other.payload)
    }

    override fun hashCode(): Int {
        // Exclude mutable payload: hash by metadata only so a mutable array
        // never destabilizes hash-based collections. Equality still compares it.
        var h = kind.hashCode()
        h = 31 * h + direction.hashCode()
        h = 31 * h + sessionId.hashCode()
        h = 31 * h + sequence.hashCode()
        h = 31 * h + timestampMicros.hashCode()
        h = 31 * h + flags
        return h
    }

    override fun toString(): String =
        "Frame(kind=$kind, dir=$direction, sid=$sessionId, seq=$sequence, " +
            "tsUs=$timestampMicros, flags=0x%02X, payloadLen=${payload.size})".format(flags)

    private companion object {
        const val U32_MAX: Long = 0xFFFF_FFFFL
    }
}

/** Thrown when an inbound byte buffer cannot be decoded into a valid [Frame]. */
class FrameMalformedException(message: String) : Exception(message)

internal fun malformed(message: String): FrameMalformedException = FrameMalformedException(message)
