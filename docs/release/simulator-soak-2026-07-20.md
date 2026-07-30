# Simulator soak investigation — 2026-07-20

## Status

**Fresh corrected one-hour simulator rerun: PASS.**

This report records the original failed run, the root-cause investigation of its memory criterion, the corrected measurement contract, and the successful rerun. The original failure remains part of the evidence history.

## Original one-hour result — FAIL

Command:

`node scripts/simulator-soak.js 3600000`

Observed after 3,600,000 ms:

- simulated lifecycle/PCM cycles: 30,194,708;
- active calls: 0;
- open simulator sockets: 1;
- file descriptors: 25 → 25;
- RSS: 56,524,800 → 145,162,240 bytes;
- RSS growth: 88,637,440 bytes;
- heap: 4,952,272 → 23,067,752 bytes;
- heap growth: 18,115,480 bytes.

The process exited 1 because cold-start-to-end RSS growth exceeded the 64 MiB gate. Heap growth and FD/state gates passed.

## Root-cause investigation

A separate bounded diagnostic repeated the exact yielded call lifecycle and forced garbage collection after each equal 100,000-cycle window. One million cycles produced:

- active calls: 0 at every checkpoint;
- FDs: 25 at every checkpoint;
- post-GC heap: approximately 4.35 MiB from 200,000 through 1,000,000 cycles;
- external/ArrayBuffer memory fluctuated and returned near baseline;
- RSS reached approximately 145 MiB by 600,000 cycles and stayed within approximately 0.4 MiB through 1,000,000 cycles.

This falsified a monotonically retained JavaScript call/map/buffer leak in the tested path. The cold Node process had not established V8/libuv/native allocator arenas; the old test counted that one-time high-water allocation as leak growth.

An initial diagnostic that yielded only every 8,192 calls was rejected: it created event/socket backlog, nonzero active calls, and hundreds of MiB of external buffers. Those numbers are not product evidence.

## Corrected contract

The simulator workload, fail thresholds, and total requested duration are unchanged. The executable now:

1. records a cold diagnostic snapshot;
2. runs the same lifecycle continuously through a bounded warmup (default: 20% of duration, capped at 10 minutes, while preserving at least 1 second of measured time);
3. records the warm baseline;
4. measures RSS, heap, and FD growth from warm baseline to end;
5. still fails on nonzero active calls, socket-count drift, FD growth over 2, RSS growth over 64 MiB, or heap growth over 32 MiB.

Cold, warm, and end values are all emitted, so one-time allocator growth remains observable rather than hidden.

Executable regression tests cover a 2-second warm-baseline run and the package's minimum 1-second no-warmup smoke. A 30-second validation completed 263,596 cycles with zero active calls, one socket, flat FDs, 20,078,592 bytes warm-to-end RSS growth, and 10,549,480 bytes warm-to-end heap growth.

## Corrected one-hour rerun — PASS

The fresh run completed with exit code 0 and retained valid JSON at `release/simulator-soak-2026-07-20-rerun.json`:

- duration: 3,600,000 ms;
- warmup: 600,000 ms;
- complete lifecycle/PCM cycles: 31,406,610;
- sent/received PCM frames: 31,406,610 / 31,406,610;
- active calls: 0;
- open simulator sockets: 1;
- file descriptors: 25 warm → 25 end, maximum 25;
- RSS: 148,107,264 warm → 150,409,216 end, growth 2,301,952 bytes;
- heap: 9,021,520 warm → 16,000,048 end, growth 6,978,528 bytes;
- retained JSON SHA-256: `7cbf172c78b3601394b0b8b1a2644cd47b01f788be4d79df89778c0dfdac54ad`.

All corrected thresholds passed. Cold-start allocator growth remains visible in the report (`rssCold`) and is not mislabeled as retained post-warmup growth.

## Acceptance boundary

This satisfies the deterministic one-hour simulator duration/state/memory/FD gate. It does not satisfy the separate approval-required one-hour physical POCO M2 Pro cellular-call gate, nor does it provide physical audio latency, thermal, route-persistence, or intelligibility evidence.
