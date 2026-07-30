package com.callagent.gateway.dialer

import com.callagent.gateway.usb.GatewayCommand
import com.callagent.gateway.usb.RecordingArtifactReceiver

class PhoneRecordingArtifactReceiver(
    private val store: PhoneRecordingStore,
    private val publish: (PhoneRecordingStore.Entry) -> Unit,
    private val isCallIdle: () -> Boolean,
    private val emitReceipt: (String) -> Unit,
    private val reportFailure: (String, Throwable?) -> Unit = { _, _ -> },
) : RecordingArtifactReceiver {
    private var callId: String? = null

    override fun begin(command: GatewayCommand.RecordingArtifactBegin): Boolean {
        if (!isCallIdle() || callId != null) return false
        return try {
            store.begin(
                callId = command.callId,
                artifact = command.artifact,
                size = command.size,
                sha256 = command.sha256,
                durationMillis = command.durationMillis,
            )
            callId = command.callId
            true
        } catch (error: Exception) {
            reportFailure("recording artifact begin failed", error)
            store.abort()
            false
        }
    }

    override fun append(payload: ByteArray): Boolean {
        if (!isCallIdle() || callId == null) return false
        return try {
            store.append(payload)
            true
        } catch (error: Exception) {
            reportFailure("recording artifact append failed", error)
            abort()
            false
        }
    }

    override fun commit(command: GatewayCommand.RecordingArtifactCommit): Boolean {
        val activeCallId = callId
        if (!isCallIdle() || activeCallId == null || activeCallId != command.callId) return false
        return try {
            val entry = store.commit()
            publish(entry)
            entry.deleteStagingFiles()
            emitReceipt(receipt("recording_artifact_stored", entry.callId))
            callId = null
            true
        } catch (error: Exception) {
            reportFailure("recording artifact commit failed", error)
            store.abort()
            store.removeCompleted(activeCallId)
            emitReceipt(receipt("recording_artifact_failed", activeCallId))
            callId = null
            true
        }
    }

    override fun abort() {
        store.abort()
        callId = null
    }

    private fun receipt(event: String, opaqueCallId: String): String =
        "{\"event\":\"$event\",\"callId\":\"$opaqueCallId\"}"
}
