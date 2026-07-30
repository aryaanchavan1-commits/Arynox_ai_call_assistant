package com.callagent.gateway.dialer

import android.content.Context
import android.provider.ContactsContract

data class ContactEntry(val id: Long, val name: String, val number: String)

class ContactRepository(private val context: Context) {
    fun list(limit: Int = 200): List<ContactEntry> = runCatching {
        context.contentResolver.query(
            ContactsContract.CommonDataKinds.Phone.CONTENT_URI,
            arrayOf(
                ContactsContract.CommonDataKinds.Phone.CONTACT_ID,
                ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME,
                ContactsContract.CommonDataKinds.Phone.NUMBER,
            ),
            null,
            null,
            "${ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME} COLLATE NOCASE ASC",
        )?.use { cursor ->
            val id = cursor.getColumnIndexOrThrow(ContactsContract.CommonDataKinds.Phone.CONTACT_ID)
            val name = cursor.getColumnIndexOrThrow(ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME)
            val number = cursor.getColumnIndexOrThrow(ContactsContract.CommonDataKinds.Phone.NUMBER)
            buildList {
                while (cursor.moveToNext() && size < limit.coerceIn(1, 500)) {
                    add(
                        ContactEntry(
                            cursor.getLong(id).coerceAtLeast(0),
                            cleanPhoneDataText(cursor.getString(name), 256) ?: "Unknown",
                            cleanPhoneDataText(cursor.getString(number), 64) ?: "Unknown",
                        ),
                    )
                }
            }
        } ?: emptyList()
    }.getOrDefault(emptyList())
}
