package com.callagent.gateway.usb

data class GatewayUiState(
    val connection: Connection,
    val detail: String,
    val desktopConnected: Boolean,
    val device: Device,
    val telecom: Health,
    val audioRx: Health,
    val audioTx: Health,
    val recording: Health,
    val call: Call,
) {
    enum class Connection { STOPPED, LISTENING_USB, DESKTOP_CONNECTED, ERROR }
    enum class Health { UNKNOWN, HEALTHY, DEGRADED, FAIL_CLOSED }
    enum class CallPhase { IDLE, RINGING, DIALING, ACTIVE, ENDING, ENDED }

    data class Device(val model: String = "Unknown device", val codename: String = "unknown", val qualification: String = "unverified")
    data class Call(
        val id: String? = null,
        val displayNumber: String = "",
        val phase: CallPhase = CallPhase.IDLE,
        val canAnswer: Boolean = false,
        val canReject: Boolean = false,
        val autoAnswered: Boolean = false,
    )

    val connectionLabel: String get() = when (connection) {
        Connection.STOPPED -> "USB gateway stopped"
        Connection.LISTENING_USB -> "Waiting for desktop over USB"
        Connection.DESKTOP_CONNECTED -> "Desktop connected via USB"
        Connection.ERROR -> "USB gateway unavailable"
    }

    val readyForAgentCalls: Boolean get() = desktopConnected
        && device.qualification == "qualified"
        && telecom == Health.HEALTHY
        && audioRx == Health.HEALTHY
        && audioTx == Health.HEALTHY
        && recording == Health.HEALTHY

    fun reduce(event: GatewayUiEvent): GatewayUiState = when (event) {
        GatewayUiEvent.WaitingForPairing -> copy(
            connection = Connection.LISTENING_USB,
            detail = "Secure pairing is ready. Keep this screen open while the desktop connects.",
            desktopConnected = false,
        )
        is GatewayUiEvent.ListenerStarted -> copy(connection = Connection.LISTENING_USB, detail = "Secure USB channel ready. Keep the phone connected while the desktop finishes setup.", desktopConnected = false)
        GatewayUiEvent.DesktopConnected -> copy(connection = Connection.DESKTOP_CONNECTED, detail = "Authenticated desktop tunnel active", desktopConnected = true)
        is GatewayUiEvent.DesktopDisconnected -> copy(
            connection = Connection.LISTENING_USB,
            detail = event.reason.take(160),
            desktopConnected = false,
            audioRx = Health.FAIL_CLOSED,
            audioTx = Health.FAIL_CLOSED,
            recording = Health.FAIL_CLOSED,
        )
        is GatewayUiEvent.DeviceQualified -> copy(device = Device(event.model, event.codename, event.qualification))
        GatewayUiEvent.TelecomReady -> copy(telecom = Health.HEALTHY)
        is GatewayUiEvent.AudioReady -> copy(audioRx = if (event.rx) Health.HEALTHY else Health.FAIL_CLOSED, audioTx = if (event.tx) Health.HEALTHY else Health.FAIL_CLOSED)
        GatewayUiEvent.RecordingHealthy -> copy(recording = Health.HEALTHY)
        is GatewayUiEvent.RecordingFailed -> copy(recording = Health.FAIL_CLOSED, detail = event.reason.take(160))
        is GatewayUiEvent.IncomingCall -> copy(call = Call(event.callId, event.displayNumber, CallPhase.RINGING, canAnswer = true, canReject = true, autoAnswered = false))
        is GatewayUiEvent.CallChanged -> copy(call = call.copy(id = event.callId, phase = event.phase, canAnswer = false, canReject = false))
        is GatewayUiEvent.Error -> copy(
            connection = Connection.ERROR,
            detail = event.message.take(160),
            desktopConnected = false,
            audioRx = Health.FAIL_CLOSED,
            audioTx = Health.FAIL_CLOSED,
            recording = Health.FAIL_CLOSED,
        )
        GatewayUiEvent.Stopped -> initial()
    }

    companion object {
        fun initial() = GatewayUiState(
            connection = Connection.STOPPED,
            detail = "Connect the phone by USB, approve USB debugging, then start secure desktop pairing.",
            desktopConnected = false,
            device = Device(),
            telecom = Health.UNKNOWN,
            audioRx = Health.UNKNOWN,
            audioTx = Health.UNKNOWN,
            recording = Health.FAIL_CLOSED,
            call = Call(),
        )
    }
}

sealed class GatewayUiEvent {
    data object WaitingForPairing : GatewayUiEvent()
    data class ListenerStarted(val port: Int) : GatewayUiEvent()
    data object DesktopConnected : GatewayUiEvent()
    data class DesktopDisconnected(val reason: String) : GatewayUiEvent()
    data class DeviceQualified(val model: String, val codename: String, val qualification: String) : GatewayUiEvent()
    data object TelecomReady : GatewayUiEvent()
    data class AudioReady(val rx: Boolean, val tx: Boolean) : GatewayUiEvent()
    data object RecordingHealthy : GatewayUiEvent()
    data class RecordingFailed(val reason: String) : GatewayUiEvent()
    data class IncomingCall(val callId: String, val displayNumber: String) : GatewayUiEvent()
    data class CallChanged(val callId: String, val phase: GatewayUiState.CallPhase) : GatewayUiEvent()
    data class Error(val message: String) : GatewayUiEvent()
    data object Stopped : GatewayUiEvent()
}
