package com.callagent.gateway.dialer

import java.io.File
import kotlin.math.max
import kotlin.math.min
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class DialerUiResourceTest {
    private val layout = File("src/main/res/layout/activity_dialer.xml").readText().replace("\r\n", "\n")
    private val strings = File("src/main/res/values/strings.xml").readText()
    private val themes = File("src/main/res/values/themes.xml").readText()
    private val tabText = File("src/main/res/color/tab_text.xml").readText()
    private val tabBackground = File("src/main/res/drawable/tab_button_bg.xml").readText()
    private val dayColors = colors("src/main/res/values/colors.xml")
    private val nightColors = colors("src/main/res/values-night/colors.xml")
    private val activity = File("src/main/java/com/callagent/gateway/dialer/DialerActivity.kt").readText()
    private val inCallLayout = File("src/main/res/layout/activity_in_call.xml").readText()
    private val acceptButton = File("src/main/res/drawable/call_accept_button_bg.xml").readText()
    private val endButton = File("src/main/res/drawable/call_end_button_bg.xml").readText()

    @Test
    fun `four tabs keep single line labels and accessible targets`() {
        assertTrue(themes.contains("<item name=\"android:layout_height\">48dp</item>"))
        assertTrue(themes.contains("<item name=\"android:maxLines\">1</item>"))
        assertTrue(themes.contains("<item name=\"android:layout_width\">0dp</item>"))
        assertTrue(themes.contains("<item name=\"android:layout_weight\">1</item>"))
        assertTrue(themes.contains("<item name=\"android:minWidth\">0dp</item>"))
        assertTrue(layout.contains("android:baselineAligned=\"false\""))
        assertTrue(themes.contains("<item name=\"android:paddingHorizontal\">0dp</item>"))
        assertFalse(layout.contains("<HorizontalScrollView"))
        assertFalse(themes.contains("autoSize"))
        assertTrue(spValue(themes, "android:textSize") >= 12f)
        assertTrue(layout.contains("android:text=\"@string/tab_contacts\""))
        assertTrue(layout.contains("android:text=\"@string/tab_recordings\""))
    }

    @Test
    fun `selected tab label meets contrast contract in day and night`() {
        assertTrue(tabText.contains("state_selected=\"true\" android:color=\"@color/tab_text_selected\""))
        assertTrue(tabBackground.contains("<solid android:color=\"@color/primary_soft\""))
        assertContrast(dayColors, "tab_text_selected", "primary_soft")
        assertContrast(dayColors + nightColors, "tab_text_selected", "primary_soft")
    }

    @Test
    fun `dialer status body meets size and contrast contract in day and night`() {
        assertTrue(layout.contains("android:textColor=\"@color/dialer_status_text\""))
        assertTrue(spValue(layout, "android:textSize", "tvDialerStatus") >= 14f)
        assertContrast(dayColors, "dialer_status_text", "background")
        assertContrast(dayColors + nightColors, "dialer_status_text", "background")
    }

    @Test
    fun `keypad panel scrolls vertically without changing its public id`() {
        assertTrue(layout.contains("<ScrollView\n            android:id=\"@+id/panelKeypad\""))
        assertTrue(layout.contains("android:fillViewport=\"true\""))
        assertTrue(activity.contains("dialNumber.showSoftInputOnFocus = false"))
        assertTrue(activity.contains("private lateinit var panelKeypad: ScrollView"))
    }

    @Test
    fun `dialer strings and symbolic keys expose resource backed labels`() {
        assertTrue(layout.contains("android:contentDescription=\"@string/dial_star_accessibility\""))
        assertTrue(layout.contains("android:contentDescription=\"@string/dial_hash_accessibility\""))
        assertTrue(layout.contains("android:textColor=\"@color/on_call_accept\""))
        assertFalse(layout.contains("android:text=\"Gateway\""))
        assertFalse(layout.contains("android:text=\"Phone ready\""))
    }

    @Test
    fun `idle status is neutral and resource backed`() {
        assertTrue(strings.contains("Phone available · gateway not ready"))
        assertTrue(activity.contains("getString(R.string.dialer_status_phone_available_gateway_not_ready)"))
        assertFalse(activity.contains("Phone ready · connect desktop to record calls"))
    }

    @Test
    fun `recordings tab has a structured empty state`() {
        assertTrue(activity.contains("addRecordingsIntro()"))
        assertTrue(activity.contains("addRecordingEmptyState()"))
        assertTrue(activity.contains("No recordings yet"))
        assertTrue(activity.contains("Verified copies synchronized from the desktop"))
    }

    @Test
    fun `recording cards hide internal identifiers and tabs reset list position`() {
        assertTrue(activity.contains("text = \"Call recording\""))
        assertTrue(activity.contains("recordingSize(entry.sizeBytes)"))
        assertFalse(activity.contains("text = entry.title"))
        assertTrue(activity.contains("panelList.post { panelList.scrollTo(0, 0) }"))
    }

    @Test
    fun `keypad and in call actions use explicit rounded surfaces`() {
        assertTrue(layout.contains("android:background=\"@drawable/call_accept_button_bg\""))
        assertTrue(layout.contains("android:background=\"@drawable/keypad_secondary_button_bg\""))
        assertTrue(inCallLayout.contains("android:background=\"@drawable/call_accept_button_bg\""))
        assertTrue(inCallLayout.contains("android:background=\"@drawable/call_end_button_bg\""))
        assertTrue(acceptButton.contains("android:radius=\"18dp\""))
        assertTrue(endButton.contains("android:radius=\"18dp\""))
    }

    private fun colors(path: String): Map<String, String> =
        Regex("<color name=\"([^\"]+)\">(#[0-9A-Fa-f]{6})</color>")
            .findAll(File(path).readText())
            .associate { it.groupValues[1] to it.groupValues[2] }

    private fun spValue(xml: String, attribute: String, after: String? = null): Float {
        val scoped = after?.let { xml.substring(xml.indexOf(it)) } ?: xml
        return Regex("""${Regex.escape(attribute)}(?:\">|=\")([0-9.]+)sp""")
            .find(scoped)?.groupValues?.get(1)?.toFloat()
            ?: error("Missing $attribute sp value")
    }

    private fun assertContrast(colors: Map<String, String>, foreground: String, background: String) {
        val ratio = contrast(colors.getValue(foreground), colors.getValue(background))
        assertTrue("$foreground on $background contrast was $ratio", ratio >= 4.5)
    }

    private fun contrast(first: String, second: String): Double {
        val a = luminance(first)
        val b = luminance(second)
        return (max(a, b) + 0.05) / (min(a, b) + 0.05)
    }

    private fun luminance(hex: String): Double {
        val channels = (1..5 step 2).map { hex.substring(it, it + 2).toInt(16) / 255.0 }
        val linear = channels.map { if (it <= 0.04045) it / 12.92 else Math.pow((it + 0.055) / 1.055, 2.4) }
        return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2]
    }
}
