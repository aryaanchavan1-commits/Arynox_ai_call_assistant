package com.callagent.gateway.usb

import java.util.Arrays

/**
 * What [FrameQueue.offer] does when the queue is full.
 *
 * - [REJECT]: refuse the new frame, drop nothing. Backpressure to the caller.
 * - [DROP_OLDEST]: evict the head, append the new frame (keep latency low).
 * - [DROP_NEWEST]: refuse the new frame, keep the head (protect in-flight audio).
 */
enum class OverflowPolicy { REJECT, DROP_OLDEST, DROP_NEWEST }

/** Immutable point-in-time counters for a [FrameQueue]. */
data class FrameQueueMetrics(
    val offered: Long,
    val enqueued: Long,
    val dropped: Long,
    val depth: Int,
)

/**
 * Strictly bounded FIFO of [Frame]s with explicit ownership.
 *
 * - Capacity is fixed at construction; no path grows it, so the number of held
 *   frame references is bounded by [capacity].
 * - On overflow the configured [OverflowPolicy] decides what is dropped.
 * - Ownership of audio is explicit: [poll] returns usable NONZERO PCM data
 *   (zeroization does NOT happen on dequeue — the consumer needs the samples).
 *   The consumer calls [release] when done so the PCM is zeroized in place and
 *   does not linger. [pollInto] copies into a caller buffer and zeroizes the
 *   slot immediately for the case where the consumer never wants a lingering
 *   reference at all.
 * - Discarded frames (DROP_OLDEST / DROP_NEWEST / clear) are zeroized.
 * - Non-PCM payloads are never zeroized.
 *
 * ponytail: one synchronized monitor guards every mutation. USB frame rates
 * (~50 PCM/s at 20ms quanta) make per-queue lock contention a non-issue; if a
 * future lane needs concurrent producers/consumers under load, swap for a
 * lock-free ring buffer.
 */
class FrameQueue(
    val capacity: Int,
    private val overflow: OverflowPolicy = OverflowPolicy.REJECT,
) {
    init {
        require(capacity > 0) { "capacity must be positive, was $capacity" }
    }

    private val buffer = ArrayDeque<Frame>(capacity)
    private var offered: Long = 0
    private var enqueued: Long = 0
    private var dropped: Long = 0

    val metrics: FrameQueueMetrics
        @Synchronized get() = FrameQueueMetrics(offered, enqueued, dropped, buffer.size)

    /**
     * Offer [frame]. Returns true if enqueued, false if the overflow policy
     * rejected it.
     *
     * On enqueue the queue does NOT take ownership of the audio samples — the
     * frame holds its own defensive copy (see [Frame]). REJECT leaves the
     * caller's frame fully intact (caller retains ownership). DROP_OLDEST
     * zeroizes the evicted head's PCM in place. DROP_NEWEST zeroizes the
     * refused new frame's PCM in place (the caller passed ownership by offering
     * into a DROP_NEWEST queue).
     */
    @Synchronized
    fun offer(frame: Frame): Boolean {
        offered++
        return when {
            buffer.size < capacity -> {
                buffer.addLast(frame)
                enqueued++
                true
            }
            overflow == OverflowPolicy.DROP_OLDEST -> {
                val evicted = buffer.removeFirst()
                zeroizeIfPcm(evicted)
                buffer.addLast(frame)
                dropped++
                enqueued++
                true
            }
            overflow == OverflowPolicy.DROP_NEWEST -> {
                zeroizeIfPcm(frame)
                dropped++
                false
            }
            else -> { // REJECT: backpressure. Caller retains ownership.
                dropped++
                false
            }
        }
    }

    /**
     * Remove and return the head, or null if empty. The returned frame's PCM
     * payload is the usable, NONZERO audio the producer offered — zeroization
     * does NOT happen here, the consumer needs the data. Call [release] when
     * done so the samples are zeroized.
     */
    @Synchronized
    fun poll(): Frame? = buffer.removeFirstOrNull()

    /**
     * Copy the head frame's payload into [dest] and remove it from the queue,
     * zeroizing the slot's PCM immediately. Returns true if a frame was
     * consumed, false if the queue was empty (dest is left untouched).
     *
     * [dest] must be at least as large as the head payload; for PCM that is
     * exactly [PcmContract.BYTES_PER_FRAME].
     */
    @Synchronized
    fun pollInto(dest: ByteArray): Boolean {
        val head = buffer.firstOrNull() ?: return false
        require(dest.size >= head.payload.size) {
            "destination too small: ${dest.size} < ${head.payload.size}"
        }
        buffer.removeFirst()
        System.arraycopy(head.payload, 0, dest, 0, head.payload.size)
        zeroizeIfPcm(head)
        return true
    }

    /** Return the head without removing it, or null if empty. Does not zeroize. */
    @Synchronized
    fun peek(): Frame? = buffer.firstOrNull()

    /**
     * Release a frame previously obtained via [poll] (or otherwise no longer
     * needed): zeroizes its PCM payload in place. Safe to call multiple times.
     * Non-PCM payloads are left intact.
     */
    fun release(frame: Frame) {
        zeroizeIfPcm(frame)
    }

    /** Remove every frame, zeroizing all PCM payloads. */
    @Synchronized
    fun clear() {
        while (buffer.isNotEmpty()) {
            zeroizeIfPcm(buffer.removeFirst())
        }
    }

    private fun zeroizeIfPcm(frame: Frame) {
        if (frame.kind == FrameKind.PCM && frame.payload.isNotEmpty()) {
            Arrays.fill(frame.payload, 0)
        }
    }
}
