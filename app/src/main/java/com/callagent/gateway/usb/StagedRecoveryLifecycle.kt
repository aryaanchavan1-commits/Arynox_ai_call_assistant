package com.callagent.gateway.usb

import java.security.MessageDigest

/** Durable staged-enrollment recovery and bounded two-sided commit gate. */
class StagedRecoveryLifecycle(
    private val store: ControllerEnrollmentStore,
    private val nowMillis: () -> Long = System::currentTimeMillis,
    private val commitTimeoutMillis: Long = DEFAULT_COMMIT_TIMEOUT_MILLIS,
) {
    enum class StartAction { BOOTSTRAP, RECOVER_OPERATIONAL_G2, RUN_COMMITTED, FAIL_CLOSED }

    private var expectedStaged: ByteArray? = null
    private var startedAtMillis = 0L
    private var running = false

    init { require(commitTimeoutMillis in 1..MAX_COMMIT_TIMEOUT_MILLIS) }

    @Synchronized
    fun start(): StartAction {
        check(!running)
        running = true
        return when (store.state()) {
            ControllerEnrollmentState.EMPTY -> StartAction.BOOTSTRAP
            ControllerEnrollmentState.STAGED -> {
                expectedStaged = store.loadStaged()
                startedAtMillis = nowMillis()
                StartAction.RECOVER_OPERATIONAL_G2
            }
            ControllerEnrollmentState.COMMITTED -> StartAction.RUN_COMMITTED
            ControllerEnrollmentState.ASYMMETRIC_RESET_REQUIRED -> StartAction.FAIL_CLOSED
        }
    }

    @Synchronized
    fun onOperationalG2AuthenticatedAndCommit(provenSecret: ByteArray): Boolean {
        val expected = expectedStaged ?: return false
        val elapsed = nowMillis() - startedAtMillis
        if (!running || elapsed !in 0..commitTimeoutMillis
            || provenSecret.size != ControllerEnrollmentStore.SECRET_BYTES
            || !MessageDigest.isEqual(expected, provenSecret)
        ) {
            revokeLocked()
            return false
        }
        return try {
            store.commitStagedAfterG2(expected)
        } finally {
            expected.fill(0)
            expectedStaged = null
            running = false
        }
    }

    @Synchronized
    fun fail() = revokeLocked()

    @Synchronized
    fun stop() = revokeLocked()

    private fun revokeLocked() {
        expectedStaged?.fill(0)
        expectedStaged = null
        startedAtMillis = 0L
        if (store.state() == ControllerEnrollmentState.STAGED) store.revokeStaged()
        running = false
    }

    companion object {
        const val DEFAULT_COMMIT_TIMEOUT_MILLIS = 30_000L
        const val MAX_COMMIT_TIMEOUT_MILLIS = 30_000L
    }
}
