package com.callagent.gateway.audio

import android.content.Context
import android.media.AudioManager
import android.media.AudioRecord
import android.media.AudioTrack

/**
 * Composes the bidirectional Telephony audio bridge with INDEPENDENT
 * directions:
 *
 *   - DOWNLINK (Rx): [TelephonyRxCapture] reads full frames from the
 *     VOICE_DOWNLINK source; each frame is handed to the caller-supplied
 *     [FrameSink] (PC-bound).  Rx never feeds Tx.
 *   - UPLINK (Tx): the pump pulls frames from the caller-supplied
 *     [FrameSource] (PC -> device) via the zero-copy [FrameSource.pollInto]
 *     and writes them through [TelephonyTxInjection].
 *
 * Lifecycle ordering (the parent review's core fix):
 *   1. [start] asks the [AudioBridgeController] to check ONLY prerequisites
 *      (active call + both permission sets).  Route/playback head are NOT
 *      checked here — they do not exist until the uplink has written a frame.
 *   2. On STARTED: open AudioRecord; if that throws, nothing to release.  Open
 *      AudioTrack; if that throws, release the already-opened record (defect #5).
 *   3. AudioRecord.startRecording() (with state verify), then AudioTrack.play()
 *      (with state verify) — defects #1, #2.
 *   4. Start a single bounded worker that reads Rx -> [FrameSink] and pulls
 *      Tx <- [FrameSource] independently (no Rx-to-Tx loop) — defect #3.
 *   5. After the first successful Tx write, verify the uplink route via the
 *      controller ([AudioBridgeController.verifyUplinkRoute]); an off-route or
 *      stalled uplink aborts deterministically — defect #1.
 *
 * Teardown (defect #4): [stop] sets running=false, stops the record and
 * pauses/stops the track (to unblock the worker's blocking read/write), joins
 * the bounded worker, releases both devices, and zeroizes every fixed buffer
 * and queued payload.  A worker failure calls back via [LifecycleListener] and
 * triggers the same deterministic cleanup rather than exiting silently while
 * the controller still reports running.
 *
 * Constraints (Phase 1 production contract):
 *   - 20 ms frames = 320 samples at 16 kHz mono PCM16
 *   - fixed scratch buffers + bounded buffer only — no per-frame allocation
 *   - no file recording, no network, no root, no mixer writes, no call control
 */
