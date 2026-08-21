package com.callagent.gateway.usb

import android.Manifest
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Bundle

import android.view.View
import android.view.WindowManager
import android.widget.Button
import android.widget.TextView
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import com.callagent.gateway.BuildConfig
import com.callagent.gateway.R
import com.callagent.gateway.gsm.GsmCallManager

class UsbGatewayActivity : AppCompatActivity() {
    private lateinit var badge: TextView
    private lateinit var connection: TextView
    private lateinit var detail: TextView
    private lateinit var toggle: Button
    private lateinit var device: TextView
    private lateinit var telecom: TextView
    private lateinit var audio: TextView
    private lateinit var recording: TextView
    private lateinit var controllerStatus: TextView
    private lateinit var controllerForget: Button
    private lateinit var callCard: View
    private lateinit var callState: TextView
    private lateinit var callNumber: TextView
    private lateinit var answer: Button
    private lateinit var reject: Button
    private lateinit var hangup: Button
    private lateinit var github: Button

    private val receiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) = render(GatewayStateStore.snapshot())
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Production builds block screenshots and screen sharing. Debug builds stay
        // inspectable so release UI reviews can capture the real device safely.
        if (!BuildConfig.DEBUG) window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        setContentView(R.layout.activity_usb_gateway)
        bindViews()
        toggle.setOnClickListener {
            if (GatewayStateStore.snapshot().connection in setOf(
                    GatewayUiState.Connection.STOPPED,
                    GatewayUiState.Connection.ERROR,
                )
            ) {
                requestPermissionsOrStart()
            } else UsbGatewayService.stop(this)
        }
        answer.setOnClickListener { GsmCallManager.answerCall() }
        reject.setOnClickListener { GsmCallManager.rejectCall() }
        hangup.setOnClickListener { GsmCallManager.hangupCall() }
        controllerForget.setOnClickListener { showForgetConfirmation() }
        github.setOnClickListener {
            runCatching {
                startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(PROJECT_URL)))
            }
        }
        render(GatewayStateStore.snapshot())
    }

    private fun bindViews() {
        badge = findViewById(R.id.tvUsbBadge)
        connection = findViewById(R.id.tvUsbConnection)
        detail = findViewById(R.id.tvUsbDetail)
        toggle = findViewById(R.id.btnUsbToggle)
        device = findViewById(R.id.tvDeviceGate)
        telecom = findViewById(R.id.tvTelecomGate)
        audio = findViewById(R.id.tvAudioGate)
        recording = findViewById(R.id.tvRecordingGate)
        controllerStatus = findViewById(R.id.tvControllerEnrollment)
        controllerForget = findViewById(R.id.btnControllerForget)
        callCard = findViewById(R.id.callCard)
        callState = findViewById(R.id.tvCallState)
        callNumber = findViewById(R.id.tvCallNumber)
        answer = findViewById(R.id.btnAnswer)
        reject = findViewById(R.id.btnReject)
        hangup = findViewById(R.id.btnHangup)
        github = findViewById(R.id.btnGithub)
    }

    override fun onStart() {
        super.onStart()
        ContextCompat.registerReceiver(this, receiver, IntentFilter(GatewayStateStore.ACTION_STATE), ContextCompat.RECEIVER_NOT_EXPORTED)
        render(GatewayStateStore.snapshot())
    }

    override fun onStop() {
        unregisterReceiver(receiver)
        super.onStop()
    }

    private fun visiblePermissions(): List<String> = buildList {
        add(Manifest.permission.READ_PHONE_STATE)
        add(Manifest.permission.CALL_PHONE)
        add(Manifest.permission.ANSWER_PHONE_CALLS)
        add(Manifest.permission.RECORD_AUDIO)
        add(Manifest.permission.READ_CONTACTS)
        add(Manifest.permission.READ_CALL_LOG)
        if (android.os.Build.VERSION.SDK_INT >= 33) add(Manifest.permission.POST_NOTIFICATIONS)
    }

    private fun requestPermissionsOrStart() {
        val missing = visiblePermissions().filter {
            ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED
        }
        if (missing.isEmpty()) UsbGatewayService.start(this)
        else ActivityCompat.requestPermissions(this, missing.toTypedArray(), 27183)
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode != 27183) return
        if (GatewayPermissionGate.mayStart(grantResults.map { it == PackageManager.PERMISSION_GRANTED }) &&
            visiblePermissions().all { ContextCompat.checkSelfPermission(this, it) == PackageManager.PERMISSION_GRANTED }
        ) {
            UsbGatewayService.start(this)
        } else {
            GatewayStateStore.update(this, GatewayUiEvent.Error("Required phone and audio permission denied; tap Start to retry"))
            render(GatewayStateStore.snapshot())
        }
    }

    private fun render(state: GatewayUiState) {
        connection.text = state.connectionLabel
        detail.text = state.detail
        badge.text = when {
            state.readyForArynoxs -> "Ready for agent calls"
            state.desktopConnected -> "Desktop connected"
            state.connection == GatewayUiState.Connection.LISTENING_USB -> "Waiting for desktop"
            else -> "USB gateway stopped"
        }
        toggle.text = if (state.connection in setOf(GatewayUiState.Connection.STOPPED, GatewayUiState.Connection.ERROR)) {
            "Connect desktop"
        } else {
            "Disconnect desktop"
        }
        device.text = "Device · ${state.device.model} (${state.device.codename}) · ${state.device.qualification}"
        telecom.text = "Telecom · ${label(state.telecom)}"
        audio.text = "Digital audio · RX ${label(state.audioRx)} · TX ${label(state.audioTx)}"
        recording.text = "Desktop recording · ${label(state.recording)}"
        val stopped = state.connection == GatewayUiState.Connection.STOPPED
        val enrolled = enrollmentStore().isEnrolled()
        controllerStatus.text = if (enrolled) "Desktop · PAIRED" else "Desktop · PAIRS AUTOMATICALLY ON CONNECT"
        controllerForget.isEnabled = stopped && enrolled
        callCard.visibility = if (state.call.phase == GatewayUiState.CallPhase.IDLE) View.GONE else View.VISIBLE
        callState.text = state.call.phase.name.replace('_', ' ')
        callNumber.text = state.call.displayNumber
        answer.visibility = if (state.call.canAnswer) View.VISIBLE else View.GONE
        reject.visibility = if (state.call.canReject) View.VISIBLE else View.GONE
        hangup.visibility = if (!state.call.canAnswer && state.call.phase != GatewayUiState.CallPhase.ENDED) View.VISIBLE else View.GONE
    }

    private fun label(health: GatewayUiState.Health): String = when (health) {
        GatewayUiState.Health.HEALTHY -> "HEALTHY"
        GatewayUiState.Health.DEGRADED -> "LIMITED"
        GatewayUiState.Health.FAIL_CLOSED -> "NOT READY"
        GatewayUiState.Health.UNKNOWN -> "UNKNOWN"
    }

    private fun enrollmentStore(): ControllerEnrollmentStore =
        ControllerEnrollmentStore(AndroidControllerSecretStorage(this))

    private fun requireStopped(): Boolean =
        GatewayStateStore.snapshot().connection == GatewayUiState.Connection.STOPPED

    private fun showForgetConfirmation() {
        if (!requireStopped()) return
        AlertDialog.Builder(this)
            .setTitle("Forget paired desktop")
            .setMessage(
                "This revokes call control, caller and call metadata, bidirectional cellular call audio, " +
                    "and recording copies for the paired desktop. You must pair again with Connect desktop."
            )
            .setNegativeButton("Cancel", null)
            .setPositiveButton("Forget") { _, _ ->
                if (requireStopped()) {
                    enrollmentStore().revoke()
                    render(GatewayStateStore.snapshot())
                }
            }
            .show()
    }

    private companion object {
        const val PROJECT_URL = "https://github.com/sidinsearch/Arynox"
    }
}
