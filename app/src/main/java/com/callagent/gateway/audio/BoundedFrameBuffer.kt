package com.callagent.gateway.audio

/**
 * A bounded, fixed-capacity ring of 20 ms PCM16 frames for the Telephony audio
 * bridge.  It bridges the downlink capture (producer) and the uplink injection
 * (consumer) without ever allocating unbounded memory or touching files,
 * sockets, shell, or mixer controls.
 *
 * Design (ponytail: simplest thing that holds the invariants):
 *   - A fixed [Array] of pre-allocated frame slots, sized at construction.
 *     No growth, no per-offer allocation beyond the slot copy.
 *   - Drop-oldest backpressure: when full, a new [offer] overwrites the oldest
 *     frame.  Live audio wins over stale audio; the producer never blocks.
 *   - [zeroize] wipes every sample of every slot and empties the queue, so a
 *     stopped bridge leaves no PCM in memory.
 *   - [snapshot] returns defensive copies; callers cannot mutate the pool.
 *
 * Tested by [BoundedFrameBufferTest].  No android.* imports.
 */
class BoundedFrameBuffer(
    /** Fixed frame capacity.  Chosen once; never grows. */
    val capacityFrames: Int,
) {
    init {
        require(capacityFrames > 0) { "capacityFrames must be > 0" }
    }

    private val samplesPerFrame: Int = AudioBridgeContract.SAMPLES_PER_FRAME

    // Fixed pool of slots.  Each slot is a reusable ShortArray; offer() copies
    // into a slot rather than retaining the caller's reference.
    private val pool: Array<ShortArray> = Array(capacityFrames) {
        ShortArray(samplesPerFrame)
    }
    private val occupied: BooleanArray = BooleanArray(capacityFrames)

    // Ring indices.
    private var head: Int = 0 // next slot to poll (oldest)
    private var tail: Int = 0 // next slot to offer
    private var count: Int = 0
    private var zeroized: Boolean = false

    /** Number of frames currently buffered. */
    val size: Int
        get() = synchronized(lock) { count }

    /** True after [zeroize] and before the next [offer]. */
    fun isZeroized(): Boolean = synchronized(lock) { zeroized }

    /**
     * Offer one frame.  Copies [frame] into the pool.  If full, the oldest
     * buffered frame is overwritten (drop-oldest).  Returns true if the frame
     * was newly buffered, false if it displaced an oldest frame.
     */
    fun offer(frame: ShortArray): Boolean = synchronized(lock) {
        require(frame.size == samplesPerFrame) {
            "frame must be $samplesPerFrame samples, was ${frame.size}"
        }
        zeroized = false
        val displaced = count == capacityFrames
        if (displaced) {
            // Overwrite the oldest slot (head) and advance head.
            System.arraycopy(frame, 0, pool[head], 0, samplesPerFrame)
            head = (head + 1) % capacityFrames
            tail = (tail + 1) % capacityFrames
        } else {
            System.arraycopy(frame, 0, pool[tail], 0, samplesPerFrame)
            occupied[tail] = true
            tail = (tail + 1) % capacityFrames
            count++
        }
        !displaced
    }

    /**
     * Poll the oldest frame.  Returns a defensive copy, or null if empty.
     */
    fun poll(): ShortArray? = synchronized(lock) {
        if (count == 0) return null
        val slot = pool[head]
        val copy = slot.copyOf()
        slot.fill(0.toShort())
        occupied[head] = false
        head = (head + 1) % capacityFrames
        count--
        copy
    }

    /**
     * Poll the oldest frame directly into [dst] at [offset] with no
     * per-frame allocation, then zeroize the source slot so no PCM lingers in
     * the pool.  Returns the number of samples copied (always
     * [AudioBridgeContract.SAMPLES_PER_FRAME]) or -1 if the buffer was empty.
     *
     * [dst] must have room for one full frame at [offset].  The caller-owned
     * [dst] is reused across calls — the bridge never allocates a frame under
     * load.
     */
    fun pollInto(dst: ShortArray, offset: Int = 0): Int = synchronized(lock) {
        if (count == 0) return -1
        require(dst.size - offset >= samplesPerFrame) {
            "dst too small for one $samplesPerFrame-sample frame at offset $offset"
        }
        val slot = pool[head]
        System.arraycopy(slot, 0, dst, offset, samplesPerFrame)
        slot.fill(0.toShort()) // zeroize source slot
        occupied[head] = false
        head = (head + 1) % capacityFrames
        count--
        samplesPerFrame
    }

    /** Drop all buffered frames.  Does not wipe the backing pool; use [zeroize]. */
    fun clear(): Unit = synchronized(lock) {
        for (i in 0 until capacityFrames) {
            occupied[i] = false
        }
        head = 0
        tail = 0
        count = 0
    }

    /**
     * Wipe every sample of every slot and empty the queue.  After this the
     * buffer holds no PCM and [isZeroized] is true until the next [offer].
     */
    fun zeroize(): Unit = synchronized(lock) {
        for (i in 0 until capacityFrames) {
            pool[i].fill(0.toShort())
            occupied[i] = false
        }
        head = 0
        tail = 0
        count = 0
        zeroized = true
    }

    /** A defensive snapshot of the currently buffered frames, in FIFO order. */
    fun snapshot(): List<ShortArray> = synchronized(lock) {
        val out = ArrayList<ShortArray>(count)
        var idx = head
        for (i in 0 until count) {
            out.add(pool[idx].copyOf())
            idx = (idx + 1) % capacityFrames
        }
        out
    }

    private val lock = Any()
}
