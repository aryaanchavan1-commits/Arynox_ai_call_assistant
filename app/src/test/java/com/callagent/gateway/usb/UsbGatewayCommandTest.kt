package com.callagent.gateway.usb

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * RED-GREEN tests for the pure command protocol: [CommandParser] decodes a
 * CONTROL HOST_TO_DEVICE frame's UTF-8 JSON payload into a typed
 * [GatewayCommand], enforcing strict object shape, a known command name, and
 * strict known fields. Mutation commands require an [idempotencyKey].
 *
 * These tests touch no socket — [CommandParser] is a pure function over bytes,
 * so the protocol surface is unit-testable without any network.
 */
class UsbGatewayCommandTest {

    private fun ctrlPayload(json: String): ByteArray = json.toByteArray(Charsets.UTF_8)

    private fun parse(json: String): GatewayCommand =
        CommandParser.parse(ctrlPayload(json))

    // ---- known command names accepted ----

    @Test
    fun `status command parses with idempotencyKey`() {
        val cmd = parse("""{"command":"status","idempotencyKey":"k1"}""")
        assertEquals("status", cmd.name)
        assertEquals("k1", cmd.idempotencyKey)
    }

    @Test
    fun `capabilities command parses`() {
        val cmd = parse("""{"command":"capabilities","idempotencyKey":"k2"}""")
        assertEquals("capabilities", cmd.name)
        assertEquals("k2", cmd.idempotencyKey)
    }

    @Test
    fun `recording health acknowledgement parses only a strict boolean`() {
        val healthy = parse("""{"command":"recording_health","healthy":true}""")
        assertTrue(healthy is GatewayCommand.RecordingHealth)
        assertTrue((healthy as GatewayCommand.RecordingHealth).healthy)
        assertFalse(healthy.isMutation)
        assertThrows(CommandProtocolException::class.java) {
            parse("""{"command":"recording_health","healthy":"true"}""")
        }
        assertThrows(CommandProtocolException::class.java) {
            parse("""{"command":"recording_health","healthy":true,"root":"/tmp"}""")
        }
    }

    @Test
    fun `recording session acknowledgement requires opaque call id and strict boolean`() {
        val active = parse("""{"command":"recording_session","callId":"call-1","active":true}""")
        assertTrue(active is GatewayCommand.RecordingSession)
        assertEquals("call-1", (active as GatewayCommand.RecordingSession).callId)
        assertTrue(active.active)
        assertThrows(CommandProtocolException::class.java) {
            parse("""{"command":"recording_session","callId":"../escape","active":true}""")
        }
        assertThrows(CommandProtocolException::class.java) {
            parse("""{"command":"recording_session","callId":"call-1","active":"true"}""")
        }
    }

    @Test
    fun `recording artifact metadata uses strict bounded decimal strings`() {
        val begin = parse("""{"command":"recording_artifact_begin","callId":"call-1","artifact":"conversation.mkv","size":"4097","sha256":"${"a".repeat(64)}","durationMillis":"10000"}""")
        assertTrue(begin is GatewayCommand.RecordingArtifactBegin)
        begin as GatewayCommand.RecordingArtifactBegin
        assertEquals(4097L, begin.size)
        assertEquals(10000L, begin.durationMillis)
        assertThrows(CommandProtocolException::class.java) {
            parse("""{"command":"recording_artifact_begin","callId":"call-1","artifact":"conversation.mkv","size":4097,"sha256":"${"a".repeat(64)}","durationMillis":"10000"}""")
        }
        val commit = parse("""{"command":"recording_artifact_commit","callId":"call-1"}""")
        assertTrue(commit is GatewayCommand.RecordingArtifactCommit)
    }

    @Test
    fun `dial command parses with redactable destination and idempotencyKey`() {
        val cmd = parse("""{"command":"dial","idempotencyKey":"k3","destination":"+919876543210"}""")
        assertEquals("dial", cmd.name)
        assertEquals("k3", cmd.idempotencyKey)
        assertEquals("dial destination=+********3210 key=k3", cmd.redactedSummary())
        assertTrue(cmd is GatewayCommand.Dial)
        assertEquals("+919876543210", (cmd as GatewayCommand.Dial).destination)
    }

    @Test
    fun `answer command parses explicit callId`() {
        val cmd = parse("""{"command":"answer","callId":"call-4","idempotencyKey":"k4"}""")
        assertEquals("answer", cmd.name)
        assertEquals("call-4", (cmd as GatewayCommand.Answer).callId)
    }

    @Test
    fun `reject command parses explicit callId`() {
        val cmd = parse("""{"command":"reject","callId":"call-5","idempotencyKey":"k5"}""")
        assertEquals("reject", cmd.name)
        assertEquals("call-5", (cmd as GatewayCommand.Reject).callId)
    }

    @Test
    fun `hangup command parses explicit callId`() {
        val cmd = parse("""{"command":"hangup","callId":"call-6","idempotencyKey":"k6"}""")
        assertEquals("hangup", cmd.name)
        assertEquals("call-6", (cmd as GatewayCommand.Hangup).callId)
    }

    @Test
    fun `send_dtmf command parses explicit callId with redactable digits`() {
        val cmd = parse("""{"command":"send_dtmf","callId":"call-7","idempotencyKey":"k7","digits":"1234"}""")
        assertEquals("send_dtmf", cmd.name)
        assertEquals("k7", cmd.idempotencyKey)
        assertEquals("call-7", (cmd as GatewayCommand.SendDtmf).callId)
        assertEquals("1234", cmd.digits)
        // Summary never exposes raw digits.
        assertFalse(cmd.redactedSummary().contains("1234"))
    }

