package com.callagent.gateway.dialer

import android.provider.CallLog
import org.junit.Assert.assertEquals
import org.junit.Test

class CallHistoryEntryTest {
    @Test
    fun `maps Android call types to user facing direction`() {
        assertEquals(CallHistoryEntry.Kind.INCOMING, CallHistoryEntry.kindFor(CallLog.Calls.INCOMING_TYPE))
        assertEquals(CallHistoryEntry.Kind.OUTGOING, CallHistoryEntry.kindFor(CallLog.Calls.OUTGOING_TYPE))
        assertEquals(CallHistoryEntry.Kind.MISSED, CallHistoryEntry.kindFor(CallLog.Calls.MISSED_TYPE))
        assertEquals(CallHistoryEntry.Kind.REJECTED, CallHistoryEntry.kindFor(CallLog.Calls.REJECTED_TYPE))
        assertEquals(CallHistoryEntry.Kind.UNKNOWN, CallHistoryEntry.kindFor(999))
    }

    @Test
    fun `formats bounded call durations`() {
        assertEquals("0:00", CallHistoryEntry.formatDuration(0))
        assertEquals("0:59", CallHistoryEntry.formatDuration(59))
        assertEquals("1:01", CallHistoryEntry.formatDuration(61))
        assertEquals("1:01:01", CallHistoryEntry.formatDuration(3661))
    }
}
