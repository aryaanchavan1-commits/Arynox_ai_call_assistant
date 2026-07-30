package com.callagent.gateway.usb

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.util.Properties
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/**
 * RED-GREEN tests for the USB binary frame codec.
 *
 * Wire contract (big-endian, fixed 24-byte header):
 *   off 0  : magic "G2" (0x47 0x32)
 *   off 2  : version
 *   off 3  : frame kind (CONTROL / EVENT / PCM)
 *   off 4  : direction (HOST_TO_DEVICE / DEVICE_TO_HOST)
 *   off 5  : flags (u8)
 *   off 6  : sessionId (u32 BE, unsigned)
 *   off 10 : sequence (u32 BE, unsigned)
 *   off 14 : timestampMicros (u64 BE, monotonic, 64-bit so no 49-day wrap)
 *   off 22 : payloadLen (u16 BE)
 *   off 24 : payload
 *
 * PCM media contract: mono PCM16LE, 16 kHz, 20 ms => 320 samples => 640 bytes.
 */
class FrameTest {

    private val sharedVectors: Properties by lazy {
        Properties().apply {
            val stream = checkNotNull(
                FrameTest::class.java.getResourceAsStream("/g2-v1.properties")
                    ?: Thread.currentThread().contextClassLoader?.getResourceAsStream("g2-v1.properties")
            ) { "shared protocol vectors missing" }
            stream.use(::load)
        }
    }

    private fun pcm640(): ByteArray = ByteArray(PcmContract.BYTES_PER_FRAME) { it.toByte() }

    @Test
    fun `shared protocol vectors encode decode and reject identically on Android`() {
        assertEquals("G2", sharedVectors.getProperty("magic"))
        assertEquals(FrameCodec.VERSION.toString(), sharedVectors.getProperty("version"))
        assertEquals(FrameCodec.HEADER_SIZE.toString(), sharedVectors.getProperty("headerSize"))
        assertEquals(FrameCodec.MAX_PAYLOAD_SIZE.toString(), sharedVectors.getProperty("maxPayload"))
        assertEquals(PcmContract.BYTES_PER_FRAME.toString(), sharedVectors.getProperty("pcmBytes"))

        val expected = vectorBytes("emptyControl.hex")
        val encoded = FrameCodec.encode(
            Frame(
                kind = FrameKind.CONTROL,
                direction = FrameDirection.HOST_TO_DEVICE,
                sessionId = sharedVectors.getProperty("emptyControl.sessionId").toLong(),
                sequence = sharedVectors.getProperty("emptyControl.sequence").toLong(),
                timestampMicros = sharedVectors.getProperty("emptyControl.timestampMicros").toLong(),
                flags = sharedVectors.getProperty("emptyControl.flags").toInt(),
                payload = ByteArray(0),
            )
        )
        assertArrayEquals(expected, encoded)
        assertEquals(FrameKind.CONTROL, FrameCodec.decodeExact(expected).kind)

        for (name in listOf(
            "reject.badMagic.hex",
            "reject.badVersion.hex",
            "reject.badKind.hex",
            "reject.badDirection.hex",
            "reject.reservedFlags.hex",
            "reject.oversizeDeclaredPayload.hex",
            "reject.shortHeader.hex",
            "reject.trailingBytes.hex",
        )) {
            assertThrows("expected shared rejection $name", FrameMalformedException::class.java) {
                FrameCodec.decodeExact(vectorBytes(name))
            }
        }
    }

    @Test
    fun `shared authentication vectors fix nonce order domains and session endianness on Android`() {
        val secret = vectorBytes("auth.secret.hex")
        val serverNonce = vectorBytes("auth.serverNonce.hex")
        val clientNonce = vectorBytes("auth.clientNonce.hex")
        fun proof(domain: String): ByteArray = Mac.getInstance("HmacSHA256").run {
            init(SecretKeySpec(secret, "HmacSHA256"))
            update(domain.toByteArray(Charsets.US_ASCII))
            update(serverNonce)
            doFinal(clientNonce)
        }

        assertArrayEquals(vectorBytes("auth.clientProof.hex"), proof("agentcall-controller-client-v1\u0000"))
        assertArrayEquals(vectorBytes("auth.serverProof.hex"), proof("agentcall-controller-server-v1\u0000"))
        val sessionDigest = proof("agentcall-controller-session-v1\u0000")
        assertArrayEquals(vectorBytes("auth.sessionDigest.hex"), sessionDigest)
        assertArrayEquals(vectorBytes("auth.sessionId.hex"), sessionDigest.copyOfRange(0, 4))
    }

