package com.callagent.gateway.usb

data class PhoneContactRow(val id: Long, val name: String, val number: String)

data class PhoneCallLogRow(
    val id: Long,
    val number: String,
    val name: String?,
    val kind: String,
    val timestampMillis: Long,
    val durationSeconds: Long,
)

object PhoneDataSnapshotEncoder {
    private const val MAX_PAGE_ROWS = 10
    private const val MAX_CONTACTS = 500
    private const val MAX_CALL_LOG = 200
    private val requestIdPattern = Regex("^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
    private val callKinds = setOf("incoming", "outgoing", "missed", "rejected", "blocked", "voicemail", "unknown")

    fun contacts(requestId: String, rows: List<PhoneContactRow>): List<String> {
        require(rows.size <= MAX_CONTACTS)
        return pages("contacts_snapshot_v1", requestId, rows) { row ->
            require(row.id >= 0 && validText(row.name, 256) && validText(row.number, 64))
            "{\"id\":\"${row.id}\",\"name\":\"${json(row.name)}\",\"number\":\"${json(row.number)}\"}"
        }
    }

    fun callLog(requestId: String, rows: List<PhoneCallLogRow>): List<String> {
        require(rows.size <= MAX_CALL_LOG)
        return pages("call_log_snapshot_v1", requestId, rows) { row ->
            require(row.id >= 0 && row.timestampMillis >= 0 && row.durationSeconds >= 0)
            require(validText(row.number, 64) && (row.name == null || validText(row.name, 256)) && row.kind in callKinds)
            val name = row.name?.let { "\"${json(it)}\"" } ?: "null"
            "{\"id\":\"${row.id}\",\"number\":\"${json(row.number)}\",\"name\":$name,\"kind\":\"${row.kind}\",\"timestampMillis\":\"${row.timestampMillis}\",\"durationSeconds\":\"${row.durationSeconds}\"}"
        }
    }

    private fun <T> pages(event: String, requestId: String, rows: List<T>, encode: (T) -> String): List<String> {
        require(requestIdPattern.matches(requestId))
        val encoded = rows.map(encode)
        val chunks = mutableListOf<MutableList<String>>()
        if (encoded.isEmpty()) chunks.add(mutableListOf())
        encoded.forEach { row ->
            var current = chunks.lastOrNull()
            if (current == null || current.size >= MAX_PAGE_ROWS ||
                payload(event, requestId, chunks.size - 1, false, current + row).toByteArray(Charsets.UTF_8).size > FrameCodec.MAX_PAYLOAD_SIZE
            ) {
                current = mutableListOf()
                chunks.add(current)
            }
            current.add(row)
        }
        return chunks.mapIndexed { page, chunk ->
            payload(event, requestId, page, page == chunks.lastIndex, chunk).also {
                require(it.toByteArray(Charsets.UTF_8).size <= FrameCodec.MAX_PAYLOAD_SIZE)
            }
        }
    }

    private fun payload(event: String, requestId: String, page: Int, final: Boolean, rows: List<String>): String =
        "{\"event\":\"$event\",\"requestId\":\"$requestId\",\"page\":$page,\"final\":$final,\"rows\":[${rows.joinToString(",")}]}"

    private fun validText(value: String, max: Int): Boolean =
        value.isNotEmpty() && value.length <= max && value.none { it.code < 0x20 || it.code == 0x7f }

    private fun json(value: String): String = buildString(value.length) {
        value.forEach { character ->
            when (character) {
                '\\' -> append("\\\\")
                '"' -> append("\\\"")
                '\b' -> append("\\b")
                '\u000c' -> append("\\f")
                '\n' -> append("\\n")
                '\r' -> append("\\r")
                '\t' -> append("\\t")
                else -> if (character.code < 0x20) append("\\u%04x".format(character.code)) else append(character)
            }
        }
    }
}
