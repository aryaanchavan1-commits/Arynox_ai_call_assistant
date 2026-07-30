package com.callagent.gateway.gsm

import android.content.Context
import android.content.Intent
import android.media.AudioManager
import android.net.Uri
import android.telecom.Call
import android.telecom.CallAudioState
import android.telecom.InCallService
import android.util.Log
import com.callagent.gateway.DeviceProfile
import com.callagent.gateway.ApprovedDeviceEvidenceProvider
import java.util.UUID

/**
 * GSM call manager: answers/makes/hangs up GSM calls, tracks state.
 *
 * Calls are controlled through the InCallService (GsmCallService).
 * Audio routing uses device-specific mixer controls via [DeviceProfile].
 *
 * Host agent→cellular: AudioTrack (USAGE_MEDIA / deep-buffer) → incall_music →
 * HAL injects STREAM_MUSIC digitally into voice TX (uplink).
 *
 * Cellular→host agent: VOICE_CALL capture provides digital call audio.
 *
 * Production uses Android audio APIs only. Historical device profile mixer
 * metadata is never executed by the app.
 */
object GsmCallManager {

    private const val TAG = "GsmCallManager"

    @Volatile private var evidenceProvider = ApprovedDeviceEvidenceProvider { null }

    /** Exact gram authorization always crosses the provisioned provider. */
    val profile: DeviceProfile get() = DeviceProfile.detect(evidenceProvider)

    fun setApprovedDeviceEvidenceProvider(provider: ApprovedDeviceEvidenceProvider) {
        evidenceProvider = provider
    }

    // Current active GSM call
    @Volatile var activeCall: Call? = null; private set
    @Volatile var activeCallState: Int = Call.STATE_NEW; private set
    @Volatile var activeCallId: String? = null; private set
    @Volatile var inCallService: InCallService? = null; private set

    @Volatile var listener: Listener? = null
    private val outgoingOwnership = OutgoingCallOwnership()

    fun isGatewayOutgoingCall(call: Call): Boolean = outgoingOwnership.isOwned(call)

    fun cancelPendingGatewayDial() = outgoingOwnership.rejectPending()

    /** Optional callback for routing bounded audio diagnostics to the native UI. */
    @Volatile var logCallback: ((String) -> Unit)? = null

    /** Log to both Android logcat AND the app log viewer. */
    private fun appLog(msg: String) {
        Log.i(TAG, msg)
        logCallback?.invoke(msg)
    }

    interface Listener {
        /** Incoming GSM call ringing — caller number provided */
        fun onIncomingGsmCall(call: Call, number: String)
        /** GSM call connected (active) */
        fun onGsmCallActive(call: Call)
        /** GSM call state changed */
        fun onGsmCallStateChanged(call: Call, state: Int)
        /** GSM call ended */
        fun onGsmCallEnded(call: Call)
    }

    // ── InCallService callbacks ─────────────────────────

    fun onCallAdded(call: Call, service: InCallService) {
        inCallService = service
        activeCall = call
        activeCallId = UUID.randomUUID().toString()
        activeCallState = call.state

        val number = call.details?.handle?.schemeSpecificPart ?: "unknown"
        if (call.state == Call.STATE_DIALING || call.state == Call.STATE_CONNECTING || call.state == Call.STATE_ACTIVE) {
            outgoingOwnership.claim(call, number)
        }

        when (call.state) {
            Call.STATE_RINGING -> {
                Log.i(TAG, "Incoming GSM call from ${com.callagent.gateway.usb.RedactingLog.redactPhone(number)}")
                // Silence the ringtone on this dedicated gateway device. The
                // call is never auto-answered; desktop policy must explicitly answer.
                try {
                    val am = service.getSystemService(Context.AUDIO_SERVICE) as AudioManager
                    am.setStreamVolume(AudioManager.STREAM_RING, 0, 0)
                } catch (e: Exception) {
                    Log.w(TAG, "Ringer silence failed: ${e.message}")
                }
                listener?.onIncomingGsmCall(call, number)
            }
            Call.STATE_DIALING, Call.STATE_CONNECTING -> {
                Log.i(TAG, "Outgoing GSM call to ${com.callagent.gateway.usb.RedactingLog.redactPhone(number)}")
                listener?.onGsmCallStateChanged(call, call.state)
            }
            Call.STATE_ACTIVE -> {
                Log.i(TAG, "GSM call active: ${com.callagent.gateway.usb.RedactingLog.redactPhone(number)}")
                configureAudioBridge()
                listener?.onGsmCallActive(call)
            }
        }
    }

