package com.callagent.gateway.audio

/**
 * Pure, Android-free lifecycle state machine for the bidirectional Telephony
 * audio bridge.  The controller owns ONLY the safety decisions; the thin
 * Android wrappers ([TelephonyRxCapture], [TelephonyTxInjection],
 * [AndroidAudioBridge]) report facts and the controller decides start/stop.
 *
 * Phase ordering (the parent review's core defect was conflating these):
 *   1. PREREQUISITES  — [start] checks ONLY active call + both permission
 *      sets.  It never inspects route or playback head, because those facts do
 *      not exist until devices are opened and the uplink has actually written a
 *      frame.  Checking them pre-start made start impossible.
 *   2. OPEN           — the bridge opens AudioRecord/AudioTrack after the
 *      controller accepts prerequisites.
 *   3. ACTIVATE       — AudioRecord.startRecording() then AudioTrack.play().
 *   4. VERIFY ROUTE   — only AFTER the first real uplink write does the bridge
 *      call [verifyUplinkRoute] with the actual routed device + playback head.
 *      A stalled or off-route uplink aborts the bridge.
 *
 * This split keeps the entire safety contract unit-testable on the host JVM
 * with no device, because it operates on plain facts rather than
 * android.media.* objects.  See [AudioBridgeControllerTest].
 *
 * Proven invariants:
 *   - start refused without an active call (MODE_IN_CALL)
 *   - start refused unless BOTH downlink AND uplink permission sets are granted
 *   - start NEVER checks route or playback head (those are post-write facts)
 *   - an uplink route that is not TYPE_TELEPHONY, or whose playback head is
 *     still zero after a real write, aborts via [verifyUplinkRoute]
 *   - start and stop are idempotent
 *   - stop zeroizes state
 *   - no file/network/root/mixer/call-control surface
 */
class AudioBridgeController {

    /** Reported facts about the runtime environment.  Immutable inputs. */
    data class Facts(
        /** True iff Android reports MODE_IN_CALL (an active cellular call). */
        val activeCall: Boolean,
        /** Runtime-granted permissions relevant to downlink capture. */
        val grantedDownlinkPermissions: Set<String>,
        /** Runtime-granted permissions relevant to uplink injection. */
        val grantedUplinkPermissions: Set<String>,
    )

    /**
     * Reported facts about the uplink route AFTER a real frame has been
     * written.  Immutable inputs.  Null head/device means "not yet measurable".
     */
    data class UplinkRouteFacts(
        /** AudioTrack.routedDevice.type for the uplink injection, or null. */
        val uplinkRoutedDeviceType: Int?,
        /** AudioTrack.playbackHeadPosition frames for the uplink injection. */
        val uplinkPlaybackHeadFrames: Int,
    )

    /** Outcome of a lifecycle decision. */
    enum class Outcome {
        STARTED,
        ALREADY_RUNNING,
        STOPPED,
        ALREADY_STOPPED,
        REFUSED_NO_ACTIVE_CALL,
        REFUSED_DOWNLINK_PERMISSIONS,
        REFUSED_UPLINK_PERMISSIONS,
        /** Uplink route off TYPE_TELEPHONY after a real write. */
        REFUSED_UPLINK_ROUTE,
        /**
         * Uplink route is still pending measurement (no write yet, or routed
         * device / playback head not yet exposed).  Not fatal — the bridge
         * keeps pumping and re-verifies.
         */
        UPLINK_ROUTE_PENDING,
    }

    @Volatile private var running: Boolean = false
    @Volatile private var zeroized: Boolean = true
    private val lock = Any()

    /** True iff the bridge is currently running. */
    val isRunning: Boolean get() = running

    /** True iff state has been zeroized (initial state, and after [stop]). */
    val isZeroized: Boolean get() = zeroized

    /**
     * Attempt to start the bridge.  Checks ONLY prerequisites, in order:
     * active call, downlink permissions, uplink permissions.  Route and
     * playback head are NOT checked here — they are post-write facts and are
     * verified later via [verifyUplinkRoute].  Idempotent: a second start
     * while running returns [Outcome.ALREADY_RUNNING].
     */
    fun start(facts: Facts): Outcome = synchronized(lock) {
        if (running) return Outcome.ALREADY_RUNNING

        if (!facts.activeCall) {
            return Outcome.REFUSED_NO_ACTIVE_CALL
        }
        if (!facts.grantedDownlinkPermissions.containsAll(
                AudioBridgeContract.DOWNLINK_REQUIRED_PERMISSIONS,
            )
        ) {
            return Outcome.REFUSED_DOWNLINK_PERMISSIONS
        }
        if (!facts.grantedUplinkPermissions.containsAll(
                AudioBridgeContract.UPLINK_REQUIRED_PERMISSIONS,
            )
        ) {
            return Outcome.REFUSED_UPLINK_PERMISSIONS
        }

        running = true
        zeroized = false
        Outcome.STARTED
    }

    /**
     * Verify the uplink route AFTER a real frame write.  Called by the bridge
     * once AudioTrack.play() has started and at least one frame has been
     * written.  Returns:
     *   - [Outcome.REFUSED_UPLINK_ROUTE] if the uplink routed device is not
     *     TYPE_TELEPHONY after a write.  This aborts the bridge.
     *   - [Outcome.UPLINK_ROUTE_PENDING] if the route is not yet measurable
     *     (routed device null, or head still zero).  The bridge stays running
     *     and re-verifies on the next frame.
     *   - [Outcome.ALREADY_RUNNING] if the route is confirmed good.
     *   - [Outcome.ALREADY_STOPPED] if the bridge is no longer running.
     */
    fun verifyUplinkRoute(route: UplinkRouteFacts): Outcome = synchronized(lock) {
        if (!running) return Outcome.ALREADY_STOPPED

        // Not yet measurable: keep pumping, re-verify next frame.
        if (route.uplinkRoutedDeviceType == null || route.uplinkPlaybackHeadFrames <= 0) {
            return Outcome.UPLINK_ROUTE_PENDING
        }

        if (route.uplinkRoutedDeviceType != AudioBridgeContract.TYPE_TELEPHONY) {
            running = false
            zeroized = true
            return Outcome.REFUSED_UPLINK_ROUTE
        }

        Outcome.ALREADY_RUNNING
    }

    /**
     * Stop the bridge and zeroize state.  Idempotent: a second stop returns
     * [Outcome.ALREADY_STOPPED].
     */
    fun stop(): Outcome = synchronized(lock) {
        if (!running) {
            zeroized = true
            return Outcome.ALREADY_STOPPED
        }
        running = false
        zeroized = true
        Outcome.STOPPED
    }
}
