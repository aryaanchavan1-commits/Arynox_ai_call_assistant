package com.callagent.gateway.usb

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/**
 * RED-GREEN tests for [UsbGatewayServer]: a loopback-only TCP gateway that
 * accepts exactly one PC client, reads canonical streaming [Frame]s, enforces
 * CONTROL/EVENT/PCM direction rules and the exact PCM-640 contract, applies
 * strict command validation + idempotent replay handling, redacts sensitive
 * fields, bounds RX/TX queues, and on malformed/overflow/direction error or on
 * disconnect closes the connection and runs cleanup exactly once (zeroizing
 * and releasing queued PCM).
 *
 * The server takes an injectable [ServerSocketFactory] so the pure bind-config
 * tests never touch the network; behavioural tests use a real loopback
 * [ServerSocket] on an ephemeral port to remain isolated and repeatable.
 */
class UsbGatewayServerTest {

    // ---- bind config (pure, factory never invoked) ----

    @Test
    fun `bind address is constant loopback 127_0_0_1`() {
        assertEquals("127.0.0.1", UsbGatewayServer.BIND_ADDRESS)
        assertEquals(
            InetAddress.getByName("127.0.0.1"),
            InetAddress.getByName(UsbGatewayServer.BIND_ADDRESS)
        )
    }

    @Test
    fun `bind port is a fixed positive constant`() {
        assertTrue(UsbGatewayServer.BIND_PORT in 1024..65535)
        // Port is stable across reads (a val, not random).
        assertEquals(UsbGatewayServer.BIND_PORT, UsbGatewayServer.BIND_PORT)
    }

    @Test
    fun `factory is invoked with loopback address and fixed port`() {
        val captured = ArrayList<Pair<String, Int>>()
        val factory = object : ServerSocketFactory {
            override fun create(host: String, port: Int): ServerSocket {
                captured.add(host to port)
                // Return a stub that is never accept()-ed in this test.
                return object : ServerSocket() {}
            }
        }
        UsbGatewayServer(factory)
        assertEquals(1, captured.size)
        assertEquals("127.0.0.1", captured[0].first)
        assertEquals(UsbGatewayServer.BIND_PORT, captured[0].second)
    }

    // ---- helper: isolated real loopback server ----

    /** A [ServerSocketFactory] backed by an ephemeral loopback socket. */
    private class RealFactory : ServerSocketFactory {
        val server: ServerSocket = ServerSocket(
            0, 1, InetAddress.getByName(UsbGatewayServer.BIND_ADDRESS)
        )

        override fun create(host: String, port: Int): ServerSocket {
            // Production bind arguments are asserted by the pure factory test;
            // behavioral tests reuse this isolated pre-bound socket.
            return server
        }
    }

    private fun connectClient(factory: RealFactory): Socket =
        Socket(InetAddress.getByName("127.0.0.1"), factory.server.localPort)

    private fun pcm640(seed: Int = 0): ByteArray =
        ByteArray(PcmContract.BYTES_PER_FRAME) { (it + seed).toByte() }

    private fun encodeControl(json: String, seq: Int): ByteArray =
        FrameCodec.encode(
            Frame(
                kind = FrameKind.CONTROL,
                direction = FrameDirection.HOST_TO_DEVICE,
                sessionId = 0L,
                sequence = seq.toLong(),
                timestampMicros = 0L,
                flags = FrameFlags.NONE,
                payload = json.toByteArray(Charsets.UTF_8),
            )
        )

    @Test
    fun `wrong controller proof never becomes connected or admits G2 traffic`() {
        val factory = RealFactory()
        val connected = AtomicInteger(0)
        val errors = AtomicInteger(0)
        val listener = object : UsbGatewayListener {
            override fun onListenerStarted(port: Int) = Unit
            override fun onDesktopConnected() { connected.incrementAndGet() }
            override fun onDesktopDisconnected(reason: String) = Unit
            override fun onAuthenticationFailed(reason: String) { errors.incrementAndGet() }
        }
        val gw = UsbGatewayServer(
            serverSocketFactory = factory,
            listener = listener,
            enrollmentSecret = ByteArray(32) { 0x5a.toByte() },
            authenticationTimeoutMillis = 500,
        )
        gw.start()
        try {
            val client = connectClient(factory)
            val input = client.getInputStream()
            val hello = ByteArray(36)
            var offset = 0
            while (offset < hello.size) {
                val read = input.read(hello, offset, hello.size - offset)
                if (read < 0) fail("server closed before authentication hello")
                offset += read
            }
            assertArrayEquals("G2A1".toByteArray(Charsets.US_ASCII), hello.copyOfRange(0, 4))
            client.getOutputStream().apply {
                write("G2C1".toByteArray(Charsets.US_ASCII))
                write(ByteArray(32) { 0x11 })
                write(ByteArray(32)) // deliberately wrong HMAC
                write(encodeControl("""{"command":"status","idempotencyKey":"unauth"}""", 1))
                flush()
            }

            assertTrue(gw.awaitCleanupCount(1, 2, TimeUnit.SECONDS))
            assertEquals(0, connected.get())
            assertEquals(1, errors.get())
            assertEquals(0, gw.appliedMutationCount())
            assertEquals(0, gw.downlinkQueueDepth())
            assertEquals(0, gw.connectedClientCount())
            expectClosed(client)
            client.close()
        } finally {
            gw.stop()
            factory.server.close()
        }
    }

    @Test
    fun `authentication success gate commits before server proof and can fail closed`() {
        val factory = RealFactory()
        val secret = ByteArray(32) { 0x5a.toByte() }
        val connected = AtomicInteger(0)
        val errors = AtomicInteger(0)
        val gateCalls = AtomicInteger(0)
        val listener = object : UsbGatewayListener {
            override fun onDesktopConnected() { connected.incrementAndGet() }
            override fun onAuthenticationFailed(reason: String) { errors.incrementAndGet() }
        }
        val gw = UsbGatewayServer(
            serverSocketFactory = factory,
            listener = listener,
            enrollmentSecret = secret,
            authenticationTimeoutMillis = 500,
            authenticationSuccessGate = {
                assertEquals(0, connected.get())
                gateCalls.incrementAndGet()
                false
            },
        )
        gw.start()
        try {
            val client = connectClient(factory)
            val input = client.getInputStream()
            val hello = ByteArray(36)
            readFully(input, hello)
            val serverNonce = hello.copyOfRange(4, 36)
            val clientNonce = ByteArray(32) { 0x22 }
            val clientProof = testAuthProof(
                secret,
                "agentcall-controller-client-v1\u0000",
                serverNonce,
                clientNonce,
            )
            client.getOutputStream().apply {
                write("G2C1".toByteArray(Charsets.US_ASCII))
                write(clientNonce)
                write(clientProof)
                flush()
            }

            assertTrue(gw.awaitCleanupCount(1, 2, TimeUnit.SECONDS))
            assertEquals(1, gateCalls.get())
            assertEquals(0, connected.get())
            assertEquals(1, errors.get())
            expectClosed(client)
            client.close()
        } finally {
            gw.stop()
            factory.server.close()
        }
    }

