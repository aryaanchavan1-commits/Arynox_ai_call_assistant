package com.callagent.gateway.usb

/**
 * PCM media contract for the USB audio gateway lane.
 *
 * Mono PCM16LE at 16 kHz, framed at 20 ms. Every PCM [Frame] payload must be
 * exactly [BYTES_PER_FRAME] bytes so the downstream capture/playback loops can
 * treat a frame as one audio quantum without length negotiation.
 *
 * ponytail: plain constants — no sample-rate negotiation, the device side is
 * fixed at this rate; add a renegotiation path only if a second device profile
 * ever needs a different rate.
 */
object PcmContract {
    const val SAMPLE_RATE_HZ: Int = 16_000
    const val CHANNELS: Int = 1
    const val BITS_PER_SAMPLE: Int = 16
    const val FRAME_DURATION_MS: Int = 20

    const val SAMPLES_PER_FRAME: Int = SAMPLE_RATE_HZ * FRAME_DURATION_MS / 1_000 // 320
    const val BYTES_PER_FRAME: Int =
        SAMPLES_PER_FRAME * (BITS_PER_SAMPLE / 8) * CHANNELS // 640
}
