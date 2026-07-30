package com.callagent.gateway.audio

/**
 * Pure, Android-free data-flow interfaces for the bidirectional Telephony
 * audio bridge.  These exist so the bridge's two directions are INDEPENDENT:
 *
 *   - DOWNLINK (Rx, device -> PC): every frame captured from the telephony
 *     downlink is handed to a [FrameSink] supplied by the caller.  The bridge
 *     never routes Rx frames into the uplink.
 *   - UPLINK (Tx, PC -> device): the bridge pulls frames to inject from a
 *     [FrameSource] supplied by the caller, via the zero-copy [pollInto] API.
 *
 * This is the core correctness fix from the parent review: the old pump copied
 * Rx straight into Tx (an echo loop).  USB full duplex requires independent
 * directions.  Because both interfaces are Android-free, the ordering —
 * prerequisites -> open -> record.start -> track.play -> Rx callback / Tx offer
 * -> route verify after first Tx write — is provable with pure fakes, not
 * android.jar mocks (see [AudioBridgeLifecycleTest]).
 */

/**
 * Consumer of downlink (Rx) frames.  The bridge calls [onFrame] for each frame
 * read from the telephony downlink.  Implementations copy the frame out before
 * returning; the bridge reuses its internal capture buffer for the next read.
 *
 * [onFrame] returns true to keep pumping. False means the mandatory PC-bound
 * media path is unavailable and must fail the active bridge closed.
 */
fun interface FrameSink {
    fun onFrame(frame: ShortArray, sampleCount: Int): Boolean
}

/**
 * Source of uplink (Tx) frames.  The bridge calls [pollInto] to obtain the next
 * frame to inject, writing directly into the bridge's own injection buffer with
 * no per-frame allocation.  Returns the sample count copied, or -1 if no frame
 * is available. The bridge writes one zeroed frame in that case so the
 * telephony AudioTrack never underruns between speech segments.
 */
fun interface FrameSource {
    fun pollInto(dst: ShortArray, offset: Int): Int
}

/**
 * Prepares every 20 ms uplink interval without allocating. An empty source is
 * represented by an all-zero frame instead of skipping the AudioTrack write.
 * Skipped writes let Android retire the telephony track; its later automatic
 * recreation clips or distorts the beginning of the next spoken segment.
 */
internal object UplinkFrameContinuity {
    fun pollOrSilence(source: FrameSource, destination: ShortArray): Boolean {
        require(destination.size == AudioBridgeContract.SAMPLES_PER_FRAME) {
            "destination must be one production frame"
        }
        destination.fill(0)
        val copied = source.pollInto(destination, 0)
        require(copied == -1 || copied == AudioBridgeContract.SAMPLES_PER_FRAME) {
            "uplink source returned an invalid sample count"
        }
        return copied > 0
    }
}

sealed interface AudioWorkerTermination {
    data object Continue : AudioWorkerTermination
    data class Failure(val reason: String) : AudioWorkerTermination

    companion object {
        fun fromDownlinkAccepted(accepted: Boolean): AudioWorkerTermination =
            if (accepted) Continue else Failure("downlink sink unavailable")
    }
}

/**
 * Observer of bridge lifecycle events, used by tests to prove ordering and by
 * the controller/bridge to surface deterministic error reporting.  All methods
 * have safe no-op defaults so production callers may ignore them.
 */
interface LifecycleListener {
    /** Prerequisites accepted, devices about to be opened. */
    fun onPrerequisitesAccepted() {}
    /** AudioRecord opened. */
    fun onRecordOpened() {}
    /** AudioTrack opened. */
    fun onTrackOpened() {}
    /** AudioRecord.startRecording() succeeded. */
    fun onRecordStarted() {}
    /** AudioTrack.play() succeeded. */
    fun onTrackStarted() {}
    /** First uplink frame successfully written. */
    fun onFirstTxWrite() {}
    /** Uplink route verified TYPE_TELEPHONY after a real write. */
    fun onUplinkRouteVerified() {}
    /** A pump worker failed; [reason] describes the failure. */
    fun onWorkerFailure(reason: String) {}
    /** Bridge stopped and all resources released/zeroized. */
    fun onStopped() {}

    companion object {
        /** No-op listener for production callers that ignore events. */
        val NONE: LifecycleListener = object : LifecycleListener {}
    }
}