    @Test
    fun `valid mutual proof connects and rejects duplicate PCM sequence`() {
        val factory = RealFactory()
        val secret = ByteArray(32) { 0x5a.toByte() }
        val connected = AtomicInteger(0)
        val listener = object : UsbGatewayListener {
            override fun onDesktopConnected() { connected.incrementAndGet() }
        }
        val gw = UsbGatewayServer(
            serverSocketFactory = factory,
            listener = listener,
            enrollmentSecret = secret,
            authenticationTimeoutMillis = 500,
        )
        gw.start()
        try {
            val client = connectClient(factory)
            val input = client.getInputStream()
            val hello = ByteArray(36)
            readFully(input, hello)
            assertArrayEquals("G2A1".toByteArray(Charsets.US_ASCII), hello.copyOfRange(0, 4))
            val serverNonce = hello.copyOfRange(4, 36)
            val clientNonce = ByteArray(32) { 0x22 }
            val clientProof = testAuthProof(
                secret,
                "agentcall-controller-client-v1\u0000",
                serverNonce,
                clientNonce,
            )
            client.getOutputStream().apply {
                write("G2C1".toByteArray(Charsets.US_ASCII))
                write(clientNonce)
                write(clientProof)
                flush()
            }
            val serverRecord = ByteArray(36)
            readFully(input, serverRecord)
            assertArrayEquals("G2S1".toByteArray(Charsets.US_ASCII), serverRecord.copyOfRange(0, 4))
            assertArrayEquals(
                testAuthProof(
                    secret,
                    "agentcall-controller-server-v1\u0000",
                    serverNonce,
                    clientNonce,
                ),
                serverRecord.copyOfRange(4, 36),
            )
            val expectedSessionId = testSessionId(secret, serverNonce, clientNonce)
            val pcm = FrameCodec.encode(
                Frame(
                    kind = FrameKind.PCM,
                    direction = FrameDirection.HOST_TO_DEVICE,
                    sessionId = expectedSessionId,
                    sequence = 1L,
                    timestampMicros = 0L,
                    flags = FrameFlags.NONE,
                    payload = pcm640(),
                )
            )
            val replay = FrameCodec.encode(
                Frame(
                    kind = FrameKind.PCM,
                    direction = FrameDirection.HOST_TO_DEVICE,
                    sessionId = expectedSessionId,
                    sequence = 1L,
                    timestampMicros = 20_000L,
                    flags = FrameFlags.NONE,
                    payload = pcm640(seed = 99),
                )
            )
            client.getOutputStream().apply { write(pcm); write(replay); flush() }
            val deadline = System.currentTimeMillis() + 2_000
            while (gw.downlinkQueueDepth() < 2 && System.currentTimeMillis() < deadline) Thread.sleep(10)
            assertEquals(1, connected.get())
            assertEquals(1, gw.connectedClientCount())
            assertEquals("duplicate sequence must not admit replayed PCM", 1, gw.downlinkQueueDepth())
            val admitted = ByteArray(PcmContract.BYTES_PER_FRAME)
            assertTrue(gw.pollDownlinkInto(admitted))
            assertArrayEquals(pcm640(), admitted)
            client.close()
        } finally {
            gw.stop()
            factory.server.close()
        }
    }

    @Test
    fun `stopped rotation rejects old secret and accepts replacement on next server lifecycle`() {
        class MemoryStorage : ControllerSecretStorage {
            private var value: ByteArray? = null
            override fun read(): ByteArray? = value?.copyOf()
            override fun write(secret: ByteArray) {
                value?.fill(0)
                value = secret.copyOf()
            }
            override fun clear() {
                value?.fill(0)
                value = null
            }
        }

        var generation = 0
        val store = ControllerEnrollmentStore(MemoryStorage()) {
            generation++
            ByteArray(ControllerEnrollmentStore.SECRET_BYTES) { generation.toByte() }
        }
        val oldSecret = store.enroll()
        val firstFactory = RealFactory()
        val firstServer = UsbGatewayServer(
            serverSocketFactory = firstFactory,
            enrollmentSecret = oldSecret,
            authenticationTimeoutMillis = 500,
        )
        firstServer.start()
        try {
            val firstClient = authenticateClient(firstFactory, oldSecret, 0x31)
            assertEquals(1, firstServer.connectedClientCount())
            firstClient.close()
        } finally {
            firstServer.stop()
            firstFactory.server.close()
        }

        val replacementSecret = store.rotate()
        assertFalse(oldSecret.contentEquals(replacementSecret))
        val replacementFactory = RealFactory()
        val connected = AtomicInteger(0)
        val replacementServer = UsbGatewayServer(
            serverSocketFactory = replacementFactory,
            listener = object : UsbGatewayListener {
                override fun onDesktopConnected() { connected.incrementAndGet() }
            },
            enrollmentSecret = replacementSecret,
            authenticationTimeoutMillis = 500,
        )
        replacementServer.start()
        try {
            val staleClient = connectClient(replacementFactory)
            val staleHello = ByteArray(36)
            readFully(staleClient.getInputStream(), staleHello)
            val staleServerNonce = staleHello.copyOfRange(4, 36)
            val staleClientNonce = ByteArray(32) { 0x41 }
            staleClient.getOutputStream().apply {
                write("G2C1".toByteArray(Charsets.US_ASCII))
                write(staleClientNonce)
                write(testAuthProof(
                    oldSecret,
                    "agentcall-controller-client-v1\u0000",
                    staleServerNonce,
                    staleClientNonce,
                ))
                flush()
            }
            assertTrue(replacementServer.awaitCleanupCount(1, 2, TimeUnit.SECONDS))
            assertEquals(0, connected.get())
            expectClosed(staleClient)
            staleClient.close()

            val replacementClient = authenticateClient(replacementFactory, replacementSecret, 0x51)
            val connectedDeadline = System.currentTimeMillis() + 2_000
            while (connected.get() == 0 && System.currentTimeMillis() < connectedDeadline) Thread.sleep(5)
            assertEquals(1, connected.get())
            assertEquals(1, replacementServer.connectedClientCount())
            replacementClient.close()
        } finally {
            replacementServer.stop()
            replacementFactory.server.close()
            oldSecret.fill(0)
            replacementSecret.fill(0)
        }
    }

    @Test
    fun `authenticated socket rejects stale session id before admitting PCM`() {
        val factory = RealFactory()
        val secret = ByteArray(32) { 0x5a.toByte() }
        val gw = UsbGatewayServer(
            serverSocketFactory = factory,
            enrollmentSecret = secret,
            authenticationTimeoutMillis = 500,
        )
        gw.start()
        try {
            val client = connectClient(factory)
            val input = client.getInputStream()
            val hello = ByteArray(36)
            readFully(input, hello)
            val serverNonce = hello.copyOfRange(4, 36)
            val clientNonce = ByteArray(32) { 0x44 }
            client.getOutputStream().apply {
                write("G2C1".toByteArray(Charsets.US_ASCII))
                write(clientNonce)
                write(testAuthProof(
                    secret,
                    "agentcall-controller-client-v1\u0000",
                    serverNonce,
                    clientNonce,
                ))
                flush()
            }
            readFully(input, ByteArray(36))
            val expectedSessionId = testSessionId(secret, serverNonce, clientNonce)
            val staleSessionId = (expectedSessionId + 1L) and 0xFFFF_FFFFL
            client.getOutputStream().apply {
                write(FrameCodec.encode(Frame(
                    kind = FrameKind.PCM,
                    direction = FrameDirection.HOST_TO_DEVICE,
                    sessionId = staleSessionId,
                    sequence = 1L,
                    timestampMicros = 0L,
                    flags = FrameFlags.NONE,
                    payload = pcm640(),
                )))
                flush()
            }
            assertTrue(gw.awaitCleanupCount(1, 2, TimeUnit.SECONDS))
            assertEquals(0, gw.downlinkQueueDepth())
            assertEquals(0, gw.connectedClientCount())
            expectClosed(client)
            client.close()
        } finally {
            gw.stop()
            factory.server.close()
        }
    }

