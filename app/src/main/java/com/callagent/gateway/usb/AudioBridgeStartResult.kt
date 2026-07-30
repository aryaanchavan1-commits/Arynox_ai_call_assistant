package com.callagent.gateway.usb

import com.callagent.gateway.audio.AudioBridgeController

/** Converts a bridge start outcome into current, coordinator-owned media truth. */
object AudioBridgeStartResult {
    fun isActive(
        outcome: AudioBridgeController.Outcome,
        coordinatorRunning: Boolean,
    ): Boolean = coordinatorRunning && outcome in setOf(
        AudioBridgeController.Outcome.STARTED,
        AudioBridgeController.Outcome.ALREADY_RUNNING,
    )
}
