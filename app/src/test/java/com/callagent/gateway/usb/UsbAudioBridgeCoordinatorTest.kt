package com.callagent.gateway.usb

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class UsbAudioBridgeCoordinatorTest {
    private class FakeBridge : UsbAudioBridgeControl {
        var starts = 0
        var stops = 0
        var queuedAudioDiscards = 0
        var running = false
        override fun start(): Boolean { starts++; running = true; return true }
        override fun stop() { stops++; running = false }
        override fun discardQueuedAudio() { queuedAudioDiscards++ }
    }

    @Test
    fun `starts only for matching active call with desktop recorder and consented session`() {
        val bridge = FakeBridge()
        val coordinator = UsbAudioBridgeCoordinator(bridge, deviceQualified = true)
        coordinator.onDesktopConnected(true)
        coordinator.onRecordingHealthy(true)
        coordinator.onRecordingSession("call-1", true)
        coordinator.onCall("call-2", active = true)
        assertFalse(bridge.running)
        coordinator.onCall("call-1", active = true)
        assertTrue(bridge.running)
        assertEquals(1, bridge.starts)
    }

    @Test
    fun `every safety loss stops and requires a fresh complete gate`() {
        val bridge = FakeBridge()
        val coordinator = UsbAudioBridgeCoordinator(bridge, deviceQualified = true)
        coordinator.onDesktopConnected(true)
        coordinator.onRecordingHealthy(true)
        coordinator.onRecordingSession("call-1", true)
        coordinator.onCall("call-1", active = true)
        coordinator.onDesktopConnected(false)
        assertFalse(bridge.running)
        assertEquals(1, bridge.stops)
        coordinator.onDesktopConnected(true)
        assertTrue(bridge.running)
        coordinator.onRecordingSession("call-1", false)
        assertFalse(bridge.running)
        assertEquals(2, bridge.stops)
    }

    @Test
    fun `unsupported device never starts privileged audio`() {
        val bridge = FakeBridge()
        val coordinator = UsbAudioBridgeCoordinator(bridge, deviceQualified = false)
        coordinator.onDesktopConnected(true)
        coordinator.onRecordingHealthy(true)
        coordinator.onRecordingSession("call-1", true)
        coordinator.onCall("call-1", active = true)
        assertFalse(bridge.running)
        assertFalse(coordinator.running)
        assertEquals(0, bridge.starts)
    }

    @Test
    fun `runtime qualification loss stops privileged audio without another gate transition`() {
        val bridge = FakeBridge()
        var qualified = true
        val coordinator = UsbAudioBridgeCoordinator(bridge, deviceQualified = { qualified })
        coordinator.onDesktopConnected(true)
        coordinator.onRecordingHealthy(true)
        coordinator.onRecordingSession("call-1", true)
        coordinator.onCall("call-1", true)
        assertEquals(1, bridge.starts)

        qualified = false
        coordinator.revalidateDeviceQualification()
        assertEquals(1, bridge.stops)
        assertFalse(coordinator.running)
    }

    @Test
    fun `failed bridge start remains fail closed`() {
        val bridge = object : UsbAudioBridgeControl {
            override fun start(): Boolean = false
            override fun stop() = Unit
        }
        val coordinator = UsbAudioBridgeCoordinator(bridge, deviceQualified = true)
        coordinator.onDesktopConnected(true)
        coordinator.onRecordingHealthy(true)
        coordinator.onRecordingSession("call-1", true)
        coordinator.onCall("call-1", active = true)
        assertFalse(coordinator.running)
    }

    @Test
    fun `reentrant worker failure during start cannot be overwritten as running`() {
        lateinit var coordinator: UsbAudioBridgeCoordinator
        var reported: AudioBridgeFailure? = null
        val bridge = object : UsbAudioBridgeControl {
            override fun start(): Boolean {
                reported = coordinator.onBridgeFailed()
                return true
            }
            override fun stop() = Unit
        }
        coordinator = UsbAudioBridgeCoordinator(bridge, deviceQualified = true)
        coordinator.onDesktopConnected(true)
        coordinator.onRecordingHealthy(true)
        coordinator.onRecordingSession("call-race", true)
        coordinator.onCall("call-race", active = true)

        assertEquals(AudioBridgeFailure("call-race"), reported)
        assertFalse(coordinator.running)
    }

    @Test
    fun `worker failure reports active call and requires fresh recorder authorization`() {
        val bridge = FakeBridge()
        val coordinator = UsbAudioBridgeCoordinator(bridge, deviceQualified = true)
        coordinator.onDesktopConnected(true)
        coordinator.onRecordingHealthy(true)
        coordinator.onRecordingSession("call-1", true)
        coordinator.onCall("call-1", active = true)
        assertTrue(coordinator.running)

        assertEquals(
            AudioBridgeFailure(callId = "call-1", reason = "audio_bridge_failed"),
            coordinator.onBridgeFailed(),
        )
        assertFalse(coordinator.running)
        assertEquals(0, bridge.stops)
        assertEquals(1, bridge.queuedAudioDiscards)
        assertEquals(null, coordinator.onBridgeFailed())
        assertEquals(1, bridge.queuedAudioDiscards)

        coordinator.onCall("call-1", active = true)
        coordinator.onDesktopConnected(true)
        assertFalse("stale gates must not restart privileged audio", coordinator.running)
        assertEquals(1, bridge.starts)

        coordinator.onRecordingHealthy(true)
        coordinator.onRecordingSession("call-1", true)
        assertTrue(coordinator.running)
        assertEquals(2, bridge.starts)
    }

    @Test
    fun `explicit stop discards queued audio even when bridge stop throws`() {
        var discards = 0
        val bridge = object : UsbAudioBridgeControl {
            override fun start(): Boolean = true
            override fun stop(): Unit = throw IllegalStateException("stop failed")
            override fun discardQueuedAudio() { discards++ }
        }
        val coordinator = UsbAudioBridgeCoordinator(bridge, deviceQualified = true)
        coordinator.onDesktopConnected(true)
        coordinator.onRecordingHealthy(true)
        coordinator.onRecordingSession("call-stop", true)
        coordinator.onCall("call-stop", active = true)

        assertThrows(IllegalStateException::class.java) { coordinator.stop() }
        assertEquals(2, discards)
        assertFalse(coordinator.running)
    }

    @Test
    fun `safety stop discards queued audio before and after stopping transmission`() {
        val events = mutableListOf<String>()
        val bridge = object : UsbAudioBridgeControl {
            override fun start(): Boolean = true
            override fun stop() { events += "stop" }
            override fun discardQueuedAudio() { events += "discard" }
        }
        val coordinator = UsbAudioBridgeCoordinator(bridge, deviceQualified = true)
        coordinator.onDesktopConnected(true)
        coordinator.onRecordingHealthy(true)
        coordinator.onRecordingSession("call-stop", true)
        coordinator.onCall("call-stop", active = true)

        coordinator.onDesktopConnected(false)
        assertEquals(listOf("discard", "stop", "discard"), events)
    }
}
