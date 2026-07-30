package com.callagent.gateway.usb

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * RED-GREEN tests for the inner strict JSON object reader used by the
 * CONTROL-frame command parser. The reader must reject every payload shape
 * the command protocol does not define (nested objects/arrays, scalars,
 * trailing junk, comments, unknown escapes, unterminated strings, duplicate
 * fields) so that anything a peer sends surfaces as a typed
 * [CommandProtocolException] at the server, not a silently accepted value.
 *
 * These tests exercise [StrictJsonObjectReader] directly. They are unit-only
 * (no sockets, no I/O) and are independent of [CommandParser] so a regression
 * in the reader is caught even if the outer parser happens to be called with
 * a different field set than these.
 *
 * ponytail: every assertion below maps to one branch of the reader's
 * state machine. There is no test for "valid happy path" beyond a smoke
 * check; the happy path is already covered transitively by
 * [UsbGatewayCommandTest]. The value of this file is rejecting the things
 * the protocol does NOT define.
 */
class StrictJsonObjectReaderTest {

    private fun read(src: String): MutableMap<String, Any?> =
        StrictJsonObjectReader(src).readObject()

    // ---- happy path: one-shot smoke ----

    @Test
    fun `reads a single-field object`() {
        val out = read("""{"k":"v"}""")
        assertEquals(1, out.size)
        assertEquals("v", out["k"])
    }

    @Test
    fun `empty object is accepted`() {
        val out = read("{}")
        assertTrue(out.isEmpty())
    }

    @Test
    fun `surrounding whitespace is tolerated`() {
        val out = read("  \n\t { \n \"a\" : 1 , \t\"b\" : 2 \n } \r\n ")
        assertEquals(2, out.size)
        assertEquals(1L, out["a"])
        assertEquals(2L, out["b"])
    }

    // ---- the only allowed top-level shape is a JSON object ----

    @Test
    fun `array at top level is rejected`() {
        assertThrows(CommandProtocolException::class.java) { read("[1,2,3]") }
    }

    @Test
    fun `scalar string at top level is rejected`() {
        assertThrows(CommandProtocolException::class.java) { read("\"status\"") }
    }

    @Test
    fun `number at top level is rejected`() {
        assertThrows(CommandProtocolException::class.java) { read("42") }
    }

    @Test
    fun `literal at top level is rejected`() {
        assertThrows(CommandProtocolException::class.java) { read("true") }
        assertThrows(CommandProtocolException::class.java) { read("null") }
    }

    @Test
    fun `empty input is rejected`() {
        assertThrows(CommandProtocolException::class.java) { read("") }
    }

    @Test
    fun `whitespace-only input is rejected`() {
        assertThrows(CommandProtocolException::class.java) { read("   \n\t ") }
    }

    // ---- nested object/array values are NOT allowed in command protocol ----

    @Test
    fun `nested object value is rejected`() {
        assertThrows(CommandProtocolException::class.java) { read("""{"a":{"x":1}}""") }
    }

    @Test
    fun `array value is rejected`() {
        assertThrows(CommandProtocolException::class.java) { read("""{"a":[1,2]}""") }
        assertThrows(CommandProtocolException::class.java) { read("""{"a":[]}""") }
    }

    // ---- duplicates are rejected (strict) ----

    @Test
    fun `duplicate field is rejected`() {
        assertThrows(CommandProtocolException::class.java) {
            read("""{"a":1,"a":2}""")
        }
    }

    // ---- trailing junk after the object is rejected ----

    @Test
    fun `trailing junk after object is rejected`() {
        assertThrows(CommandProtocolException::class.java) { read("""{"a":1}garbage""") }
        assertThrows(CommandProtocolException::class.java) { read("""{"a":1}{}""") }
    }

    // ---- string tokenization ----

    @Test
    fun `unterminated string is rejected`() {
        assertThrows(CommandProtocolException::class.java) { read("""{"a":"unterminated""") }
    }

    @Test
    fun `non-string field name is rejected`() {
        // Field name must be a JSON string. A bare identifier is not valid JSON.
        assertThrows(CommandProtocolException::class.java) { read("""{a:1}""") }
    }

    @Test
    fun `bad backslash escape is rejected`() {
        // A control character (here: bare 0x01) is not a recognized escape.
        assertThrows(CommandProtocolException::class.java) { read("""{"a":"\x01"}""") }
    }

    @Test
    fun `bad unicode escape is rejected`() {
        // Non-hex digits in a \uXXXX escape are rejected.
        assertThrows(CommandProtocolException::class.java) { read("""{"a":"\uZZZZ"}""") }
    }

    @Test
    fun `truncated unicode escape is rejected`() {
        assertThrows(CommandProtocolException::class.java) { read("""{"a":"\u00"}""") }
    }

    // ---- literal tokens: only the exact lowercase four-letter forms ----

    @Test
    fun `case-sensitive true and false only`() {
        assertThrows(CommandProtocolException::class.java) { read("""{"a":True}""") }
        assertThrows(CommandProtocolException::class.java) { read("""{"a":TRUE}""") }
        assertThrows(CommandProtocolException::class.java) { read("""{"a":truee}""") }
        // The valid forms parse correctly.
        assertEquals(true, read("""{"a":true}""")["a"])
        assertEquals(false, read("""{"a":false}""")["a"])
    }

    @Test
    fun `case-sensitive null only`() {
        assertThrows(CommandProtocolException::class.java) { read("""{"a":NULL}""") }
        assertThrows(CommandProtocolException::class.java) { read("""{"a":nul}""") }
        // null is a valid value.
        val out = read("""{"a":null}""")
        assertNull(out["a"])
    }

    // ---- number parsing: integer returned as Long, float returned as Double ----

    @Test
    fun `integer is parsed as Long`() {
        val out = read("""{"n":-12345}""")
        assertEquals(-12345L, out["n"])
    }

    @Test
    fun `float is parsed as Double`() {
        val out = read("""{"x":-1.5e2}""")
        assertEquals(-150.0, out["x"])
    }

    // ---- structural separators are required ----

    @Test
    fun `missing colon between field and value is rejected`() {
        assertThrows(CommandProtocolException::class.java) { read("""{"a" 1}""") }
    }

    @Test
    fun `missing comma between fields is rejected`() {
        assertThrows(CommandProtocolException::class.java) { read("""{"a":1 "b":2}""") }
    }

    @Test
    fun `object that does not close is rejected`() {
        assertThrows(CommandProtocolException::class.java) { read("""{"a":1""") }
    }

    // ---- comments and JSON5-isms are NOT accepted ----

    @Test
    fun `line comments are rejected`() {
        assertThrows(CommandProtocolException::class.java) {
            read("""{"a":1} // trailing comment""")
        }
    }

    @Test
    fun `block comments are rejected`() {
        assertThrows(CommandProtocolException::class.java) {
            read("""{"a":/* nope */1}""")
        }
    }

    // ---- the order of fields is preserved in the returned map ----

    @Test
    fun `field order matches source order`() {
        val out = read("""{"a":1,"b":2,"c":3}""")
        assertEquals(listOf("a", "b", "c"), out.keys.toList())
    }
}
