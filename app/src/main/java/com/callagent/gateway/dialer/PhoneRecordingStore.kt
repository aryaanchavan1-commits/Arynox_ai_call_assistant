package com.callagent.gateway.dialer

import java.io.BufferedOutputStream
import java.io.File
import java.io.FileOutputStream
import java.security.MessageDigest

class PhoneRecordingStore(private val root: File) {
    data class Entry(
        val callId: String,
        val durationMillis: Long,
        val sha256: String,
        val file: File,
    )

    private data class Transfer(
        val callId: String,
        val expectedBytes: Long,
        val expectedSha256: String,
        val durationMillis: Long,
        val part: File,
        val output: BufferedOutputStream,
        val digest: MessageDigest,
        var receivedBytes: Long = 0,
    )

    private var transfer: Transfer? = null

    fun begin(callId: String, artifact: String, size: Long, sha256: String, durationMillis: Long) {
        require(CALL_ID.matches(callId)) { "invalid callId" }
        require(artifact == ARTIFACT) { "unsupported recording artifact" }
        require(size in 1..MAX_RECORDING_BYTES) { "recording size out of bounds" }
        require(SHA256.matches(sha256)) { "invalid sha256" }
        require(durationMillis >= 0) { "invalid duration" }
        abort()
        root.mkdirs()
        require(root.isDirectory) { "recording staging unavailable" }
        val part = File(root, "$callId.part")
        val output = BufferedOutputStream(FileOutputStream(part, false))
        transfer = Transfer(
            callId = callId,
            expectedBytes = size,
            expectedSha256 = sha256,
            durationMillis = durationMillis,
            part = part,
            output = output,
            digest = MessageDigest.getInstance("SHA-256"),
        )
    }

    fun append(bytes: ByteArray) {
        val current = transfer ?: throw IllegalStateException("no recording transfer")
        if (bytes.isEmpty() || bytes.size > MAX_CHUNK_BYTES || current.receivedBytes + bytes.size > current.expectedBytes) {
            abort()
            throw IllegalStateException("recording chunk exceeds transfer bounds")
        }
        current.output.write(bytes)
        current.digest.update(bytes)
        current.receivedBytes += bytes.size
    }

    fun commit(): Entry {
        val current = transfer ?: throw IllegalStateException("no recording transfer")
        transfer = null
        return try {
            current.output.flush()
            current.output.close()
            val actualSha256 = current.digest.digest().joinToString("") { "%02x".format(it) }
            if (current.receivedBytes != current.expectedBytes || actualSha256 != current.expectedSha256) {
                current.part.delete()
                throw IllegalStateException("recording verification failed")
            }
            val completed = File(root, "${current.callId}.wav")
            if (completed.exists() && !completed.delete()) throw IllegalStateException("existing recording cannot be replaced")
            if (!current.part.renameTo(completed)) {
                current.part.delete()
                throw IllegalStateException("recording commit failed")
            }
            File(root, "${current.callId}.meta").writeText(
                listOf(current.durationMillis, actualSha256).joinToString("\n", postfix = "\n"),
                Charsets.UTF_8,
            )
            Entry(current.callId, current.durationMillis, actualSha256, completed)
        } catch (error: Exception) {
            current.part.delete()
            throw error
        }
    }

    fun abort() {
        val current = transfer ?: return
        transfer = null
        try { current.output.close() } catch (_: Exception) {}
        current.part.delete()
    }

    fun removeCompleted(callId: String) {
        if (!CALL_ID.matches(callId)) return
        File(root, "$callId.wav").delete()
        File(root, "$callId.meta").delete()
    }

    fun list(): List<Entry> {
        root.mkdirs()
        val files = root.listFiles { file -> file.isFile && file.name.endsWith(".wav") } ?: return emptyList()
        return files.mapNotNull { file ->
            val callId = file.name.removeSuffix(".wav")
            if (!CALL_ID.matches(callId)) return@mapNotNull null
            val lines = try { File(root, "$callId.meta").readLines(Charsets.UTF_8) } catch (_: Exception) { return@mapNotNull null }
            val duration = lines.getOrNull(0)?.toLongOrNull() ?: return@mapNotNull null
            val sha = lines.getOrNull(1) ?: return@mapNotNull null
            if (duration < 0 || !SHA256.matches(sha)) return@mapNotNull null
            Entry(callId, duration, sha, file)
        }.sortedByDescending { it.file.lastModified() }
    }

    companion object {
        const val ARTIFACT = "conversation.wav"
        const val MAX_CHUNK_BYTES = 4096
        const val MAX_RECORDING_BYTES = 512L * 1024 * 1024
        private val CALL_ID = Regex("^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
        private val SHA256 = Regex("^[0-9a-f]{64}$")
    }
}