    // ---- PCM contract constants (locked) ----

    @Test
    fun `pcm contract is 16kHz mono 16-bit 20ms`() {
        assertEquals(16_000, PcmContract.SAMPLE_RATE_HZ)
        assertEquals(1, PcmContract.CHANNELS)
        assertEquals(16, PcmContract.BITS_PER_SAMPLE)
        assertEquals(20, PcmContract.FRAME_DURATION_MS)
    }

    @Test
    fun `pcm frame is 320 samples and 640 bytes`() {
        assertEquals(320, PcmContract.SAMPLES_PER_FRAME)
        assertEquals(640, PcmContract.BYTES_PER_FRAME)
        assertEquals(
            PcmContract.BYTES_PER_FRAME,
            PcmContract.SAMPLES_PER_FRAME * (PcmContract.BITS_PER_SAMPLE / 8) * PcmContract.CHANNELS
        )
    }

    @Test
    fun `header size is 24 bytes`() {
        assertEquals(24, FrameCodec.HEADER_SIZE)
    }

    // ---- round trips ----

    @Test
    fun `control frame round trips`() {
        val payload = byteArrayOf(0x01, 0x02, 0x03)
        val f = Frame(
            kind = FrameKind.CONTROL,
            direction = FrameDirection.HOST_TO_DEVICE,
            sessionId = 1L,
            sequence = 7L,
            timestampMicros = 1_000L,
            flags = 0,
            payload = payload,
        )
        val bytes = FrameCodec.encode(f)
        assertEquals(FrameCodec.HEADER_SIZE + payload.size, bytes.size)
        val back = FrameCodec.decodeExact(bytes)
        assertEquals(f, back)
        assertArrayEquals(payload, back.payload)
    }

    @Test
    fun `pcm frame round trips and stays exactly 640 bytes`() {
        val payload = pcm640()
        val f = Frame(
            kind = FrameKind.PCM,
            direction = FrameDirection.DEVICE_TO_HOST,
            sessionId = 42L,
            sequence = 99L,
            timestampMicros = 2_000_000L,
            flags = 0,
            payload = payload,
        )
        val bytes = FrameCodec.encode(f)
        assertEquals(FrameCodec.HEADER_SIZE + 640, bytes.size)
        val back = FrameCodec.decodeExact(bytes)
        assertEquals(FrameKind.PCM, back.kind)
        assertEquals(640, back.payload.size)
        assertArrayEquals(payload, back.payload)
    }

    @Test
    fun `event frame round trips with end-of-stream flag`() {
        val f = Frame(
            kind = FrameKind.EVENT,
            direction = FrameDirection.DEVICE_TO_HOST,
            sessionId = 1L,
            sequence = 0L,
            timestampMicros = 0L,
            flags = FrameFlags.END_OF_STREAM,
            payload = byteArrayOf(0x00),
        )
        val back = FrameCodec.decodeExact(FrameCodec.encode(f))
        assertEquals(FrameFlags.END_OF_STREAM, back.flags)
        assertEquals(f, back)
    }

    // ---- 64-bit timestamp: no 49-day wrap ----

    @Test
    fun `timestamp is 64-bit and survives values that overflow u32 millis`() {
        // 2^32 microseconds ~= ~71 min; well under one day. A monotonic clock at
        // micros over a multi-day session would pass 2^32 in ~71 minutes, so the
        // field MUST be 64-bit. 2^40 micros ~ 13 days, comfortably past 49 days
        // once scaled (micros => 2^63 ~ 292 years). Use a value > 2^32.
        val ts = (1L shl 40) // past u32
        val f = pcmFrame(timestampMicros = ts)
        val back = FrameCodec.decodeExact(FrameCodec.encode(f))
        assertEquals(ts, back.timestampMicros)
    }

