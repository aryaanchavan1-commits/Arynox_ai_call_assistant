package com.callagent.gateway.usb

/**
 * Pure parser for CONTROL HOST_TO_DEVICE command payloads.
 *
 * Input: the raw payload bytes of a CONTROL frame (direction HOST_TO_DEVICE).
 * Output: a typed [GatewayCommand], or [CommandProtocolException] for any
 * deviation. Strictness rules:
 *
 *  - Payload must be valid UTF-8 (reject lone continuation bytes, etc.).
 *  - Payload must be a single JSON *object* (reject arrays, scalars, garbage,
 *    and trailing non-whitespace after the object).
 *  - Object must have a string `command` whose value is one of the known six:
 *    status, capabilities, dial, answer, reject, hangup, send_dtmf.
 *  - Strict known fields per command: only the fields defined for that command
 *    are allowed; any other top-level field is rejected (no forward-compat by
 *    silent ignore — a mismatch surfaces as a typed error).
 *  - Mutation commands (dial/answer/reject/hangup/send_dtmf) require a
 *    non-blank `idempotencyKey` of length <= [MAX_IDEMPOTENCY_KEY_LEN].
 *    Query commands (status/capabilities) accept an optional (possibly empty)
 *    idempotencyKey.
 *  - `dial` requires a non-blank string `phone`.
 *  - `send_dtmf` requires a non-empty string `digits` of DTMF chars
 *    (0-9, *, #, A-D, case-insensitive — stored upper-cased).
 *  - Field types are checked: `command`/`phone`/`digits`/`idempotencyKey` must
 *    be JSON strings.
 *
 * This object holds no state and does no I/O; it is fully unit-testable.
 *
 * ponytail: hand-rolled strict JSON reader. org.json is not reliably on the
 * plain-JVM unit-test classpath, and a 60-line strict object reader is shorter
 * than adding a dependency and narrower than a full JSON library (we reject
 * everything we do not expect, which is exactly the contract).
 */
object CommandParser {

    /** Upper bound on an idempotencyKey length. */
    const val MAX_IDEMPOTENCY_KEY_LEN: Int = 128

    private val KNOWN_COMMANDS: Set<String> = setOf(
        "status", "capabilities", "recording_health", "recording_session",
        "recording_artifact_begin", "recording_artifact_commit",
        "sync_contacts", "sync_call_log",
        "dial", "answer", "reject", "hangup", "send_dtmf", "provision_device_evidence",
    )

    private val MUTATIONS: Set<String> = setOf(
        "dial", "answer", "reject", "hangup", "send_dtmf", "provision_device_evidence"
    )

    /** Per-command allowed top-level field sets (besides `command`). */
    private val ALLOWED_FIELDS: Map<String, Set<String>> = mapOf(
        "status" to setOf("idempotencyKey"),
        "capabilities" to setOf("idempotencyKey"),
        "sync_contacts" to setOf("requestId"),
        "sync_call_log" to setOf("requestId"),
        "recording_health" to setOf("healthy"),
        "recording_session" to setOf("callId", "active"),
        "recording_artifact_begin" to setOf("callId", "artifact", "size", "sha256", "durationMillis"),
        "recording_artifact_commit" to setOf("callId"),
        "dial" to setOf("idempotencyKey", "destination"),
        "answer" to setOf("idempotencyKey", "callId"),
        "reject" to setOf("idempotencyKey", "callId"),
        "hangup" to setOf("idempotencyKey", "callId"),
        "send_dtmf" to setOf("idempotencyKey", "callId", "digits"),
        "provision_device_evidence" to setOf(
            "idempotencyKey", "observedSystemFingerprint", "observedVendorFingerprint",
            "attestedOn", "attestedSystemDescription",
        ),
    )

