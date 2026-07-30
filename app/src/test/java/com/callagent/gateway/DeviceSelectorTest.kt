package com.callagent.gateway

import org.junit.Test
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue

/**
 * Lane B — Phase-0 qualification.  Pure JVM tests for [DeviceSelector] and
 * [DeviceProfile.atollGram].  These run on the host JVM (no Android), so the
 * selector under test must not touch android.os.Build — it takes identity
 * strings as input.
 *
 * Hard safety invariants enforced here (RED first, GREEN after impl):
 *   - atoll/gram selection never emits destructive mixer writes
 *   - atoll/gram never sets an unverified HAL incall_music parameter
 *   - atoll/gram selection runs BEFORE the generic Qualcomm fallback
 *   - atoll/gram exposes capability metadata + read-only diagnostics
 */
class DeviceSelectorTest {

    // POCO M2 Pro, board/platform atoll, hw qcom, Android 15.
    private val atollGramIdentity = DeviceSelector.Identity(
        hardware = "qcom",
        board = "atoll",
        model = "POCO M2 Pro",
        device = "gram",
        apiLevel = 35,
        fingerprint = "lineage/miatoll/miatoll:15/AP3A.240905.015.A2/observed:userdebug/dev-keys",
        vendorFingerprint = DeviceSelector.APPROVED_GRAM_VENDOR_FINGERPRINT,
    )
    private val observedEvidence = ApprovedDeviceEvidence(
        observedSystemFingerprint = atollGramIdentity.fingerprint,
        observedVendorFingerprint = DeviceSelector.APPROVED_GRAM_VENDOR_FINGERPRINT,
        attestedOn = "2026-07-20",
        attestedSystemDescription = "Android 15 API 35 custom Lineage userdebug system",
        source = ApprovedDeviceEvidence.Source.EXTERNALLY_PROVISIONED,
    )

    @Test
    fun selectsAtollGramForAtollBoard() {
        val sel = DeviceSelector.select(atollGramIdentity, observedEvidence)
        assertEquals(DeviceSelector.ProfileId.ATOLL_GRAM, sel.profileId)
        assertNotNull(sel.evidence)
        assertTrue("evidence must mention board=atoll", sel.evidence!!.contains("atoll"))
    }

    @Test
    fun atollGramWinsOverGenericQualcommWhenBoardIsAtoll() {
        // hw=qcom alone would otherwise route to genericQualcomm, which blindly
        // mutes Voice Rx and forces incall_music.  Atoll must take precedence.
        val sel = DeviceSelector.select(atollGramIdentity, observedEvidence)
        assertFalse(
            "atoll board must NOT fall through to GENERIC_QUALCOMM",
            sel.profileId == DeviceSelector.ProfileId.GENERIC_QUALCOMM
        )
    }

    @Test
    fun atollGramRequiresEveryApprovedIdentityField() {
        val variants = listOf(
            atollGramIdentity.copy(board = "atoll-pro"),
            atollGramIdentity.copy(device = "gram_in"),
            atollGramIdentity.copy(model = "M2002J9B"),
            atollGramIdentity.copy(apiLevel = 34),
            atollGramIdentity.copy(fingerprint = "lineage/gram/gram:15/other"),
            atollGramIdentity.copy(vendorFingerprint = "other/vendor"),
        )
        variants.forEach { identity ->
            assertFalse(DeviceSelector.select(identity, observedEvidence).profileId == DeviceSelector.ProfileId.ATOLL_GRAM)
        }
    }

    @Test
    fun atollGramRejectsAbsentSelfAssertedOrMismatchedEvidence() {
        assertFalse(DeviceSelector.select(atollGramIdentity, null).profileId == DeviceSelector.ProfileId.ATOLL_GRAM)
        assertFalse(DeviceSelector.select(
            atollGramIdentity,
            observedEvidence.copy(observedSystemFingerprint = "other/system"),
        ).profileId == DeviceSelector.ProfileId.ATOLL_GRAM)
        assertFalse(DeviceSelector.select(
            atollGramIdentity,
            observedEvidence.copy(observedVendorFingerprint = "other/vendor"),
        ).profileId == DeviceSelector.ProfileId.ATOLL_GRAM)
        assertFalse(DeviceSelector.select(
            atollGramIdentity,
            observedEvidence.copy(attestedOn = "", attestedSystemDescription = ""),
        ).profileId == DeviceSelector.ProfileId.ATOLL_GRAM)
    }

    @Test
    fun genericQualcommStillUsedForUnrecognizedQcomBoard() {
        // Regression guard: a qcom board that is NOT atoll must still fall to
        // GENERIC_QUALCOMM so existing devices keep their behavior.
        val sel = DeviceSelector.select(
            DeviceSelector.Identity("qcom", "sm8150", "Other Qcom", "star")
        )
        assertEquals(DeviceSelector.ProfileId.GENERIC_QUALCOMM, sel.profileId)
    }

    @Test
    fun atollGramEmitsNoDestructiveMixerSetup() {
        val p = DeviceProfile.atollGram()
        assertTrue(
            "Phase-0 atoll/gram must not write mixer controls on setup",
            p.mixerSetupCmd.isEmpty()
        )
    }

    @Test
    fun atollGramEmitsNoDestructiveMixerRestore() {
        val p = DeviceProfile.atollGram()
        assertTrue(
            "Phase-0 atoll/gram must not write mixer controls on restore",
            p.mixerRestoreCmd.isEmpty()
        )
    }

    @Test
    fun atollGramEmitsNoIncallMusicMixerCommand() {
        val p = DeviceProfile.atollGram()
        assertTrue(
            "Phase-0 atoll/gram must not write the Incall_Music mixer blindly",
            p.mixerIncallMusicCmd.isEmpty()
        )
    }

    @Test
    fun atollGramSetsNoUnverifiedHalParameter() {
        // The device DOES expose incall_music uplink in policy, but the HAL
        // parameter name (if any) is not yet verified on this firmware.  An
        // empty param causes every setParameters() call site to skip.
        val p = DeviceProfile.atollGram()
        assertTrue(
            "Phase-0 atoll/gram must not set an unverified HAL param",
            p.incallMusicParam.isEmpty()
        )
    }

    @Test
    fun atollGramReportsQualifiedVoiceDownlink() {
        val p = DeviceProfile.atollGram()
        assertTrue("qualified full-duplex evidence includes digital downlink", p.voiceDownlinkWorks)
    }

    @Test
    fun atollGramExposesReadonlyDiagGrep() {
        val p = DeviceProfile.atollGram()
        // Diagnostics only: a tinymix read (no value arguments) piped to grep.
        assertTrue("diag grep must read tinymix", p.mixerDiagGrep.contains("tinymix"))
        assertFalse(
            "diag grep must not contain value-assignment writes",
            p.mixerDiagGrep.contains("' 1")
        )
    }

    @Test
    fun atollGramExposesCapabilityMetadata() {
        val p = DeviceProfile.atollGram()
        val cap = p.capabilities
        assertNotNull(cap)
        assertTrue("profile must advertise its platform", cap.platform.contains("atoll"))
        // Policy-confirmed facts from the device evidence (read-only metadata).
        assertTrue("incall_music uplink capability must be recorded", cap.incallMusicUplinkExposed)
        assertTrue("voice_rx capability must be recorded", cap.voiceRxExposed)
        assertTrue("exact profile evidence must record verified injection", cap.injectionVerified)
        assertFalse("must not claim destructive mixer writes are allowed", cap.mixerWritesAllowed)
    }
}
