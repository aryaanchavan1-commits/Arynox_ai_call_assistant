package com.callagent.gateway.usb

interface UsbAudioBridgeControl {
    fun start(): Boolean
    fun stop()
    fun discardQueuedAudio() = Unit
}

data class AudioBridgeFailure(
    val callId: String,
    val reason: String = "audio_bridge_failed",
)

/** Pure safety gate for activating privileged cellular audio. */
class UsbAudioBridgeCoordinator(
    private val bridge: UsbAudioBridgeControl,
    private val deviceQualified: () -> Boolean,
) {
    constructor(bridge: UsbAudioBridgeControl, deviceQualified: Boolean) :
        this(bridge, { deviceQualified })
    private var desktopConnected = false
    private var recordingHealthy = false
    private var recordingCallId: String? = null
    private var activeCallId: String? = null
    var running: Boolean = false
        private set

    @Synchronized
    fun onDesktopConnected(connected: Boolean) {
        desktopConnected = connected
        reconcile()
    }

    @Synchronized
    fun onRecordingHealthy(healthy: Boolean) {
        recordingHealthy = healthy
        reconcile()
    }

    @Synchronized
    fun onRecordingSession(callId: String, active: Boolean) {
        recordingCallId = if (active) callId else null
        reconcile()
    }

    @Synchronized
    fun onCall(callId: String, active: Boolean) {
        activeCallId = if (active) callId else null
        reconcile()
    }

    @Synchronized
    fun onBridgeFailed(): AudioBridgeFailure? {
        if (!running) return null
        val failedCallId = activeCallId
        running = false
        recordingHealthy = false
        recordingCallId = null
        bridge.discardQueuedAudio()
        return failedCallId?.let(::AudioBridgeFailure)
    }

    @Synchronized
    fun revalidateDeviceQualification() {
        reconcile()
    }

    @Synchronized
    fun stop() {
        activeCallId = null
        recordingCallId = null
        bridge.discardQueuedAudio()
        try {
            if (running) bridge.stop()
        } finally {
            running = false
            bridge.discardQueuedAudio()
        }
    }

    private fun reconcile() {
        val shouldRun = deviceQualified() &&
            desktopConnected &&
            recordingHealthy &&
            recordingCallId != null &&
            recordingCallId == activeCallId
        if (shouldRun && !running) {
            running = true
            val started = try {
                bridge.start()
            } catch (error: Throwable) {
                running = false
                throw error
            }
            if (!started) running = false
        }
        if (!shouldRun && running) {
            bridge.discardQueuedAudio()
            try {
                bridge.stop()
            } finally {
                running = false
                bridge.discardQueuedAudio()
            }
        }
    }
}