    @Test
    fun `timestamp near 49-day-in-millis boundary survives as 64-bit`() {
        // 49 days in ms = 4_233_600_000 which fits u32 by a hair. In micros the
        // same instant is 4_233_600_000_000 which exceeds u32. Encode/decode
        // must round-trip the micros value exactly.
        val micros = 4_233_600_000_000L
        val back = FrameCodec.decodeExact(FrameCodec.encode(pcmFrame(timestampMicros = micros)))
        assertEquals(micros, back.timestampMicros)
    }

    // ---- unsigned u32 handling for sessionId / sequence ----

    @Test
    fun `sessionId and sequence accept full u32 range via Long`() {
        val maxU32 = 0xFFFF_FFFFL
        val f = Frame(
            kind = FrameKind.CONTROL,
            direction = FrameDirection.HOST_TO_DEVICE,
            sessionId = maxU32,
            sequence = maxU32,
            timestampMicros = 0L,
            flags = 0,
            payload = byteArrayOf(0x01),
        )
        val back = FrameCodec.decodeExact(FrameCodec.encode(f))
        assertEquals(maxU32, back.sessionId)
        assertEquals(maxU32, back.sequence)
    }

    @Test
    fun `sessionId above u32 is rejected at construction`() {
        assertThrows(IllegalArgumentException::class.java) {
            Frame(
                kind = FrameKind.CONTROL,
                direction = FrameDirection.HOST_TO_DEVICE,
                sessionId = 0x1_0000_0000L, // 2^32
                sequence = 0L,
                timestampMicros = 0L,
                flags = 0,
                payload = byteArrayOf(0x01),
            )
        }
    }

    @Test
    fun `sequence above u32 is rejected at construction`() {
        assertThrows(IllegalArgumentException::class.java) {
            Frame(
                kind = FrameKind.CONTROL,
                direction = FrameDirection.HOST_TO_DEVICE,
                sessionId = 0L,
                sequence = -1L, // negative not a valid u32
                timestampMicros = 0L,
                flags = 0,
                payload = byteArrayOf(0x01),
            )
        }
    }

    @Test
    fun `negative timestamp is rejected`() {
        assertThrows(IllegalArgumentException::class.java) {
            pcmFrame(timestampMicros = -1L)
        }
    }

    // ---- encode rejections ----

    @Test
    fun `encode rejects payload above MAX_PAYLOAD_SIZE`() {
        val oversize = ByteArray(FrameCodec.MAX_PAYLOAD_SIZE + 1)
        val ex = assertThrows(IllegalArgumentException::class.java) {
            Frame(
                kind = FrameKind.CONTROL,
                direction = FrameDirection.HOST_TO_DEVICE,
                sessionId = 0L,
                sequence = 0L,
                timestampMicros = 0L,
                flags = 0,
                payload = oversize,
            )
        }
        assertTrue(ex.message!!.contains("MAX_PAYLOAD_SIZE") || ex.message!!.contains("payload"))
    }

    @Test
    fun `encode rejects unknown flag bits`() {
        // Only bits 0..1 are defined (END_OF_STREAM, RETRANSMIT). Bit 7 is reserved.
        // The Frame constructor rejects reserved flag bits at construction time;
        // the codec re-validates on encode so a frame built another way cannot
        // smuggle reserved bits onto the wire.
        assertThrows(IllegalArgumentException::class.java) {
            Frame(
                kind = FrameKind.CONTROL,
                direction = FrameDirection.HOST_TO_DEVICE,
                sessionId = 0L,
                sequence = 0L,
                timestampMicros = 0L,
                flags = 0x80, // reserved bit set
                payload = byteArrayOf(0x01),
            )
        }
    }

    @Test
    fun `pcm payload must be exactly 640 bytes`() {
        assertThrows(IllegalArgumentException::class.java) {
            Frame(
                kind = FrameKind.PCM,
                direction = FrameDirection.DEVICE_TO_HOST,
                sessionId = 0L,
                sequence = 0L,
                timestampMicros = 0L,
                flags = 0,
                payload = ByteArray(639),
            )
        }
        assertThrows(IllegalArgumentException::class.java) {
            Frame(
                kind = FrameKind.PCM,
                direction = FrameDirection.DEVICE_TO_HOST,
                sessionId = 0L,
                sequence = 0L,
                timestampMicros = 0L,
                flags = 0,
                payload = ByteArray(641),
            )
        }
    }

