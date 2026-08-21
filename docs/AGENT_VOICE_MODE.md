# Arynox voice-agent mode

Arynox carries live cellular audio and semantic turns. Hermes or OpenClaw is
the conversational agent. Keep one agent session alive for the entire call so
its model context and MCP connection are not restarted between turns.

Do not run a complete call with a one-shot agent command. A one-shot command may
legitimately return after any model turn while the cellular call remains active,
leaving the caller with silence. On Linux, use the persistent Hermes stdio
gateway with Arynox's supervisor:

```bash
sudo -u "$USER" sg agentcall -c \
  'AGENTCALL_QUALIFICATION_CALL_APPROVED=yes \
   AGENTCALL_QUALIFICATION_PHONE=+15551234567 \
   AGENTCALL_OUTGOING_RECIPIENT_NAME="Recipient name" \
   AGENTCALL_OUTGOING_CALL_CONTEXT="Confirm the requested details and report the response." \
   npm --prefix pc/pc-gateway run qualify:hermes-voice'
```

The supervisor warms the user's normal Hermes configuration before dialing and
retains that session for context. Arynox, rather than the model, waits for
each completed caller turn. It sends the transcript directly into the existing
Hermes session and speaks the completed answer through one continuous TTS
request. The voice prompt asks for one to three concise, complete sentences so
replies remain useful without restarting prosody between fragments or dropping
the second thought. The opening that Arynox already played is included in
every turn prompt to prevent repeated greetings. One transient provider failure
gets a natural clarification and retry instead of immediately ending the call.
This removes a model tool-selection round while keeping consistent voice
prosody and Hermes as the conversational brain. It does not create a profile or
override the user's model. The managed voice subprocess loads only the
Arynox MCP surface and does not inject unrelated coding-workspace rules or
tools into telephone turns. The conversation still stays in one persistent
Hermes session for the entire call.
`HERMES_VOICE_MODEL` and `HERMES_VOICE_PROVIDER` are optional, explicit
qualification overrides only. Arynox continues to enforce consent, call
correlation, interruption cancellation, and the five-minute limit.

For AI-answered incoming calls, Arynox treats the saved desktop text as the
owner's authoritative receptionist context. The opening identifies itself as
the owner's AI call assistant when the owner's name is present, explains the
saved availability, and asks an unknown caller for their name and reason. The
persistent agent then collects only missing details—message, urgency and
callback confirmation—one focused question at a time. It reuses a saved contact
name and displayed callback number, accepts callers who decline to share
details, and confirms the collected message before closing. It must not invent
an availability, callback time, urgency or notification promise.

## Model and audio ownership

- Arynox does not hardcode a Hermes or OpenClaw model. An ordinary call uses
  the model/provider already active in the host agent. Model selection remains
  the user's responsibility in that agent's normal configuration.
- Do not route cellular PCM through the host agent's microphone-oriented voice
  mode. Arynox owns the continuous phone STT/TTS, 20 ms media framing, VAD,
  recording, and barge-in behavior.
- Arynox paces every synthesized frame on the 20 ms telephone clock. Provider
  streams can deliver audio much faster than real time; forwarding that burst
  directly would overflow the phone's bounded media queue and leave the caller
  hearing only the end of a greeting.
- Hermes or OpenClaw owns reasoning, conversation context, and semantic call
  control through MCP. This keeps Arynox plug-and-play and avoids running two
  competing STT/TTS and turn-detection pipelines.
- Qualification may report that a selected model is incompatible or too slow
  for a natural call, but it must not silently change the user's model.

To prefer a model already configured in Hermes for a qualification call, set
both values explicitly:

```bash
HERMES_VOICE_PROVIDER='configured-provider' \
HERMES_VOICE_MODEL='configured-fast-model' \
npm --prefix pc/pc-gateway run qualify:hermes-voice
```

The supervisor performs a read-only Arynox status tool call before dialing.
If the preferred model cannot use Arynox tools, it closes that session and
retries with the user's current/default Hermes model. Model names and providers
are never hardcoded or silently persisted.

## Recommended agent instruction

