# AgentCall MCP guide

## Boundary

AgentCall implements MCP protocol `2024-11-05` over local stdio. The MCP process
connects to the local AgentCall gateway through a Unix socket on Linux or a
named pipe on Windows.

There is no MCP HTTP server and no remote listener. MCP does not carry audio,
ADB frames, provider keys, recording bytes, contact rows, or raw phone numbers.

## Register with Hermes

Linux:

```bash
hermes mcp add agentcall --command /usr/bin/agentcall-mcp
hermes mcp test agentcall
hermes mcp list
```

Windows:

1. Open **AgentCall Desktop -> MCP**.
2. Copy the displayed `agentcall-mcp.cmd` path.
3. Register that exact path as a local stdio MCP command.
4. Do not configure a URL or the Linux `/usr/bin` path.

OpenClaw uses the same stdio command definition.

## Tools

| Tool | Purpose |
|---|---|
| `status {}` | Redacted connection, call, recording, and realtime state |
| `capabilities {}` | Available semantic operations and policy gates |
| `wait_for_incoming_call { afterSequence, timeoutMs? }` | Wait for an opted-in incoming receptionist call and receive bounded instructions/context |
| `wait_for_turn { callId, afterSequence, timeoutMs?, autoAcknowledge?, autoPreparedReply? }` | Receive each final remote turn exactly once; strong warmed matches and delayed contextual acknowledgement are on by default |
| `dial { destination, openingText, preparedReplies, approved, consent, idempotencyKey }` | Render the opening, then place a policy-approved recorded call and play it once when active |
| `prepare_speech { callId, texts }` | Queue bounded likely speech without blocking the live agent |
| `answer { callId, idempotencyKey }` | Answer the correlated incoming call |
| `reject { callId, idempotencyKey }` | Reject the correlated incoming call |
| `hangup { callId, idempotencyKey }` | End the correlated call |
| `send_dtmf { callId, digits, idempotencyKey }` | Send bounded DTMF |
| `speak { callId, text, respondingToSequence?, idempotencyKey }` | Speak one complete correlated reply |

All schemas are strict and reject unknown fields. Mutations require bounded
idempotency keys. `dial` requires strict E.164, explicit approval, recording
consent, one complete context-specific opening, and one to four complete likely
replies. AgentCall renders the opening before touching the phone, warms the
likely replies while it rings, correlates the exact new call instead of a
previous ended call, and plays the opening once only after recording and
realtime media both report ready. Gateway policy remains authoritative.

An accepted `dial` returns `nextAction: "wait_for_turn"` and
`afterSequence: 0`. Do not end the agent turn after dialing: remain attached to
the call and alternate `wait_for_turn` and `speak` until `wait_for_turn` reports
that the call ended. For live dialogue, pass the last `wait_for_turn.sequence` as
`respondingToSequence`. AgentCall rejects a stale answer if the caller has
already begun a newer turn.

## Resources

Advertised canonical resources:

- `agentcall://gateway/status`
- `agentcall://gateway/capabilities`
- `agentcall://calls/current`
- `agentcall://events/recent`
- `agentcall://phone-data/status`

The resources use explicit bounded output schemas. `phone-data/status` returns
only collection state, counts, and synchronization timestamps.

Only the five canonical `agentcall://` resource URIs are readable,
subscribable, and advertised.

## Agent conversation loop

1. Read `status` and `capabilities`.
2. For outgoing calls, first write a complete context-specific opening and one
   to four likely complete replies. Pass them to `dial` only after the user has
   supplied the destination, objective, approval, and recording consent.
3. Keep the returned call ID and turn sequence.
4. Call `wait_for_turn`.
5. If the receipt has `preparedReplySpoken: true`, the exact warmed response has
   already played. Do not call `speak` for that sequence; immediately wait
   again. Otherwise produce a concise but complete spoken response using the
   full call objective, prior conversation, and newest caller turn.
6. Call `speak` with `respondingToSequence`.
7. Repeat until the call ends.
8. When the caller clearly says goodbye or asks to end the call, speak one warm
   farewell and call `hangup`.

The context-matched latency bridge is enabled by default. It starts one short
prewarmed acknowledgement after about 250 ms and may add one brief follow-up
after about 2.2 seconds when the full answer is still pending. Set
`autoAcknowledge: false` only when the external agent provides its own latency
bridge. Both stages are rate limited, cancelled by a quick response, serialized
before the full answer, and not used for greetings, urgent turns, or goodbyes.

Automatic strong-match prepared speech is also enabled by default. Set
`autoPreparedReply: false` to keep selection entirely in the external agent.
Prepared candidates are single-use; ambiguous or unexpected turns always fall
back to live reasoning. TTS streams have a three-second no-audio watchdog and
one safe retry before any audio is sent. A repeated stall releases the speech
slot and returns `speech provider unavailable` instead of blocking later MCP
commands.
The prepared opening is protected from barge-in so its greeting and authorized
context play once without a clipped beginning or ending. Normal interruption
handling starts as soon as that opening completes.

## Incoming receptionist loop

1. The desktop operator explicitly enables **AI answers incoming calls** and
   saves bounded instructions.
2. Call `wait_for_incoming_call` with a cursor.
3. AgentCall returns an event only while the mode is enabled. It may include a
   saved contact name and consented expiring caller context.
4. Answer only the returned call ID.
5. Use `wait_for_turn` and `speak` as above.
6. Capture the requested message, urgency, callback number, and confirmation
   according to the operator's instructions.

The managed desktop supervisor prepares the context-based morning, afternoon,
evening, and neutral-night openings when AI pickup is enabled, along with common
name, message, urgency, callback, privacy, repeat, identity, and closing
responses. It reuses those selected-voice clips for all callers and falls back
to live Hermes for anything that does not safely match. Saving new receptionist
context or changing the TTS selection regenerates the prepared audio.

## Verification

Source:

```bash
cd pc/pc-gateway
npm test
npm run check
node test/process-smoke.mjs
```

Installed Linux package:

```bash
hermes mcp test agentcall
/usr/bin/agentcall-mcp
```

The packaged release test initializes MCP, lists the exact tools and canonical
resources, reads every resource, verifies subscriptions, exercises mutation
denials/idempotency, and scans receipts for private or credential-shaped data.