    private fun authenticateClient(factory: RealFactory, secret: ByteArray, nonceSeed: Int): Socket {
        val client = connectClient(factory)
        try {
            val input = client.getInputStream()
            val hello = ByteArray(36)
            readFully(input, hello)
            assertArrayEquals("G2A1".toByteArray(Charsets.US_ASCII), hello.copyOfRange(0, 4))
            val serverNonce = hello.copyOfRange(4, 36)
            val clientNonce = ByteArray(32) { nonceSeed.toByte() }
            client.getOutputStream().apply {
                write("G2C1".toByteArray(Charsets.US_ASCII))
                write(clientNonce)
                write(testAuthProof(
                    secret,
                    "agentcall-controller-client-v1\u0000",
                    serverNonce,
                    clientNonce,
                ))
                flush()
            }
            val serverRecord = ByteArray(36)
            readFully(input, serverRecord)
            assertArrayEquals("G2S1".toByteArray(Charsets.US_ASCII), serverRecord.copyOfRange(0, 4))
            assertArrayEquals(
                testAuthProof(
                    secret,
                    "agentcall-controller-server-v1\u0000",
                    serverNonce,
                    clientNonce,
                ),
                serverRecord.copyOfRange(4, 36),
            )
            return client
        } catch (error: Throwable) {
            client.close()
            throw error
        }
    }

    private fun readFully(input: InputStream, destination: ByteArray) {
        var offset = 0
        while (offset < destination.size) {
            val count = input.read(destination, offset, destination.size - offset)
            if (count < 0) fail("stream ended early")
            offset += count
        }
    }

    private fun testAuthProof(
        secret: ByteArray,
        domain: String,
        serverNonce: ByteArray,
        clientNonce: ByteArray,
    ): ByteArray = Mac.getInstance("HmacSHA256").run {
        init(SecretKeySpec(secret, "HmacSHA256"))
        update(domain.toByteArray(Charsets.US_ASCII))
        update(serverNonce)
        doFinal(clientNonce)
    }

    private fun testSessionId(
        secret: ByteArray,
        serverNonce: ByteArray,
        clientNonce: ByteArray,
    ): Long {
        val digest = testAuthProof(
            secret,
            "agentcall-controller-session-v1\u0000",
            serverNonce,
            clientNonce,
        )
        return ((digest[0].toLong() and 0xFFL) shl 24) or
            ((digest[1].toLong() and 0xFFL) shl 16) or
            ((digest[2].toLong() and 0xFFL) shl 8) or
            (digest[3].toLong() and 0xFFL)
    }

    // ---- one accepted client only ----

    @Test
    fun `only one PC client is accepted, second is rejected or ignored`() {
        val factory = RealFactory()
        val gw = UsbGatewayServer(factory)
        gw.start()
        try {
            val first = connectClient(factory)
            Thread.sleep(150)
            assertEquals(1, gw.connectedClientCount())

            val second = connectClient(factory)
            Thread.sleep(150)
            // Either rejected immediately or counted as not admitted; never >1.
            assertTrue("at most one client", gw.connectedClientCount() <= 1)

            first.close()
            second.close()
        } finally {
            gw.stop()
            factory.server.close()
        }
    }

    // ---- CONTROL direction: HOST_TO_DEVICE only from PC ----

    @Test
    fun `CONTROL in wrong direction DEVICE_TO_HOST closes connection with cleanup`() {
        val factory = RealFactory()
        val gw = UsbGatewayServer(factory)
        gw.start()
        try {
            val client = connectClient(factory)
            Thread.sleep(150)
            val out: OutputStream = client.getOutputStream()

            // A CONTROL frame flowing device->host from the PC is illegal.
            val bad = rawFrame(
                kind = FrameKind.CONTROL.code,
                dir = FrameDirection.DEVICE_TO_HOST.code,
                payload = """{"command":"status","idempotencyKey":"k"}""".toByteArray(),
            )
            out.write(bad)
            out.flush()

            assertTrue("cleanup should fire on direction error",
                gw.awaitCleanupCount(1, 2, TimeUnit.SECONDS))
            assertEquals(1, gw.cleanupCount())

            expectClosed(client)
            client.close()
        } finally {
            gw.stop()
            factory.server.close()
        }
    }

    // ---- PCM direction + exact 640 contract ----

    @Test
    fun `PCM HOST_TO_DEVICE downlink accepted when exactly 640 bytes`() {
        val factory = RealFactory()
        val gw = UsbGatewayServer(factory)
        gw.start()
        try {
            val client = connectClient(factory)
            Thread.sleep(150)
            val out: OutputStream = client.getOutputStream()

            val good = FrameCodec.encode(
                Frame(
                    kind = FrameKind.PCM,
                    direction = FrameDirection.HOST_TO_DEVICE, // downlink
                    sessionId = 1L,
                    sequence = 1L,
                    timestampMicros = 0L,
                    flags = FrameFlags.NONE,
                    payload = pcm640(),
                )
            )
            out.write(good)
            out.flush()
            Thread.sleep(150)

            assertEquals(0, gw.cleanupCount())
            assertEquals(1, gw.downlinkQueueDepth())
            client.close()
        } finally {
            gw.stop()
            factory.server.close()
        }
    }

    @Test
    fun `PCM with wrong size closes connection with cleanup`() {
        val factory = RealFactory()
        val gw = UsbGatewayServer(factory)
        gw.start()
        try {
            val client = connectClient(factory)
            Thread.sleep(150)
            val out: OutputStream = client.getOutputStream()

            // PCM payload NOT 640 bytes — built raw to bypass Frame invariants.
            val raw = rawFrame(
                kind = FrameKind.PCM.code,
                dir = FrameDirection.HOST_TO_DEVICE.code,
                payload = ByteArray(10) { it.toByte() },
            )
            out.write(raw)
            out.flush()

            assertTrue(gw.awaitCleanupCount(1, 2, TimeUnit.SECONDS))
            assertEquals(1, gw.cleanupCount())
            expectClosed(client)
            client.close()
        } finally {
            gw.stop()
            factory.server.close()
        }
    }

    @Test
    fun `PCM in wrong direction DEVICE_TO_HOST from PC closes connection`() {
        val factory = RealFactory()
        val gw = UsbGatewayServer(factory)
        gw.start()
        try {
            val client = connectClient(factory)
            Thread.sleep(150)
            val out: OutputStream = client.getOutputStream()

            // PC must never send DEVICE_TO_HOST PCM (that is the uplink lane).
            val raw = rawFrame(
                kind = FrameKind.PCM.code,
                dir = FrameDirection.DEVICE_TO_HOST.code,
                payload = pcm640(),
            )
            out.write(raw)
            out.flush()

            assertTrue(gw.awaitCleanupCount(1, 2, TimeUnit.SECONDS))
            assertEquals(1, gw.cleanupCount())
            expectClosed(client)
            client.close()
        } finally {
            gw.stop()
            factory.server.close()
        }
    }

    // ---- EVENT direction: DEVICE_TO_HOST only (PC must not send EVENT) ----

