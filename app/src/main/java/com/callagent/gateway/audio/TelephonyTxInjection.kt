package com.callagent.gateway.audio

import android.media.AudioAttributes
import android.media.AudioDeviceInfo
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioTrack

/**
 * Thin Android wrapper for uplink (Tx) Telephony injection, extracted from the
 * proven uplinkProbe:
 *   - AudioAttributes.USAGE_MEDIA (usage 1)
 *   - explicit AudioTrack.setPreferredDevice(TYPE_TELEPHONY output)
 *   - PCM16, 16 kHz mono production frames
 *   - route accepted only when preferred-device call succeeds, the actual
 *     routed device is TYPE_TELEPHONY, and playbackHeadPosition > 0
 *   - write must consume the entire frame
 *
 * No manual mixer writes, no file recording, no network, no root, no call
 * control.  Lifecycle decisions remain in [AudioBridgeController].
 */
class TelephonyTxInjection internal constructor(
    private val audioManager: AudioManager,
    private val trackFactory: TrackFactory,
) {

    /** Constructor used in production. */
    constructor(audioManager: AudioManager) : this(
        audioManager,
        DefaultTrackFactory,
    )

    /** Allows tests/production to supply AudioTrack creation. */
    fun interface TrackFactory {
        fun create(
            attributes: AudioAttributes,
            format: AudioFormat,
            bufferBytes: Int,
        ): AudioTrack
    }

    private object DefaultTrackFactory : TrackFactory {
        override fun create(
            attributes: AudioAttributes,
            format: AudioFormat,
            bufferBytes: Int,
        ): AudioTrack = AudioTrack.Builder()
            .setAudioAttributes(attributes)
            .setAudioFormat(format)
            .setBufferSizeInBytes(bufferBytes)
            .setTransferMode(AudioTrack.MODE_STREAM)
            .build()
    }

    /** Resolved injection parameters, derived from [AudioBridgeContract]. */
    data class InjectionParams(
        val usage: Int = AudioBridgeContract.UPLINK_AUDIO_USAGE,
        val sampleRateHz: Int = AudioBridgeContract.SAMPLE_RATE_HZ,
        val channelMask: Int = AudioFormat.CHANNEL_OUT_MONO,
        val encoding: Int = AudioBridgeContract.ENCODING_PCM_16BIT,
        val bufferBytes: Int,
    )

    /** Actual TYPE_TELEPHONY output device, or null if none is exposed. */
    fun telephonyTxDevice(): AudioDeviceInfo? =
        audioManager.getDevices(AudioManager.GET_DEVICES_OUTPUTS)
            .firstOrNull { it.type == AudioBridgeContract.TYPE_TELEPHONY }

    /**
     * Build params for one frame.  AudioTrack buffer is at least platform
     * minimum and one production frame, so the bridge stays bounded.
     */
    fun paramsForFrameBuffer(frameBufferBytes: Int): InjectionParams {
        val minBytes = AudioTrack.getMinBufferSize(
            AudioBridgeContract.SAMPLE_RATE_HZ,
            AudioFormat.CHANNEL_OUT_MONO,
            AudioBridgeContract.ENCODING_PCM_16BIT,
        )
        require(minBytes > 0) { "No supported 16 kHz mono output profile ($minBytes)" }
        return InjectionParams(bufferBytes = maxOf(minBytes, frameBufferBytes))
    }

    /**
     * Open AudioTrack and explicitly request Telephony Tx routing.  Fails if
     * no actual TYPE_TELEPHONY output is exposed or setPreferredDevice rejects
     * the request.  Caller must still verify the actual routed device after
     * playback starts.
     */
    @android.annotation.SuppressLint("WrongConstant")
    fun open(params: InjectionParams): AudioTrack {
        val device = telephonyTxDevice()
            ?: error("No TYPE_TELEPHONY output device exposed")
        val attributes = AudioAttributes.Builder()
            .setUsage(params.usage)
            .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
            .build()
        val format = AudioFormat.Builder()
            .setEncoding(params.encoding)
            .setSampleRate(params.sampleRateHz)
            .setChannelMask(params.channelMask)
            .build()
        val track = trackFactory.create(attributes, format, params.bufferBytes)
        check(track.state == AudioTrack.STATE_INITIALIZED) {
            "AudioTrack initialization failed (state=${track.state})"
        }
        check(track.setPreferredDevice(device)) {
            "AudioTrack rejected TYPE_TELEPHONY preferred device"
        }
        return track
    }

    /**
     * Start playback after open.  Explicit start + state verification: the
     * track must be PLAYSTATE_PLAYING after the call, else the bridge fails
     * closed.
     */
    fun play(track: AudioTrack) {
        track.play()
        check(track.playState == AudioTrack.PLAYSTATE_PLAYING) {
            "AudioTrack not playing after play() (state=${track.playState})"
        }
    }

    /**
     * Write one complete frame.  The probe requires the write result to equal
     * the requested sample count; partial/negative writes fail closed.
     */
    fun writeFrame(track: AudioTrack, frame: ShortArray): Int {
        require(frame.size == AudioBridgeContract.SAMPLES_PER_FRAME) {
            "frame must be ${AudioBridgeContract.SAMPLES_PER_FRAME} samples, was ${frame.size}"
        }
        val written = track.write(frame, 0, frame.size, AudioTrack.WRITE_BLOCKING)
        check(written == frame.size) {
            "AudioTrack wrote $written/${frame.size} samples"
        }
        return written
    }

    /** Actual routed device type after playback has progressed. */
    fun routedDeviceType(track: AudioTrack): Int? = track.routedDevice?.type

    /** Proven playback-progress guard: head must advance above zero. */
    fun playbackHeadFrames(track: AudioTrack): Int = track.playbackHeadPosition

    /** Zeroize PCM frame after it has been written. */
    fun zeroize(frame: ShortArray) {
        frame.fill(0.toShort())
    }
}
