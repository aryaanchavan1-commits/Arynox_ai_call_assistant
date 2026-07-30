# Windows real-call qualification — 2026-07-23

This report records the physical Windows + POCO M2 Pro acceptance run performed from
`wt/desktop-complete-v1`. Phone numbers, contact data, provider credentials, transcript
text, and recording paths are intentionally omitted.

## Qualified tuple

- Windows desktop package: `agentcall Desktop 0.2.3`, unpacked and NSIS builds
- Android package: `com.callagent.gateway` `2.8.52 (330)`
- Phone: Xiaomi POCO M2 Pro, authenticated over the private USB/ADB bridge
- Cellular voice: BSNL Mobile
- STT: OpenAI `gpt-4o-transcribe`
- TTS: ElevenLabs `eleven_flash_v2_5`
- MCP: packaged Windows stdio bridge over the local named-pipe RPC service

## Physical results

Two consented outgoing cellular calls were placed from the final Windows package.

### Human PC-audio call

- The destination was resolved to the saved Android contact and displayed with the full
  number in Live Call.
- **Use PC audio** connected the Windows microphone and speakers without dropping the
  desktop call state.
- The call remained active, the gateway remained authenticated, and recording health
  remained `ok`.
- OpenAI STT produced a final remote transcript.
- The finalized recording was complete:
  - remote track: 12,545 frames;
  - PC/agent track: 10,623 frames;
  - outcome: `ended`;
  - failure reasons: none.

### MCP agent speech call

- The packaged MCP process initialized with protocol `2024-11-05` and reported the
  gateway as `running`.
- A fixed MCP `speak` turn and a response based on the caller's immediately preceding
  STT turn were both accepted and transmitted through ElevenLabs TTS.
- The call stayed active and recording-healthy after both agent turns.
- The finalized recording was complete:
  - remote track: 10,983 frames;
  - agent track: 589 frames;
  - transcript: 8 final entries (6 remote, 2 agent);
  - outcome: `ended`;
  - failure reasons: none.
- `conversation.mkv` decoded fully with the packaged FFmpeg (`exit 0`).

### Low-latency autonomous conversation qualification

- A reusable event-driven qualification client now consumes `transcript_final` RPC
  events directly instead of polling the recording filesystem.
- OpenAI `gpt-4o-mini` generated short conversational replies while the active desktop
  speech configuration continued to use OpenAI `gpt-4o-transcribe` for STT and
  ElevenLabs `eleven_flash_v2_5` with the configured voice for TTS.
- On the real Poco M2 Pro call, accepted reply turns measured 1.1-3.0 seconds for text
  generation and 1.6-3.4 seconds through accepted ElevenLabs playback, after the
  transcript event. A 650 ms turn-settling window was then added to combine natural
  short pauses; the later measured turns completed in 1.6-2.4 seconds after settling.
- The settled path correctly combined split phrases such as `Can you tell me` plus
  `more about India?` into one agent turn.
- Explicit goodbye/end-call phrases now trigger a short farewell followed by hang-up.
  Incidental uses of words such as `goodbye` do not end the call.
- Autonomous qualification calls have a five-minute maximum and send a farewell before
  the hard hang-up. Both policies have focused automated coverage.
- A later fresh-call attempt reached `dialing` but was not answered and therefore
  produced no active-call speech evidence.

## Defects found and fixed during the run

1. Arbitrary Web Audio microphone chunks were previously passed to a strict 640-byte
   transport/recording boundary. The renderer now frames microphone PCM into exact
   20 ms packets and applies bounded backpressure.
2. A recording filesystem write was incorrectly treated as all-or-nothing. Legal
   partial writes are now completed before counters advance; zero-progress writes still
   fail closed.
3. A media-write failure previously removed the whole live call from the desktop. Media
   now fails closed while the cellular call retains safe hang-up/reject controls.
4. Outgoing Android events did not repeat the destination, so Live Call could lose the
   contact name and number. The approved destination is now carried into the correlated
   call and resolved against the synchronized contact mirror.
5. The packaged MCP entrypoint compared Windows paths as malformed file URLs and exited.
   Entrypoint detection now uses native resolved paths and is covered by a Windows
   named-pipe subprocess smoke test.
6. ElevenLabs can end synthesis with fewer than 320 final samples. The realtime session
   now silence-pads that final audio into one exact transport frame instead of rejecting
   an otherwise valid utterance.
7. The earlier conversational test polled finalized transcript files, adding human-scale
   delay. The qualification path now subscribes to live RPC events and cancels stale
   reasoning when caller speech continues.
8. A 200 ms acoustic pause can legally produce several provider-final transcript
   fragments during natural speech. The conversational qualification client now settles
   and combines adjacent fragments before generating one reply.

## Automated evidence after the fixes

- Gateway: 354 tests, 349 passed, 5 platform skips, 0 failed.
- Desktop: 103 passed, 0 failed, plus JavaScript syntax checks.
- MCP Windows process smoke: initialize, named-pipe status, resource notification, and
  redaction passed.
- Android: debug unit tests, lint, and APK assembly passed.
- Packaged provider-pair test: passed.
- Credential-pattern scan of source changes: no match.
- `git diff --check`: passed.

## Qualification artifacts

- Windows NSIS installer SHA-256:
  `dc66033d52a2b877743b894a89adb05c7773b9577bd5e06c4327b95c7ceb7919`
- Android qualification APK SHA-256:
  `87029b87f0fc5233364a7d6cb9a22854736adb96f5e1fe194184c226eed183f5`
- Matched Magisk ZIP SHA-256:
  `2c67e65285bb297f5ce27173dd935a8f844526fbcebc27cef707e77e987fac35`
- The Magisk module's embedded APK is byte-identical to the standalone qualification APK.

## Remaining publication gates

This is a physically qualified release candidate, not a signed stable release.

- The Windows executable and installer are not Authenticode-signed.
- The Android APK and matched Magisk module use the qualification/debug signer; a stable
  Android signing identity was not supplied.
- A final Linux package lifecycle must be rebuilt and exercised on Linux from this exact
  source.
- A real incoming-call answer/reject/ring acceptance run remains open.
- USB/process interruption, screen-off/Doze, repeated-call, and one-hour thermal/resource
  soak tests remain open.
- Returning-caller memory is implemented as consent-bound, expiring, local context and is
  covered by automated MCP tests. It remains disabled by default until the operator
  explicitly configures memory consent; it was not enabled for this physical run.
- Hermes/OpenClaw supplies the conversational reasoning loop. agentcall provides the live
  call events, transcripts, consented context, and `speak` tool; it does not embed an
  autonomous general-purpose LLM.
