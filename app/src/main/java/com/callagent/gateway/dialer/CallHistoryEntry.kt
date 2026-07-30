package com.callagent.gateway.dialer

import android.provider.CallLog
import java.util.Locale

data class CallHistoryEntry(
    val id: Long,
    val number: String,
    val cachedName: String?,
    val kind: Kind,
    val timestampMillis: Long,
    val durationSeconds: Long,
) {
    enum class Kind { INCOMING, OUTGOING, MISSED, REJECTED, BLOCKED, VOICEMAIL, UNKNOWN }

    val title: String get() = cachedName?.takeIf { it.isNotBlank() } ?: number

    companion object {
        fun kindFor(type: Int): Kind = when (type) {
            CallLog.Calls.INCOMING_TYPE -> Kind.INCOMING
            CallLog.Calls.OUTGOING_TYPE -> Kind.OUTGOING
            CallLog.Calls.MISSED_TYPE -> Kind.MISSED
            CallLog.Calls.REJECTED_TYPE -> Kind.REJECTED
            CallLog.Calls.BLOCKED_TYPE -> Kind.BLOCKED
            CallLog.Calls.VOICEMAIL_TYPE -> Kind.VOICEMAIL
            else -> Kind.UNKNOWN
        }

        fun formatDuration(seconds: Long): String {
            val safe = seconds.coerceAtLeast(0)
            val hours = safe / 3600
            val minutes = (safe % 3600) / 60
            val remaining = safe % 60
            return if (hours > 0) {
                String.format(Locale.US, "%d:%02d:%02d", hours, minutes, remaining)
            } else String.format(Locale.US, "%d:%02d", minutes, remaining)
        }
    }
}
