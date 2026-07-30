package com.callagent.gateway.usb

/** Narrow semantic boundary between the USB protocol and Android Telecom. */
fun interface GatewayCommandExecutor {
    fun execute(command: GatewayCommand): CommandExecutionResult
}

data class GatewayRuntimeSnapshot(
    val listenerRunning: Boolean,
    val desktopConnected: Boolean,
    val activeCallId: String?,
    val recordingHealthy: Boolean,
) {
    companion object {
        fun stopped() = GatewayRuntimeSnapshot(
            listenerRunning = false,
            desktopConnected = false,
            activeCallId = null,
            recordingHealthy = false,
        )
    }
}

sealed class CommandExecutionResult {
    data class Accepted(val command: String) : CommandExecutionResult()
    data class Rejected(val command: String, val reason: String) : CommandExecutionResult()
    data class Status(val snapshot: GatewayRuntimeSnapshot) : CommandExecutionResult()
    data class Capabilities(val values: Set<String>) : CommandExecutionResult()
}

object RejectingCommandExecutor : GatewayCommandExecutor {
    override fun execute(command: GatewayCommand): CommandExecutionResult = when (command) {
        is GatewayCommand.Status -> CommandExecutionResult.Status(GatewayRuntimeSnapshot.stopped())
        is GatewayCommand.Capabilities -> CommandExecutionResult.Capabilities(emptySet())
        is GatewayCommand.RecordingHealth -> CommandExecutionResult.Rejected(command.name, "telecom boundary unavailable")
        is GatewayCommand.ProvisionDeviceEvidence -> CommandExecutionResult.Rejected(command.name, "evidence provisioner unavailable")
        else -> CommandExecutionResult.Rejected(command.name, "telecom boundary unavailable")
    }
}