    fun parse(payload: ByteArray): GatewayCommand {
        val text = decodeUtf8Strict(payload)
        val reader = StrictJsonObjectReader(text)
        val fields = reader.readObject()
        val command = requireString(fields, "command", remove = true)
        if (command !in KNOWN_COMMANDS) {
            throw CommandProtocolException("unknown command: $command")
        }

        val allowed = ALLOWED_FIELDS.getValue(command)
        for (key in fields.keys) {
            if (key !in allowed) {
                throw CommandProtocolException("unknown field for $command: $key")
            }
        }

        val idempotencyKey = fields.remove("idempotencyKey")?.let { v ->
            when (v) {
                is String -> v
                else -> throw CommandProtocolException("idempotencyKey must be a string")
            }
        } ?: ""

        if (command in MUTATIONS) {
            if (idempotencyKey.isBlank()) {
                throw CommandProtocolException("$command requires non-blank idempotencyKey")
            }
            if (idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LEN) {
                throw CommandProtocolException("idempotencyKey over bound $MAX_IDEMPOTENCY_KEY_LEN")
            }
        }

        return when (command) {
            "status" -> GatewayCommand.Status(idempotencyKey)
            "capabilities" -> GatewayCommand.Capabilities(idempotencyKey)
            "sync_contacts" -> GatewayCommand.SyncContacts(requireRequestId(fields, command))
            "sync_call_log" -> GatewayCommand.SyncCallLog(requireRequestId(fields, command))
            "recording_health" -> GatewayCommand.RecordingHealth(requireBoolean(fields, "healthy"))
            "recording_session" -> GatewayCommand.RecordingSession(
                requireOpaqueCallId(fields, command),
                requireBoolean(fields, "active"),
            )
            "recording_artifact_begin" -> GatewayCommand.RecordingArtifactBegin(
                callId = requireOpaqueCallId(fields, command),
                artifact = requireString(fields, "artifact", remove = true),
                size = requireDecimalLong(fields, "size"),
                sha256 = requireString(fields, "sha256", remove = true),
                durationMillis = requireDecimalLong(fields, "durationMillis"),
            )
            "recording_artifact_commit" -> GatewayCommand.RecordingArtifactCommit(
                requireOpaqueCallId(fields, command),
            )
            "dial" -> {
                val destination = requireString(fields, "destination", remove = true)
                if (destination.isBlank()) {
                    throw CommandProtocolException("dial requires non-blank destination")
                }
                GatewayCommand.Dial(idempotencyKey, destination)
            }
            "answer" -> GatewayCommand.Answer(idempotencyKey, requireCallId(fields, command))
            "reject" -> GatewayCommand.Reject(idempotencyKey, requireCallId(fields, command))
            "hangup" -> GatewayCommand.Hangup(idempotencyKey, requireCallId(fields, command))
            "send_dtmf" -> {
                val callId = requireCallId(fields, command)
                val digits = requireString(fields, "digits", remove = true)
                if (digits.isEmpty()) {
                    throw CommandProtocolException("send_dtmf requires non-empty digits")
                }
                if (!digits.all { isDtmfChar(it) }) {
                    throw CommandProtocolException("send_dtmf digits contain non-DTMF characters")
                }
                GatewayCommand.SendDtmf(idempotencyKey, callId, digits.uppercase())
            }
            "provision_device_evidence" -> GatewayCommand.ProvisionDeviceEvidence(
                idempotencyKey,
                requireBoundedString(fields, "observedSystemFingerprint", 1024),
                requireBoundedString(fields, "observedVendorFingerprint", 1024),
                requireBoundedString(fields, "attestedOn", 10),
                requireBoundedString(fields, "attestedSystemDescription", 512),
            )
            else -> throw CommandProtocolException("unreachable command: $command")
        }
    }

    private fun requireBoundedString(fields: MutableMap<String, Any?>, name: String, max: Int): String {
        val value = requireString(fields, name, remove = true)
        if (value.isBlank() || value.length > max || value.any { it == '\\' || it == '"' || it.code < 0x20 }) {
            throw CommandProtocolException("$name is invalid")
        }
        return value
    }

    private fun requireCallId(fields: MutableMap<String, Any?>, command: String): String {
        val callId = requireString(fields, "callId", remove = true)
        if (callId.isBlank()) throw CommandProtocolException("$command requires non-blank callId")
        if (callId.length > MAX_IDEMPOTENCY_KEY_LEN) {
            throw CommandProtocolException("callId over bound $MAX_IDEMPOTENCY_KEY_LEN")
        }
        return callId
    }

    private fun requireOpaqueCallId(fields: MutableMap<String, Any?>, command: String): String {
        val callId = requireCallId(fields, command)
        if (!callId.matches(Regex("^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$"))) {
            throw CommandProtocolException("$command requires an opaque callId")
        }
        return callId
    }

    private fun requireRequestId(fields: MutableMap<String, Any?>, command: String): String {
        val requestId = requireString(fields, "requestId", remove = true)
        if (!requestId.matches(Regex("^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$"))) {
            throw CommandProtocolException("$command requires an opaque requestId")
        }
        return requestId
    }

