package com.callagent.gateway

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pure-logic tests for [DeviceProfile.selectProfile].
 *
 * The selection function takes raw hardware/board/model strings so it can be
 * exercised on the JVM without android.os.Build statics.  These tests lock
 * the device→profile routing table documented in [DeviceProfile.detect].
 */
class DeviceProfileTest {

    @Test
    fun `selects MSM8930 profile for S4 Mini board`() {
        val p = DeviceProfile.selectProfile(
            hw = "qcom",
            board = "MSM8930",
            model = "GT-I9195"
        )
        assertEquals("MSM8930 (S4 Mini)", p.name)
    }

    @Test
    fun `selects MSM8930 profile for qcom hardware with GT-I919 model`() {
        val p = DeviceProfile.selectProfile(
            hw = "qcom",
            board = "msm8960",
            model = "SCH-I605 GT-I9190"
        )
        assertEquals("MSM8930 (S4 Mini)", p.name)
    }

    @Test
    fun `selects Exynos 9820 profile for S10e`() {
        val p = DeviceProfile.selectProfile(
            hw = "exynos",
            board = "exynos9820",
            model = "SM-G970F"
        )
        assertEquals("Exynos 9820 (S10e)", p.name)
    }

    @Test
    fun `selects generic Qualcomm for qcom hardware on unknown board`() {
        val p = DeviceProfile.selectProfile(
            hw = "qcom",
            board = "sdm845",
            model = "Pixel 3"
        )
        assertEquals("Generic Qualcomm", p.name)
    }

    @Test
    fun `selects generic Exynos for samsung hardware on unknown board`() {
        val p = DeviceProfile.selectProfile(
            hw = "samsung",
            board = "universal2100",
            model = "SM-G998B"
        )
        assertEquals("Generic Exynos", p.name)
    }

    @Test
    fun `falls back to Generic profile for unknown hardware`() {
        val p = DeviceProfile.selectProfile(
            hw = "ranchu",
            board = "goldfish",
            model = "sdk_gphone64"
        )
        assertEquals("Generic", p.name)
    }

    @Test
    fun `selection is case-insensitive`() {
        val upper = DeviceProfile.selectProfile("QCOM", "MSM8930", "GT-I9195")
        val lower = DeviceProfile.selectProfile("qcom", "msm8930", "gt-i9195")
        assertEquals(upper.name, lower.name)
        assertEquals("MSM8930 (S4 Mini)", upper.name)
    }

    @Test
    fun `generic profile has no mixer commands`() {
        val p = DeviceProfile.selectProfile("unknown", "unknown", "unknown")
        assertTrue("generic setup should be empty", p.mixerSetupCmd.isEmpty())
        assertTrue("generic restore should be empty", p.mixerRestoreCmd.isEmpty())
    }
}
