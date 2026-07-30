# Shared Communications Product Design System

Status: implementation contract for Android and Electron

## Product character

AgentCall is a professional cellular-agent communications product. Its interaction model may feel familiar to users of Telegram Desktop and WhatsApp Desktop, but its visual identity, components, colors, names, and assets are original. Android and Electron must feel like two native clients of the same product—not unrelated applications and not one platform compressed into the other.

## Shared foundations

### Palette

- `accent-600`: `#087F8C` — primary product teal; active navigation, primary actions, focus rings.
- `accent-500`: `#0EA5A8` — connected media and live activity.
- `accent-100`: `#DDF7F5` — selected rows and low-emphasis accent surfaces.
- `ink-900`: `#162126` — primary text.
- `ink-600`: `#52636B` — secondary text.
- `surface-0`: `#FFFFFF` — active workspace/cards.
- `surface-1`: `#F6F8F9` — application canvas and list backgrounds.
- `surface-2`: `#E9EFF1` — dividers, inactive controls, compact chips.
- `healthy`: `#238636` — connected, recording healthy, verified.
- `degraded`: `#B7791F` — reconnecting, provider delay, incomplete noncritical state.
- `danger`: `#D93025` — hangup, reject, destructive actions, fail-closed recording.
- `info`: `#2563EB` — supplementary information and translation indicators.

Colors are semantic. Red is never decorative. State must also be communicated with text/iconography, not color alone.

### Typography

Use a crisp platform-native sans stack with equivalent hierarchy:

- display/app title: 22–24 px, semibold;
- workspace title/caller: 17–20 px, semibold;
- list primary text: 15–16 px, medium;
- body/transcript: 14–16 px, regular;
- metadata/status: 12–13 px, medium;
- identifiers/hashes: platform monospace, 12–13 px.

Android uses `sp`; Electron uses CSS pixels. Respect OS font scaling.

### Shape and spacing

- 4 px base spacing grid.
- Main interactive controls: at least 44×44 CSS px desktop and 48×48 dp Android.
- Component radius: 8 px compact controls, 12 px cards/dialogs, circular avatars and call controls.
- Structural separation uses subtle 1 px dividers and modest elevation. No heavy outlines, glass effects, or random gradients.
- Focus/selection must remain obvious in keyboard, mouse, and touch modes.

### Iconography

Use one original SVG/vector icon family:

- 20–24 px navigation/action icons;
- 2 px rounded stroke;
- filled variants only for selected navigation or critical call actions;
- identical concepts and silhouettes across platforms for Call, Transcript, Device, Agent/MCP, Recording, Policy, Speech, Settings, RX, and TX.

Do not ship Telegram or WhatsApp logos/assets.

## Shared information and state language

Canonical states and labels must match across platforms:

- USB: `Disconnected`, `Authorizing`, `Connecting`, `Connected`, `Unsupported device`.
- Call: `Idle`, `Incoming`, `Dialing`, `Ringing`, `Active`, `Ending`, `Ended`, `Failed`.
- Recording: `Checking`, `Healthy`, `Recording`, `Finalizing`, `Complete`, `Fail-closed`, `Incomplete`.
- Providers: `Not configured`, `Ready`, `Connecting`, `Streaming`, `Degraded`, `Unavailable`.
- MCP: `Stopped`, `Starting`, `Ready`, `Controller connected`, `Error`.

Never substitute optimistic labels for backend truth. Fixture/simulation mode is always persistent and visible.

## Shared communication components

### Identity rows

Every caller/call row uses the same hierarchy:

1. circular avatar/initial or unknown-caller glyph;
2. caller display name or redacted number;
3. direction/status preview;
4. time/duration;
5. recording, consent, unread, or failure badges.

Raw phone numbers are not exposed where policy requires redaction.

### Transcript timeline

- Caller and agent turns use distinct but restrained conversation bubbles.
- Original-language transcript is authoritative and visually primary.
- Translation is supplementary, smaller, and labeled with target language.
- Interim speech is visibly provisional; finalized speech is stable.
- System events (consent, recording, barge-in, provider switch) appear as centered timeline events, not speaker messages.
- Timestamps and confidence details remain available without dominating the conversation.

### Call controls

Shared order and semantics:

- incoming: Answer (primary/healthy), Reject (danger);
- active: Mute/agent pause, DTMF, details, Hang up (danger and most visually distinct);
- every destructive action has an accessible name and cannot be confused with a non-destructive action;
- recording fail-closed blocks Answer/Dial with an explicit reason and repair path.

### Health and route display

RX and TX are always shown independently. Device, provider, recording, and MCP health use the same badge vocabulary and icons on both platforms.

## Electron adaptation

- Three-pane communications layout: narrow navigation rail, searchable call list, active call/detail workspace.
- Optional right inspector for caller memory, device route, consent, recording integrity, and policy.
- Inspector collapses first at compact widths; call list collapses next with an explicit back path.
- Native menu and keyboard shortcuts supplement rather than replace visible controls.
- Renderer remains sandboxed and communicates through typed preload IPC only.

## Android adaptation

- Mobile-first hierarchy: top app bar, Calls/Live/Device primary destinations, native bottom navigation or navigation rail depending on width.
- Call list opens a full-screen call/detail surface; no compressed desktop panes.
- Details use native bottom sheets and dialogs with reachable actions.
- Permission, default-dialer/Telecom role, USB authorization, root/audio-route, and foreground-service states receive first-class screens.
- Persistent foreground notification uses the same caller/status/action semantics while following Android notification conventions.
- Material interaction behavior may be used, but token colors, typography hierarchy, icons, status language, transcript treatment, and call controls must match Electron.

## Required state screens on both platforms

- first launch/setup;
- no Android device;
- unauthorized ADB/USB;
- unsupported ROM/device profile;
- connected and idle;
- incoming call;
- active call;
- provider degraded/outage;
- recording fail-closed;
- no calls/recordings;
- permission denied;
- simulation/fixture mode.

## Verification gates

- Token names and semantic meanings match in Android resources and Electron CSS.
- Equivalent screenshots show recognizable shared identity and component hierarchy.
- Desktop controls are at least 44×44 px; Android controls are at least 48×48 dp.
- Text remains usable under OS scaling.
- Keyboard focus is visible on Electron; TalkBack labels and traversal are correct on Android.
- All state labels match this contract.
- No Telegram/WhatsApp proprietary assets, logos, colors, or copied layouts are shipped.
- Both apps truthfully distinguish simulated state from verified device/backend state.
