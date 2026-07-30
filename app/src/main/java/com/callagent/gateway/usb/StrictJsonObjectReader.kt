package com.callagent.gateway.usb

/**
 * Minimal, strict JSON object reader for the command protocol.
 *
 * Accepts ONLY: an optional leading/trailing JSON whitespace, a single top-level
 * object `{...}`, and after it only whitespace until end-of-input. Anything else
 * (arrays, scalars, trailing junk, comments, nested structures beyond string
 * field values) is rejected with [CommandProtocolException].
 *
 * Object values may be: JSON string (with standard `\` escapes), or JSON number
 * (returned as a Long or Double), or `true`/`false`/`null`. Field names must be
 * JSON strings. Duplicates are rejected (strict). No nested objects/arrays are
 * accepted as field values — the command protocol is flat.
 *
 * ponytail: a ~120-line hand-rolled reader. Tighter and stricter than a general
 * JSON parser: it rejects everything the command protocol does not define, which
 * is the whole point (a stray array in a `dial` payload must surface as an
 * error, not be silently swallowed).
 */
internal class StrictJsonObjectReader(private val src: String) {

    private var pos: Int = 0

    fun readObject(): MutableMap<String, Any?> {
        skipWs()
        expect('{')
        val out = LinkedHashMap<String, Any?>()
        skipWs()
        if (peek() == '}') { pos++; skipWs(); requireEof(); return out }
        while (true) {
            skipWs()
            val key = readString()
            if (out.containsKey(key)) {
                throw CommandProtocolException("duplicate field: $key")
            }
            skipWs()
            expect(':')
            skipWs()
            val value = readValue()
            out[key] = value
            skipWs()
            when (peek()) {
                ',' -> { pos++ }
                '}' -> { pos++; skipWs(); requireEof(); return out }
                else -> throw CommandProtocolException("expected ',' or '}' at pos $pos")
            }
        }
    }

    private fun readValue(): Any? = when (peek()) {
        '"' -> readString()
        '{' -> throw CommandProtocolException("nested object not allowed in command protocol")
        '[' -> throw CommandProtocolException("array not allowed in command protocol")
        't', 'f' -> readBool()
        'n' -> readNull()
        in '0'..'9', '-' -> readNumber()
        else -> throw CommandProtocolException("unexpected value char at pos $pos")
    }

    private fun readString(): String {
        expect('"')
        val sb = StringBuilder()
        while (true) {
            val c = peek()
            if (c == 0.toChar()) throw CommandProtocolException("unterminated string")
            pos++
            when (c) {
                '"' -> return sb.toString()
                '\\' -> {
                    val e = peekOrEof()
                    pos++
                    when (e) {
                        '"' -> sb.append('"')
                        '\\' -> sb.append('\\')
                        '/' -> sb.append('/')
                        'b' -> sb.append('\b')
                        'f' -> sb.append('')
                        'n' -> sb.append('\n')
                        'r' -> sb.append('\r')
                        't' -> sb.append('\t')
                        'u' -> {
                            val hex = src.substring(pos, pos + 4)
                            pos += 4
                            try {
                                sb.append(hex.toInt(16).toChar())
                            } catch (e: Exception) {
                                throw CommandProtocolException("bad \\u escape: $hex")
                            }
                        }
                        else -> throw CommandProtocolException("bad escape \\$e")
                    }
                }
                else -> sb.append(c)
            }
        }
    }

    private fun readBool(): Boolean {
        if (src.startsWith("true", pos)) { pos += 4; return true }
        if (src.startsWith("false", pos)) { pos += 5; return false }
        throw CommandProtocolException("invalid literal at pos $pos")
    }

    private fun readNull(): Any? {
        if (src.startsWith("null", pos)) { pos += 4; return null }
        throw CommandProtocolException("invalid literal at pos $pos")
    }

    private fun readNumber(): Any {
        val start = pos
        if (peek() == '-') pos++
        var isFloat = false
        while (pos < src.length) {
            val c = src[pos]
            when {
                c in '0'..'9' -> pos++
                c == '.' || c == 'e' || c == 'E' || c == '+' || c == '-' -> { isFloat = true; pos++ }
                else -> break
            }
        }
        val tok = src.substring(start, pos)
        return if (isFloat) tok.toDouble() else tok.toLong()
    }

    // ---- low-level helpers ----

    private fun peek(): Char = if (pos < src.length) src[pos] else 0.toChar()

    private fun peekOrEof(): Char {
        if (pos >= src.length) throw CommandProtocolException("unexpected end of input")
        return src[pos]
    }

    private fun expect(c: Char) {
        if (peek() != c) throw CommandProtocolException("expected '$c' at pos $pos")
        pos++
    }

    private fun skipWs() {
        while (pos < src.length) {
            when (src[pos]) {
                ' ', '\t', '\n', '\r' -> pos++
                else -> return
            }
        }
    }

    private fun requireEof() {
        if (pos != src.length) throw CommandProtocolException("trailing junk at pos $pos")
    }
}
