package com.callagent.gateway.usb

/** Framework-neutral port so command correlation and safety are unit-testable. */
interface TelecomPort {
    fun dial(destination: String): Boolean
    fun answer(): Boolean
    fun reject(): Boolean
    fun hangup(): Boolean
    fun sendDtmf(digits: String): Boolean
}

fun interface ActiveCallId {
    fun current(): String?
}

fun interface PhoneDataSyncPort {
    fun request(command: GatewayCommand): Boolean
}

class CorrelatedTelecomExecutor(
    private val telecom: TelecomPort,
    private val activeCallId: ActiveCallId,
    private val snapshot: () -> GatewayRuntimeSnapshot,
    private val recordingHealthChanged: (Boolean) -> Unit = {},
    private val recordingSessionChanged: (String, Boolean) -> Unit = { _, _ -> },
    private val gatewayDialStarting: () -> Boolean = { true },
    private val gatewayDialRejected: () -> Unit = {},
    private val provisionDeviceEvidence: (GatewayCommand.ProvisionDeviceEvidence) -> Boolean = { false },
    private val phoneDataSync: PhoneDataSyncPort = PhoneDataSyncPort { false },
) : GatewayCommandExecutor {
    override fun execute(command: GatewayCommand): CommandExecutionResult = when (command) {
        is GatewayCommand.Status -> CommandExecutionResult.Status(snapshot())
        is GatewayCommand.Capabilities -> CommandExecutionResult.Capabilities(CAPABILITIES)
        is GatewayCommand.SyncContacts,
        is GatewayCommand.SyncCallLog -> outcome(
            command.name, phoneDataSync.request(command), "phone data sync unavailable",
        )
        is GatewayCommand.RecordingHealth -> {
            recordingHealthChanged(command.healthy)
            CommandExecutionResult.Accepted(command.name)
        }
        is GatewayCommand.RecordingSession -> {
            recordingSessionChanged(command.callId, command.active)
            CommandExecutionResult.Accepted(command.name)
        }
        is GatewayCommand.ProvisionDeviceEvidence -> outcome(
            command.name, provisionDeviceEvidence(command), "device evidence rejected",
        )
        is GatewayCommand.RecordingArtifactBegin,
        is GatewayCommand.RecordingArtifactCommit ->
            CommandExecutionResult.Rejected(command.name, "recording artifact receiver unavailable")
        is GatewayCommand.Dial -> recordingRequired(command.name) {
            if (!gatewayDialStarting()) return@recordingRequired CommandExecutionResult.Rejected(
                command.name, "another outgoing call is pending",
            )
            val accepted = telecom.dial(command.destination)
            if (!accepted) gatewayDialRejected()
            outcome(command.name, accepted, "dial refused")
        }
        is GatewayCommand.Answer -> recordingRequired(command.name) {
            correlated(command.name, command.callId) { telecom.answer() }
        }
        is GatewayCommand.Reject -> correlated(command.name, command.callId) { telecom.reject() }
        is GatewayCommand.Hangup -> correlated(command.name, command.callId) { telecom.hangup() }
        is GatewayCommand.SendDtmf -> recordingRequired(command.name) {
            correlated(command.name, command.callId) { telecom.sendDtmf(command.digits) }
        }
    }

    private fun recordingRequired(name: String, operation: () -> CommandExecutionResult): CommandExecutionResult {
        if (!snapshot().recordingHealthy) return CommandExecutionResult.Rejected(name, "required desktop recording is not healthy")
        return operation()
    }

    private fun correlated(name: String, requested: String, operation: () -> Boolean): CommandExecutionResult {
        val current = activeCallId.current()
        if (current == null || current != requested) return CommandExecutionResult.Rejected(name, "callId does not match active call")
        return outcome(name, operation(), "telecom operation refused")
    }

    private fun outcome(name: String, accepted: Boolean, reason: String): CommandExecutionResult =
        if (accepted) CommandExecutionResult.Accepted(name) else CommandExecutionResult.Rejected(name, reason)

    companion object {
        val CAPABILITIES = setOf(
            "dial", "answer", "reject", "hangup", "send_dtmf", "usb_loopback", "pcm16_16khz",
            "recording_sync_v1", "contacts_sync_v1", "call_log_sync_v1",
        )
    }
}
