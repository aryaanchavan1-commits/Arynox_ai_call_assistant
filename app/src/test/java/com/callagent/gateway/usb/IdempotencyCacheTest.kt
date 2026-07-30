package com.callagent.gateway.usb

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * RED-GREEN tests for [IdempotencyCache]: mutation commands are deduplicated by
 * their [idempotencyKey]. A second command with the same key is treated as a
 * replay (not re-applied) and the cache is bounded so a malicious or chatty
 * peer cannot grow memory without limit.
 */
class IdempotencyCacheTest {

    @Test
    fun `first mutation key is admitted`() {
        val c = IdempotencyCache(capacity = 4)
        assertTrue(c.admit("k1"))
    }

    @Test
    fun `duplicate key rejected as replay`() {
        val c = IdempotencyCache(capacity = 4)
        assertTrue(c.admit("k1"))
        assertFalse("duplicate key must be a replay", c.admit("k1"))
    }

    @Test
    fun `distinct keys all admitted`() {
        val c = IdempotencyCache(capacity = 4)
        assertTrue(c.admit("a"))
        assertTrue(c.admit("b"))
        assertTrue(c.admit("c"))
        assertTrue(c.admit("d"))
    }

    @Test
    fun `capacity is bounded and running entries reject new admission`() {
        val c = IdempotencyCache(capacity = 2)
        assertTrue(c.admit("a"))
        assertTrue(c.admit("b"))
        assertFalse("running entries must not be evicted", c.admit("c"))
        assertFalse("first running key remains admitted", c.admit("a"))
        assertFalse("second running key remains admitted", c.admit("b"))
    }

    @Test
    fun `capacity must be positive`() {
        assertThrows(IllegalArgumentException::class.java) { IdempotencyCache(capacity = 0) }
        assertThrows(IllegalArgumentException::class.java) { IdempotencyCache(capacity = -1) }
    }

    @Test
    fun `blank key rejected`() {
        val c = IdempotencyCache(capacity = 4)
        assertThrows(IllegalArgumentException::class.java) { c.admit("  ") }
        assertThrows(IllegalArgumentException::class.java) { c.admit("") }
    }

    @Test
    fun `key over bound rejected`() {
        val c = IdempotencyCache(capacity = 4)
        val tooLong = "x".repeat(CommandParser.MAX_IDEMPOTENCY_KEY_LEN + 1)
        assertThrows(IllegalArgumentException::class.java) { c.admit(tooLong) }
    }

    @Test
    fun `clear empties the cache so keys become admissible again`() {
        val c = IdempotencyCache(capacity = 4)
        assertTrue(c.admit("k1"))
        assertFalse(c.admit("k1"))
        c.clear()
        assertTrue("after clear k1 is fresh again", c.admit("k1"))
    }

    @Test
    fun `size reports live entry count and never exceeds capacity`() {
        val c = IdempotencyCache(capacity = 3)
        assertEquals(0, c.size)
        c.admit("a"); assertEquals(1, c.size)
        c.admit("b"); assertEquals(2, c.size)
        c.admit("c"); assertEquals(3, c.size)
        // capacity reached; a duplicate does not grow.
        assertFalse(c.admit("a"))
        assertEquals(3, c.size)
        // all entries are running, so a new key is rejected without growth.
        assertFalse(c.admit("d"))
        assertEquals(3, c.size)
    }

    @Test
    fun `exact replay returns original typed result`() {
        val c = IdempotencyCache(capacity = 4)
        val result = CommandExecutionResult.Rejected("dial", "policy denied")
        assertTrue(c.begin("k1", "dial|+15550000100") is IdempotencyCache.Decision.Execute)
        c.complete("k1", "dial|+15550000100", result)

        val replay = c.begin("k1", "dial|+15550000100")
        assertEquals(IdempotencyCache.Decision.Replay(result), replay)
    }

    @Test
    fun `same key with different request fingerprint is a collision`() {
        val c = IdempotencyCache(capacity = 4)
        assertTrue(c.begin("k1", "answer|call-1") is IdempotencyCache.Decision.Execute)
        c.complete("k1", "answer|call-1", CommandExecutionResult.Accepted("answer"))

        assertTrue(c.begin("k1", "hangup|call-1") is IdempotencyCache.Decision.Collision)
    }

    @Test
    fun `failed in flight entry reports every same generation waiter and permits retry`() {
        val c = IdempotencyCache(capacity = 4)
        assertTrue(c.begin("k1", "dial|+155****0100", generation = 7) is IdempotencyCache.Decision.Execute)
        assertTrue(c.begin("k1", "dial|+155****0100", generation = 7) is IdempotencyCache.Decision.InFlight)
        assertEquals(2, c.fail("k1", "dial|+155****0100", generation = 7))
        assertTrue(c.begin("k1", "dial|+155****0100", generation = 7) is IdempotencyCache.Decision.Execute)
    }

    @Test
    fun `exact in flight duplicates coalesce into typed result deliveries`() {
        val c = IdempotencyCache(capacity = 4)
        val result = CommandExecutionResult.Rejected("dial", "policy denied")
        assertTrue(c.begin("k1", "dial|+155****0100", generation = 3) is IdempotencyCache.Decision.Execute)
        assertTrue(c.begin("k1", "dial|+155****0100", generation = 3) is IdempotencyCache.Decision.InFlight)
        assertTrue(c.begin("k1", "dial|+155****0100", generation = 3) is IdempotencyCache.Decision.InFlight)

        assertEquals(3, c.complete("k1", "dial|+155****0100", generation = 3, result = result))
        assertEquals(IdempotencyCache.Decision.Replay(result), c.begin("k1", "dial|+155****0100", generation = 3))
    }

    @Test
    fun `running entries are never evicted under capacity pressure`() {
        val c = IdempotencyCache(capacity = 2)
        assertTrue(c.begin("running-a", "a", 1) is IdempotencyCache.Decision.Execute)
        assertTrue(c.begin("running-b", "b", 1) is IdempotencyCache.Decision.Execute)
        assertTrue(c.begin("rejected", "c", 1) is IdempotencyCache.Decision.Capacity)
        assertTrue(c.begin("running-a", "a", 1) is IdempotencyCache.Decision.InFlight)
        assertEquals(2, c.fail("running-a", "a", 1))
        assertTrue(c.begin("after-fail", "c", 1) is IdempotencyCache.Decision.Execute)
    }

    @Test
    fun `capacity pressure evicts completed entry only`() {
        val c = IdempotencyCache(capacity = 2)
        assertTrue(c.begin("complete", "a", 1) is IdempotencyCache.Decision.Execute)
        c.complete("complete", "a", CommandExecutionResult.Accepted("dial"), generation = 1)
        assertTrue(c.begin("running", "b", 1) is IdempotencyCache.Decision.Execute)
        assertTrue(c.begin("new", "c", 1) is IdempotencyCache.Decision.Execute)
        assertTrue(c.begin("running", "b", 1) is IdempotencyCache.Decision.InFlight)
        assertTrue(c.begin("complete", "a", 1) is IdempotencyCache.Decision.Capacity)
    }

    @Test
    fun `replacement generation cannot join or complete stale running entry`() {
        val c = IdempotencyCache(capacity = 2)
        assertTrue(c.begin("k", "dial", 10) is IdempotencyCache.Decision.Execute)
        assertTrue(c.begin("k", "dial", 11) is IdempotencyCache.Decision.GenerationMismatch)
        assertEquals(1, c.cancelGeneration(10))
        assertTrue(c.begin("k", "dial", 11) is IdempotencyCache.Decision.Execute)
    }
}