    private fun requireString(
        fields: MutableMap<String, Any?>,
        name: String,
        remove: Boolean,
    ): String {
        val v = if (remove) fields.remove(name) else fields[name]
            ?: throw CommandProtocolException("missing required field: $name")
        return when (v) {
            is String -> v
            else -> throw CommandProtocolException("$name must be a string")
        }
    }

    private fun requireBoolean(fields: MutableMap<String, Any?>, name: String): Boolean {
        val value = fields.remove(name)
            ?: throw CommandProtocolException("missing required field: $name")
        return value as? Boolean
            ?: throw CommandProtocolException("$name must be a boolean")
    }

    private fun requireDecimalLong(fields: MutableMap<String, Any?>, name: String): Long {
        val value = requireString(fields, name, remove = true)
        if (!value.matches(Regex("^(0|[1-9][0-9]{0,11})$"))) {
            throw CommandProtocolException("$name must be a bounded decimal string")
        }
        return value.toLongOrNull() ?: throw CommandProtocolException("$name is out of range")
    }

    private fun isDtmfChar(c: Char): Boolean =
        c.isDigit() || c == '*' || c == '#' || c in 'A'..'D' || c in 'a'..'d'

    /**
     * Decode [bytes] as UTF-8, rejecting malformed sequences (lone continuation
     * bytes, truncated multi-byte sequences). [String(bytes, UTF_8)] silently
     * replaces bad bytes with U+FFFD; we must not.
     */
    private fun decodeUtf8Strict(bytes: ByteArray): String {
        val sb = StringBuilder(bytes.size)
        var i = 0
        while (i < bytes.size) {
            val b0 = bytes[i].toInt() and 0xFF
            when {
                b0 < 0x80 -> { sb.append(b0.toChar()); i += 1 }
                b0 and 0xE0 == 0xC0 -> {
                    if (i + 1 >= bytes.size) throw CommandProtocolException("truncated UTF-8 2-byte sequence")
                    val b1 = bytes[i + 1].toInt() and 0xFF
                    if (b1 and 0xC0 != 0x80) throw CommandProtocolException("invalid UTF-8 continuation byte")
                    val cp = (b0 and 0x1F shl 6) or (b1 and 0x3F)
                    if (cp < 0x80) throw CommandProtocolException("overlong UTF-8 sequence")
                    sb.append(cp.toChar()); i += 2
                }
                b0 and 0xF0 == 0xE0 -> {
                    if (i + 2 >= bytes.size) throw CommandProtocolException("truncated UTF-8 3-byte sequence")
                    val b1 = bytes[i + 1].toInt() and 0xFF
                    val b2 = bytes[i + 2].toInt() and 0xFF
                    if (b1 and 0xC0 != 0x80 || b2 and 0xC0 != 0x80)
                        throw CommandProtocolException("invalid UTF-8 continuation byte")
                    val cp = (b0 and 0x0F shl 12) or (b1 and 0x3F shl 6) or (b2 and 0x3F)
                    if (cp < 0x800) throw CommandProtocolException("overlong UTF-8 sequence")
                    sb.append(cp.toChar()); i += 3
                }
                b0 and 0xF8 == 0xF0 -> {
                    if (i + 3 >= bytes.size) throw CommandProtocolException("truncated UTF-8 4-byte sequence")
                    val b1 = bytes[i + 1].toInt() and 0xFF
                    val b2 = bytes[i + 2].toInt() and 0xFF
                    val b3 = bytes[i + 3].toInt() and 0xFF
                    if (b1 and 0xC0 != 0x80 || b2 and 0xC0 != 0x80 || b3 and 0xC0 != 0x80)
                        throw CommandProtocolException("invalid UTF-8 continuation byte")
                    val cp = (b0 and 0x07 shl 18) or (b1 and 0x3F shl 12) or
                        (b2 and 0x3F shl 6) or (b3 and 0x3F)
                    if (cp < 0x10000 || cp > 0x10FFFF)
                        throw CommandProtocolException("invalid UTF-8 code point")
                    val v = cp - 0x10000
                    sb.append((0xD800 + (v shr 10)).toChar())
                    sb.append((0xDC00 + (v and 0x3FF)).toChar())
                    i += 4
                }
                else -> throw CommandProtocolException("invalid UTF-8 lead byte: 0x%02X".format(b0))
            }
        }
        return sb.toString()
    }
}
