package com.callagent.gateway.dialer

import java.io.InputStream
import java.security.MessageDigest

object RecordingCopyVerifier {
    fun verify(input: InputStream, expectedBytes: Long, expectedSha256: String) {
        require(expectedBytes >= 0) { "invalid expected recording size" }
        val digest = MessageDigest.getInstance("SHA-256")
        val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
        var actualBytes = 0L
        input.use { source ->
            while (true) {
                val count = source.read(buffer)
                if (count < 0) break
                if (count == 0) continue
                actualBytes += count
                if (actualBytes > expectedBytes) throw IllegalStateException("published recording size mismatch")
                digest.update(buffer, 0, count)
            }
        }
        val actualSha256 = digest.digest().joinToString("") { "%02x".format(it) }
        if (actualBytes != expectedBytes || actualSha256 != expectedSha256) {
            throw IllegalStateException("published recording verification failed")
        }
    }
}
