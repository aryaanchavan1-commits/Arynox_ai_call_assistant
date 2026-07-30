package com.callagent.gateway.usb

import java.io.File
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread
import org.junit.Assert.assertArrayEquals
import org.junit.Test

class ControllerBootstrapProtocolV2InteropTest {
    @Test fun `production codecs interoperate both directions`() {
        val hex = File("../protocol/bootstrap-v2-vectors.properties").readLines().single { it.startsWith("positive.transcript.hex=") }.substringAfter('=')
        val kotlinBytes = hex.bytes()
        assertArrayEquals(kotlinBytes, node("roundtrip", kotlinBytes))
        val nodeBytes = node("produce", ByteArray(0))
        assertArrayEquals(nodeBytes, ControllerBootstrapProtocolV2.encodeTranscript(ControllerBootstrapProtocolV2.decodeTranscript(nodeBytes)))
    }

    private fun node(mode: String, bytes: ByteArray): ByteArray {
        require(mode == "produce" || mode == "roundtrip")
        val process = ProcessBuilder("node", "test/helpers/bootstrap-v2-interop.js", mode).directory(File("../pc/pc-gateway")).start()
        val stderrReader = thread(start = true, isDaemon = true) { process.errorStream.bufferedReader().use { it.readText() } }
        process.outputStream.bufferedWriter(Charsets.US_ASCII).use { output ->
            if (mode == "roundtrip") { output.write(bytes.hex()); output.newLine() }
        }
        val stdout = StringBuilder()
        val stdoutReader = thread(start = true, isDaemon = true) { process.inputStream.bufferedReader().use { stdout.append(it.readText()) } }
        if (!process.waitFor(10, TimeUnit.SECONDS)) { process.destroyForcibly(); throw IllegalStateException("Node interop timed out") }
        stdoutReader.join(1_000); stderrReader.join(1_000)
        check(process.exitValue() == 0) { "Node interop failed" }
        val line = stdout.toString().trimEnd('\n')
        require(!line.contains('\n') && Regex("(?:[0-9a-f]{2})+").matches(line) && line.length <= ControllerBootstrapProtocolV2.MAX_MESSAGE_BYTES * 2) { "invalid Node interop output" }
        return line.bytes()
    }
    private fun ByteArray.hex() = joinToString("") { "%02x".format(it) }
    private fun String.bytes(): ByteArray { require(length % 2 == 0); return chunked(2).map { it.toInt(16).toByte() }.toByteArray() }
}