```text
Use only the local Arynox MCP tools for this call.

Hold a natural telephone conversation. Respond to the caller's actual intent,
not to the mechanics of the call. Use contractions and ordinary spoken
language. Start with the direct answer. Never answer with one or two words.
Use at least one complete sentence for a simple greeting or confirmation, and
normally two to four complete sentences with enough detail to answer properly.
Vary sentence rhythm naturally and do not end every reply with a question. Ask
at most one relevant follow-up question when it genuinely moves the
conversation forward. Do not repeat or summarize the caller unless it helps
clarify something. Do not use lists unless the caller asks for one. Do not
mention tools, qualification, transcription, latency, or being an AI unless the
caller asks. If a turn is genuinely unclear, ask a brief clarification instead
of guessing.

At the start of a call, greet the caller according to the gateway computer's
local time (good morning, good afternoon, or good evening). If Arynox exposes
a saved `contactName`, use the first name naturally once in the greeting. Never
guess a name.

Maintain conversational memory for the whole call: the caller's facts,
preferences, unresolved questions, and earlier topics remain available after
the topic changes. Give priority to the newest complete turn, but resolve
references such as "that", "earlier", or "what you said" from the prior call
context. Connect back naturally when relevant; do not recite the history.

When an external Hermes/OpenClaw agent is driving MCP directly, prepare a
complete context-specific opening and one to four likely complete replies before
calling dial. Arynox renders the opening before dialing, plays it once after
the media route is stable, and warms the likely replies while the phone rings.
When the next caller turn strongly matches a prepared reply, Arynox plays
that exact warmed reply itself. If `wait_for_turn` reports
`preparedReplySpoken: true`, do not call `speak` for that sequence; immediately
wait again. Generate a live reply only when Arynox has not already spoken.
Pass `autoPreparedReply: false` only when the external agent must own selection.
Keep the callId and latest sequence. Repeatedly call wait_for_turn with timeoutMs
30000; contextual acknowledgement is enabled by default. If it times out, wait
again. Answer each returned caller
turn with speak, its `sequence` as `respondingToSequence`, and a fresh
idempotency key. If speak reports `stale caller turn`, discard that draft
immediately, wait for the newer thought, and answer it. The managed Hermes
supervisor performs this waiting and stale-turn work outside the model, so its
per-turn prompt returns only the natural words to say and does not call a tool.
If speech reports `speech provider unavailable`, the failed stream has already
been aborted and the speech slot released. Re-read the latest turn and retry
once with a fresh key; never replay a receipt marked `preparedReplySpoken`.

For a managed outgoing call, Arynox creates a dynamic plan from the recipient,
call context, caller configuration, local time, and language, then renders the
recipient-verification opening before dialing. Identity
disclosure, purpose, first question, likely question answers, busy/callback
handling, clarification, voicemail, confirmation, and closing lines are
generated before dialing and their selected-voice audio is warmed while the
phone rings. Each prepared reply is a complete
one-to-three-sentence response, normally about 10 to 45 words.

The managed supervisor's prepared replies use semantic intent matching, not
exact caller phrases. They are used
only for strong matches such as recipient confirmation, identity, purpose,
repeat, busy, callback, hold, wrong-number, or stop-calling requests. A reply is
used at most once. Corrections, changed objectives, specific questions, and
unexpected turns go to the same persistent Hermes/OpenClaw session. The live
prompt receives the outgoing objective and a bounded ledger of both prepared
and live spoken turns, so preparation does not break conversational memory.
Wrong-number and stop-calling requests receive a complete apology or
acknowledgement and then end the call.

When the caller interrupts an answer, the next turn may include
`previousCallerText` and `interruptedAgentText`. Treat the interrupted agent
text as only partially heard. Continue from the useful context, answer the
caller's newest words directly, and do not restart or repeat the whole earlier
answer.

Arynox may play one or two short contextual acknowledgements while the model
is generating, such as "Sure, let me check that" followed by "I'm checking that
now." Do not repeat either acknowledgement when the full response is ready.
Continue immediately with the useful answer. Do not add another filler phrase.

Treat explicit goodbye, hang-up, or end-call language as terminal. Say one
brief, warm farewell, call hangup with a fresh idempotency key, and stop. End
the call after five minutes at most.
```

## AI answers incoming calls

Incoming-call answering is an explicit, local opt-in:

1. Open **Settings** in Arynox AI Call Assistant.
2. Turn on **AI answers incoming calls**.
3. Enter the context and boundaries Hermes or OpenClaw should follow, then
   save. For example: “I am in a meeting until 4 PM. Tell callers I will call
   back, collect their name and reason, and do not discuss project details.”