    @Test
    fun `PC sending EVENT closes connection`() {
        val factory = RealFactory()
        val gw = UsbGatewayServer(factory)
        gw.start()
        try {
            val client = connectClient(factory)
            Thread.sleep(150)
            val out: OutputStream = client.getOutputStream()

            // EVENT is device->host; the PC has no business emitting it.
            val raw = rawFrame(
                kind = FrameKind.EVENT.code,
                dir = FrameDirection.DEVICE_TO_HOST.code,
                payload = "{}".toByteArray(),
            )
            out.write(raw)
            out.flush()

            assertTrue(gw.awaitCleanupCount(1, 2, TimeUnit.SECONDS))
            assertEquals(1, gw.cleanupCount())
            expectClosed(client)
            client.close()
        } finally {
            gw.stop()
            factory.server.close()
        }
    }

    // ---- backpressure: bounded RX queue drops on overflow, no cleanup ----

    @Test
    fun `downlink queue is bounded, overflow drops without closing connection`() {
        val factory = RealFactory()
        val gw = UsbGatewayServer(factory)
        gw.start()
        try {
            val client = connectClient(factory)
            Thread.sleep(150)
            val out: OutputStream = client.getOutputStream()

            val flood = gw.downlinkQueueCapacity() + 4
            for (i in 0 until flood) {
                out.write(
                    FrameCodec.encode(
                        Frame(
                            kind = FrameKind.PCM,
                            direction = FrameDirection.HOST_TO_DEVICE,
                            sessionId = 1L,
                            sequence = i.toLong(),
                            timestampMicros = 0L,
                            flags = FrameFlags.NONE,
                            payload = pcm640(i),
                        )
                    )
                )
            }
            out.flush()
            Thread.sleep(250)

            assertTrue("queue must stay bounded",
                gw.downlinkQueueDepth() <= gw.downlinkQueueCapacity())
            assertEquals(0, gw.cleanupCount())
            client.close()
        } finally {
            gw.stop()
            factory.server.close()
        }
    }

    // ---- malformed stream: closes connection with cleanup once ----

    @Test
    fun `malformed frame bytes close connection with cleanup`() {
        val factory = RealFactory()
        val gw = UsbGatewayServer(factory)
        gw.start()
        try {
            val client = connectClient(factory)
            Thread.sleep(150)
            val out: OutputStream = client.getOutputStream()

            // A complete header with bad magic must fail immediately. A short
            // prefix alone is valid streaming input and must be buffered.
            out.write(ByteArray(FrameCodec.HEADER_SIZE) { 0x00 })
            out.flush()

            assertTrue(gw.awaitCleanupCount(1, 2, TimeUnit.SECONDS))
            assertEquals(1, gw.cleanupCount())
            expectClosed(client)
            client.close()
        } finally {
            gw.stop()
            factory.server.close()
        }
    }

    @Test
    fun `oversize declared payload closes connection with cleanup`() {
        val factory = RealFactory()
        val gw = UsbGatewayServer(factory)
        gw.start()
        try {
            val client = connectClient(factory)
            Thread.sleep(150)
            val out: OutputStream = client.getOutputStream()

            // Declare a payload length above MAX_PAYLOAD_SIZE.
            val raw = rawFrame(
                kind = FrameKind.CONTROL.code,
                dir = FrameDirection.HOST_TO_DEVICE.code,
                payloadLen = (FrameCodec.MAX_PAYLOAD_SIZE + 1),
                payload = ByteArray(0),
            )
            out.write(raw)
            out.flush()

            assertTrue(gw.awaitCleanupCount(1, 2, TimeUnit.SECONDS))
            assertEquals(1, gw.cleanupCount())
            expectClosed(client)
            client.close()
        } finally {
            gw.stop()
            factory.server.close()
        }
    }

    // ---- valid command accepted; mutation applied once ----

    @Test
    fun `valid status command does not close connection or trigger cleanup`() {
        val factory = RealFactory()
        val gw = UsbGatewayServer(factory)
        gw.start()
        try {
            val client = connectClient(factory)
            Thread.sleep(150)
            val out: OutputStream = client.getOutputStream()
            out.write(encodeControl("""{"command":"status","idempotencyKey":"k"}""", 1))
            out.flush()
            Thread.sleep(200)

            assertEquals(0, gw.cleanupCount())
            assertEquals(0, gw.appliedMutationCount())
            client.close()
        } finally {
            gw.stop()
            factory.server.close()
        }
    }

    @Test
    fun `valid dial command is applied exactly once`() {
        val factory = RealFactory()
        val gw = UsbGatewayServer(factory)
        gw.start()
        try {
            val client = connectClient(factory)
            Thread.sleep(150)
            val out: OutputStream = client.getOutputStream()
            out.write(encodeControl(
                """{"command":"dial","idempotencyKey":"k1","destination":"+15551230100"}""", 1))
            out.flush()
            Thread.sleep(200)

            assertEquals(1, gw.appliedMutationCount())
            assertEquals(0, gw.cleanupCount())
            client.close()
        } finally {
            gw.stop()
            factory.server.close()
        }
    }

    @Test
    fun `in flight duplicate dial coalesces and receives the original typed result`() {
        val factory = RealFactory()
        val executed = mutableListOf<GatewayCommand>()
        val entered = CountDownLatch(1)
        val release = CountDownLatch(1)
        val executor = GatewayCommandExecutor { command ->
            executed += command
            entered.countDown()
            assertTrue(release.await(2, TimeUnit.SECONDS))
            CommandExecutionResult.Rejected(command.name, "policy denied")
        }
        val gw = UsbGatewayServer(factory, executor)
        gw.start()
        try {
            val client = connectClient(factory)
            client.soTimeout = 2_000
            Thread.sleep(150)
            val out: OutputStream = client.getOutputStream()
            val payload = """{"command":"dial","idempotencyKey":"dup","destination":"+15550000100"}"""
            out.write(encodeControl(payload, 1))
            out.flush()
            assertTrue(entered.await(2, TimeUnit.SECONDS))
            out.write(encodeControl(payload, 2))
            out.flush()
            release.countDown()

            val first = readFrame(client.getInputStream()).payload.toString(Charsets.UTF_8)
            val duplicate = readFrame(client.getInputStream()).payload.toString(Charsets.UTF_8)
            assertEquals(first, duplicate)
            assertTrue(first.contains("\"accepted\":false"))
            assertTrue(first.contains("\"reason\":\"policy denied\""))
            assertEquals("mutation applied once despite duplicate", 1, gw.appliedMutationCount())
            assertEquals(1, executed.size)
            assertTrue(executed.single() is GatewayCommand.Dial)
            assertEquals(0, gw.cleanupCount())
            client.close()
        } finally {
            release.countDown()
            gw.stop()
            factory.server.close()
        }
    }

    @Test
    fun `malformed command payload closes connection with cleanup`() {
        val factory = RealFactory()
        val gw = UsbGatewayServer(factory)
        gw.start()
        try {
            val client = connectClient(factory)
            Thread.sleep(150)
            val out: OutputStream = client.getOutputStream()
            out.write(encodeControl("""{"command":"nope","idempotencyKey":"k"}""", 1))
            out.flush()

            assertTrue(gw.awaitCleanupCount(1, 2, TimeUnit.SECONDS))
            assertEquals(1, gw.cleanupCount())
            expectClosed(client)
            client.close()
        } finally {
            gw.stop()
            factory.server.close()
        }
    }

    // ---- disconnect: cleanup exactly once, queues zeroized/released ----