    fun onCallRemoved(call: Call) {
        Log.i(TAG, "GSM call removed")
        if (activeCall == call) {
            activeCall = null
            activeCallId = null
            activeCallState = Call.STATE_DISCONNECTED
        }
        outgoingOwnership.release(call)
        restoreAudio()
        listener?.onGsmCallEnded(call)
    }

    fun onCallStateChanged(call: Call, state: Int) {
        activeCallState = state
        if (state == Call.STATE_DIALING || state == Call.STATE_CONNECTING || state == Call.STATE_ACTIVE) {
            val number = call.details?.handle?.schemeSpecificPart ?: "unknown"
            outgoingOwnership.claim(call, number)
        }

        when (state) {
            Call.STATE_RINGING -> {
                // Handle calls that arrive as STATE_NEW in onCallAdded and
                // transition to RINGING via the callback.  Without this,
                // the orchestrator never learns about the incoming call.
                val number = call.details?.handle?.schemeSpecificPart ?: "unknown"
                Log.i(TAG, "GSM call ringing: ${com.callagent.gateway.usb.RedactingLog.redactPhone(number)} (via state change)")
                listener?.onIncomingGsmCall(call, number)
            }
            Call.STATE_ACTIVE -> {
                Log.i(TAG, "GSM call active")
                configureAudioBridge()
                listener?.onGsmCallActive(call)
            }
            Call.STATE_DISCONNECTED -> {
                Log.i(TAG, "GSM call disconnected")
                listener?.onGsmCallEnded(call)
                if (activeCall == call) {
                    activeCall = null
                    activeCallId = null
                }
            }
        }
        listener?.onGsmCallStateChanged(call, state)
    }

    // ── Call control ────────────────────────────────────

    /** Answer a ringing GSM call */
    fun answerCall(call: Call? = activeCall) {
        call?.let {
            Log.i(TAG, "Answering GSM call")
            it.answer(it.details.videoState)
        }
    }

    /** Reject a ringing GSM call */
    fun rejectCall(call: Call? = activeCall) {
        call?.let {
            Log.i(TAG, "Rejecting GSM call")
            it.reject(false, "")
        }
    }

    /** Hang up active GSM call */
    fun hangupCall(call: Call? = activeCall) {
        call?.let {
            Log.i(TAG, "Hanging up GSM call")
            it.disconnect()
        }
    }

    fun sendDtmf(digits: String, call: Call? = activeCall): Boolean {
        val target = call ?: return false
        for (digit in digits) {
            target.playDtmfTone(digit)
            target.stopDtmfTone()
        }
        return true
    }

    /** Place one authenticated outgoing GSM call via the SIM. */
    fun makeCall(context: Context, destination: String): Boolean {
        if (!outgoingOwnership.arm(destination)) return false
        Log.i(TAG, "Making GSM call to ${com.callagent.gateway.usb.RedactingLog.redactPhone(destination)}")
        val intent = Intent(Intent.ACTION_CALL, Uri.parse("tel:$destination"))
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        return try {
            context.startActivity(intent)
            true
        } catch (error: Exception) {
            outgoingOwnership.rejectPending()
            throw error
        }
    }

    /** Music volume percent — from device profile. */
    val MUSIC_VOL_PERCENT: Int get() = profile.musicVolPercent

    /** Configure audio for the cellular↔USB bridge using the active device profile. */
    private fun configureAudioBridge() {
        try {
            inCallService?.let { service ->
                val audioManager = service.getSystemService(Context.AUDIO_SERVICE) as? AudioManager

                // Device-specific HAL/mixer controls are delayed until the
                // digital audio bridge is established. Setting them before
                // capture can kill VOICE_CALL capture on historical profiles.

                if (profile.requireSpeakerMode) {
                    service.setAudioRoute(CallAudioState.ROUTE_SPEAKER)
                }

                audioManager?.let { am ->
                    // Do NOT set isMicrophoneMute = true here!
                    // v2.8.50: Samsung Exynos HAL interprets mic mute as "mute
                    // entire voice uplink to modem", which blocks NSRC-injected
                    // AudioTrack audio from reaching the caller.
                    // MSM8930: mic muting is handled at ALSA level (DEC MUX=ZERO,
                    // MICBIAS=0) in mixerSetupCmd — no need for API-level mute.
                    am.isMicrophoneMute = false
                    enforceVolumes(am)

                    // Delay mixer/volume setup until speaker route change settles.
                    Thread({
                        try {
                            Thread.sleep(profile.routeChangeDelayMs)
                            enforceVolumes(am)
                        } catch (_: Exception) {}
                    }, "VolEnforce").start()

                    // Samsung Exynos re-route dance REMOVED (v2.8.39):
                    // v2.8.38 tried earpiece→speaker re-route at t=3s to force HAL
                    // voice path recreation with incall_music ausage.  Results:
                    //   - Audio moved from speaker to earpiece and STAYED there
                    //   - 300ms delay was insufficient for route to settle
                    //   - No incall_music mixer controls exist on Exynos 9820 anyway
                    //     (confirmed: 1267 tinymix controls, zero match incall/inject)
                    //   - No ausage config files on this firmware
                    // The re-route served no purpose and broke speaker mode.

                    val route = if (profile.requireSpeakerMode) "speaker" else "earpiece"
                    appLog("Audio bridge: $route, mode=${am.mode}, profile=${profile.name}")
                }
            }
        } catch (e: Exception) {
            Log.e(TAG, "Failed to configure audio: ${e.message}")
        }
    }

