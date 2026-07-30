# Third-party notices

AgentCall includes or interoperates with third-party components. Those
components remain under their own terms; `LICENSE` does not replace them.

## Included build and application components

| Component | Use | License | Source |
|---|---|---|---|
| Gradle wrapper | Android build bootstrap | Apache-2.0 | <https://github.com/gradle/gradle> |
| Android Material icons | Android interface symbols | Apache-2.0 | <https://github.com/google/material-design-icons> |
| Font Awesome Free | Android settings symbol | CC-BY-4.0 (icons) | <https://github.com/FortAwesome/Font-Awesome> |
| Magisk module installer | Privileged Android module bootstrap | GPL-3.0-only | <https://github.com/topjohnwu/Magisk> |
| Electron and Node.js packages | Desktop runtime and build dependencies | Per-package terms | `pc/pc-gateway/ui/package-lock.json` |
| `ws` | Local gateway WebSocket client support | MIT | `pc/pc-gateway/package-lock.json` |

The Magisk installer source URL and retrieval date are recorded in
`packaging/android/magisk-module-installer.sh`. Dependency lockfiles and the
generated CycloneDX SBOM are the authoritative component inventory for each
build.

## Brand assets and interoperability

Hermes, OpenClaw, OpenAI, ElevenLabs, Supertonic, Android, POCO, Xiaomi,
Qualcomm, and Samsung names and marks belong to their respective owners. They
identify supported integrations or qualification targets and do not imply
endorsement. Asset sources are recorded in
`pc/pc-gateway/ui/renderer/assets/BRAND-ASSETS.md`.

## Historical provenance

The accurate historical provenance and the licensing boundary for the private
migration are stated in `NOTICE`. Do not remove that notice or rewrite
third-party authorship.
