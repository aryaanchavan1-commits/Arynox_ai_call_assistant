package com.callagent.gateway.usb

import java.io.File
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class UsbGatewayEnrollmentUxSecurityTest {
    @Test
    fun `non exported activity offers one tap automatic connect and stopped-only forget`() {
        val activity = File("src/main/java/com/callagent/gateway/usb/UsbGatewayActivity.kt").readText()
        val layout = File("src/main/res/layout/activity_usb_gateway.xml").readText()
        val manifest = File("src/main/AndroidManifest.xml").readText()

        assertTrue(layout.contains("@+id/btnUsbToggle"))
        assertTrue(layout.contains("@+id/btnControllerForget"))
        assertTrue(layout.contains("@+id/btnGithub"))
        assertTrue(layout.contains("<com.google.android.material.button.MaterialButton"))
        assertTrue(layout.contains("app:icon=\"@drawable/ic_github\""))
        assertTrue(layout.contains("Connect desktop"))
        assertFalse(layout.contains("Enroll controller"))
        assertFalse(layout.contains("Rotate credential"))
        assertTrue(activity.contains("GatewayUiState.Connection.STOPPED"))
        assertTrue(activity.contains("ControllerEnrollmentStore(AndroidControllerSecretStorage(this))"))
        assertTrue(activity.contains("showForgetConfirmation"))
        assertTrue(activity.contains("Intent.ACTION_VIEW"))
        assertTrue(activity.contains("https://github.com/sidinsearch/AgentCall"))
        assertTrue(activity.contains("enrollmentStore().revoke()"))
        assertTrue(manifest.contains("android:name=\".usb.UsbGatewayActivity\""))
        assertTrue(manifest.contains("android:exported=\"false\""))
    }

    @Test
    fun `pairing never displays or exports a controller secret`() {
        val activity = File("src/main/java/com/callagent/gateway/usb/UsbGatewayActivity.kt").readText()
        assertTrue(activity.contains("WindowManager.LayoutParams.FLAG_SECURE"))
        assertFalse(activity.contains("Base64"))
        assertFalse(activity.contains("showOneTimeSecret"))
        assertFalse(activity.contains("Controller credential — shown once"))
        assertFalse(activity.contains("ClipboardManager"))
        assertFalse(activity.contains("putExtra("))
        assertFalse(activity.contains("sendBroadcast("))
        assertFalse(activity.contains("Log."))
    }

    @Test
    fun `forget confirmation explains the authority that will be revoked`() {
        val activity = File("src/main/java/com/callagent/gateway/usb/UsbGatewayActivity.kt").readText()
        assertTrue(activity.contains("call control"))
        assertTrue(activity.contains("caller and call metadata"))
        assertTrue(activity.contains("bidirectional cellular call audio"))
        assertTrue(activity.contains("recording copies"))
        assertTrue(activity.contains("must pair again"))
    }
}
