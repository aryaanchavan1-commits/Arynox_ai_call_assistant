package com.callagent.gateway.dialer

import android.content.Context
import android.net.Uri
import android.provider.ContactsContract

object ContactResolver {
    fun displayName(context: Context, number: String): String? {
        if (number.isBlank() || number == "Unknown") return null
        val uri = Uri.withAppendedPath(
            ContactsContract.PhoneLookup.CONTENT_FILTER_URI,
            Uri.encode(number),
        )
        return runCatching {
            context.contentResolver.query(
                uri,
                arrayOf(ContactsContract.PhoneLookup.DISPLAY_NAME),
                null,
                null,
                null,
            )?.use { cursor ->
                if (!cursor.moveToFirst()) null
                else cursor.getString(cursor.getColumnIndexOrThrow(ContactsContract.PhoneLookup.DISPLAY_NAME))
            }
        }.getOrNull()
    }
}
