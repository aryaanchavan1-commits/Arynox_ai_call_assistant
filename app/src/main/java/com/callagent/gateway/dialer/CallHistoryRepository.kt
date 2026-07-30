package com.callagent.gateway.dialer

import android.content.Context
import android.provider.CallLog

class CallHistoryRepository(private val context: Context) {
    fun recent(limit: Int = 100): List<CallHistoryEntry> {
        val safeLimit = limit.coerceIn(1, 200)
        val projection = arrayOf(
            CallLog.Calls._ID,
            CallLog.Calls.NUMBER,
            CallLog.Calls.CACHED_NAME,
            CallLog.Calls.TYPE,
            CallLog.Calls.DATE,
            CallLog.Calls.DURATION,
        )
        return runCatching {
            context.contentResolver.query(
                CallLog.Calls.CONTENT_URI,
                projection,
                null,
                null,
                "${CallLog.Calls.DATE} DESC LIMIT $safeLimit",
            )?.use { cursor ->
                val id = cursor.getColumnIndexOrThrow(CallLog.Calls._ID)
                val number = cursor.getColumnIndexOrThrow(CallLog.Calls.NUMBER)
                val name = cursor.getColumnIndexOrThrow(CallLog.Calls.CACHED_NAME)
                val type = cursor.getColumnIndexOrThrow(CallLog.Calls.TYPE)
                val date = cursor.getColumnIndexOrThrow(CallLog.Calls.DATE)
                val duration = cursor.getColumnIndexOrThrow(CallLog.Calls.DURATION)
                buildList {
                    while (cursor.moveToNext()) {
                        add(
                            CallHistoryEntry(
                                id = cursor.getLong(id).coerceAtLeast(0),
                                number = cleanPhoneDataText(cursor.getString(number), 64) ?: "Unknown",
                                cachedName = cleanPhoneDataText(cursor.getString(name), 256),
                                kind = CallHistoryEntry.kindFor(cursor.getInt(type)),
                                timestampMillis = cursor.getLong(date).coerceAtLeast(0),
                                durationSeconds = cursor.getLong(duration).coerceAtLeast(0),
                            ),
                        )
                    }
                }
            } ?: emptyList()
        }.getOrDefault(emptyList())
    }
}

internal fun cleanPhoneDataText(value: String?, maxLength: Int): String? {
    if (value == null || maxLength < 1) return null
    val clean = value.trim().filter { it.code >= 0x20 && it.code != 0x7f }.take(maxLength)
    return clean.ifEmpty { null }
}
