# Controller bootstrap protocol v2 foundation

This document defines the side-by-side v2 transcript codec. This foundation does not connect v2 to the bootstrap transport or lifecycle.

## Canonical transcript bytes

All integers are unsigned big-endian. Text is an unsigned 16-bit byte length followed by strict UTF-8. Text must be non-empty NFC, must contain no C0 control or DEL characters, and has the byte cap shown below. Decoders reject malformed UTF-8, non-NFC text, unknown headers, zero/reflected nonces or keys, invalid fixed-width values, overlong fields, truncation, and trailing bytes. The whole message is at most 4096 bytes.

| Offset/order | Encoding | Meaning |
|---|---:|---|
| 1 | 4 bytes | ASCII `G2B2` |
| 2 | u8 | version `2` |
| 3 | u8 | type `1` (transcript) |
| 4 | u16 | reserved, exactly zero |
| 5–8 | 32 bytes each | nonzero desktop nonce, phone nonce, desktop X25519 public key, phone X25519 public key; corresponding values must differ |
| 9 | text, 128 | exact selected or synthetic ADB serial |
| 10 | text, 128 | product |
| 11 | text, 128 | device |
| 12 | u32 | API level |
| 13 | text, 512 | system fingerprint |
| 14 | text, 512 | vendor fingerprint |
| 15 | text, 255 | Android package name |
| 16 | u32 | Android version code |
| 17 | 32 bytes | SHA-256 of current signing certificate DER |
| 18 | 32 bytes | SHA-256 of canonical matched-artifact manifest bytes |
| 19 | u32 | desktop bootstrap version, exactly `2` |
| 20 | text, 64 | desktop package version |

`protocol/bootstrap-v2-vectors.properties` and `protocol/bootstrap-v2-negative.properties` are public synthetic corpora. They contain no private key or durable controller material.

### Negative mutation corpus grammar

Each nonblank line is `caseName=operation[;operation...]`. Names are unique. Decimal operands are canonical unsigned decimal (`0` or a nonzero digit followed by digits); hex is lowercase, even-length, and nonempty. The closed operation set is:

- `set:offset:hex`: replace the complete byte range at `offset`.
- `append:hex`: append bytes.
- `truncate:count`: remove a positive byte count from the end.
- `zero:offset:count`: zero a positive in-range byte range.
- `copy:source:destination:count`: copy a positive in-range byte range using snapshot semantics.
- `identity:field`: construct a valid transcript through the production encoder with exactly the named identity field changed. Fields are closed to those listed in the corpus.

Kotlin and Node test-only applicators reject empty, unknown, malformed, overflowing, out-of-range, or noncanonical operations. Structural operations must change the positive transcript bytes and then be rejected by the production decoder for the targeted framing, canonicalization, nonzero, or reflection rule. Identity operations must change the semantic identity; the production encoder builds the modified valid transcript and decoding against the original expected identity must reject it. The downgrade case is rejected by the production encoder because bootstrap version `2` is invariant. Both suites assert the exact shared case-name set and that every case ran, preventing skipped or vacuous malformed-hex cases.

## Identity and trust boundary

Linux must bind one exact selected authorized ADB serial and use `adb -s <serial>` for every command, forward, and transcript operation. Selection is not transferable between commands.

Android cannot attest the host ADB key or host-selected serial through `LocalSocket`. Android therefore relies on an explicit foreground Start action and the kernel-reported shell UID `2000`, while independently checking its local build product, device, API level, system and vendor fingerprints, installed package/version, exactly one current signing certificate, and canonical matched-manifest bytes. These checks do not turn the serial claim into Android-host attestation.

Lifecycle integration, two-phase commit, and physical-device qualification are outside this foundation and remain required before auto-pair is complete.