4. Keep Arynox AI Call Assistant open. It starts Hermes with the user's current
   provider/model, generates and renders the reusable opening and expected
   replies, keeps the session warm, and re-arms it after every call.
   OpenClaw can instead use the MCP receptionist loop below.

The setting is off by default. The managed Hermes listener stops when the mode
is turned off or Arynox AI Call Assistant exits, and restarts after an unexpected
agent exit. Enabling it does not bypass recording health,
speech-provider health, call correlation, or the normal answer policy. If no
agent listener is running, or if Arynox cannot start the mandatory recording
and speech session, the call is not silently answered.

```text
Act as my telephone receptionist through the local Arynox MCP server.

Repeatedly call wait_for_incoming_call with the latest afterSequence cursor and
timeoutMs 30000. If it returns disabled, stop and tell me receptionist mode is
off. If it times out, wait again.

When it returns an incoming call, treat `instructions` as the owner's
authoritative context and boundaries for this call. Use only the exposed
`contactName` and consented caller context; never guess a name or private fact.
Call answer once with the returned callId and a fresh idempotency key. If answer
is refused, do not keep retrying.

After a successful answer, greet the caller naturally according to local time.
Use the saved first name once when available. Briefly explain any owner context
that the instructions authorize, then follow those instructions. Repeatedly use
wait_for_turn and speak exactly as described in the main voice instruction.
Preserve earlier topics and interrupted-answer context, keep replies short and
natural, and hang up after a clear goodbye. Resume waiting for the next
incoming call only after the current call ends.
```

The bounded receptionist file is local to the gateway service and contains only
the enabled flag and the text entered in Settings. MCP never exposes a raw phone
number; it provides the saved contact name and consented caller memory when
available.

## Latency behavior

- When receptionist mode is enabled, the managed listener generates and renders
  reusable morning, afternoon, evening, and neutral-night openings from the
  saved owner context. It also renders complete expected replies for name,
  message, urgency, callback, privacy, identity, repeat, and closing branches.
  Every caller hears the same context-safe opening for that time period; saved
  caller identity remains available to Hermes after the opening. Saving new
  context or changing the TTS selection restarts preparation. The call is not
  answered until this audio is ready. If draft generation is unavailable, a
  bounded local context template still supplies the complete script.
- A final STT turn settles in 80 ms when complete, instead of taking a second
  model round-trip through `wait_for_turn`. Fragments of up to five words without
  a question or exclamation boundary receive a 650 ms continuation window, so
  phrases such as "Yeah, this is Siddharth speaking" become one thought instead
  of repeatedly cancelling otherwise valid replies.
- Punctuation-only duplicates and equivalent attention checks such as "hello",
  "hello, please speak", and "are you there" collapse into one turn. A warmed,
  protected attention reply confirms that Arynox is listening without
  restarting the greeting, identity disclosure, or call purpose. Noisy
  affirmations remain eligible for recipient confirmation, while substantive
  repetitions, corrections, and unexpected questions continue through Hermes
  with the full prior topic.
- Hermes `message.delta` output is observed for diagnostics while the model is
  generating. Arynox waits for the complete response and sends it through
  one continuous TTS request. Splitting a reply across independent TTS requests
  restarted prosody and could make adjacent replies sound as though they
  overlapped.
- Every TTS chunk is guarded by a three-second no-audio deadline. Arynox may
  retry once before any audio reaches the phone; after partial playback it
  never retries automatically, preventing doubled or overlapping speech.
- The first outgoing and incoming opening is one protected continuous segment.
  It is deliberately short, and early background/caller transcripts captured
  while it plays are discarded at the opening turn boundary. Normal caller
  barge-in is enabled immediately after the opening completes and applies to
  every later response.
- If the caller interrupts, Arynox cancels the active continuous TTS. The
  interrupted text and previous caller turn are included with the next prompt.
- Slow questions receive a short, prewarmed context-matched acknowledgement
  after about 250 ms of model time. If Hermes is still thinking after about
  2.2 seconds, Arynox may add one brief follow-up. A quick complete answer
  cancels both timers, active acknowledgement playback finishes before the
  answer begins, and a six-second cross-turn cooldown prevents filler stacking.