class AndroidAudioBridge(
    private val context: Context,
    /** Fixed frame-buffer capacity (number of 20 ms frames). */
    private val bufferCapacityFrames: Int = DEFAULT_BUFFER_CAPACITY_FRAMES,
    rxCapture: TelephonyRxCapture? = null,
    txInjection: TelephonyTxInjection? = null,
    private val controller: AudioBridgeController = AudioBridgeController(),
) {
    init {
        require(bufferCapacityFrames > 0) { "bufferCapacityFrames must be > 0" }
    }

    private val rxCapture: TelephonyRxCapture = rxCapture ?: TelephonyRxCapture(audioManager())
    private val txInjection: TelephonyTxInjection = txInjection ?: TelephonyTxInjection(audioManager())

    // Fixed scratch frames, reused across every iteration — no per-frame alloc.
    private val captureFrame = ShortArray(AudioBridgeContract.SAMPLES_PER_FRAME)
    private val injectFrame = ShortArray(AudioBridgeContract.SAMPLES_PER_FRAME)

    @Volatile private var record: AudioRecord? = null
    @Volatile private var track: AudioTrack? = null
    @Volatile private var running: Boolean = false
    @Volatile private var errorState: String? = null
    private val workerLock = Any()
    private var worker: Thread? = null

    /** Whether the bridge is currently running. */
    val isRunning: Boolean get() = controller.isRunning

    /** Last deterministic worker failure, or null.  Cleared on [start]. */
    val lastError: String? get() = errorState

    /**
     * Attempt to start the bridge.  Preconditions (active call + permissions)
     * are checked by the controller first; only on STARTED does the bridge
     * open devices, activate them, and begin the independent Rx/Tx pump.
     *
     * [downlinkSink] receives every captured Rx frame (PC-bound).
     * [uplinkSource] supplies Tx frames to inject (PC -> device).
     */
    fun start(
        facts: AudioBridgeController.Facts,
        downlinkSink: FrameSink,
        uplinkSource: FrameSource,
        listener: LifecycleListener = LifecycleListener.NONE,
    ): AudioBridgeController.Outcome {
        errorState = null
        val outcome = controller.start(facts)
        if (outcome != AudioBridgeController.Outcome.STARTED) return outcome
        listener.onPrerequisitesAccepted()

        // --- OPEN with partial-failure release (defect #5) ---
        val openedRecord = openRecordOrRelease(listener)
            ?: return failClosed(listener, "AudioRecord open failed")
        val openedTrack = openTrackOrRelease(openedRecord, listener)
            ?: return failClosed(listener, "AudioTrack open failed")

        // --- ACTIVATE: start record, then play track (defects #1, #2) ---
        try {
            rxCapture.startRecording(openedRecord)
            listener.onRecordStarted()
        } catch (e: Throwable) {
            return failClosedDevices(openedRecord, openedTrack, listener, "AudioRecord startRecording failed: ${e.message}")
        }
        try {
            txInjection.play(openedTrack)
            listener.onTrackStarted()
        } catch (e: Throwable) {
            return failClosedDevices(openedRecord, openedTrack, listener, "AudioTrack play failed: ${e.message}")
        }

        record = openedRecord
        track = openedTrack
        running = true
        startPumpLoop(downlinkSink, uplinkSource, listener)
        return outcome
    }

    /**
     * Stop the bridge: set running false, stop record and pause/stop the track
     * to unblock the worker, join the bounded worker, release both devices,
     * and zeroize every fixed buffer and queued payload.  Idempotent via the
     * controller (defect #4).
     */
    fun stop(): AudioBridgeController.Outcome {
        val outcome = controller.stop()
        teardown(clearError = true, listener = LifecycleListener.NONE)
        return outcome
    }

    /**
     * Shared teardown for explicit stops and worker termination.
     *
     * A worker never joins itself. An external caller joins with a hard bound;
     * if the worker is still alive, devices are deliberately not released out
     * from under it and the failure is surfaced through [lastError].
     */
    private fun teardown(clearError: Boolean, listener: LifecycleListener) {
        running = false
        val r = record
        val t = track
        runCatching { r?.stop() }
        runCatching { t?.pause() }
        runCatching { t?.stop() }

        val current = Thread.currentThread()
        val w = synchronized(workerLock) { worker }
        if (w != null && w !== current) {
            runCatching { w.join(JOIN_TIMEOUT_MS) }
            if (w.isAlive) {
                errorState = "audio worker did not stop within ${JOIN_TIMEOUT_MS}ms"
                listener.onWorkerFailure(requireNotNull(errorState))
                return
            }
        }
        synchronized(workerLock) {
            if (worker === w || worker === current) worker = null
        }
        record = null
        track = null
        closeQuietly(r, t)
        rxCapture.zeroize(captureFrame)
        txInjection.zeroize(injectFrame)
        if (clearError) errorState = null
        listener.onStopped()
    }

    // --- internals ---------------------------------------------------------

    /**
     * Open the AudioRecord.  On failure there is nothing partially created to
     * release (factory threw before returning), so return null.
     */
    private fun openRecordOrRelease(listener: LifecycleListener): AudioRecord? {
        val params = rxCapture.paramsForFrameBuffer(AudioBridgeContract.BYTES_PER_FRAME)
        return try {
            val rec = rxCapture.open(params)
            listener.onRecordOpened()
            rec
        } catch (e: Throwable) {
            errorState = "AudioRecord open failed: ${e.message}"
            null
        }
    }

    /**
     * Open the AudioTrack.  On failure release the already-opened record so no
     * device leaks (defect #5).
     */
    private fun openTrackOrRelease(
        openedRecord: AudioRecord,
        listener: LifecycleListener,
    ): AudioTrack? {
        val params = txInjection.paramsForFrameBuffer(AudioBridgeContract.BYTES_PER_FRAME)
        return try {
            val trk = txInjection.open(params)
            listener.onTrackOpened()
            trk
        } catch (e: Throwable) {
            errorState = "AudioTrack open failed: ${e.message}"
            runCatching { openedRecord.release() }
            null
        }
    }

    /**
     * Single bounded worker.  Rx and Tx are independent: every read frame goes
     * to [downlinkSink]; every injected frame comes from [uplinkSource].  Rx is
     * never copied into Tx (defect #3). Every interval writes either the next
     * PC frame or silence, preventing AudioTrack underruns between utterances.
     * After the first successful Tx write the uplink route is verified once
     * (defect #1). Any failure triggers
     * deterministic cleanup + error reporting instead of a silent exit (defect
     * #4).
     */
    private fun startPumpLoop(
        downlinkSink: FrameSink,
        uplinkSource: FrameSource,
        listener: LifecycleListener,
    ) {
        val w = Thread({
            val r = record ?: return@Thread
            val t = track ?: return@Thread
            var txRouteVerified = false
            try {
                while (running) {
                    // --- DOWNLINK (Rx -> PC) ---
                    val read = rxCapture.readFrame(r, captureFrame)
                    if (read <= 0) {
                        failWorker(listener, "downlink read returned $read"); return@Thread
                    }
                    when (val termination = AudioWorkerTermination.fromDownlinkAccepted(
                        downlinkSink.onFrame(captureFrame, read),
                    )) {
                        AudioWorkerTermination.Continue -> Unit
                        is AudioWorkerTermination.Failure -> {
                            failWorker(listener, termination.reason)
                            return@Thread
                        }
                    }
                    // The sink copied what it needs; zeroize before next read.
                    rxCapture.zeroize(captureFrame)

                    // --- UPLINK (PC -> Tx), independent direction ---
                    UplinkFrameContinuity.pollOrSilence(uplinkSource, injectFrame)
                    val written = txInjection.writeFrame(t, injectFrame)
                    if (written <= 0) {
                        failWorker(listener, "uplink write returned $written"); return@Thread
                    }
                    txInjection.zeroize(injectFrame)
                    if (!txRouteVerified) {
                        listener.onFirstTxWrite()
                        val route = AudioBridgeController.UplinkRouteFacts(
                            uplinkRoutedDeviceType = txInjection.routedDeviceType(t),
                            uplinkPlaybackHeadFrames = txInjection.playbackHeadFrames(t),
                        )
                        when (controller.verifyUplinkRoute(route)) {
                            AudioBridgeController.Outcome.REFUSED_UPLINK_ROUTE -> {
                                failWorker(listener, "uplink route not TYPE_TELEPHONY"); return@Thread
                            }
                            AudioBridgeController.Outcome.ALREADY_RUNNING -> {
                                txRouteVerified = true
                                listener.onUplinkRouteVerified()
                            }
                            // PENDING: keep pumping, re-verify next frame.
                            AudioBridgeController.Outcome.UPLINK_ROUTE_PENDING -> Unit
                            else -> Unit
                        }
                    }
                }
            } catch (e: Throwable) {
                failWorker(listener, "pump exception: ${e.message}")
            }
        }, "audio-bridge-pump")
        synchronized(workerLock) { worker = w }
        w.isDaemon = true
        w.start()
    }

    /** Deterministic worker failure: preserve the reason and clean up without self-join. */
    private fun failWorker(listener: LifecycleListener, reason: String) {
        stopFromWorker(listener, failure = reason)
    }

    private fun stopFromWorker(listener: LifecycleListener, failure: String?) {
        if (failure != null) {
            errorState = failure
            listener.onWorkerFailure(failure)
        }
        controller.stop()
        teardown(clearError = false, listener = listener)
    }

    private fun failClosed(listener: LifecycleListener, reason: String): AudioBridgeController.Outcome {
        errorState = reason
        controller.stop()
        listener.onStopped()
        return AudioBridgeController.Outcome.REFUSED_UPLINK_ROUTE
    }

    private fun failClosedDevices(
        record: AudioRecord,
        track: AudioTrack,
        listener: LifecycleListener,
        reason: String,
    ): AudioBridgeController.Outcome {
        errorState = reason
        runCatching { record.stop() }
        closeQuietly(record, track)
        rxCapture.zeroize(captureFrame)
        txInjection.zeroize(injectFrame)
        controller.stop()
        listener.onStopped()
        return AudioBridgeController.Outcome.REFUSED_UPLINK_ROUTE
    }

    private fun closeQuietly(record: AudioRecord?, track: AudioTrack?) {
        runCatching { track?.pause() }
        runCatching { track?.flush() }
        runCatching { track?.release() }
        runCatching { record?.release() }
    }

    private fun audioManager(): AudioManager =
        context.getSystemService(Context.AUDIO_SERVICE) as AudioManager

    companion object {
        /** Fixed frame-buffer capacity.  ~1 s of 20 ms frames. */
        const val DEFAULT_BUFFER_CAPACITY_FRAMES: Int = 50

        /** Bounded join timeout so teardown cannot hang a caller. */
        const val JOIN_TIMEOUT_MS: Long = 1_000L
    }
}
