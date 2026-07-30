package com.callagent.gateway.usb

import java.util.Arrays
import java.util.concurrent.ArrayBlockingQueue

/** Pure generation guard used by service/UI lifecycle reducers. */
class ConnectionGenerationOwner {
    private var generation: Long? = null

    @Synchronized
    fun connected(candidate: Long): Boolean {
        if (generation != null && candidate <= generation!!) return false
        generation = candidate
        return true
    }

    @Synchronized
    fun disconnected(candidate: Long): Boolean {
        if (generation != candidate) return false
        generation = null
        return true
    }

    @Synchronized
    fun current(): Long? = generation
}

/** Bounded connection-owned EVENT/PCM queue. PCM is zeroized on every discard. */
class GenerationOutboundQueue(private val capacity: Int) {
    data class Message(
        val generation: Long,
        val kind: FrameKind,
        val payload: ByteArray,
        val timestampMicros: Long,
    )

    init { require(capacity > 0) }

    private val queue = ArrayBlockingQueue<Message>(capacity)
    private var activeGeneration: Long? = null
    private var lastDiscarded: ByteArray? = null

    @Synchronized
    fun activate(generation: Long) {
        clearLocked()
        activeGeneration = generation
    }

    @Synchronized
    fun offer(generation: Long, kind: FrameKind, payload: ByteArray, timestampMicros: Long): Boolean {
        val message = Message(generation, kind, payload.copyOf(), timestampMicros)
        if (activeGeneration != generation || !queue.offer(message)) {
            discard(message)
            return false
        }
        return true
    }

    @Synchronized
    fun poll(generation: Long): Message? {
        while (true) {
            val message = queue.poll() ?: return null
            if (activeGeneration == generation && message.generation == generation) return message
            discard(message)
        }
    }

    @Synchronized
    fun clear() = clearLocked()

    @Synchronized
    fun release(message: Message) = discard(message)

    @Synchronized
    fun lastDiscardedPayloadForTest(): ByteArray? = lastDiscarded

    private fun clearLocked() {
        while (true) discard(queue.poll() ?: return)
    }

    private fun discard(message: Message) {
        if (message.kind == FrameKind.PCM) Arrays.fill(message.payload, 0)
        lastDiscarded = message.payload
    }
}

/** Bounded host-to-device PCM queue whose producer and consumer must own the active connection. */
class GenerationDownlinkQueue(val capacity: Int) {
    private data class OwnedFrame(val generation: Long, val frame: Frame)

    init { require(capacity > 0) }

    private val queue = ArrayDeque<OwnedFrame>(capacity)
    private var activeGeneration: Long? = null
    private var lastDiscarded: ByteArray? = null

    @Synchronized
    fun activate(generation: Long) {
        clearLocked()
        activeGeneration = generation
    }

    @Synchronized
    fun offer(generation: Long, frame: Frame): Boolean {
        if (activeGeneration != generation) {
            discard(frame)
            return false
        }
        if (queue.size == capacity) discard(queue.removeFirst().frame)
        queue.addLast(OwnedFrame(generation, frame))
        return true
    }

    @Synchronized
    fun pollInto(generation: Long, destination: ByteArray): Boolean {
        if (activeGeneration != generation) return false
        while (true) {
            val owned = queue.removeFirstOrNull() ?: return false
            if (owned.generation != generation) {
                discard(owned.frame)
                continue
            }
            require(destination.size >= owned.frame.payload.size) {
                "destination too small: ${destination.size} < ${owned.frame.payload.size}"
            }
            System.arraycopy(owned.frame.payload, 0, destination, 0, owned.frame.payload.size)
            discard(owned.frame)
            return true
        }
    }

    @Synchronized
    fun clear() = clearLocked()

    val depth: Int @Synchronized get() = queue.size

    @Synchronized
    fun lastDiscardedPayloadForTest(): ByteArray? = lastDiscarded

    private fun clearLocked() {
        while (true) discard(queue.removeFirstOrNull()?.frame ?: return)
    }

    private fun discard(frame: Frame) {
        if (frame.kind == FrameKind.PCM) Arrays.fill(frame.payload, 0)
        lastDiscarded = frame.payload
    }
}