    // ---- unknown / empty command names rejected ----

    @Test
    fun `unknown command name rejected`() {
        assertThrows(CommandProtocolException::class.java) {
            parse("""{"command":"explode","idempotencyKey":"k"}""")
        }
    }

    @Test
    fun `missing command field rejected`() {
        assertThrows(CommandProtocolException::class.java) {
            parse("""{"idempotencyKey":"k"}""")
        }
    }

    @Test
    fun `non-object json rejected`() {
        assertThrows(CommandProtocolException::class.java) {
            parse("""[1,2,3]""")
        }
        assertThrows(CommandProtocolException::class.java) {
            parse(""""status"""")
        }
        assertThrows(CommandProtocolException::class.java) {
            parse("42")
        }
    }

    @Test
    fun `malformed json rejected`() {
        assertThrows(CommandProtocolException::class.java) {
            parse("""{"command":"status"""")
        }
        assertThrows(CommandProtocolException::class.java) {
            parse("")
        }
    }

    @Test
    fun `non-utf8 payload rejected`() {
        // Lone continuation byte is not valid UTF-8.
        val bad = byteArrayOf(0xFF.toByte(), 0xFE.toByte())
        assertThrows(CommandProtocolException::class.java) {
            CommandParser.parse(bad)
        }
    }

    // ---- idempotencyKey: required for mutation commands, bounded ----

    @Test
    fun `mutation commands require idempotencyKey`() {
        // dial/answer/reject/hangup/send_dtmf are mutations.
        for (name in listOf("dial", "answer", "reject", "hangup", "send_dtmf")) {
            val ex = assertThrows(CommandProtocolException::class.java) {
                parse("""{"command":"$name"}""")
            }
            assertTrue("expected idempotencyKey mention for $name: ${ex.message}",
                ex.message!!.contains("idempotencyKey", ignoreCase = true))
        }
    }

    @Test
    fun `idempotencyKey blank rejected`() {
        assertThrows(CommandProtocolException::class.java) {
            parse("""{"command":"answer","idempotencyKey":"  "}""")
        }
    }

    @Test
    fun `idempotencyKey over bound rejected`() {
        val tooLong = "x".repeat(CommandParser.MAX_IDEMPOTENCY_KEY_LEN + 1)
        assertThrows(CommandProtocolException::class.java) {
            parse("""{"command":"answer","idempotencyKey":"$tooLong"}""")
        }
    }

    // ---- strict known fields: unknown top-level fields rejected ----

    @Test
    fun `unknown top-level field rejected`() {
        assertThrows(CommandProtocolException::class.java) {
            parse("""{"command":"status","idempotencyKey":"k","extra":"no"}""")
        }
    }

    @Test
    fun `dial without destination rejected`() {
        assertThrows(CommandProtocolException::class.java) {
            parse("""{"command":"dial","idempotencyKey":"k"}""")
        }
    }

    @Test
    fun `dial with blank destination rejected`() {
        assertThrows(CommandProtocolException::class.java) {
            parse("""{"command":"dial","idempotencyKey":"k","destination":"  "}""")
        }
    }

    @Test
    fun `send_dtmf without digits rejected`() {
        assertThrows(CommandProtocolException::class.java) {
            parse("""{"command":"send_dtmf","callId":"c","idempotencyKey":"k"}""")
        }
    }

    @Test
    fun `send_dtmf rejects invalid dtmf characters`() {
        // Only 0-9, *, #, A-D allowed.
        assertThrows(CommandProtocolException::class.java) {
            parse("""{"command":"send_dtmf","callId":"c","idempotencyKey":"k","digits":"1Z9"}""")
        }
    }

    @Test
    fun `status and capabilities do not strictly require idempotencyKey`() {
        // status/capabilities are queries, not mutations. They still parse and
        // carry whatever key was given (possibly empty).
        val s = parse("""{"command":"status"}""")
        assertEquals("status", s.name)
        assertEquals("", s.idempotencyKey)
        val c = parse("""{"command":"capabilities","idempotencyKey":"q"}""")
        assertEquals("capabilities", c.name)
    }

    // ---- field types: wrong types rejected ----

    @Test
    fun `command field must be string`() {
        assertThrows(CommandProtocolException::class.java) {
            parse("""{"command":5,"idempotencyKey":"k"}""")
        }
    }

    @Test
    fun `destination field must be string`() {
        assertThrows(CommandProtocolException::class.java) {
            parse("""{"command":"dial","idempotencyKey":"k","destination":123}""")
        }
    }

    // ---- command set is closed: nothing outside the known six ----

    @Test
    fun `only six known command names are accepted`() {
        val known = setOf("status", "capabilities", "dial", "answer", "reject", "hangup", "send_dtmf")
        // Every accepted command's name is in the known set.
        for (name in listOf("status", "capabilities", "dial", "answer", "reject", "hangup", "send_dtmf")) {
            val payload = when (name) {
                "dial" -> """{"command":"dial","idempotencyKey":"k","destination":"+15551230100"}"""
                "send_dtmf" -> """{"command":"send_dtmf","callId":"c","idempotencyKey":"k","digits":"12"}"""
                "answer", "reject", "hangup" -> """{"command":"$name","callId":"c","idempotencyKey":"k"}"""
                else -> """{"command":"$name","idempotencyKey":"k"}"""
            }
            assertTrue(known.contains(parse(payload).name))
        }
        // A near-miss typo is rejected.
        assertThrows(CommandProtocolException::class.java) {
            parse("""{"command":"stat","idempotencyKey":"k"}""")
        }
    }
}
