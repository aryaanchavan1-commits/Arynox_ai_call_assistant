package com.callagent.gateway.dialer

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class PhoneDataTextTest {
    @Test
    fun `phone sync text removes provider control bytes and respects bounds`() {
        assertEquals("Alice Smith", cleanPhoneDataText("  Alice\u0000 Smith\n", 64))
        assertEquals("1234", cleanPhoneDataText("123456", 4))
    }

    @Test
    fun `phone sync text treats empty provider values as absent`() {
        assertNull(cleanPhoneDataText(null, 64))
        assertNull(cleanPhoneDataText(" \n\t ", 64))
    }
}
