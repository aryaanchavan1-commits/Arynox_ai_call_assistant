package com.callagent.gateway.usb

/**
 * Typed, parsed representation of a CONTROL HOST_TO_DEVICE command.
 *
 * The wire payload is a strict UTF-8 JSON object. [CommandParser] validates the
 * object shape, the known command [name], and the strict known fields, then
 * produces one of these. Mutation subtypes carry their argument; query
 * subtypes (Status, Capabilities) carry none.
 *
 * [redactedSummary] is the ONLY safe way to mention a command in a log line or
 * EVENT payload — it masks phone numbers and DTMF digits via [RedactingLog].
 */
sealed class GatewayCommand {

    abstract val name: String
    abstract val idempotencyKey: String

    /** True for commands that mutate call state and so require idempotency. */
    abstract val isMutation: Boolean

    /** Canonical request identity used only for bounded in-memory replay matching. */
    fun requestFingerprint(): String = when (this) {
        is Dial -> "$name\u0000$destination"
        is Answer -> "$name\u0000$callId"
        is Reject -> "$name\u0000$callId"
        is Hangup -> "$name\u0000$callId"
        is SendDtmf -> "$name\u0000$callId\u0000$digits"
        is ProvisionDeviceEvidence -> listOf(
            name, observedSystemFingerprint, observedVendorFingerprint,
            attestedOn, attestedSystemDescription,
        ).joinToString("\u0000")
        else -> name
    }

    /** A log/EVENT-safe summary: command name plus redacted arguments. */
    fun redactedSummary(): String = when (this) {
        is Dial -> "dial destination=${RedactingLog.redactPhone(destination)} key=$idempotencyKey"
        is SendDtmf -> "send_dtmf call=$callId digits=${RedactingLog.redactDtmf(digits)} key=$idempotencyKey"
        else -> "$name key=$idempotencyKey"
    }

    data class Status(override val idempotencyKey: String) : GatewayCommand() {
        override val name = "status"
        override val isMutation = false
    }

    data class Capabilities(override val idempotencyKey: String) : GatewayCommand() {
        override val name = "capabilities"
        override val isMutation = false
    }

    data class SyncContacts(val requestId: String) : GatewayCommand() {
        override val name = "sync_contacts"
        override val idempotencyKey = ""
        override val isMutation = false
    }

    data class SyncCallLog(val requestId: String) : GatewayCommand() {
        override val name = "sync_call_log"
        override val idempotencyKey = ""
        override val isMutation = false
    }

    data class RecordingHealth(val healthy: Boolean) : GatewayCommand() {
        override val name = "recording_health"
        override val idempotencyKey = ""
        override val isMutation = false
    }

    data class RecordingSession(val callId: String, val active: Boolean) : GatewayCommand() {
        override val name = "recording_session"
        override val idempotencyKey = ""
        override val isMutation = false
    }

    data class RecordingArtifactBegin(
        val callId: String,
        val artifact: String,
        val size: Long,
        val sha256: String,
        val durationMillis: Long,
    ) : GatewayCommand() {
        override val name = "recording_artifact_begin"
        override val idempotencyKey = ""
        override val isMutation = false
    }

    data class RecordingArtifactCommit(val callId: String) : GatewayCommand() {
        override val name = "recording_artifact_commit"
        override val idempotencyKey = ""
        override val isMutation = false
    }

    data class Dial(
        override val idempotencyKey: String,
        val destination: String,
    ) : GatewayCommand() {
        override val name = "dial"
        override val isMutation = true
    }

    data class Answer(override val idempotencyKey: String, val callId: String) : GatewayCommand() {
        override val name = "answer"
        override val isMutation = true
    }

    data class Reject(override val idempotencyKey: String, val callId: String) : GatewayCommand() {
        override val name = "reject"
        override val isMutation = true
    }

    data class Hangup(override val idempotencyKey: String, val callId: String) : GatewayCommand() {
        override val name = "hangup"
        override val isMutation = true
    }

    data class ProvisionDeviceEvidence(
        override val idempotencyKey: String,
        val observedSystemFingerprint: String,
        val observedVendorFingerprint: String,
        val attestedOn: String,
        val attestedSystemDescription: String,
    ) : GatewayCommand() {
        override val name = "provision_device_evidence"
        override val isMutation = true
    }

    data class SendDtmf(
        override val idempotencyKey: String,
        val callId: String,
        val digits: String,
    ) : GatewayCommand() {
        override val name = "send_dtmf"
        override val isMutation = true
    }
}
