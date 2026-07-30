package com.callagent.gateway.audio

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Phase 1 — Pure JVM tests for [AudioBridgeController], the Android-free
 * lifecycle state machine for the bidirectional Telephony audio bridge.
 *
 * The controller owns ONLY decisions; the Android wrappers (TelephonyRxCapture,
 * TelephonyTxInjection) report facts (audio mode, granted permissions, routed
 * device type, playback head) and the controller decides start/verify/stop.
 * This separation keeps the entire safety logic unit-testable on the host JVM.
 *
 * Phase ordering enforced here (the parent review's core fix):
 *   - [start] checks ONLY active call + both permission sets.  It NEVER looks
 *     at route or playback head, because those are post-write facts that do
 *     not exist at start time.  Checking them pre-start made start impossible.
 *   - [verifyUplinkRoute] is called AFTER a real uplink write; an off-route or
 *     stalled (head == 0) uplink is PENDING (keep pumping) until a device is
 *     reported, and REFUSED only when a non-telephony device is reported.
 *   - start and stop are idempotent
 *   - stop zeroizes state
 *   - no file/network/root/mixer/call-control behavior is exposed
 */
class AudioBridgeControllerTest {

    private fun facts(
        activeCall: Boolean = true,
        downlinkPerms: Set<String> = AudioBridgeContract.DOWNLINK_REQUIRED_PERMISSIONS,
        uplinkPerms: Set<String> = AudioBridgeContract.UPLINK_REQUIRED_PERMISSIONS,
    ) = AudioBridgeController.Facts(
        activeCall = activeCall,
        grantedDownlinkPermissions = downlinkPerms,
        grantedUplinkPermissions = uplinkPerms,
    )

    private fun uplinkRouteOk() = AudioBridgeController.UplinkRouteFacts(
        uplinkRoutedDeviceType = AudioBridgeContract.TYPE_TELEPHONY,
        uplinkPlaybackHeadFrames = 1,
    )

    // --- prerequisites: start checks ONLY active call + permissions --------

    @Test
    fun startRefusedWithoutActiveCall() {
        val c = AudioBridgeController()
        val r = c.start(facts(activeCall = false))
        assertEquals(AudioBridgeController.Outcome.REFUSED_NO_ACTIVE_CALL, r)
        assertFalse(c.isRunning)
    }

    @Test
    fun startRefusedWithoutDownlinkPermissions() {
        val c = AudioBridgeController()
        val r = c.start(facts(downlinkPerms = emptySet()))
        assertEquals(AudioBridgeController.Outcome.REFUSED_DOWNLINK_PERMISSIONS, r)
        assertFalse(c.isRunning)
    }

    @Test
    fun startRefusedWithoutUplinkPermissions() {
        val c = AudioBridgeController()
        val r = c.start(facts(uplinkPerms = emptySet()))
        assertEquals(AudioBridgeController.Outcome.REFUSED_UPLINK_PERMISSIONS, r)
        assertFalse(c.isRunning)
    }

    @Test
    fun startRefusedWithPartialDownlinkPermissions() {
        val c = AudioBridgeController()
        // Only RECORD_AUDIO, missing CAPTURE_AUDIO_OUTPUT.
        val r = c.start(facts(downlinkPerms = setOf("android.permission.RECORD_AUDIO")))
        assertEquals(AudioBridgeController.Outcome.REFUSED_DOWNLINK_PERMISSIONS, r)
    }

    @Test
    fun startRefusedWithPartialUplinkPermissions() {
        val c = AudioBridgeController()
        // Only MODIFY_PHONE_STATE, missing MODIFY_AUDIO_ROUTING.
        val r = c.start(facts(uplinkPerms = setOf("android.permission.MODIFY_PHONE_STATE")))
        assertEquals(AudioBridgeController.Outcome.REFUSED_UPLINK_PERMISSIONS, r)
    }

    // --- happy path: start accepts with all prereqs, NO route needed -------

    @Test
    fun startAcceptedWhenAllPrerequisitesPass() {
        val c = AudioBridgeController()
        val r = c.start(facts())
        assertEquals(AudioBridgeController.Outcome.STARTED, r)
        assertTrue(c.isRunning)
    }

    @Test
    fun startDoesNotRequireRouteOrPlaybackHead() {
        // The core defect: start must succeed with zero route/head facts.
        // Route/head are post-write facts, never a start prerequisite.
        val c = AudioBridgeController()
        val r = c.start(facts())
        assertEquals(AudioBridgeController.Outcome.STARTED, r)
        assertTrue(c.isRunning)
    }

    // --- idempotency -------------------------------------------------------

    @Test
    fun startIsIdempotent() {
        val c = AudioBridgeController()
        assertEquals(AudioBridgeController.Outcome.STARTED, c.start(facts()))
        val r2 = c.start(facts())
        assertEquals(AudioBridgeController.Outcome.ALREADY_RUNNING, r2)
        assertTrue(c.isRunning)
    }

    @Test
    fun stopIsIdempotent() {
        val c = AudioBridgeController()
        c.start(facts())
        assertEquals(AudioBridgeController.Outcome.STOPPED, c.stop())
        assertEquals(AudioBridgeController.Outcome.ALREADY_STOPPED, c.stop())
        assertFalse(c.isRunning)
    }

    @Test
    fun stopWhenNeverStartedIsAlreadyStopped() {
        val c = AudioBridgeController()
        assertEquals(AudioBridgeController.Outcome.ALREADY_STOPPED, c.stop())
        assertFalse(c.isRunning)
    }

    // --- uplink route verification: POST-WRITE, not pre-start --------------

    @Test
    fun verifyUplinkRoutePendingWhenHeadZero() {
        // After a real write the playback head may not have advanced yet.
        // That is PENDING, not fatal — the bridge keeps pumping and re-verifies.
        val c = AudioBridgeController()
        c.start(facts())
        val r = c.verifyUplinkRoute(
            AudioBridgeController.UplinkRouteFacts(
                uplinkRoutedDeviceType = AudioBridgeContract.TYPE_TELEPHONY,
                uplinkPlaybackHeadFrames = 0,
            ),
        )
        assertEquals(AudioBridgeController.Outcome.UPLINK_ROUTE_PENDING, r)
        assertTrue(c.isRunning)
    }

    @Test
    fun verifyUplinkRoutePendingWhenDeviceNull() {
        val c = AudioBridgeController()
        c.start(facts())
        val r = c.verifyUplinkRoute(
            AudioBridgeController.UplinkRouteFacts(
                uplinkRoutedDeviceType = null,
                uplinkPlaybackHeadFrames = 1,
            ),
        )
        assertEquals(AudioBridgeController.Outcome.UPLINK_ROUTE_PENDING, r)
        assertTrue(c.isRunning)
    }

    @Test
    fun verifyUplinkRouteConfirmedWhenTelephonyAndHeadAdvanced() {
        val c = AudioBridgeController()
        c.start(facts())
        val r = c.verifyUplinkRoute(uplinkRouteOk())
        assertEquals(AudioBridgeController.Outcome.ALREADY_RUNNING, r)
        assertTrue(c.isRunning)
    }

    @Test
    fun verifyUplinkRouteRefusedWhenNotTelephonyAbortsBridge() {
        // A real write landed but routed to a non-telephony device: abort.
        val c = AudioBridgeController()
        c.start(facts())
        val r = c.verifyUplinkRoute(
            AudioBridgeController.UplinkRouteFacts(
                uplinkRoutedDeviceType = 0, // not TYPE_TELEPHONY
                uplinkPlaybackHeadFrames = 1,
            ),
        )
        assertEquals(AudioBridgeController.Outcome.REFUSED_UPLINK_ROUTE, r)
        assertFalse(c.isRunning)
    }

    @Test
    fun verifyUplinkRouteAfterStopIsAlreadyStopped() {
        val c = AudioBridgeController()
        c.start(facts())
        c.stop()
        assertEquals(
            AudioBridgeController.Outcome.ALREADY_STOPPED,
            c.verifyUplinkRoute(uplinkRouteOk()),
        )
    }

    // --- zeroization -------------------------------------------------------

    @Test
    fun stopZeroizesState() {
        val c = AudioBridgeController()
        c.start(facts())
        c.stop()
        assertTrue("controller must report zeroized after stop", c.isZeroized)
    }

    @Test
    fun startAfterStopReArmsCleanly() {
        val c = AudioBridgeController()
        c.start(facts())
        c.stop()
        assertTrue(c.isZeroized)
        // Re-arm: start again from a zeroized controller must succeed.
        assertEquals(AudioBridgeController.Outcome.STARTED, c.start(facts()))
        assertTrue(c.isRunning)
        assertFalse(c.isZeroized)
    }

    // --- forbidden behavior ------------------------------------------------

    @Test
    fun controllerExposesNoFileNetworkRootOrMixerSurface() {
        val forbidden = listOf(
            "writeFile", "openFile", "recordToFile", "socket", "exec", "shell",
            "setMixer", "writeMixer", "tinymix", "dial", "placeCall",
        )
        val publicMethods = AudioBridgeController::class.java.methods.map { it.name }
        forbidden.forEach { name ->
            assertFalse(
                "controller must not expose '$name'",
                publicMethods.contains(name),
            )
        }
    }
}
