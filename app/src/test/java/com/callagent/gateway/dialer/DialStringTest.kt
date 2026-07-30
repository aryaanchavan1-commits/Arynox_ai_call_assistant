package com.callagent.gateway.dialer

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class DialStringTest {
    @Test
    fun `normalizes human formatted telephone input`() {
        assertEquals("+919876543210", DialString.normalize(" +91 98765-43210 "))
        assertEquals("18005551212", DialString.normalize("1 (800) 555-1212"))
    }

    @Test
    fun `preserves star and hash for explicit user dial strings`() {
        assertEquals("*123#", DialString.normalize("*123#"))
    }

    @Test
    fun `rejects empty malformed and overlong destinations`() {
        assertNull(DialString.normalize(""))
        assertNull(DialString.normalize("hello"))
        assertNull(DialString.normalize("++123"))
        assertNull(DialString.normalize("1".repeat(65)))
    }
}
