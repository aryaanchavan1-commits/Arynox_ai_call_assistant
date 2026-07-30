package com.callagent.gateway.audio

/**
 * Immutable, Android-free contract for the Phase 1 Telephony audio bridge.
 *
 * Every value here is a literal proven by the qualification probes (uplinkProbe
 * and downlinkProbe) and is unit-tested by [AudioBridgeContractTest].  Nothing
 * in this file may import android.* — it must stay pure JVM so the safety
 * constants are verifiable on the host without a device.
 *
 * Proven evidence:
 *   - Downlink (Rx) capture: VOICE_DOWNLINK source, 16 kHz mono PCM16, the
 *     capture only counts if AudioRecord.routedDevice is TYPE_TELEPHONY.
 *   - Uplink (Tx) injection: USAGE_MEDIA attributes explicitly routed to the
 *     Telephony Tx output device; the injection only counts if the playback
 *     head advanced AND routedDevice is TYPE_TELEPHONY.
 *   - Production contract: 20 ms frames == 320 samples at 16 kHz mono PCM16.
 *   - No file recording by default.
 */
object AudioBridgeContract {

    /** MediaRecorder.AudioSource.VOICE_DOWNLINK.  Proven in downlinkProbe. */
    const val DOWNLINK_AUDIO_SOURCE: Int = 3

    /** AudioAttributes.USAGE_MEDIA.  Proven in uplinkProbe (explicitly routed to Telephony Tx). */
    const val UPLINK_AUDIO_USAGE: Int = 1

    /** AudioFormat.ENCODING_PCM_16BIT. */
    const val ENCODING_PCM_16BIT: Int = 2

    /** AudioDeviceInfo.TYPE_TELEPHONY.  Proven in both probes' route guards. */
    const val TYPE_TELEPHONY: Int = 18

    /** Production sample rate (Hz).  Downlink is 16 kHz mono. */
    const val SAMPLE_RATE_HZ: Int = 16_000

    /** Production channel count.  Downlink is mono. */
    const val CHANNEL_COUNT: Int = 1

    /** Production frame duration (ms).  20 ms frames. */
    const val FRAME_DURATION_MS: Int = 20

    /** Samples per 20 ms frame at 16 kHz: 16000 * 20 / 1000 == 320. */
    val SAMPLES_PER_FRAME: Int = SAMPLE_RATE_HZ * FRAME_DURATION_MS / 1_000

    /** Bytes per 20 ms frame: 320 samples * 2 bytes * 1 channel == 640. */
    val BYTES_PER_FRAME: Int = SAMPLES_PER_FRAME * 2 * CHANNEL_COUNT

    /**
     * Permissions required for downlink (Rx) capture.  Proven in downlinkProbe.
     * RECORD_AUDIO + CAPTURE_AUDIO_OUTPUT.
     */
    val DOWNLINK_REQUIRED_PERMISSIONS: Set<String> = setOf(
        "android.permission.RECORD_AUDIO",
        "android.permission.CAPTURE_AUDIO_OUTPUT",
    )

    /**
     * Permissions required for uplink (Tx) injection.  Proven in uplinkProbe
     * (ProbePrivilege).  MODIFY_AUDIO_ROUTING + MODIFY_PHONE_STATE.
     */
    val UPLINK_REQUIRED_PERMISSIONS: Set<String> = setOf(
        "android.permission.MODIFY_AUDIO_ROUTING",
        "android.permission.MODIFY_PHONE_STATE",
    )

    /** No file recording by default.  Live PCM frames only. */
    const val FILE_RECORDING_ENABLED: Boolean = false
}
