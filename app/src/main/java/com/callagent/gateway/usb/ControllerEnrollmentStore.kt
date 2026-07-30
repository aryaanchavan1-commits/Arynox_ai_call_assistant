package com.callagent.gateway.usb

import java.security.MessageDigest
import java.security.SecureRandom

interface ControllerSecretStorage {
    fun read(): ByteArray?
    fun write(secret: ByteArray)
    fun clear()
}

interface TransactionalControllerSecretStorage : ControllerSecretStorage {
    fun readStaged(): ByteArray?
    fun writeStaged(secret: ByteArray)
    fun commitStaged()
    fun clearStaged()
}

enum class ControllerEnrollmentState { EMPTY, STAGED, COMMITTED, ASYMMETRIC_RESET_REQUIRED }

class ControllerEnrollmentStore(
    private val storage: ControllerSecretStorage,
    private val generateSecret: () -> ByteArray = { ByteArray(SECRET_BYTES).also(SecureRandom()::nextBytes) },
) {
    private val transactional get() = storage as? TransactionalControllerSecretStorage

    fun state(): ControllerEnrollmentState {
        val committed = storage.read()?.also(::validateAndClear)
        val staged = transactional?.readStaged()?.also(::validateAndClear)
        return when {
            committed != null && staged != null -> ControllerEnrollmentState.ASYMMETRIC_RESET_REQUIRED
            committed != null -> ControllerEnrollmentState.COMMITTED
            staged != null -> ControllerEnrollmentState.STAGED
            else -> ControllerEnrollmentState.EMPTY
        }
    }

    fun isEnrolled(): Boolean = state() == ControllerEnrollmentState.COMMITTED
    fun enroll(): ByteArray { check(load() == null) { "controller is already enrolled; use explicit rotation" }; return generateAndPersist() }
    fun rotate(): ByteArray { check(load() != null) { "controller is not enrolled" }; return generateAndPersist() }
    fun revoke() = storage.clear()

    fun load(): ByteArray? {
        check(state() != ControllerEnrollmentState.ASYMMETRIC_RESET_REQUIRED) { "asymmetric controller enrollment requires explicit reset" }
        val secret = storage.read() ?: return null
        if (secret.size != SECRET_BYTES) { secret.fill(0); error("persisted controller secret must be exactly 32 bytes") }
        return secret.copyOf().also { secret.fill(0) }
    }

    fun stage(secret: ByteArray) {
        require(secret.size == SECRET_BYTES)
        val target = transactional ?: error("transactional controller storage required")
        check(state() == ControllerEnrollmentState.EMPTY) { "controller enrollment is not empty" }
        try {
            target.writeStaged(secret.copyOf())
            val readBack = target.readStaged() ?: error("staged controller enrollment unavailable")
            try { check(readBack.size == SECRET_BYTES && readBack.contentEquals(secret)) { "staged controller enrollment readback failed" } }
            finally { readBack.fill(0) }
        } catch (e: Exception) { target.clearStaged(); throw e }
    }

    fun loadStaged(): ByteArray? = transactional?.readStaged()?.let { secret ->
        if (secret.size != SECRET_BYTES) { secret.fill(0); error("staged controller secret must be exactly 32 bytes") }
        secret.copyOf().also { secret.fill(0) }
    }

    fun commitStagedAfterG2(provenSecret: ByteArray): Boolean {
        val target = transactional ?: return false
        val staged = loadStaged() ?: return false
        return try {
            if (!MessageDigest.isEqual(staged, provenSecret)) { target.clearStaged(); false }
            else { target.commitStaged(); true }
        } finally { staged.fill(0) }
    }

    fun revokeStaged() { transactional?.clearStaged() }

    fun resetAsymmetricState() { storage.clear(); transactional?.clearStaged() }

    private fun generateAndPersist(): ByteArray {
        val generated = generateSecret()
        if (generated.size != SECRET_BYTES) { generated.fill(0); error("generated controller secret must be exactly 32 bytes") }
        return try { storage.write(generated.copyOf()); generated.copyOf() } finally { generated.fill(0) }
    }

    private fun validateAndClear(secret: ByteArray) {
        try { check(secret.size == SECRET_BYTES) { "persisted controller secret must be exactly 32 bytes" } }
        finally { secret.fill(0) }
    }

    companion object { const val SECRET_BYTES = 32 }
}
