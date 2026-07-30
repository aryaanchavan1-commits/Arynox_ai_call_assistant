package com.callagent.gateway.gsm

/** Binds one authenticated gateway dial request to the matching Android Call object. */
class OutgoingCallOwnership {
    private var pendingDestination: String? = null
    private var ownedCall: Any? = null

    @Synchronized
    fun arm(destination: String): Boolean {
        val normalized = normalize(destination) ?: return false
        if (pendingDestination != null || ownedCall != null) return false
        pendingDestination = normalized
        return true
    }

    @Synchronized
    fun claim(call: Any, destination: String): Boolean {
        val pending = pendingDestination ?: return false
        if (ownedCall != null || normalize(destination) != pending) return false
        pendingDestination = null
        ownedCall = call
        return true
    }

    @Synchronized
    fun isOwned(call: Any): Boolean = ownedCall === call

    @Synchronized
    fun rejectPending() {
        pendingDestination = null
    }

    @Synchronized
    fun release(call: Any) {
        if (ownedCall === call) ownedCall = null
    }

    private fun normalize(value: String): String? {
        val digits = value.filter(Char::isDigit)
        if (digits.length !in 6..15 || digits.firstOrNull() == '0') return null
        return "+$digits"
    }
}
