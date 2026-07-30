package com.callagent.gateway

/**
 * Pure, Android-free device selection.  Takes identity strings as input so it
 * is unit-testable on the host JVM (no android.os.Build dependency).
 * [DeviceProfile.detect] delegates here so the matching rules live in one
 * place and are covered by [DeviceSelectorTest].
 *
 * Matching order matters: the atoll/gram branch MUST precede the generic
 * Qualcomm branch, because atoll devices report hardware "qcom" and would
 * otherwise fall through to [ProfileId.GENERIC_QUALCOMM] — a profile that
 * blindly mutes Voice Rx and forces incall_music, which is unsafe on an
 * unverified platform.
 */
object DeviceSelector {
    const val APPROVED_GRAM_API = 35
    const val APPROVED_GRAM_VENDOR_FINGERPRINT =
        "POCO/gram_in/gram:12/RKQ1.211019.001/V14.0.5.0.SJPINXM:user/release-keys"


    /** Normalized device identity.  Inputs are lowercased internally. */
    data class Identity(
        val hardware: String,
        val board: String,
        val model: String,
        val device: String,
        val apiLevel: Int = -1,
        val fingerprint: String = "",
        val vendorFingerprint: String = "",
    )

    enum class ProfileId {
        MSM8930,
        EXYNOS9820,
        ATOLL_GRAM,
        GENERIC_QUALCOMM,
        GENERIC_EXYNOS,
        GENERIC,
    }

    /**
     * @param profileId selected profile
     * @param evidence short human-readable reason (board/device/hw/model) for
     *   diagnostics; never contains PII — only public Build.* identity fields.
     */
    data class Selection(
        val profileId: ProfileId,
        val evidence: String?,
    )

    fun select(id: Identity, evidence: ApprovedDeviceEvidence? = null): Selection {
        val hw = id.hardware.lowercase()
        val board = id.board.lowercase()
        val model = id.model.lowercase()
        val device = id.device.lowercase()
        val evidenceMatches = evidence != null &&
            evidence.source == ApprovedDeviceEvidence.Source.EXTERNALLY_PROVISIONED &&
            evidence.observedSystemFingerprint == id.fingerprint &&
            evidence.observedVendorFingerprint == id.vendorFingerprint &&
            evidence.attestedOn.isNotBlank() && evidence.attestedSystemDescription.isNotBlank()

        return when {
            // Production authorization is pinned to the exact qualified tuple.
            hw == "qcom" && board == "atoll" && model == "poco m2 pro" && device == "gram" &&
                id.apiLevel == APPROVED_GRAM_API && id.fingerprint.isNotBlank() &&
                id.vendorFingerprint == APPROVED_GRAM_VENDOR_FINGERPRINT && evidenceMatches ->
                Selection(
                    ProfileId.ATOLL_GRAM,
                    "exact approved gram/atoll API ${id.apiLevel} full-duplex evidence",
                )

            // A near-match to the production tuple is unsupported, not generic Qualcomm.
            board.contains("atoll") || device.contains("gram") || model.contains("poco m2 pro") ->
                Selection(ProfileId.GENERIC, "unapproved gram/atoll identity")

            // Samsung Galaxy S4 Mini (MSM8930 / WCD9304)
            board.contains("msm8930") || hw.contains("qcom") && model.contains("gt-i919") ->
                Selection(ProfileId.MSM8930, "board=$board model=${id.model}")

            // Samsung Galaxy S10e Exynos (Exynos 9820)
            board.contains("exynos9820") || hw.contains("exynos") && model.contains("sm-g970") ->
                Selection(ProfileId.EXYNOS9820, "board=$board model=${id.model}")

            // Generic Qualcomm — unverified incall_music path; legacy behavior.
            hw.contains("qcom") || hw.contains("qualcomm") ->
                Selection(ProfileId.GENERIC_QUALCOMM, "hw=$hw board=$board")

            // Generic Samsung Exynos
            hw.contains("exynos") || hw.contains("samsung") ->
                Selection(ProfileId.GENERIC_EXYNOS, "hw=$hw model=${id.model}")

            // Unknown device — minimal mixer interaction
            else -> Selection(ProfileId.GENERIC, "hw=$hw board=$board model=${id.model}")
        }
    }
}