- Android writes a paced silent uplink frame between spoken segments. This
  keeps the telephony `AudioTrack` alive instead of letting it underrun and
  distort the beginning of the next greeting or reply.
- After a call becomes active, Arynox gives Android's telephony route a 250 ms
  safety margin for both incoming and outgoing calls before speaking the
  pre-rendered opening. The call is rechecked after the guard so a greeting is
  never sent to an ended call. Frame pacing, rather than extra startup silence,
  prevents the phone queue from losing the beginning of an utterance.
- Activating a TTS provider/model/voice prepares the standard local-time
  greeting and latency-bridge phrase sets for that exact voice. An outgoing dial and dynamic conversation
  plan start together. The recipient-verification opening plus the identity,
  purpose, repeat, and closing replies are synthesized while the phone is
  dialing. Other prepared text remains available but is synthesized only when
  used, preserving provider capacity for live replies and the final farewell. An
  incoming personalized opening is synthesized while the phone is
  still ringing. The managed receptionist waits 15 seconds from call detection
  before answering, uses a synchronized contact name only when one is available,
  and rechecks that the same call is still ringing before pickup. PCM is held
  in a small in-memory, voice-specific cache and
  plays immediately after the route guard. Changing the TTS provider, model,
  voice, or language rebuilds the runtime and regenerates the set.
- Direct requests such as "end this call" select the prepared complete farewell
  and hang up immediately after the farewell. Incomplete or incoherent
  recognition fragments are
  clarified instead of being treated as permission to invent support tickets,
  appointments, purchases, callbacks, or other actions outside the call
  objective.
  Context-specific audio is never persisted to disk.
- OpenAI realtime transcription enables the provider's `near_field` input-noise
  reduction before STT and supplies a bounded telephone prompt that excludes
  background noise, music, line echo, and synthetic speech from the other side.
  Provider-independent turn logic still requires stable speech and clarifies
  ambiguous text instead of guessing. Availability, time, or date statements
  bypass generic prepared replies so Hermes can answer the actual request.
- The same persistent Hermes session receives every caller turn, including the
  previous caller text and any interrupted agent text, so topic changes do not
  erase conversation context.
- Transient agent failures remain audible: Arynox gives up to three complete
  recovery prompts while keeping the call active. If the fourth consecutive
  response fails, it speaks a natural apology and farewell before hanging up;
  it never leaves repeated "Are you there?" turns in unexplained silence.
- Between turns, 12 seconds without caller speech triggers one natural
  "Are you still there?" check. A second silent window receives a complete
  farewell and hang-up instead of consuming the five-minute limit in silence.
- The existing 500 ms stable-silence boundary remains intentionally unchanged.
  Shortening it made pauses inside normal human speech look like completed
  turns.

For the lowest latency, select a fast model in the user's normal Hermes or
OpenClaw configuration. Arynox does not hardcode or silently replace that
model. The managed Hermes path explicitly skips MCP tool selection during
ordinary reply generation, while the generic OpenClaw path remains compatible
with `wait_for_turn` and `speak`.

## Relation to hosted voice-call products

[OpenClaw's official voice-call plugin](https://docs.openclaw.ai/plugins/reference/voice-call)
uses Twilio, Telnyx, or Plivo.
[Vapi's OpenClaw skills](https://vapi.ai/blog/openclaw) provision a hosted
assistant and telephone number. Those integrations validate the same realtime
design principles used here: a persistent media stream, incremental model
output, streamed TTS, and cancellation on interruption. Arynox intentionally
uses a different transport: the user's rooted Android phone, SIM, and USB audio
bridge. It therefore does not require a hosted phone number, Twilio media
stream, or Vapi subscription. Hermes/OpenClaw still connects through the local
Arynox MCP server for semantic call control.

The implementation also follows the interruption and persistent-session model
documented for
[OpenAI voice agents](https://openai.github.io/openai-agents-js/guides/voice-agents/build/)
and uses ElevenLabs' recommended
[Flash plus HTTP streaming path](https://elevenlabs.io/docs/api-reference/reducing-latency)
once a complete self-contained sentence is available. ElevenLabs recommends
its WebSocket input API when raw LLM tokens are sent incrementally, but also
warns that committing before a natural phrase boundary harms prosody. Arynox
therefore commits one complete sentence rather than forwarding partial words.
