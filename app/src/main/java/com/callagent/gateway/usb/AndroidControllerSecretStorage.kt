package com.callagent.gateway.usb

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.nio.charset.StandardCharsets
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

class AndroidControllerSecretStorage(context: Context) : TransactionalControllerSecretStorage {
    private val preferences = context.applicationContext.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE)

    override fun read(): ByteArray? = readRecord(RECORD_KEY)
    override fun write(secret: ByteArray) = writeRecord(RECORD_KEY, secret)
    override fun readStaged(): ByteArray? = readRecord(STAGED_RECORD_KEY)
    override fun writeStaged(secret: ByteArray) = writeRecord(STAGED_RECORD_KEY, secret)

    override fun commitStaged() {
        val staged = preferences.getString(STAGED_RECORD_KEY, null)
            ?: throw IllegalStateException("staged controller enrollment unavailable")
        check(!preferences.contains(RECORD_KEY)) { "committed controller enrollment already exists" }
        check(preferences.edit().putString(RECORD_KEY, staged).remove(STAGED_RECORD_KEY).commit()) {
            "controller enrollment commit failed"
        }
    }

    override fun clearStaged() {
        check(preferences.edit().remove(STAGED_RECORD_KEY).commit()) { "staged controller enrollment could not be removed" }
    }

    override fun clear() {
        check(preferences.edit().remove(RECORD_KEY).remove(STAGED_RECORD_KEY).commit()) {
            "controller enrollment record could not be removed"
        }
        keyStore().apply { load(null); if (containsAlias(KEY_ALIAS)) deleteEntry(KEY_ALIAS) }
    }

    private fun readRecord(key: String): ByteArray? {
        val encoded = preferences.getString(key, null) ?: return null
        val parts = encoded.split('.')
        check(parts.size == 3 && parts[0] == RECORD_VERSION) { "controller enrollment record is invalid" }
        val iv = decode(parts[1])
        val ciphertext = decode(parts[2])
        check(iv.size in 12..16 && ciphertext.size >= ControllerEnrollmentStore.SECRET_BYTES + 16) { "controller enrollment record is invalid" }
        return try {
            Cipher.getInstance(TRANSFORMATION).run {
                init(Cipher.DECRYPT_MODE, requireKey(), GCMParameterSpec(GCM_TAG_BITS, iv))
                updateAAD(RECORD_AAD)
                doFinal(ciphertext).also { check(it.size == ControllerEnrollmentStore.SECRET_BYTES) { "controller secret must be exactly 32 bytes" } }
            }
        } finally { iv.fill(0); ciphertext.fill(0) }
    }

    private fun writeRecord(key: String, secret: ByteArray) {
        require(secret.size == ControllerEnrollmentStore.SECRET_BYTES) { "controller secret must be exactly 32 bytes" }
        val cipher = Cipher.getInstance(TRANSFORMATION).apply { init(Cipher.ENCRYPT_MODE, getOrCreateKey()); updateAAD(RECORD_AAD) }
        val ciphertext = cipher.doFinal(secret)
        val iv = cipher.iv
        val record = listOf(RECORD_VERSION, encode(iv), encode(ciphertext)).joinToString(".")
        try {
            check(preferences.edit().putString(key, record).commit()) { "controller enrollment record could not be persisted" }
        } finally { iv.fill(0); ciphertext.fill(0) }
    }

    private fun requireKey(): SecretKey = keyStore().run {
        load(null)
        getKey(KEY_ALIAS, null) as? SecretKey ?: throw IllegalStateException("controller enrollment key is unavailable")
    }

    private fun getOrCreateKey(): SecretKey {
        val store = keyStore().apply { load(null) }
        (store.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEY_STORE).run {
            init(KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setKeySize(256).setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).setRandomizedEncryptionRequired(true).build())
            generateKey()
        }
    }

    private fun keyStore(): KeyStore = KeyStore.getInstance(ANDROID_KEY_STORE)
    private fun encode(value: ByteArray): String = Base64.encodeToString(value, Base64.NO_WRAP or Base64.NO_PADDING or Base64.URL_SAFE)
    private fun decode(value: String): ByteArray = try { Base64.decode(value, Base64.NO_WRAP or Base64.NO_PADDING or Base64.URL_SAFE) }
        catch (_: IllegalArgumentException) { throw IllegalStateException("controller enrollment record is invalid") }

    companion object {
        private const val ANDROID_KEY_STORE = "AndroidKeyStore"
        private const val TRANSFORMATION = "AES/GCM/NoPadding"
        private const val KEY_ALIAS = "agentcall.controller.enrollment.v1"
        private const val PREFERENCES_NAME = "agentcall_controller_enrollment"
        private const val RECORD_KEY = "encrypted_record"
        private const val STAGED_RECORD_KEY = "encrypted_record_staged"
        private const val RECORD_VERSION = "v1"
        private const val GCM_TAG_BITS = 128
        private val RECORD_AAD = "agentcall-controller-enrollment-v1".toByteArray(StandardCharsets.US_ASCII)
    }
}
