package com.callagent.gateway.usb

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class PhoneDataSyncProtocolTest {
    @Test
    fun `sync commands require exact opaque request ids and are non-mutating`() {
        val contacts = CommandParser.parse("""{"command":"sync_contacts","requestId":"contacts-1"}""".toByteArray())
        val calls = CommandParser.parse("""{"command":"sync_call_log","requestId":"calls_1"}""".toByteArray())
        assertEquals(GatewayCommand.SyncContacts("contacts-1"), contacts)
        assertEquals(GatewayCommand.SyncCallLog("calls_1"), calls)
        assertFalse(contacts.isMutation)
        for (json in listOf(
            """{"command":"sync_contacts"}""",
            """{"command":"sync_contacts","requestId":"../escape"}""",
            """{"command":"sync_call_log","requestId":"x","extra":true}""",
            """{"command":"sync_call_log","requestId":"${"x".repeat(129)}"}""",
        )) assertThrows(CommandProtocolException::class.java) { CommandParser.parse(json.toByteArray()) }
    }

    @Test
    fun `contact encoder emits bounded ordered pages with strict escaping`() {
        val rows = (0 until 101).map { index ->
            PhoneContactRow(index.toLong(), if (index == 0) "A\"da\\One" else "Name $index", "+1000000${index.toString().padStart(4, '0')}")
        }
        val pages = PhoneDataSnapshotEncoder.contacts("request-1", rows)
        assertEquals(11, pages.size)
        assertTrue(pages[0].contains("\"event\":\"contacts_snapshot_v1\""))
        assertTrue(pages[0].contains("\"page\":0,\"final\":false"))
        assertTrue(pages.last().contains("\"page\":10,\"final\":true"))
        assertTrue(pages[0].contains("A\\\"da\\\\One"))
        assertTrue(pages.all { it.toByteArray().size <= FrameCodec.MAX_PAYLOAD_SIZE })
    }

    @Test
    fun `empty call-log snapshot emits one final page and rows are capped`() {
        val empty = PhoneDataSnapshotEncoder.callLog("request-2", emptyList())
        assertEquals(1, empty.size)
        assertTrue(empty.single().contains("\"page\":0,\"final\":true,\"rows\":[]"))
        val over = (0 until 201).map { index ->
            PhoneCallLogRow(index.toLong(), "+10000000000", null, "incoming", 1_721_664_000_000, 42)
        }
        assertThrows(IllegalArgumentException::class.java) { PhoneDataSnapshotEncoder.callLog("request-2", over) }
    }

    @Test
    fun `executor advertises and routes phone-data sync without telecom mutation`() {
        val commands = mutableListOf<GatewayCommand>()
        val executor = CorrelatedTelecomExecutor(
            telecom = object : TelecomPort {
                override fun dial(destination: String) = false
                override fun answer() = false
                override fun reject() = false
                override fun hangup() = false
                override fun sendDtmf(digits: String) = false
            },
            activeCallId = ActiveCallId { null },
            snapshot = { GatewayRuntimeSnapshot(true, true, null, true) },
            phoneDataSync = PhoneDataSyncPort { command -> commands += command; true },
        )
        assertTrue(executor.execute(GatewayCommand.SyncContacts("contacts-1")) is CommandExecutionResult.Accepted)
        assertTrue(executor.execute(GatewayCommand.SyncCallLog("calls-1")) is CommandExecutionResult.Accepted)
        assertEquals(listOf(GatewayCommand.SyncContacts("contacts-1"), GatewayCommand.SyncCallLog("calls-1")), commands)
        val capabilities = executor.execute(GatewayCommand.Capabilities("")) as CommandExecutionResult.Capabilities
        assertTrue(capabilities.values.containsAll(setOf("contacts_sync_v1", "call_log_sync_v1")))
    }
}
