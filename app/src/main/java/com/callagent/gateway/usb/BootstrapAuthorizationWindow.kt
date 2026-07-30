package com.callagent.gateway.usb

/** Bounded foreground-start authorization with one in-flight bootstrap claim. */
class BootstrapAuthorizationWindow(
    private val openedAtMillis: Long,
    private val nowMillis: () -> Long = System::currentTimeMillis,
    private val durationMillis: Long = DEFAULT_DURATION_MILLIS,
) {
    data class Claim(val accepted: Boolean, val generation: Long = 0L)

    private var generation = 0L
    private var activeGeneration = 0L
    private var revoked = false

    init { require(durationMillis in 1..MAX_DURATION_MILLIS) }

    @Synchronized
    fun tryClaim(uid: Int, gid: Int): Claim {
        if (!isOpenLocked() || uid != SHELL_ID || gid != SHELL_ID || activeGeneration != 0L) return Claim(false)
        generation++
        activeGeneration = generation
        return Claim(true, generation)
    }

    /**
     * Claims the user-opened window for a connection delivered by an ADB TCP
     * forward to the app's loopback-only listener. Android 15 isolates app
     * abstract sockets from adbd, so peer credentials are unavailable on the
     * supported transport; the protocol still authenticates the exact matched
     * artifact before any controller key is staged.
     */
    @Synchronized
    fun tryClaimForwardedTunnel(): Claim {
        if (!isOpenLocked() || activeGeneration != 0L) return Claim(false)
        generation++
        activeGeneration = generation
        return Claim(true, generation)
    }

    @Synchronized
    fun isCurrent(candidate: Long): Boolean = isOpenLocked() && candidate != 0L && candidate == activeGeneration

    @Synchronized
    fun release(candidate: Long) {
        if (candidate == activeGeneration) activeGeneration = 0L
    }

    @Synchronized
    fun revoke() {
        revoked = true
        activeGeneration = 0L
    }

    @Synchronized
    fun isOpen(): Boolean = isOpenLocked()

    private fun isOpenLocked(): Boolean = !revoked && nowMillis() - openedAtMillis in 0 until durationMillis

    companion object {
        const val SHELL_ID = 2000
        const val DEFAULT_DURATION_MILLIS = 30_000L
        const val MAX_DURATION_MILLIS = 30_000L
    }
}
