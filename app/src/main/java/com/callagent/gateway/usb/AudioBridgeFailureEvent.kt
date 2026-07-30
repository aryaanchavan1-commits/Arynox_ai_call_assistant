package com.callagent.gateway.usb

/** Exact device-to-host semantic event for a failed privileged audio bridge. */
object AudioBridgeFailureEvent {
    private val CALL_ID = Regex("^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
    private const val REASON = "audio_bridge_failed"

    fun encode(failure: AudioBridgeFailure): ByteArray {
        require(CALL_ID.matches(failure.callId)) { "invalid audio failure callId" }
        require(failure.reason == REASON) { "invalid audio failure reason" }
        return "{\"event\":\"media_failure\",\"callId\":\"${failure.callId}\",\"reason\":\"$REASON\"}"
            .toByteArray(Charsets.UTF_8)
    }
}
