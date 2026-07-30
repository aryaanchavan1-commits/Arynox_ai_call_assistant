package com.callagent.gateway.dialer

import android.content.ContentValues
import android.content.Context
import android.media.MediaPlayer
import android.net.Uri
import android.os.Build
import android.provider.MediaStore
import java.io.File
import java.text.DateFormat
import java.util.Date

class PhoneRecordingMediaStore(private val context: Context) {
    data class PublishedEntry(
        val displayName: String,
        val uri: Uri,
        val sizeBytes: Long,
        val modifiedMillis: Long,
    ) {
        val title: String get() = displayName.removePrefix(PREFIX).removeSuffix(".wav")
        val modifiedLabel: String get() = DateFormat.getDateTimeInstance().format(Date(modifiedMillis))
    }

    fun publish(entry: PhoneRecordingStore.Entry): Uri {
        require(Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) { "visible recording publication requires Android 10 or newer" }
        val resolver = context.contentResolver
        val values = ContentValues().apply {
            put(MediaStore.MediaColumns.DISPLAY_NAME, "$PREFIX${entry.callId}.wav")
            put(MediaStore.MediaColumns.MIME_TYPE, MIME_TYPE)
            put(MediaStore.MediaColumns.RELATIVE_PATH, RELATIVE_PATH)
            put(MediaStore.MediaColumns.IS_PENDING, 1)
        }
        val uri = resolver.insert(MediaStore.Audio.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY), values)
            ?: throw IllegalStateException("recording publication unavailable")
        try {
            resolver.openOutputStream(uri, "w")?.use { output -> entry.file.inputStream().use { it.copyTo(output) } }
                ?: throw IllegalStateException("recording output unavailable")
            val publishedInput = resolver.openInputStream(uri)
                ?: throw IllegalStateException("recording verification unavailable")
            RecordingCopyVerifier.verify(publishedInput, entry.file.length(), entry.sha256)
            val published = ContentValues().apply { put(MediaStore.MediaColumns.IS_PENDING, 0) }
            if (resolver.update(uri, published, null, null) != 1) throw IllegalStateException("recording publication failed")
            return uri
        } catch (error: Exception) {
            resolver.delete(uri, null, null)
            throw error
        }
    }

    fun list(limit: Int = 100): List<PublishedEntry> {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return emptyList()
        require(limit in 1..200)
        val collection = MediaStore.Audio.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
        val projection = arrayOf(
            MediaStore.MediaColumns._ID,
            MediaStore.MediaColumns.DISPLAY_NAME,
            MediaStore.MediaColumns.SIZE,
            MediaStore.MediaColumns.DATE_MODIFIED,
        )
        val selection = "${MediaStore.MediaColumns.RELATIVE_PATH}=? AND ${MediaStore.MediaColumns.DISPLAY_NAME} LIKE ?"
        val args = arrayOf(RELATIVE_PATH, "$PREFIX%")
        val entries = mutableListOf<PublishedEntry>()
        context.contentResolver.query(
            collection,
            projection,
            selection,
            args,
            "${MediaStore.MediaColumns.DATE_MODIFIED} DESC",
        )?.use { cursor ->
            val idIndex = cursor.getColumnIndexOrThrow(MediaStore.MediaColumns._ID)
            val nameIndex = cursor.getColumnIndexOrThrow(MediaStore.MediaColumns.DISPLAY_NAME)
            val sizeIndex = cursor.getColumnIndexOrThrow(MediaStore.MediaColumns.SIZE)
            val modifiedIndex = cursor.getColumnIndexOrThrow(MediaStore.MediaColumns.DATE_MODIFIED)
            while (cursor.moveToNext() && entries.size < limit) {
                val name = cursor.getString(nameIndex) ?: continue
                if (!SAFE_NAME.matches(name)) continue
                val uri = Uri.withAppendedPath(collection, cursor.getLong(idIndex).toString())
                entries += PublishedEntry(name, uri, cursor.getLong(sizeIndex), cursor.getLong(modifiedIndex) * 1000L)
            }
        }
        return entries
    }

    fun delete(uri: Uri): Boolean {
        require(uri.authority == MediaStore.AUTHORITY) { "invalid recording uri" }
        return context.contentResolver.delete(uri, null, null) == 1
    }

    fun saveCopy(source: PublishedEntry, destination: Uri): Long {
        require(source.uri.authority == MediaStore.AUTHORITY) { "invalid recording uri" }
        val resolver = context.contentResolver
        var copied = 0L
        resolver.openInputStream(source.uri)?.use { input ->
            resolver.openOutputStream(destination, "w")?.use { output ->
                copied = input.copyTo(output, DEFAULT_BUFFER_SIZE)
            } ?: throw IllegalStateException("recording destination unavailable")
        } ?: throw IllegalStateException("recording source unavailable")
        if (copied != source.sizeBytes) throw IllegalStateException("recording copy verification failed")
        return copied
    }

    fun player(uri: Uri, onCompletion: () -> Unit, onError: () -> Unit): MediaPlayer =
        MediaPlayer().apply {
            setDataSource(context, uri)
            setOnCompletionListener { media -> media.release(); onCompletion() }
            setOnErrorListener { media, _, _ -> media.release(); onError(); true }
            prepare()
            start()
        }

    companion object {
        const val RELATIVE_PATH = "Recordings/AgentCall/"
        const val PREFIX = "AgentCall-"
        const val MIME_TYPE = "audio/wav"
        private val SAFE_NAME = Regex("^AgentCall-[A-Za-z0-9][A-Za-z0-9._-]{0,127}\\.wav$")
    }
}

fun PhoneRecordingStore.Entry.deleteStagingFiles() {
    val meta = File(file.parentFile, "$callId.meta")
    file.delete()
    meta.delete()
}
