package com.callagent.gateway.audio

import android.media.AudioDeviceInfo
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioRecord
import android.media.MediaRecorder

/**
 * Thin Android wrapper for the downlink (Rx) Telephony capture, extracted
 * faithfully from the proven downlinkProbe:
 *   - AudioSource = VOICE_DOWNLINK
 *   - 16 kHz mono PCM16
 *   - buffer = max(minBuf, oneFrameBytes)
 *   - the capture only counts if [AudioRecord.getRoutedDevice] is the actual
 *     TYPE_TELEPHONY device (proven StoredCaptureGuard)
 *
 * This class holds no lifecycle policy of its own — it reports facts
 * ([AudioBridgeController.RouteFacts]) and the controller decides.  Construction
 * is split so the pure controller logic stays host-testable: pass a real
 * [AudioManager] to resolve the telephony device, or test the route decision
 * via the controller with fabricated route facts.
 *
 * No file recording, no network, no root, no mixer writes.
 */
class TelephonyRxCapture internal constructor(
    private val audioManager: AudioManager,
    private val recordFactory: RecordFactory,
) {

    /** Constructor used in production. */
    constructor(audioManager: AudioManager) : this(
        audioManager,
        DefaultRecordFactory,
    )

    /** Allows tests/production to supply the AudioRecord build. */
    fun interface RecordFactory {
        fun create(
            source: Int,
            sampleRate: Int,
            channelMask: Int,
            encoding: Int,
            bufferBytes: Int,
        ): AudioRecord
    }

    private object DefaultRecordFactory : RecordFactory {
        @android.annotation.SuppressLint("MissingPermission,WrongConstant")
        override fun create(
            source: Int,
            sampleRate: Int,
            channelMask: Int,
            encoding: Int,
            bufferBytes: Int,
        ): AudioRecord = AudioRecord.Builder()
            .setAudioSource(source)
            .setAudioFormat(
                AudioFormat.Builder()
                    .setEncoding(encoding)
                    .setSampleRate(sampleRate)
                    .setChannelMask(channelMask)
                    .build(),
            )
            .setBufferSizeInBytes(bufferBytes)
            .build()
    }

    /** Resolved capture parameters, derived from [AudioBridgeContract]. */
    data class CaptureParams(
        val source: Int = AudioBridgeContract.DOWNLINK_AUDIO_SOURCE,
        val sampleRateHz: Int = AudioBridgeContract.SAMPLE_RATE_HZ,
        val channelMask: Int = AudioFormat.CHANNEL_IN_MONO,
        val encoding: Int = AudioBridgeContract.ENCODING_PCM_16BIT,
        val bufferBytes: Int,
    )

    /** The actual TYPE_TELEPHONY input device, or null if none is exposed. */
    fun telephonyRxDevice(): AudioDeviceInfo? =
        audioManager.getDevices(AudioManager.GET_DEVICES_INPUTS)
            .firstOrNull { it.type == AudioBridgeContract.TYPE_TELEPHONY }

    /**
     * Build the capture params for one frame buffer.  Buffer is at least one
     * frame and at least the platform minimum, mirroring the probe.
     */
    fun paramsForFrameBuffer(frameBufferBytes: Int): CaptureParams {
        val minBytes = AudioRecord.getMinBufferSize(
            AudioBridgeContract.SAMPLE_RATE_HZ,
            AudioFormat.CHANNEL_IN_MONO,
            AudioBridgeContract.ENCODING_PCM_16BIT,
        )
        require(minBytes > 0) { "No supported 16 kHz mono input profile ($minBytes)" }
        val buffer = maxOf(minBytes, frameBufferBytes)
        return CaptureParams(bufferBytes = buffer)
    }

    /**
     * Open the AudioRecord for the given params.  Caller must call
     * [startRecording] before reading.  Throws if initialization fails; the
     * caller is responsible for releasing a partially-created record (handled
     * in [AndroidAudioBridge.openRecordOrRelease]).
     */
    fun open(params: CaptureParams): AudioRecord {
        val record = recordFactory.create(
            params.source,
            params.sampleRateHz,
            params.channelMask,
            params.encoding,
            params.bufferBytes,
        )
        check(record.state == AudioRecord.STATE_INITIALIZED) {
            "AudioRecord initialization failed (state=${record.state})"
        }
        return record
    }

    /**
     * Start capture.  Explicit start + state verification: the record must be
     * in RECORDSTATE_RECORDING after the call, else the bridge fails closed.
     */
    fun startRecording(record: AudioRecord) {
        record.startRecording()
        check(record.recordingState == AudioRecord.RECORDSTATE_RECORDING) {
            "AudioRecord not recording after startRecording() (state=${record.recordingState})"
        }
    }

    /**
     * Read exactly one 20 ms frame (320 samples) blocking, into [frame] at
     * [offset].  Returns the number of samples read.  Mirrors the probe's
     * blocking read loop.
     */
    fun readFrame(record: AudioRecord, frame: ShortArray, offset: Int = 0): Int {
        require(frame.size - offset >= AudioBridgeContract.SAMPLES_PER_FRAME) {
            "frame too small for one ${AudioBridgeContract.SAMPLES_PER_FRAME}-sample frame"
        }
        var read = 0
        val need = AudioBridgeContract.SAMPLES_PER_FRAME
        while (read < need) {
            val n = record.read(frame, offset + read, need - read, AudioRecord.READ_BLOCKING)
            check(n > 0) { "AudioRecord read failed ($n)" }
            read += n
        }
        return read
    }

    /**
     * Report the downlink route fact for the controller: the actual routed
     * device type after [AudioRecord] open.  Proven guard: must be
     * TYPE_TELEPHONY.  Returns null if no device is routed.
     */
    fun downlinkRouteType(record: AudioRecord): Int? = record.routedDevice?.type

    /**
     * Zeroize a frame buffer's worth of PCM in place.  Called on stop so no
     * downlink samples persist.
     */
    fun zeroize(frame: ShortArray) {
        frame.fill(0.toShort())
    }
}
