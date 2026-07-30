# AgentCall release status

Updated: 2026-07-30

## Classification

**Hardware-qualified v1.0.0 release**

- Desktop version: `1.0.0`
- Android version: `1.0.0 (332)`
- Reference phone: Xiaomi POCO M2 Pro (`gram`, Qualcomm `atoll`)
- Reference Android: tested Android 15 / API 35 build, Magisk 30.7,
  SELinux Enforcing
- Desktop hosts: Windows 10/11 x86-64 and Ubuntu/Debian-compatible x86-64
- Repository branch: `main`

The application, module, desktop packages, USB connection, providers, MCP, and
real cellular calls work on the reference setup. The distributed Android APK
uses the qualification/debug signing identity, and the Windows and Debian
packages are not platform/notary signed. They must not be represented as
app-store, Authenticode, or signed-repository artifacts.

## Current evidence

### Automated

- Gateway and MCP: 442 tests pass on Linux with 0 failures; 437 pass and 5
  platform-specific skips on Windows.
- Desktop: 108 tests and syntax checks pass on Windows and Linux.
- Android: unit tests, lint, manifest binding, and debug APK assembly are part
  of the canonical `verify.sh` gate.
- Packaging: deterministic Android APK/Magisk pairing, embedded APK byte
  equality, permission boundaries, Debian extraction, systemd, local RPC, and
  packaged MCP are release gates.
- GitHub Actions reruns `verify.sh` on every `main` push.

### Physical Windows and POCO M2 Pro

- Authenticated USB pairing and reconnect.
- Saved-contact identity in calls and Live Call.
- PC microphone and speaker mode.
- OpenAI STT and ElevenLabs TTS.
- Packaged Windows MCP initialization and agent speech.
- Complete local recording and in-app playback/export.
- Recording synchronization to Android.

See
[`release/windows-real-call-qualification-2026-07-23.md`](release/windows-real-call-qualification-2026-07-23.md).

### Physical Linux and POCO M2 Pro

- Final unified Debian installed and services active.
- Phone authenticated and gateway phase `ready`.
- GNOME resolves the packaged AgentCall launcher icon from standard 16 through
  512 px hicolor entries instead of falling back to a generic gear.
- The packaged desktop played a verified WAV in-app, saved a 1,602,638-byte
  copy through the native dialog, and synchronized the same finalized
  recording to Android.
- Repeated Play/Save export of the same recording is idempotent, and failed
  automatic phone copies retry while the same authenticated phone remains
  connected as well as after reconnect.
- OpenAI `gpt-4o-transcribe` healthy.
- ElevenLabs `eleven_flash_v2_5` healthy with zero-retention configuration.
- Hermes managed voice call placed through the installed package.
- The final accepted outgoing call began agent audio after approximately
  0.179 seconds on the recorded active-call timeline.
- Live Hermes replies were ready in approximately 0.76-1.13 seconds.
- The call retained context, spoke complete responses, and ended through the
  explicit `agent_hangup` farewell path. The human receiver confirmed that the
  call was perfect.
- Incoming AI receptionist audio and answer behavior were physically iterated
  on the same phone; the final incoming opening was clear and the handling flow
  was accepted before the final outgoing latency/closing pass.

The final release note records the exact commit and checksums used for published
artifacts.

## MCP acceptance

- Server identity: `agentcall-mcp`
- Protocol: MCP `2024-11-05`
- Transport: local stdio to local Unix socket/named pipe
- Tools: status, capabilities, incoming wait, turn wait, dial, speech
  preparation, answer, reject, hang-up, DTMF, and speak
- Canonical resources: `agentcall://...`
- MCP namespace: only the five canonical `agentcall://...` resources are
  readable, subscribable, and advertised
- Privacy: explicit schemas prevent PCM, provider keys, raw ADB data, private
  paths, contact rows, and raw phone numbers from leaving the gateway

See [MCP.md](MCP.md).

## Remaining distribution gates

These do not block private qualification use on the tested setup, but they do
block claims of broad store-ready production distribution:

| Gate | Status |
|---|---|
| Operator-controlled Android production signer and migration plan | Not supplied |
| Windows Authenticode signing | Not supplied |
| Signed Debian repository/package provenance | Not supplied |
| Broad device support beyond the documented POCO tuple | Not qualified |
| One-hour physical call/thermal/resource soak | Not completed |
| Full USB/process-death/screen-off matrix on the final published hashes | Partial |
| Independent external security/package scanners | Optional tools not all available |

## Release rule

Every GitHub Release must:

1. point at one immutable `main` commit;
2. include Windows, Debian, APK, and matched Magisk artifacts;
3. validate and publish the SHA-256 digest of every downloadable artifact;
4. state the signing/classification honestly;
5. prove the Magisk-embedded APK is byte-identical to the standalone APK;
6. contain no provider keys, ADB keys, controller credentials, contacts,
   recordings, or private phone identifiers.
