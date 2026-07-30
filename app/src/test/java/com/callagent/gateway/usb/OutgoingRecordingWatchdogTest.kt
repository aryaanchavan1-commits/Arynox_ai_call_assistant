package com.callagent.gateway.usb

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class OutgoingRecordingWatchdogTest {
    private class FakeScheduled : OutgoingRecordingWatchdog.Scheduled {
        var cancelled = false
        override fun cancel() { cancelled = true }
    }

    private class FakeScheduler : OutgoingRecordingWatchdog.Scheduler {
        var task: (() -> Unit)? = null
        var delayMs: Long? = null
        var scheduled: FakeScheduled? = null
        override fun schedule(delayMs: Long, task: () -> Unit): OutgoingRecordingWatchdog.Scheduled {
            this.delayMs = delayMs
            this.task = task
            return FakeScheduled().also { scheduled = it }
        }
        fun fire() { task?.invoke() }
    }

    @Test
    fun `only an authenticated gateway dial can arm an outgoing call watchdog`() {
        val scheduler = FakeScheduler()
        var hungUp: String? = null
        val watchdog = OutgoingRecordingWatchdog(scheduler, timeoutMs = 15_000) { hungUp = it }

        assertFalse(watchdog.onOutgoingCall("manual-call"))
        scheduler.fire()
        assertEquals(null, hungUp)

        watchdog.onGatewayDialAccepted()
        assertTrue(watchdog.onOutgoingCall("gateway-call"))
        assertEquals(15_000L, scheduler.delayMs)
        scheduler.fire()
        assertEquals("gateway-call", hungUp)
    }

    @Test
    fun `matching recording acknowledgement cancels timeout while foreign acknowledgement does not`() {
        val scheduler = FakeScheduler()
        val hungUp = mutableListOf<String>()
        val watchdog = OutgoingRecordingWatchdog(scheduler, timeoutMs = 15_000) { hungUp += it }

        watchdog.onGatewayDialAccepted()
        assertTrue(watchdog.onOutgoingCall("call-1"))
        watchdog.onRecordingSession("foreign", active = true)
        assertFalse(scheduler.scheduled!!.cancelled)
        watchdog.onRecordingSession("call-1", active = true)
        assertTrue(scheduler.scheduled!!.cancelled)
        scheduler.fire()
        assertTrue(hungUp.isEmpty())
    }

    @Test
    fun `call end and gateway disconnect clear pending ownership and timeout`() {
        val scheduler = FakeScheduler()
        val hungUp = mutableListOf<String>()
        val watchdog = OutgoingRecordingWatchdog(scheduler, timeoutMs = 15_000) { hungUp += it }

        watchdog.onGatewayDialAccepted()
        watchdog.onGatewayDisconnected()
        assertFalse(watchdog.onOutgoingCall("stale-call"))

        watchdog.onGatewayDialAccepted()
        assertTrue(watchdog.onOutgoingCall("call-2"))
        watchdog.onCallEnded("call-2")
        assertTrue(scheduler.scheduled!!.cancelled)
        scheduler.fire()
        assertTrue(hungUp.isEmpty())
    }

    @Test
    fun `duplicate outgoing events cannot replace the owned call`() {
        val scheduler = FakeScheduler()
        val hungUp = mutableListOf<String>()
        val watchdog = OutgoingRecordingWatchdog(scheduler, timeoutMs = 15_000) { hungUp += it }

        watchdog.onGatewayDialAccepted()
        assertTrue(watchdog.onOutgoingCall("call-1"))
        assertFalse(watchdog.onOutgoingCall("call-2"))
        scheduler.fire()
        assertEquals(listOf("call-1"), hungUp)
    }

    @Test
    fun `accepted dial without generated call id expires bounded ownership`() {
        val scheduler = FakeScheduler()
        val hungUp = mutableListOf<String>()
        var pendingExpired = 0
        val watchdog = OutgoingRecordingWatchdog(
            scheduler,
            timeoutMs = 15_000,
            hangup = { hungUp += it },
            pendingExpired = { pendingExpired++ },
        )

        watchdog.onGatewayDialAccepted()
        assertEquals(15_000L, scheduler.delayMs)
        scheduler.fire()

        assertTrue(hungUp.isEmpty())
        assertEquals(1, pendingExpired)
        assertFalse(watchdog.onOutgoingCall("late-call"))
    }

    @Test
    fun `telecom refusal clears prearmed ownership`() {
        val scheduler = FakeScheduler()
        val hungUp = mutableListOf<String>()
        val watchdog = OutgoingRecordingWatchdog(scheduler, timeoutMs = 15_000) { hungUp += it }

        watchdog.onGatewayDialAccepted()
        watchdog.onGatewayDialRejected()
        scheduler.fire()

        assertFalse(watchdog.onOutgoingCall("unrelated-call"))
        assertTrue(hungUp.isEmpty())
    }

    @Test
    fun `second dial cannot replace pending or owned authorization`() {
        val scheduler = FakeScheduler()
        val watchdog = OutgoingRecordingWatchdog(scheduler, timeoutMs = 15_000) { }
        assertTrue(watchdog.onGatewayDialStarting())
        assertFalse(watchdog.onGatewayDialStarting())
        assertTrue(watchdog.onOutgoingCall("call-1"))
        assertFalse(watchdog.onGatewayDialStarting())
    }

    @Test
    fun `recording session false clears owned timeout after fail closed teardown`() {
        val scheduler = FakeScheduler()
        val hungUp = mutableListOf<String>()
        val watchdog = OutgoingRecordingWatchdog(scheduler, timeoutMs = 15_000) { hungUp += it }
        assertTrue(watchdog.onGatewayDialStarting())
        assertTrue(watchdog.onOutgoingCall("call-1"))
        watchdog.onRecordingSession("call-1", active = false)
        scheduler.fire()
        assertTrue(hungUp.isEmpty())
    }
}
