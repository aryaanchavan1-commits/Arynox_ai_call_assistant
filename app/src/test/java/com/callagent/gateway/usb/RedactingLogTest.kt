package com.callagent.gateway.usb

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * RED-GREEN tests for [RedactingLog]: the gateway must never log or return raw
 * phone numbers or DTMF digits. Every sensitive numeric string is masked before
 * it can reach a log line, an error message, or an EVENT payload.
 *
 * Phone numbers keep at most the last 4 digits visible (and only when long
 * enough that the tail alone cannot identify the subscriber); DTMF digit
 * strings are fully masked because they are short and any leak is a key press.
 */
class RedactingLogTest {

    // ---- phone: long number keeps only last 4, rest masked ----

    @Test
    fun `long phone number masks all but last four digits`() {
        val masked = RedactingLog.redactPhone("+919876543210")
        assertEquals("+********3210", masked)
    }

    @Test
    fun `phone without plus prefix still masks middle and keeps last four`() {
        val masked = RedactingLog.redactPhone("919876543210")
        assertEquals("********3210", masked)
    }

    @Test
    fun `raw full phone number never appears in redacted form`() {
        val raw = "+919876543210"
        val masked = RedactingLog.redactPhone(raw)
        assertFalse("raw number must not survive redaction", masked.contains(raw))
        assertFalse(masked.contains("987654"))
    }

    // ---- phone: short number masks everything (last-4 would be the whole number) ----

    @Test
    fun `phone of four or fewer digits is fully masked`() {
        assertEquals("****", RedactingLog.redactPhone("1234"))
        assertEquals("***", RedactingLog.redactPhone("123"))
        assertEquals("+**", RedactingLog.redactPhone("+12"))
    }

    @Test
    fun `phone of exactly five digits shows last four`() {
        // 5 digits: mask 1, show 4 — never reveal the whole thing.
        val masked = RedactingLog.redactPhone("12345")
        assertEquals("*2345", masked)
        assertFalse(masked.contains("12345"))
    }

    // ---- null / blank ----

    @Test
    fun `null or blank phone yields empty string`() {
        assertEquals("", RedactingLog.redactPhone(null))
        assertEquals("", RedactingLog.redactPhone(""))
        assertEquals("", RedactingLog.redactPhone("   "))
    }

    // ---- phone preserves non-digit structural chars but masks digits around them ----

    @Test
    fun `phone keeps plus prefix and masks digit body`() {
        val masked = RedactingLog.redactPhone("+1-555-0102")
        // Plus and dash structure survive; digits beyond last 4 are masked.
        assertTrue(masked.endsWith("0102"))
        assertTrue(masked.startsWith("+"))
        assertFalse(masked.contains("555"))
    }

    // ---- DTMF: always fully masked, length preserved ----

    @Test
    fun `dtmf digits are fully masked with length preserved`() {
        assertEquals("***", RedactingLog.redactDtmf("123"))
        assertEquals("*****", RedactingLog.redactDtmf("12345"))
    }

    @Test
    fun `dtmf special chars are masked too`() {
        // DTMF includes *,#,A-D; none survive redaction.
        val masked = RedactingLog.redactDtmf("1*#A")
        assertEquals("****", masked)
    }

    @Test
    fun `null or blank dtmf yields empty string`() {
        assertEquals("", RedactingLog.redactDtmf(null))
        assertEquals("", RedactingLog.redactDtmf(""))
    }

    @Test
    fun `raw dtmf never appears in redacted form`() {
        val raw = "1234"
        assertFalse(RedactingLog.redactDtmf(raw).contains(raw))
    }

    // ---- generic digit-run mask: scrub digits inside arbitrary text ----

    @Test
    fun `redactDigits masks digit runs and preserves non-digits`() {
        assertEquals("abc***def", RedactingLog.redactDigits("abc123def"))
        assertEquals("call **** now", RedactingLog.redactDigits("call 1234 now"))
    }

    @Test
    fun `redactDigits on null or blank yields empty string`() {
        assertEquals("", RedactingLog.redactDigits(null))
        assertEquals("", RedactingLog.redactDigits(""))
    }

    @Test
    fun `redactDigits leaves digit-free text unchanged`() {
        assertEquals("no numbers here", RedactingLog.redactDigits("no numbers here"))
    }
}