    @Test
    fun `client disconnect runs cleanup exactly once`() {
        val factory = RealFactory()
        val gw = UsbGatewayServer(factory)
        gw.start()
        try {
            val client = connectClient(factory)
            Thread.sleep(150)
            val out: OutputStream = client.getOutputStream()
            out.write(FrameCodec.encode(
                Frame(
                    kind = FrameKind.PCM,
                    direction = FrameDirection.HOST_TO_DEVICE,
                    sessionId = 1L,
                    sequence = 1L,
                    timestampMicros = 0L,
                    flags = FrameFlags.NONE,
                    payload = pcm640(),
                )
            ))
            out.flush()
            Thread.sleep(150)
            assertTrue("precondition: frame queued", gw.downlinkQueueDepth() >= 1)

            client.close()
            assertTrue(gw.awaitCleanupCount(1, 2, TimeUnit.SECONDS))
            assertEquals(1, gw.cleanupCount())

            assertEquals(0, gw.downlinkQueueDepth())
        } finally {
            gw.stop()
            factory.server.close()
        }
    }

    @Test
    fun `queued mutation from disconnected generation never executes or reaches replacement`() {
        val factory = RealFactory()
        val entered = CountDownLatch(1)
        val release = CountDownLatch(1)
        val executedKeys = mutableListOf<String>()
        val executor = GatewayCommandExecutor { command ->
            synchronized(executedKeys) { executedKeys += command.idempotencyKey }
            if (command.idempotencyKey == "blocker") {
                entered.countDown()
                release.await(3, TimeUnit.SECONDS)
            }
            CommandExecutionResult.Accepted(command.name)
        }
        val gw = UsbGatewayServer(factory, executor)
        gw.start()
        try {
            val first = connectClient(factory)
            first.getOutputStream().apply {
                write(encodeControl("""{"command":"dial","idempotencyKey":"blocker","destination":"+15550000100"}""", 1))
                flush()
            }
            assertTrue(entered.await(2, TimeUnit.SECONDS))
            first.getOutputStream().apply {
                write(encodeControl("""{"command":"dial","idempotencyKey":"stale","destination":"+15550000101"}""", 2))
                flush()
            }
            first.close()
            assertTrue(gw.awaitCleanupCount(1, 2, TimeUnit.SECONDS))

            val replacement = connectClient(factory)
            replacement.soTimeout = 400
            Thread.sleep(100)
            release.countDown()
            Thread.sleep(250)
            synchronized(executedKeys) { assertFalse(executedKeys.contains("stale")) }
            try {
                readFrame(replacement.getInputStream())
                fail("replacement generation received stale command_result")
            } catch (_: java.net.SocketTimeoutException) {
                // Expected: no stale result is routed to generation N+1.
            }
            replacement.close()
        } finally {
            release.countDown()
            gw.stop()
            factory.server.close()
        }
    }

    @Test
    fun `executor throw returns one typed failure per coalesced waiter and permits retry`() {
        val factory = RealFactory()
        val entered = CountDownLatch(1)
        val release = CountDownLatch(1)
        val attempts = AtomicInteger(0)
        val executor = GatewayCommandExecutor { command ->
            if (attempts.incrementAndGet() == 1) {
                entered.countDown()
                release.await(2, TimeUnit.SECONDS)
                throw IllegalStateException("boom")
            }
            CommandExecutionResult.Accepted(command.name)
        }
        val gw = UsbGatewayServer(factory, executor)
        gw.start()
        try {
            val client = connectClient(factory)
            client.soTimeout = 2_000
            val payload = """{"command":"dial","idempotencyKey":"retryable","destination":"+15550000100"}"""
            client.getOutputStream().apply { write(encodeControl(payload, 1)); flush() }
            assertTrue(entered.await(2, TimeUnit.SECONDS))
            client.getOutputStream().apply { write(encodeControl(payload, 2)); flush() }
            Thread.sleep(100) // let the reader register the duplicate waiter before execution fails
            release.countDown()
            repeat(2) {
                val failure = readFrame(client.getInputStream()).payload.toString(Charsets.UTF_8)
                assertTrue(failure.contains("\"accepted\":false"))
                assertTrue(failure.contains("\"reason\":\"command executor failed\""))
            }
            client.getOutputStream().apply { write(encodeControl(payload, 3)); flush() }
            val retry = readFrame(client.getInputStream()).payload.toString(Charsets.UTF_8)
            assertTrue(retry.contains("\"accepted\":true"))
            assertEquals(2, attempts.get())
            client.close()
        } finally {
            release.countDown()
            gw.stop()
            factory.server.close()
        }
    }

    @Test
    fun `server stop clears queued downlink pcm`() {
        val factory = RealFactory()
        val gw = UsbGatewayServer(factory)
        gw.start()
        val client = connectClient(factory)
        try {
            Thread.sleep(150)
            client.getOutputStream().apply {
                write(FrameCodec.encode(Frame(
                    kind = FrameKind.PCM,
                    direction = FrameDirection.HOST_TO_DEVICE,
                    sessionId = 1L,
                    sequence = 1L,
                    timestampMicros = 0L,
                    flags = FrameFlags.NONE,
                    payload = pcm640(seed = 4),
                )))
                flush()
            }
            val deadline = System.currentTimeMillis() + 2_000
            while (gw.downlinkQueueDepth() == 0 && System.currentTimeMillis() < deadline) Thread.sleep(10)
            assertEquals(1, gw.downlinkQueueDepth())
            gw.stop()
            assertEquals(0, gw.downlinkQueueDepth())
        } finally {
            client.close()
            gw.stop()
            factory.server.close()
        }
    }

    @Test
    fun `each sequential client disconnect runs its own cleanup exactly once`() {
        val factory = RealFactory()
        val gw = UsbGatewayServer(factory)
        gw.start()
        try {
            val first = connectClient(factory)
            Thread.sleep(150)
            first.getOutputStream().apply {
                write(FrameCodec.encode(
                    Frame(
                        kind = FrameKind.PCM,
                        direction = FrameDirection.HOST_TO_DEVICE,
                        sessionId = 1L,
                        sequence = 1L,
                        timestampMicros = 0L,
                        flags = FrameFlags.NONE,
                        payload = pcm640(seed = 1),
                    )
                ))
                flush()
            }
            Thread.sleep(150)
            assertTrue("precondition: first frame queued", gw.downlinkQueueDepth() >= 1)
            first.close()
            assertTrue(gw.awaitCleanupCount(1, 2, TimeUnit.SECONDS))
            assertEquals(0, gw.downlinkQueueDepth())
            assertEquals(0, gw.connectedClientCount())

            val second = connectClient(factory)
            Thread.sleep(150)
            second.getOutputStream().apply {
                write(FrameCodec.encode(
                    Frame(
                        kind = FrameKind.PCM,
                        direction = FrameDirection.HOST_TO_DEVICE,
                        sessionId = 2L,
                        sequence = 1L,
                        timestampMicros = 0L,
                        flags = FrameFlags.NONE,
                        payload = pcm640(seed = 2),
                    )
                ))
                flush()
            }
            Thread.sleep(150)
            assertTrue("precondition: second frame queued", gw.downlinkQueueDepth() >= 1)
            second.close()

            assertTrue("second connection must run independent cleanup",
                gw.awaitCleanupCount(2, 2, TimeUnit.SECONDS))
            assertEquals(2, gw.cleanupCount())
            assertEquals(0, gw.downlinkQueueDepth())
            assertEquals(0, gw.connectedClientCount())
        } finally {
            gw.stop()
            factory.server.close()
        }
    }

