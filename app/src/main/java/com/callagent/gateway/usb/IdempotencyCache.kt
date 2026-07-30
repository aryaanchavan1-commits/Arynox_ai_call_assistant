package com.callagent.gateway.usb

import java.util.LinkedHashMap

/** Bounded process-lifecycle replay cache. Keys bind to a canonical request fingerprint and typed result. */
class IdempotencyCache(private val capacity: Int) {
    sealed class Decision {
        data object Execute : Decision()
        data class Replay(val result: CommandExecutionResult) : Decision()
        data object InFlight : Decision()
        data object Collision : Decision()
        data object GenerationMismatch : Decision()
        data object Capacity : Decision()
    }

    private sealed class State {
        data class Running(val duplicateWaiters: Int) : State()
        data class Complete(val result: CommandExecutionResult) : State()
    }

    private data class Entry(val fingerprint: String, val generation: Long, val state: State)

    init { require(capacity > 0) { "capacity must be positive, was $capacity" } }

    private val entries = object : LinkedHashMap<String, Entry>(capacity, 1f, false) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, Entry>?): Boolean = size > capacity
    }

    @Synchronized
    fun begin(key: String, fingerprint: String, generation: Long = 0L): Decision {
        validateKey(key)
        require(fingerprint.isNotBlank()) { "fingerprint must not be blank" }
        val existing = entries[key]
        if (existing == null) {
            if (entries.size >= capacity) {
                val completed = entries.entries.firstOrNull { it.value.state is State.Complete }
                    ?: return Decision.Capacity
                entries.remove(completed.key)
            }
            entries[key] = Entry(fingerprint, generation, State.Running(duplicateWaiters = 0))
            return Decision.Execute
        }
        if (existing.generation != generation) return Decision.GenerationMismatch
        if (existing.fingerprint != fingerprint) return Decision.Collision
        return when (val state = existing.state) {
            is State.Running -> {
                entries[key] = existing.copy(state = state.copy(duplicateWaiters = state.duplicateWaiters + 1))
                Decision.InFlight
            }
            is State.Complete -> Decision.Replay(state.result)
        }
    }

    @Synchronized
    fun complete(
        key: String,
        fingerprint: String,
        result: CommandExecutionResult,
        generation: Long = 0L,
    ): Int {
        val existing = entries[key]
        val running = existing?.state as? State.Running
        require(
            existing?.fingerprint == fingerprint && existing.generation == generation && running != null
        ) { "no matching in-flight request" }
        entries[key] = existing.copy(state = State.Complete(result))
        return 1 + running.duplicateWaiters
    }

    @Synchronized
    fun fail(key: String, fingerprint: String, generation: Long = 0L): Int {
        val existing = entries[key]
        val running = existing?.state as? State.Running
        if (existing?.fingerprint != fingerprint || existing.generation != generation || running == null) return 0
        entries.remove(key)
        return 1 + running.duplicateWaiters
    }

    @Synchronized
    fun cancelGeneration(generation: Long): Int {
        val keys = entries.filterValues { it.generation == generation && it.state is State.Running }.keys.toList()
        keys.forEach(entries::remove)
        return keys.size
    }

    /** Compatibility admission API for callers that only need duplicate suppression. */
    @Synchronized
    fun admit(key: String): Boolean = begin(key, key) == Decision.Execute

    @Synchronized
    fun lookup(key: String): Boolean? = if (entries.containsKey(key)) true else null

    @Synchronized
    fun clear() = entries.clear()

    val size: Int @Synchronized get() = entries.size

    private fun validateKey(key: String) {
        require(key.isNotBlank()) { "idempotencyKey must not be blank" }
        require(key.length <= CommandParser.MAX_IDEMPOTENCY_KEY_LEN) {
            "idempotencyKey over bound ${CommandParser.MAX_IDEMPOTENCY_KEY_LEN}: ${key.length}"
        }
    }
}
