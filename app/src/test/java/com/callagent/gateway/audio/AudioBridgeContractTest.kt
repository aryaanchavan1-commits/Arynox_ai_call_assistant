package com.callagent.gateway.audio

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Phase 1 — AudioBridge extraction lane.  Pure JVM tests for the immutable
 * [AudioBridgeContract].  These run on the host JVM (no Android), so the
 * contract must hold only literal/derived constants — no android.* imports.
 *
 * Proven evidence carried over from the qualification probes:
 *   - Downlink (Rx): VOICE_DOWNLINK source, 16 kHz mono PCM16, requires an
 *     actual TYPE_TELEPHONY routed device, RECORD_AUDIO + CAPTURE_AUDIO_OUTPUT.
 *   - Uplink (Tx): USAGE_MEDIA attributes explicitly routed to Telephony Tx,
 *     requires an actual TYPE_TELEPHONY routed device + a positive playback
 *     head, MODIFY_AUDIO_ROUTING + MODIFY_PHONE_STATE.
 *   - Production contract: 20 ms frames == 320 samples at 16 kHz mono PCM16.
 *   - No file recording by default.
 *
 * RED first, GREEN after impl.
 */
class AudioBridgeContractTest {

    @Test
    fun downlinkUsesVoiceDownlinkSource() {
        // MediaRecorder.AudioSource.VOICE_DOWNLINK == 3 (proven in downlinkProbe).
        assertEquals(3, AudioBridgeContract.DOWNLINK_AUDIO_SOURCE)
    }

    @Test
    fun downlinkIs16kHzMonoPcm16() {
        assertEquals(16_000, AudioBridgeContract.SAMPLE_RATE_HZ)
        assertEquals(1, AudioBridgeContract.CHANNEL_COUNT)
        // AudioFormat.ENCODING_PCM_16BIT == 2.
        assertEquals(2, AudioBridgeContract.ENCODING_PCM_16BIT)
    }

    @Test
    fun frameIs20MillisecondsAt16kMono() {
        // 20 ms * 16000 Hz / 1000 == 320 samples per frame (production contract).
        assertEquals(320, AudioBridgeContract.SAMPLES_PER_FRAME)
        // 320 samples * 2 bytes (PCM16) * 1 channel == 640 bytes.
        assertEquals(640, AudioBridgeContract.BYTES_PER_FRAME)
    }

    @Test
    fun telephonyRouteTypeIsConstant() {
        // AudioDeviceInfo.TYPE_TELEPHONY == 18 (proven in both probes' guards).
        assertEquals(18, AudioBridgeContract.TYPE_TELEPHONY)
    }

    @Test
    fun uplinkUsesMediaUsageRoutedToTelephonyTx() {
        // AudioAttributes.USAGE_MEDIA == 1 (proven in uplinkProbe plan).
        assertEquals(1, AudioBridgeContract.UPLINK_AUDIO_USAGE)
    }

    @Test
    fun downlinkRequiresCaptureAndRecordPermissions() {
        assertTrue(
            "downlink needs RECORD_AUDIO",
            AudioBridgeContract.DOWNLINK_REQUIRED_PERMISSIONS
                .contains("android.permission.RECORD_AUDIO"),
        )
        assertTrue(
            "downlink needs CAPTURE_AUDIO_OUTPUT",
            AudioBridgeContract.DOWNLINK_REQUIRED_PERMISSIONS
                .contains("android.permission.CAPTURE_AUDIO_OUTPUT"),
        )
        assertEquals(2, AudioBridgeContract.DOWNLINK_REQUIRED_PERMISSIONS.size)
    }

    @Test
    fun uplinkRequiresRoutingAndPhoneStatePermissions() {
        assertTrue(
            "uplink needs MODIFY_AUDIO_ROUTING",
            AudioBridgeContract.UPLINK_REQUIRED_PERMISSIONS
                .contains("android.permission.MODIFY_AUDIO_ROUTING"),
        )
        assertTrue(
            "uplink needs MODIFY_PHONE_STATE",
            AudioBridgeContract.UPLINK_REQUIRED_PERMISSIONS
                .contains("android.permission.MODIFY_PHONE_STATE"),
        )
        assertEquals(2, AudioBridgeContract.UPLINK_REQUIRED_PERMISSIONS.size)
    }

    @Test
    fun contractDoesNotAdvertiseFileRecording() {
        // No file recording by default.  The contract exposes no file path or
        // writer; it only carries the live PCM frame dimensions.
        assertFalse(AudioBridgeContract.FILE_RECORDING_ENABLED)
    }

    @Test
    fun frameDurationIs20Milliseconds() {
        assertEquals(20, AudioBridgeContract.FRAME_DURATION_MS)
    }
}