    @Test
    fun `stale first connection teardown cannot close a reconnected client`() {
        val factory = RealFactory()
        val gw = UsbGatewayServer(factory)
        gw.start()
        try {
            val first = connectClient(factory)
            Thread.sleep(150)
            first.close()
            assertTrue(gw.awaitCleanupCount(1, 2, TimeUnit.SECONDS))

            val second = connectClient(factory)
            Thread.sleep(150)
            assertEquals(1, gw.connectedClientCount())
            second.getOutputStream().apply {
                write(FrameCodec.encode(
                    Frame(
                        kind = FrameKind.PCM,
                        direction = FrameDirection.HOST_TO_DEVICE,
                        sessionId = 2L,
                        sequence = 1L,
                        timestampMicros = 0L,
                        flags = FrameFlags.NONE,
                        payload = pcm640(seed = 3),
                    )
                ))
                flush()
            }
            Thread.sleep(250)

            assertEquals("reconnected client must remain admitted", 1, gw.connectedClientCount())
            assertEquals("stale teardown must not clear new PCM", 1, gw.downlinkQueueDepth())
            assertEquals(1, gw.cleanupCount())
            second.close()
            assertTrue(gw.awaitCleanupCount(2, 2, TimeUnit.SECONDS))
        } finally {
            gw.stop()
            factory.server.close()
        }
    }

    @Test
    fun `stale downlink poller cannot consume pcm from reconnected generation`() {
        val factory = RealFactory()
        val gw = UsbGatewayServer(factory)
        gw.start()
        try {
            val first = connectClient(factory)
            Thread.sleep(150)
            val stalePoller = gw.downlinkPollerForCurrentGeneration()
            assertNotNull(stalePoller)
            first.close()
            assertTrue(gw.awaitCleanupCount(1, 2, TimeUnit.SECONDS))

            val second = connectClient(factory)
            Thread.sleep(150)
            second.getOutputStream().apply {
                write(FrameCodec.encode(
                    Frame(
                        kind = FrameKind.PCM,
                        direction = FrameDirection.HOST_TO_DEVICE,
                        sessionId = 2L,
                        sequence = 1L,
                        timestampMicros = 0L,
                        flags = FrameFlags.NONE,
                        payload = pcm640(seed = 4),
                    )
                ))
                flush()
            }
            val deadline = System.currentTimeMillis() + 2_000
            while (gw.downlinkQueueDepth() == 0 && System.currentTimeMillis() < deadline) Thread.sleep(10)
            assertEquals(1, gw.downlinkQueueDepth())

            val staleDestination = ByteArray(PcmContract.BYTES_PER_FRAME) { 9 }
            assertFalse(stalePoller!!.invoke(staleDestination))
            assertArrayEquals(ByteArray(PcmContract.BYTES_PER_FRAME) { 9 }, staleDestination)
            val currentDestination = ByteArray(PcmContract.BYTES_PER_FRAME)
            assertTrue(gw.pollDownlinkInto(currentDestination))
            assertArrayEquals(pcm640(seed = 4), currentDestination)
            second.close()
        } finally {
            gw.stop()
            factory.server.close()
        }
    }

    @Test
    fun `multiple error conditions do not run cleanup more than once`() {
        val factory = RealFactory()
        val gw = UsbGatewayServer(factory)
        gw.start()
        try {
            val client = connectClient(factory)
            Thread.sleep(150)
            val out: OutputStream = client.getOutputStream()

            repeat(5) {
                try {
                    out.write(ByteArray(FrameCodec.HEADER_SIZE) { 0x00 })
                    out.flush()
                } catch (_: IOException) {
                    // Expected once the first malformed header closes the socket.
                }
                Thread.sleep(50)
            }
            assertTrue(gw.awaitCleanupCount(1, 2, TimeUnit.SECONDS))
            assertEquals("cleanup runs at most once per connection", 1, gw.cleanupCount())
            client.close()
        } finally {
            gw.stop()
            factory.server.close()
        }
    }

    @Test
    fun `outbound submission never blocks a Telecom caller when peer stops reading`() {
        val factory = RealFactory()
        val gw = UsbGatewayServer(factory)
        gw.start()
        try {
            val client = connectClient(factory)
            client.receiveBufferSize = 1_024
            Thread.sleep(150)
            val completed = CountDownLatch(1)
            val producer = Thread({
                repeat(20_000) { gw.sendPcm(pcm640(seed = it)) }
                completed.countDown()
            }, "simulated-telecom-caller")
            producer.start()

            assertTrue("outbound submission blocked on socket I/O", completed.await(2, TimeUnit.SECONDS))
            client.close()
        } finally {
            gw.stop()
            factory.server.close()
        }
    }

    // ---- never auto-answer or dial without a command ----

    @Test
    fun `no outbound call is placed without an explicit dial command`() {
        val factory = RealFactory()
        val gw = UsbGatewayServer(factory)
        gw.start()
        try {
            val client = connectClient(factory)
            Thread.sleep(200)
            assertEquals(0, gw.appliedMutationCount())
            assertEquals(0, gw.autoCallAttempts())
            client.close()
        } finally {
            gw.stop()
            factory.server.close()
        }
    }

    @Test
    fun `device events and PCM are serialized to the connected PC in canonical order`() {
        val factory = RealFactory()
        val gw = UsbGatewayServer(factory)
        gw.start()
        try {
            val client = connectClient(factory)
            client.soTimeout = 2_000
            Thread.sleep(150)

            assertTrue(gw.sendEvent("{\"event\":\"active\",\"callId\":\"call-1\"}".toByteArray()))
            val pcm = pcm640(seed = 7)
            assertTrue(gw.sendPcm(pcm))

            val event = readFrame(client.getInputStream())
            val audio = readFrame(client.getInputStream())
            assertEquals(FrameKind.EVENT, event.kind)
            assertEquals(FrameDirection.DEVICE_TO_HOST, event.direction)
            assertEquals(0L, event.sequence)
            assertEquals("{\"event\":\"active\",\"callId\":\"call-1\"}", event.payload.toString(Charsets.UTF_8))
            assertEquals(FrameKind.PCM, audio.kind)
            assertEquals(FrameDirection.DEVICE_TO_HOST, audio.direction)
            assertEquals(1L, audio.sequence)
            assertTrue(audio.payload.contentEquals(pcm))
            client.close()
        } finally {
            gw.stop()
            factory.server.close()
        }
    }

    /**
     * Lightweight in-test fake recording-artifact receiver that records each
     * lifecycle call. Used to assert wire-level routing from the gateway's
     * CONTROL/ARTIFACT frame paths into the receiver. The production wiring
     * uses [com.callagent.gateway.dialer.PhoneRecordingArtifactReceiver]; this
     * fake is for protocol routing only (no FS, no MediaStore).
     */
    private class FakeArtifactReceiver : RecordingArtifactReceiver {
        val begins = mutableListOf<GatewayCommand.RecordingArtifactBegin>()
        val chunks = mutableListOf<ByteArray>()
        val commits = mutableListOf<GatewayCommand.RecordingArtifactCommit>()
        var aborted: Int = 0
        var beginResult: Boolean = true
        var appendResult: Boolean = true
        var commitResult: Boolean = true

        override fun begin(command: GatewayCommand.RecordingArtifactBegin): Boolean {
            begins += command
            return beginResult
        }

        override fun append(payload: ByteArray): Boolean {
            chunks += payload.copyOf()
            return appendResult
        }

        override fun commit(command: GatewayCommand.RecordingArtifactCommit): Boolean {
            commits += command
            return commitResult
        }