    // ---- decodeExact rejections: malformed magic/version/kind/direction/oversize/truncated/trailing ----

    @Test
    fun `decode rejects short header`() {
        assertThrows(FrameMalformedException::class.java) {
            FrameCodec.decodeExact(ByteArray(FrameCodec.HEADER_SIZE - 1))
        }
    }

    @Test
    fun `decode rejects bad magic`() {
        val bytes = FrameCodec.encode(pcmFrame())
        bytes[0] = 'X'.code.toByte()
        assertThrows(FrameMalformedException::class.java) { FrameCodec.decodeExact(bytes) }
    }

    @Test
    fun `decode rejects unknown version`() {
        val bytes = FrameCodec.encode(pcmFrame())
        bytes[2] = 0x09
        assertThrows(FrameMalformedException::class.java) { FrameCodec.decodeExact(bytes) }
    }

    @Test
    fun `decode rejects unknown kind`() {
        val bytes = FrameCodec.encode(pcmFrame())
        bytes[3] = 0x7F
        assertThrows(FrameMalformedException::class.java) { FrameCodec.decodeExact(bytes) }
    }

    @Test
    fun `decode rejects unknown direction`() {
        val bytes = FrameCodec.encode(pcmFrame())
        bytes[4] = 0x00
        assertThrows(FrameMalformedException::class.java) { FrameCodec.decodeExact(bytes) }
    }

    @Test
    fun `decode rejects oversize payloadLen`() {
        val bytes = FrameCodec.encode(
            Frame(
                kind = FrameKind.CONTROL,
                direction = FrameDirection.HOST_TO_DEVICE,
                sessionId = 0L,
                sequence = 0L,
                timestampMicros = 0L,
                flags = 0,
                payload = byteArrayOf(0x01),
            )
        )
        // Forge payloadLen to MAX+1 (fits u16, exceeds bound).
        val forged = bytes.copyOf()
        val len = FrameCodec.MAX_PAYLOAD_SIZE + 1
        forged[22] = (len ushr 8).toByte()
        forged[23] = len.toByte()
        assertThrows(FrameMalformedException::class.java) { FrameCodec.decodeExact(forged) }
    }

    @Test
    fun `decode rejects truncated payload`() {
        val bytes = FrameCodec.encode(pcmFrame())
        val truncated = bytes.copyOfRange(0, FrameCodec.HEADER_SIZE + 100)
        assertThrows(FrameMalformedException::class.java) { FrameCodec.decodeExact(truncated) }
    }

    @Test
    fun `decodeExact rejects trailing bytes`() {
        val bytes = FrameCodec.encode(pcmFrame())
        val withTrailer = bytes + byteArrayOf(0xDE.toByte(), 0xAD.toByte())
        assertThrows(FrameMalformedException::class.java) { FrameCodec.decodeExact(withTrailer) }
    }

    @Test
    fun `decode rejects reserved flag bit on wire`() {
        val bytes = FrameCodec.encode(pcmFrame())
        bytes[5] = 0x80.toByte()
        assertThrows(FrameMalformedException::class.java) { FrameCodec.decodeExact(bytes) }
    }

    // ---- streaming decoder: concatenated / partial socket buffers ----

    @Test
    fun `streaming decoder decodes two concatenated frames`() {
        val a = FrameCodec.encode(pcmFrame(sequence = 1L))
        val b = FrameCodec.encode(pcmFrame(sequence = 2L))
        val dec = StreamingFrameDecoder()
        val out = dec.feed(a + b)
        assertEquals(2, out.size)
        assertEquals(1L, out[0].sequence)
        assertEquals(2L, out[1].sequence)
    }

    @Test
    fun `streaming decoder buffers partial frame across feeds`() {
        val a = FrameCodec.encode(pcmFrame())
        val dec = StreamingFrameDecoder()
        // First half -> no complete frame.
        assertEquals(0, dec.feed(a.copyOfRange(0, a.size / 2)).size)
        // Remainder -> one complete frame.
        val out = dec.feed(a.copyOfRange(a.size / 2, a.size))
        assertEquals(1, out.size)
        assertArrayEquals(a, FrameCodec.encode(out[0]))
    }

