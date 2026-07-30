package com.callagent.gateway.usb

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class CorrelatedTelecomExecutorTest {
    private class FakeTelecom(var dialAccepted: Boolean = true) : TelecomPort {
        val actions = mutableListOf<String>()
        override fun dial(destination: String) = dialAccepted.also { actions += "dial:$destination" }
        override fun answer() = true.also { actions += "answer" }
        override fun reject() = true.also { actions += "reject" }
        override fun hangup() = true.also { actions += "hangup" }
        override fun sendDtmf(digits: String) = true.also { actions += "dtmf:$digits" }
    }

    private fun executor(
        port: FakeTelecom,
        id: String? = "call-1",
        recordingHealthy: Boolean = true,
    ) = CorrelatedTelecomExecutor(
        telecom = port,
        activeCallId = ActiveCallId { id },
        snapshot = {
            GatewayRuntimeSnapshot(
                listenerRunning = true,
                desktopConnected = true,
                activeCallId = id,
                recordingHealthy = recordingHealthy,
            )
        },
    )

    @Test
    fun `recording session acknowledgement updates only bounded lifecycle state`() {
        val changes = mutableListOf<Pair<String, Boolean>>()
        val executor = CorrelatedTelecomExecutor(
            telecom = FakeTelecom(),
            activeCallId = ActiveCallId { "call-1" },
            snapshot = { GatewayRuntimeSnapshot(true, true, "call-1", true) },
            recordingSessionChanged = { callId, active -> changes += callId to active },
        )
        assertTrue(executor.execute(GatewayCommand.RecordingSession("call-1", true)) is CommandExecutionResult.Accepted)
        assertEquals(listOf("call-1" to true), changes)
    }

    @Test
    fun `wrong call id cannot affect active call`() {
        val port = FakeTelecom()
        val result = executor(port).execute(GatewayCommand.Hangup("key", "stale-call"))
        assertTrue(result is CommandExecutionResult.Rejected)
        assertEquals(emptyList<String>(), port.actions)
    }

    @Test
    fun `matching call id routes answer reject hangup and dtmf`() {
        val port = FakeTelecom()
        val executor = executor(port)
        executor.execute(GatewayCommand.Answer("a", "call-1"))
        executor.execute(GatewayCommand.Reject("r", "call-1"))
        executor.execute(GatewayCommand.Hangup("h", "call-1"))
        executor.execute(GatewayCommand.SendDtmf("d", "call-1", "12#"))
        assertEquals(listOf("answer", "reject", "hangup", "dtmf:12#"), port.actions)
    }

    @Test
    fun `recording failure blocks dial answer and dtmf but permits reject and hangup`() {
        val port = FakeTelecom()
        val executor = executor(port, recordingHealthy = false)
        assertTrue(executor.execute(GatewayCommand.Dial("d", "+155****0100")) is CommandExecutionResult.Rejected)
        assertTrue(executor.execute(GatewayCommand.Answer("a", "call-1")) is CommandExecutionResult.Rejected)
        assertTrue(executor.execute(GatewayCommand.SendDtmf("t", "call-1", "1")) is CommandExecutionResult.Rejected)
        assertTrue(executor.execute(GatewayCommand.Reject("r", "call-1")) is CommandExecutionResult.Accepted)
        assertTrue(executor.execute(GatewayCommand.Hangup("h", "call-1")) is CommandExecutionResult.Accepted)
        assertEquals(listOf("reject", "hangup"), port.actions)
    }

    @Test
    fun `dial is explicit and independent of active call correlation`() {
        val port = FakeTelecom()
        val result = executor(port, null).execute(GatewayCommand.Dial("key", "+15555550100"))
        assertTrue(result is CommandExecutionResult.Accepted)
        assertEquals(listOf("dial:+15555550100"), port.actions)
    }

    @Test
    fun `outgoing recording watchdog prearms before telecom and clears refusal`() {
        val lifecycle = mutableListOf<String>()
        val accepted = CorrelatedTelecomExecutor(
            telecom = FakeTelecom(dialAccepted = true),
            activeCallId = ActiveCallId { null },
            snapshot = { GatewayRuntimeSnapshot(true, true, null, true) },
            gatewayDialStarting = { lifecycle += "start"; true },
            gatewayDialRejected = { lifecycle += "reject" },
        )
        assertTrue(accepted.execute(GatewayCommand.Dial("accepted", "+15555550100")) is CommandExecutionResult.Accepted)
        assertEquals(listOf("start"), lifecycle)

        val refused = CorrelatedTelecomExecutor(
            telecom = FakeTelecom(dialAccepted = false),
            activeCallId = ActiveCallId { null },
            snapshot = { GatewayRuntimeSnapshot(true, true, null, true) },
            gatewayDialStarting = { lifecycle += "start"; true },
            gatewayDialRejected = { lifecycle += "reject" },
        )
        assertTrue(refused.execute(GatewayCommand.Dial("refused", "+15555550100")) is CommandExecutionResult.Rejected)
        assertEquals(listOf("start", "start", "reject"), lifecycle)
    }
}