        override fun abort() {
            aborted += 1
        }
    }

    private fun beginJson(callId: String, size: Long, sha: String, artifact: String = "conversation.mkv"): String =
        """{"command":"recording_artifact_begin","callId":"$callId","artifact":"$artifact","size":"$size","sha256":"$sha","durationMillis":"20"}"""

    private fun commitJson(callId: String): String =
        """{"command":"recording_artifact_commit","callId":"$callId"}"""

    // ---- artifact happy path: begin → ARTIFACT chunks → commit, no cleanup ----

    @Test
    fun `begin then ARTIFACT chunk then commit all route to receiver without closing connection`() {
        val factory = RealFactory()
        val fake = FakeArtifactReceiver()
        val gw = UsbGatewayServer(
            serverSocketFactory = factory,
            recordingArtifactReceiver = fake,
        )
        gw.start()
        try {
            val client = connectClient(factory)
            Thread.sleep(150)
            val out: OutputStream = client.getOutputStream()

            val sha = "0".repeat(64)
            out.write(encodeControl(beginJson("call-1", 8L, sha), 1))
            val chunk = byteArrayOf(1, 2, 3, 4, 5, 6, 7, 8)
            out.write(rawFrame(
                kind = FrameKind.ARTIFACT.code,
                dir = FrameDirection.HOST_TO_DEVICE.code,
                sequence = 2L,
                payload = chunk,
            ))
            out.write(encodeControl(commitJson("call-1"), 3))
            out.flush()
            Thread.sleep(250)

            assertEquals(1, fake.begins.size)
            assertEquals(1, fake.chunks.size)
            assertArrayEquals(chunk, fake.chunks[0])
            assertEquals(1, fake.commits.size)
            assertEquals(0, gw.cleanupCount())
            assertEquals(0, gw.appliedMutationCount())
            client.close()
        } finally {
            gw.stop()
            factory.server.close()
        }
    }

    // ---- ARTIFACT with no prior begin: receiver returns false, server closes ----

    @Test
    fun `ARTIFACT chunk with no active begin is rejected and closes the connection`() {
        val factory = RealFactory()
        val fake = FakeArtifactReceiver().apply { appendResult = false }
        val gw = UsbGatewayServer(
            serverSocketFactory = factory,
            recordingArtifactReceiver = fake,
        )
        gw.start()
        try {
            val client = connectClient(factory)
            Thread.sleep(150)
            val out: OutputStream = client.getOutputStream()

            out.write(rawFrame(
                kind = FrameKind.ARTIFACT.code,
                dir = FrameDirection.HOST_TO_DEVICE.code,
                payload = byteArrayOf(9, 9, 9),
            ))
            out.flush()

            assertTrue(gw.awaitCleanupCount(1, 2, TimeUnit.SECONDS))
            assertEquals(1, gw.cleanupCount())
            expectClosed(client)
            client.close()
        } finally {
            gw.stop()
            factory.server.close()
        }
    }

    // ---- ARTIFACT in wrong direction (device->host) from PC closes the connection ----

    @Test
    fun `ARTIFACT frame in wrong direction DEVICE_TO_HOST closes the connection`() {
        val factory = RealFactory()
        val gw = UsbGatewayServer(factory)
        gw.start()
        try {
            val client = connectClient(factory)
            Thread.sleep(150)
            val out: OutputStream = client.getOutputStream()

            out.write(rawFrame(
                kind = FrameKind.ARTIFACT.code,
                dir = FrameDirection.DEVICE_TO_HOST.code,
                payload = byteArrayOf(1, 2, 3),
            ))
            out.flush()

            assertTrue(gw.awaitCleanupCount(1, 2, TimeUnit.SECONDS))
            assertEquals(1, gw.cleanupCount())
            expectClosed(client)
            client.close()
        } finally {
            gw.stop()
            factory.server.close()
        }
    }

    // ---- ARTIFACT empty payload is malformed and closes the connection ----

    @Test
    fun `ARTIFACT frame with empty payload closes the connection`() {
        val factory = RealFactory()
        val gw = UsbGatewayServer(factory)
        gw.start()
        try {
            val client = connectClient(factory)
            Thread.sleep(150)
            val out: OutputStream = client.getOutputStream()

            out.write(rawFrame(
                kind = FrameKind.ARTIFACT.code,
                dir = FrameDirection.HOST_TO_DEVICE.code,
                payload = ByteArray(0),
            ))
            out.flush()

            assertTrue(gw.awaitCleanupCount(1, 2, TimeUnit.SECONDS))
            assertEquals(1, gw.cleanupCount())
            expectClosed(client)
            client.close()
        } finally {
            gw.stop()
            factory.server.close()
        }
    }

    // ---- commit without a begin (receiver returns false) closes connection ----

    @Test
    fun `commit with no active begin closes the connection with cleanup`() {
        val factory = RealFactory()
        val fake = FakeArtifactReceiver().apply { commitResult = false }
        val gw = UsbGatewayServer(
            serverSocketFactory = factory,
            recordingArtifactReceiver = fake,
        )
        gw.start()
        try {
            val client = connectClient(factory)
            Thread.sleep(150)
            val out: OutputStream = client.getOutputStream()

            out.write(encodeControl(commitJson("call-no-begin"), 1))
            out.flush()

            assertTrue(gw.awaitCleanupCount(1, 2, TimeUnit.SECONDS))
            assertEquals(1, gw.cleanupCount())
            assertEquals(1, fake.commits.size)
            expectClosed(client)
            client.close()
        } finally {
            gw.stop()
            factory.server.close()
        }
    }

    // ---- client disconnect after begin aborts the receiver exactly once ----

    @Test
    fun `disconnect after a begin aborts the active recording receiver exactly once`() {
        val factory = RealFactory()
        val fake = FakeArtifactReceiver()
        val gw = UsbGatewayServer(
            serverSocketFactory = factory,
            recordingArtifactReceiver = fake,
        )
        gw.start()
        try {
            val client = connectClient(factory)
            Thread.sleep(150)
            val out: OutputStream = client.getOutputStream()

            val sha = "0".repeat(64)
            out.write(encodeControl(beginJson("call-7", 4L, sha), 1))
            out.flush()
            Thread.sleep(150)
            assertEquals(1, fake.begins.size)

            client.close()
            assertTrue(gw.awaitCleanupCount(1, 2, TimeUnit.SECONDS))
            assertEquals(1, gw.cleanupCount())
            // teardownCurrentClient invokes recordingArtifactReceiver.abort()
            // unconditionally and is reached exactly once via the reader thread
            // finally-block when the connection terminates. The disconnect
            // after a successful begin must therefore abort the receiver once.
            assertEquals("receiver aborted exactly once on disconnect", 1, fake.aborted)
            // No commit ever happened, so the only artifact-call sequence is begin+abort.
            assertEquals(0, fake.commits.size)
        } finally {
            gw.stop()
            factory.server.close()
        }
    }