    @Test
    fun `streaming decoder rejects malformed magic in buffered stream`() {
        val dec = StreamingFrameDecoder()
        val bad = ByteArray(FrameCodec.HEADER_SIZE) { 0x00 }
        bad[0] = 'X'.code.toByte()
        assertThrows(FrameMalformedException::class.java) { dec.feed(bad) }
    }

    @Test
    fun `streaming decoder detects overflow of declared payloadLen`() {
        val dec = StreamingFrameDecoder()
        val header = ByteArray(FrameCodec.HEADER_SIZE) { 0x00 }
        header[0] = 'G'.code.toByte(); header[1] = '2'.code.toByte()
        header[2] = FrameCodec.VERSION
        header[3] = FrameKind.PCM.code
        header[4] = FrameDirection.DEVICE_TO_HOST.code
        // payloadLen = MAX+1
        val len = FrameCodec.MAX_PAYLOAD_SIZE + 1
        header[22] = (len ushr 8).toByte()
        header[23] = len.toByte()
        assertThrows(FrameMalformedException::class.java) { dec.feed(header) }
    }

    // ---- Frame ownership: defensive copy, mutation safety, hashing ----

    @Test
    fun `frame defensively copies payload`() {
        val src = pcm640()
        val f = pcmFrame(payload = src)
        // Caller mutates the source array after construction.
        src[0] = 0x7F
        // Frame's copy is unaffected.
        assertEquals(0.toByte(), f.payload[0])
    }

    @Test
    fun `caller mutation of source does not break equality while queued`() {
        val src = pcm640()
        val a = pcmFrame(payload = src)
        val b = pcmFrame(payload = pcm640())
        assertEquals(a, b)
        // Mutate a's original source (not a.payload).
        src[10] = 0x55
        // Equality unchanged: a still equals b.
        assertEquals(a, b)
        assertEquals(a.hashCode(), b.hashCode())
    }

    @Test
    fun `frames with differing payload are not equal`() {
        val a = pcmFrame()
        val b = pcmFrame()
        b.payload[0] = 0x01
        assertNotEquals(a, b)
    }

    @Test
    fun `frame payload is internally owned - encode reads snapshot`() {
        // Even if encode output is later mutated, a fresh encode of the same
        // frame is stable.
        val f = pcmFrame()
        val e1 = FrameCodec.encode(f)
        e1[FrameCodec.HEADER_SIZE] = 0x00
        val e2 = FrameCodec.encode(f)
        assertArrayEquals(pcm640(), e2.copyOfRange(FrameCodec.HEADER_SIZE, e2.size))
    }

    @Test
    fun `decodeExact payload is owned by returned frame - no aliasing to input`() {
        val bytes = FrameCodec.encode(pcmFrame())
        val back = FrameCodec.decodeExact(bytes)
        bytes[FrameCodec.HEADER_SIZE] = 0x00
        assertEquals(0.toByte(), pcm640()[0])
        // back.payload must not reflect the mutation of the decode input.
        assertArrayEquals(pcm640(), back.payload)
    }

    @Test
    fun `equals and hashCode consistent in a HashSet`() {
        val a = pcmFrame(sequence = 5L)
        val b = pcmFrame(sequence = 5L)
        val set = HashSet<Frame>()
        assertTrue(set.add(a))
        assertTrue(!set.add(b)) // b equals a
        assertEquals(1, set.size)
    }

    // ---- helpers ----

    private fun vectorBytes(name: String): ByteArray {
        val hex = checkNotNull(sharedVectors.getProperty(name)) { "missing shared vector $name" }
        require(hex.length % 2 == 0) { "shared vector $name has odd hex length" }
        return ByteArray(hex.length / 2) { index ->
            hex.substring(index * 2, index * 2 + 2).toInt(16).toByte()
        }
    }

    private fun pcmFrame(
        sequence: Long = 0L,
        timestampMicros: Long = 0L,
        payload: ByteArray = pcm640(),
    ): Frame = Frame(
        kind = FrameKind.PCM,
        direction = FrameDirection.DEVICE_TO_HOST,
        sessionId = 1L,
        sequence = sequence,
        timestampMicros = timestampMicros,
        flags = 0,
        payload = payload,
    )
}
