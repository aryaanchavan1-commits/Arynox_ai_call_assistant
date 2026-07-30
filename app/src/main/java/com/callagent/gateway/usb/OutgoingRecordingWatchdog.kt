package com.callagent.gateway.usb

/**
 * Owns the short interval between an authenticated gateway dial and Linux
 * acknowledging mandatory recording for Android's generated call ID.
 */
class OutgoingRecordingWatchdog(
    private val scheduler: Scheduler,
    private val timeoutMs: Long,
    private val pendingExpired: () -> Unit = {},
    private val hangup: (String) -> Unit,
) {
    interface Scheduled { fun cancel() }
    fun interface Scheduler { fun schedule(delayMs: Long, task: () -> Unit): Scheduled }

    private var gatewayDialPending = false
    private var ownedCallId: String? = null
    private var scheduled: Scheduled? = null
    private var generation = 0L

    init {
        require(timeoutMs in 1_000..120_000) { "outgoing recording timeout is invalid" }
    }

    @Synchronized
    fun onGatewayDialStarting(): Boolean {
        if (gatewayDialPending || ownedCallId != null) return false
        gatewayDialPending = true
        val token = ++generation
        scheduled = scheduler.schedule(timeoutMs) { onPendingTimeout(token) }
        return true
    }

    fun onGatewayDialAccepted() { onGatewayDialStarting() }

    @Synchronized
    fun onGatewayDialRejected() {
        clearLocked()
    }

    @Synchronized
    fun onOutgoingCall(callId: String): Boolean {
        if (!gatewayDialPending || ownedCallId != null || callId.isBlank()) return false
        gatewayDialPending = false
        ownedCallId = callId
        scheduled?.cancel()
        val token = ++generation
        scheduled = scheduler.schedule(timeoutMs) { onTimeout(callId, token) }
        return true
    }

    @Suppress("UNUSED_PARAMETER")
    @Synchronized
    fun onRecordingSession(callId: String, active: Boolean) {
        if (ownedCallId == callId) clearLocked()
    }

    @Synchronized
    fun onCallEnded(callId: String) {
        if (ownedCallId == callId) clearLocked()
    }

    @Synchronized
    fun onGatewayDisconnected() {
        clearLocked()
    }

    private fun onTimeout(callId: String, token: Long) {
        val shouldHangup = synchronized(this) {
            if (generation != token || ownedCallId != callId) false
            else {
                clearLocked()
                true
            }
        }
        if (shouldHangup) hangup(callId)
    }

    private fun onPendingTimeout(token: Long) {
        val expired = synchronized(this) {
            if (generation == token && gatewayDialPending && ownedCallId == null) {
                clearLocked()
                true
            } else false
        }
        if (expired) pendingExpired()
    }

    private fun clearLocked() {
        generation++
        gatewayDialPending = false
        ownedCallId = null
        scheduled?.cancel()
        scheduled = null
    }
}