    @Test
    fun `coalesced begin ARTIFACT chunk and commit route in wire order`() {
        val factory = RealFactory()
        val fake = FakeArtifactReceiver()
        val gw = UsbGatewayServer(
            serverSocketFactory = factory,
            recordingArtifactReceiver = fake,
        )
        gw.start()
        try {
            val client = connectClient(factory)
            Thread.sleep(150)
            val chunk = byteArrayOf(4, 3, 2, 1)
            val coalesced = encodeControl(beginJson("call-coalesced", chunk.size.toLong(), "0".repeat(64)), 10) +
                rawFrame(
                    kind = FrameKind.ARTIFACT.code,
                    dir = FrameDirection.HOST_TO_DEVICE.code,
                    sequence = 11L,
                    payload = chunk,
                ) +
                encodeControl(commitJson("call-coalesced"), 12)

            client.getOutputStream().apply {
                write(coalesced)
                flush()
            }
            Thread.sleep(250)

            assertEquals(1, fake.begins.size)
            assertEquals("call-coalesced", fake.begins.single().callId)
            assertEquals(1, fake.chunks.size)
            assertArrayEquals(chunk, fake.chunks.single())
            assertEquals(1, fake.commits.size)
            assertEquals("call-coalesced", fake.commits.single().callId)
            assertEquals(0, gw.cleanupCount())
            client.close()
        } finally {
            gw.stop()
            factory.server.close()
        }
    }

    @Test
    fun `artifact sequence gap is observable without aborting the transfer`() {
        val factory = RealFactory()
        val fake = FakeArtifactReceiver()
        val gw = UsbGatewayServer(
            serverSocketFactory = factory,
            recordingArtifactReceiver = fake,
        )
        gw.start()
        try {
            val client = connectClient(factory)
            Thread.sleep(150)
            val chunk = byteArrayOf(1, 2, 3, 4)
            val out = client.getOutputStream()
            out.write(encodeControl(beginJson("call-gap", chunk.size.toLong(), "0".repeat(64)), 20))
            out.write(rawFrame(
                kind = FrameKind.ARTIFACT.code,
                dir = FrameDirection.HOST_TO_DEVICE.code,
                sequence = 22L,
                payload = chunk,
            ))
            out.write(encodeControl(commitJson("call-gap"), 23))
            out.flush()
            Thread.sleep(250)

            assertEquals(1L, gw.inboundSequenceGapCount())
            assertEquals(1L, gw.inboundLostFrameCount())
            assertEquals(1, fake.commits.size)
            assertEquals(0, gw.cleanupCount())
            client.close()
        } finally {
            gw.stop()
            factory.server.close()
        }
    }

    @Test
    fun `inbound sequence wraps from u32 max to zero without false loss`() {
        val factory = RealFactory()
        val gw = UsbGatewayServer(factory)
        gw.start()
        try {
            val client = connectClient(factory)
            Thread.sleep(150)
            val out = client.getOutputStream()
            out.write(rawFrame(
                kind = FrameKind.CONTROL.code,
                dir = FrameDirection.HOST_TO_DEVICE.code,
                sequence = 0xFFFF_FFFFL,
                payload = """{"command":"status","idempotencyKey":"max"}""".toByteArray(),
            ))
            out.write(encodeControl("""{"command":"status","idempotencyKey":"zero"}""", 0))
            out.flush()
            Thread.sleep(250)

            assertEquals(0L, gw.inboundSequenceGapCount())
            assertEquals(0L, gw.inboundLostFrameCount())
            assertEquals(0, gw.cleanupCount())
            client.close()
        } finally {
            gw.stop()
            factory.server.close()
        }
    }

    @Test
    fun `stale retransmit does not move sequence baseline or create false loss`() {
        val factory = RealFactory()
        val gw = UsbGatewayServer(factory)
        gw.start()
        try {
            val client = connectClient(factory)
            Thread.sleep(150)
            val out = client.getOutputStream()
            out.write(encodeControl("""{"command":"status","idempotencyKey":"first"}""", 100))
            out.write(encodeControl("""{"command":"status","idempotencyKey":"stale"}""", 99))
            out.write(encodeControl("""{"command":"status","idempotencyKey":"next"}""", 101))
            out.flush()
            Thread.sleep(250)

            assertEquals(0L, gw.inboundSequenceGapCount())
            assertEquals(0L, gw.inboundLostFrameCount())
            assertEquals(0, gw.cleanupCount())
            client.close()
        } finally {
            gw.stop()
            factory.server.close()
        }
    }

    @Test
    fun `oversize declared ARTIFACT is rejected before receiver append`() {
        val factory = RealFactory()
        val fake = FakeArtifactReceiver()
        val gw = UsbGatewayServer(
            serverSocketFactory = factory,
            recordingArtifactReceiver = fake,
        )
        gw.start()
        try {
            val client = connectClient(factory)
            Thread.sleep(150)
            client.getOutputStream().apply {
                write(rawFrame(
                    kind = FrameKind.ARTIFACT.code,
                    dir = FrameDirection.HOST_TO_DEVICE.code,
                    payloadLen = FrameCodec.MAX_PAYLOAD_SIZE + 1,
                ))
                flush()
            }

            assertTrue(gw.awaitCleanupCount(1, 2, TimeUnit.SECONDS))
            assertTrue(fake.chunks.isEmpty())
            expectClosed(client)
            client.close()
        } finally {
            gw.stop()
            factory.server.close()
        }
    }

    // ---- helpers ----

    private fun readFrame(input: InputStream): Frame {
        val header = input.readNBytes(FrameCodec.HEADER_SIZE)
        assertEquals(FrameCodec.HEADER_SIZE, header.size)
        val payloadLength = ((header[22].toInt() and 0xFF) shl 8) or (header[23].toInt() and 0xFF)
        val payload = input.readNBytes(payloadLength)
        assertEquals(payloadLength, payload.size)
        return FrameCodec.decodeExact(header + payload)
    }

    /** Build a raw 24-byte-header frame bypassing [Frame] invariants. */
    private fun rawFrame(
        kind: Byte,
        dir: Byte,
        flags: Int = 0,
        sessionId: Long = 0L,
        sequence: Long = 0L,
        timestampMicros: Long = 0L,
        payloadLen: Int = -1,
        payload: ByteArray = ByteArray(0),
    ): ByteArray {
        val len = if (payloadLen >= 0) payloadLen else payload.size
        val buf = ByteArray(24 + payload.size)
        buf[0] = 'G'.code.toByte()
        buf[1] = '2'.code.toByte()
        buf[2] = FrameCodec.VERSION
        buf[3] = kind
        buf[4] = dir
        buf[5] = flags.toByte()
        putU32(buf, 6, sessionId)
        putU32(buf, 10, sequence)
        putU64(buf, 14, timestampMicros)
        buf[22] = ((len ushr 8) and 0xFF).toByte()
        buf[23] = (len and 0xFF).toByte()
        payload.copyInto(buf, 24)
        return buf
    }

    private fun putU32(buf: ByteArray, off: Int, v: Long) {
        buf[off] = ((v ushr 24) and 0xFF).toByte()
        buf[off + 1] = ((v ushr 16) and 0xFF).toByte()
        buf[off + 2] = ((v ushr 8) and 0xFF).toByte()
        buf[off + 3] = (v and 0xFF).toByte()
    }

    private fun putU64(buf: ByteArray, off: Int, v: Long) {
        for (i in 0 until 8) buf[off + i] = ((v ushr (56 - 8 * i)) and 0xFF).toByte()
    }

    /** Assert the server closed the socket (read returns -1 or throws). */
    private fun expectClosed(client: Socket) {
        try {
            val input: InputStream = client.getInputStream()
            val deadline = System.currentTimeMillis() + 2000
            while (System.currentTimeMillis() < deadline) {
                if (input.read() == -1) return
            }
            fail("expected server to close the connection")
        } catch (e: IOException) {
            // Closed/reset is acceptable.
        }
    }
}