    /** Set audio stream volumes for the cellular↔USB bridge.
     * Called immediately and again after the delayed route change. */
    fun enforceVolumes(am: AudioManager) {
        // Clear any stale ADJUST_MUTE flag from a previous call.
        // CRITICAL: Do NOT use ADJUST_MUTE on STREAM_VOICE_CALL — on
        // MSM8930 it kills the incall_music injection path, preventing
        // the agent's audio from reaching the GSM caller.  Speaker
        // silencing is handled by muteVoiceRx() at the ALSA mixer level.
        try {
            am.adjustStreamVolume(AudioManager.STREAM_VOICE_CALL, AudioManager.ADJUST_UNMUTE, 0)
        } catch (_: SecurityException) {}
        // Voice call volume: controls caller's voice on speaker.
        // MSM8930: minimum (1) — speaker silenced by muteVoiceRx via tinymix.
        // Exynos 9820: 80% — no muteVoiceRx, need loud speaker for mic capture.
        // Volume=0 can confuse audio policy into treating call as inactive.
        try {
            val vcVol = if (profile.voiceCallVolPercent > 0) {
                val maxVc = am.getStreamMaxVolume(AudioManager.STREAM_VOICE_CALL)
                (maxVc * profile.voiceCallVolPercent / 100).coerceAtLeast(1)
            } else {
                1
            }
            am.setStreamVolume(AudioManager.STREAM_VOICE_CALL, vcVol, 0)
        } catch (_: SecurityException) {}
        // Music stream controls incall_music injection level into
        // the modem uplink.  Lower value = quieter speaker + quieter
        // agent voice for the GSM caller.
        val maxMusic = am.getStreamMaxVolume(AudioManager.STREAM_MUSIC)
        val musicVol = (maxMusic * MUSIC_VOL_PERCENT / 100).coerceAtLeast(1)
        am.setStreamVolume(AudioManager.STREAM_MUSIC, musicVol, 0)
        // Read back actual values to confirm they stuck
        val actualVoice = am.getStreamVolume(AudioManager.STREAM_VOICE_CALL)
        val actualMusic = am.getStreamVolume(AudioManager.STREAM_MUSIC)
        val muted = am.isStreamMute(AudioManager.STREAM_VOICE_CALL)
        appLog("Vol: voice=$actualVoice(m=$muted), music=$actualMusic/$maxMusic(target=$musicVol)")
    }

    /** Restore audio state when call ends */
    private fun restoreAudio() {
        try {
            inCallService?.let { service ->
                service.setAudioRoute(CallAudioState.ROUTE_EARPIECE)

                val audioManager = service.getSystemService(Context.AUDIO_SERVICE) as? AudioManager
                audioManager?.let { am ->
                    am.isMicrophoneMute = false
                    // Clear incall_music HAL parameter for clean state on next call
                    if (profile.incallMusicParam.isNotEmpty()) {
                        am.setParameters("${profile.incallMusicParam}=false")
                    }

                    // Unmute voice call stream and restore volume for normal phone use
                    try {
                        am.adjustStreamVolume(AudioManager.STREAM_VOICE_CALL, AudioManager.ADJUST_UNMUTE, 0)
                    } catch (_: SecurityException) {}
                    try {
                        val maxVc = am.getStreamMaxVolume(AudioManager.STREAM_VOICE_CALL)
                        am.setStreamVolume(AudioManager.STREAM_VOICE_CALL, (maxVc * 2 / 3).coerceAtLeast(1), 0)
                    } catch (_: SecurityException) {}
                    Log.i(TAG, "Audio restored: earpiece, VoiceRx unmuted, echoRef=SLIM_RX, incall_music=false")
                }
            }
        } catch (e: Exception) {
            Log.e(TAG, "Failed to restore audio: ${e.message}")
        }
    }

    /** Check if a GSM call is currently active */
    val isCallActive: Boolean
        get() = activeCall != null && activeCallState == Call.STATE_ACTIVE

    /** Get current call number */
    val currentNumber: String?
        get() = activeCall?.details?.handle?.schemeSpecificPart
}
