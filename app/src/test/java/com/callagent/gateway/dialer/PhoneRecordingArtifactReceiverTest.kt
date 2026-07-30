package com.callagent.gateway.dialer

import com.callagent.gateway.usb.GatewayCommand
import java.io.File
import java.nio.file.Files
import java.security.MessageDigest
import org.junit.After
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class PhoneRecordingArtifactReceiverTest {
    private lateinit var root: File

    @Before fun setUp() { root = Files.createTempDirectory("phone-artifact-receiver").toFile() }
    @After fun tearDown() { root.deleteRecursively() }

    @Test fun `publication failure cleans verified staging and emits failure without dropping protocol`() {
        val bytes = byteArrayOf(1, 2, 3)
        val sha = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
        val receipts = mutableListOf<String>()
        val store = PhoneRecordingStore(root)
        val receiver = PhoneRecordingArtifactReceiver(
            store = store,
            publish = { throw IllegalStateException("fixture failure") },
            isCallIdle = { true },
            emitReceipt = receipts::add,
        )

        assertTrue(receiver.begin(GatewayCommand.RecordingArtifactBegin("call-1", "conversation.wav", 3, sha, 20)))
        assertTrue(receiver.append(bytes))
        assertTrue(receiver.commit(GatewayCommand.RecordingArtifactCommit("call-1")))
        assertTrue(store.list().isEmpty())
        assertFalse(root.walkTopDown().any { it.name.endsWith(".wav") || it.name.endsWith(".meta") || it.name.endsWith(".part") })
        assertTrue(receipts.single().contains("recording_artifact_failed"))
    }

    @Test fun `active call rejects begin and malformed chunk aborts staging`() {
        var idle = false
        val store = PhoneRecordingStore(root)
        val receiver = PhoneRecordingArtifactReceiver(store, {}, { idle }, {})
        val begin = GatewayCommand.RecordingArtifactBegin("call-2", "conversation.wav", 2, "0".repeat(64), 20)
        assertFalse(receiver.begin(begin))
        idle = true
        assertTrue(receiver.begin(begin))
        assertFalse(receiver.append(byteArrayOf(1, 2, 3)))
        assertTrue(store.list().isEmpty())
        assertFalse(root.walkTopDown().any { it.name.endsWith(".part") })
    }
}
