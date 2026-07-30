# AgentCall recording, playback, and branding qualification

Initial qualification: 2026-07-23
Latest Linux recheck: 2026-07-29
Branch: `main`

## Public brand

The public product name is **AgentCall** on Android, Windows, Linux, the Magisk
module, MCP setup guidance, release assets, and primary documentation.

The following legacy identifiers intentionally remain for upgrade and protocol
compatibility:

- Android package: `com.callagent.gateway`
- Magisk module ID: `agentcall-privileged`
- daemon environment variables and private state paths prefixed `AGENTCALL_`
- Linux service account, systemd unit, and private RPC/storage paths
- selected upgrade-compatible private Linux paths and environment variables

These identifiers are not product UI. Renaming them without a staged migration
would orphan installed modules, controller pairing state, provider credentials,
and recordings.

## Application icon

The supplied teal handset artwork is the single AgentCall icon source at
`app/artwork/agentcall-app-icon.png`.

- Android includes density-specific legacy square and round launchers plus a
  safe-zone adaptive foreground and matching diagonal background.
- Windows embeds a multi-resolution ICO in the packaged executable and
  installer.
- Linux packages hicolor launcher icons at 16, 24, 32, 48, 64, 96, 128, 256,
  and 512 px so GNOME and other desktop shells resolve the AgentCall mark.
- Android and desktop in-app brand marks use the same artwork.
- The final Android icon was visually checked on the connected POCO M2 Pro.
- The final Windows executable icon was extracted from the rebuilt package and
  checked at small and large sizes.

## Recording changes

- Finalization now creates `conversation.wav` in addition to the archival
  `conversation.mkv`.
- Both sides are silence-padded and the mixed review artifact is trimmed to the
  longer track, so a short agent response no longer truncates the caller side.
- Phone sync transfers the verified WAV with its declared size, SHA-256, and
  full duration.
- Android publishes the copy in `Recordings/AgentCall` as `audio/wav`.
- Android playback is in-app with play, pause/resume, seek, elapsed time, delete,
  and Storage Access Framework **Save a copy**.
- Desktop playback uses a time-limited local custom media URL and an embedded
  HTML audio player. No arbitrary filesystem path is exposed to the renderer.
- Desktop **Save a copy** uses the native save dialog and copies only a
  daemon-authorized, integrity-verified recording.
- Linux playback and save use a service-owned, digest-verified export beneath
  `/run/agentcall/recording-exports`; private recording directories stay
  inaccessible to the unprivileged UI. Repeated export of the same artifact is
  safe and idempotent.
- Desktop **Sync to phone** retries a finalized copy only while the authenticated
  phone is connected and no call is active.
- Failed automatic copy schedules bounded retries while the same phone remains
  connected and remains queued for the next authenticated reconnect.
- Phone publication failures are logged locally and the desktop status keeps a
  bounded public failure reason.

## Physical recording proof

A 30-second consented real call (`54a39755-08be-45ac-9034-74cf4d5bbe6e`)
produced a mixed WAV on both surfaces. The desktop artifact and
`/sdcard/Recordings/AgentCall/AgentCall-54a39755-08be-45ac-9034-74cf4d5bbe6e.wav`
had the same SHA-256:

`97e6bce1fca63f654d2582ee637f77df172d648b821dd534b9c9332e8c7cb028`

Playback was exercised in the Android app and the packaged Windows desktop
player. Desktop **Save a copy** opened the native destination dialog.

On 2026-07-29 the rebuilt unified Debian package was installed over the
qualified Linux system. The POCO M2 Pro authenticated with recording health
`ok` and `recording_sync_v1` ready. The packaged desktop played a finalized WAV
inline, saved a 1,602,638-byte WAV through the native dialog, and received a
phone storage receipt for that same byte count. Android displayed the
synchronized recordings with in-app Play and Save controls. Captures used in
the README contain no caller names or phone numbers.

## Call behavior retained

- Live finalized-transcript subscription instead of transcript-file polling.
- Short low-latency spoken responses using the configured STT and TTS pair.
- ElevenLabs Flash v2.5 remains the configured realtime voice path.
- Caller turn settling, interruption cancellation, explicit goodbye hang-up,
  and a five-minute maximum automated call duration.

## Release classification

All unsigned desktop packages and debug-signed Android/Magisk artifacts remain
**qualification prerelease** assets. They must not be described as a stable
production release until platform signing and the remaining physical soak gates
are complete.
