package com.callagent.gateway.usb

/**
 * Redaction helper for the USB gateway: the gateway must never log or return
 * raw phone numbers or DTMF digits. Every sensitive numeric string is masked
 * before it can reach a log line, an error message, or an EVENT payload.
 *
 * - [redactPhone]: keeps at most the last 4 digits (and only when the number
 *   is long enough that the tail alone cannot identify the subscriber). Short
 *   numbers are fully masked. Structural non-digit chars (leading `+`, dashes)
 *   survive so a log line still reads as "a phone number", not a blob.
 * - [redactDtmf]: every DTMF char (0-9, *, #, A-D) is masked, length preserved.
 *   DTMF strings are short and any leak is a key press.
 * - [redactDigits]: scrubs digit runs inside arbitrary text (error messages).
 *
 * ponytail: plain string functions, no regex engine dependency. The masking
 * rules are fixed; if a future locale needs different digit classes, swap here.
 */
object RedactingLog {

    private const val PHONE_TAIL_VISIBLE = 4

    /** Mask a phone number, keeping at most the last 4 digits visible. */
    fun redactPhone(raw: String?): String {
        if (raw.isNullOrBlank()) return ""
        val s = raw.trim()
        val digitCount = s.count { it.isDigit() }
        if (digitCount <= PHONE_TAIL_VISIBLE) {
            // Short number: mask every digit, keep non-digits.
            return buildString(s.length) {
                for (c in s) if (c.isDigit()) append('*') else append(c)
            }
        }
        // Long number: mask all digits except the last PHONE_TAIL_VISIBLE.
        val tailStart = digitCount - PHONE_TAIL_VISIBLE
        var digitSeen = 0
        return buildString(s.length) {
            for (c in s) {
                if (c.isDigit()) {
                    if (digitSeen >= tailStart) append(c) else append('*')
                    digitSeen++
                } else {
                    append(c)
                }
            }
        }
    }

    /** Mask every DTMF char, preserving length. DTMF set: 0-9 * # A-D a-d. */
    fun redactDtmf(raw: String?): String {
        if (raw.isNullOrBlank()) return ""
        val s = raw.trim()
        return buildString(s.length) {
            for (c in s) if (isDtmfChar(c)) append('*') else append(c)
        }
    }

    /** Mask every digit run inside arbitrary text, preserving length. */
    fun redactDigits(raw: String?): String {
        if (raw.isNullOrBlank()) return ""
        return buildString(raw.length) {
            for (c in raw) if (c.isDigit()) append('*') else append(c)
        }
    }

    private fun isDtmfChar(c: Char): Boolean =
        c.isDigit() || c == '*' || c == '#' ||
            c in 'A'..'D' || c in 'a'..'d'
}
