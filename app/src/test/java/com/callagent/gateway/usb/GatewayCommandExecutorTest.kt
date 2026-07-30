package com.callagent.gateway.usb

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class GatewayCommandExecutorTest {
    private class RecordingExecutor : GatewayCommandExecutor {
        val commands = mutableListOf<GatewayCommand>()
        override fun execute(command: GatewayCommand): CommandExecutionResult {
            commands += command
            return CommandExecutionResult.Accepted(command.name)
        }
    }

    @Test
    fun `typed mutations are delivered to injected telecom boundary`() {
        val executor = RecordingExecutor()
        val commands = listOf(
            GatewayCommand.Dial("dial-1", "+155****0100"),
            GatewayCommand.Answer("answer-1", "call-1"),
            GatewayCommand.Reject("reject-1", "call-1"),
            GatewayCommand.Hangup("hangup-1", "call-1"),
            GatewayCommand.SendDtmf("dtmf-1", "call-1", "12#"),
        )
        commands.forEach { assertTrue(executor.execute(it) is CommandExecutionResult.Accepted) }
        assertEquals(commands, executor.commands)
    }

    @Test
    fun `status and capabilities preserve typed values`() {
        val status = CommandExecutionResult.Status(GatewayRuntimeSnapshot.stopped())
        val capabilities = CommandExecutionResult.Capabilities(setOf("usb_loopback"))
        assertEquals(false, status.snapshot.listenerRunning)
        assertEquals(setOf("usb_loopback"), capabilities.values)
    }
}
