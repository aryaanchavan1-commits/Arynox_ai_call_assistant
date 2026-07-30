# Android release-candidate artifacts

`build-artifacts.sh` accepts one already-built APK and produces the standalone APK plus a matched Magisk ZIP. It parses the APK with Android `aapt` and refuses a package or version mismatch before copying any release artifact.

For the current release candidate, the only accepted identity is `com.callagent.gateway` version `1.0.0` (`332`). The debug APK and its matched module are `QUALIFICATION_ONLY_DEBUG_SIGNED`, `Publishable: NO`; they must not be described or uploaded as production-signed artifacts.

The generated `ARTIFACT-STATUS.txt` records parsed identity, standalone and embedded APK hashes, and byte-equality status. `ANDROID-ROLLBACK-MANIFEST.txt` records the fail-closed downgrade policy and the operator-supplied facts required before rollback. `SHA256SUMS` covers the two installable artifacts.

The Magisk installer propagates `install_module` failure. `customize.sh` validates the embedded APK hash and refuses an in-place downgrade when an active module has a higher `versionCode`. A rollback must instead remove the module, reboot, verify package absence, and install a separately verified prior matched artifact. Never use `adb install -d` or a simultaneous standalone APK to bypass this gate.

Run:

    packaging/android/test-build-artifacts.sh

The test builds twice and byte-compares the APK, ZIP, status, rollback manifest, and checksum evidence. No test or build command installs to or mutates a phone.
