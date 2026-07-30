package com.callagent.gateway.gsm

import android.content.Intent
import android.telecom.Call
import android.telecom.InCallService
import android.util.Log
import com.callagent.gateway.dialer.DialerCallState
import com.callagent.gateway.dialer.DialerCallStateStore
import com.callagent.gateway.dialer.InCallActivity
import com.callagent.gateway.usb.RedactingLog

/**
 * InCallService implementation: intercepts all GSM calls on the device.
 *
 * When registered as the default dialer (or with BIND_INCALL_SERVICE permission
 * on rooted device), Android routes all call events through this service.
 *
 * Based on the telon-org/react-native-tele InCallService approach.
 */
class GsmCallService : InCallService() {

    override fun onCallAdded(call: Call) {
        super.onCallAdded(call)
        val number = call.details?.handle?.schemeSpecificPart ?: "unknown"
        val state = call.state
        Log.i(TAG, "Call added: number=${RedactingLog.redactPhone(number)} state=$state")

        call.registerCallback(callCallback)
        GsmCallManager.onCallAdded(call, this)
        publish(call, state, openUi = true)
    }

    override fun onCallRemoved(call: Call) {
        super.onCallRemoved(call)
        Log.i(TAG, "Call removed")
        call.unregisterCallback(callCallback)
        DialerCallStateStore.update(DialerCallStateStore.snapshot().change(DialerCallState.Phase.ENDED))
        sendBroadcast(Intent(DialerCallStateStore.ACTION_STATE).setPackage(packageName))
        GsmCallManager.onCallRemoved(call)
    }

    private val callCallback = object : Call.Callback() {
        override fun onStateChanged(call: Call, state: Int) {
            val stateStr = when (state) {
                Call.STATE_DIALING -> "DIALING"
                Call.STATE_RINGING -> "RINGING"
                Call.STATE_ACTIVE -> "ACTIVE"
                Call.STATE_HOLDING -> "HOLDING"
                Call.STATE_DISCONNECTED -> "DISCONNECTED"
                Call.STATE_CONNECTING -> "CONNECTING"
                Call.STATE_DISCONNECTING -> "DISCONNECTING"
                Call.STATE_SELECT_PHONE_ACCOUNT -> "SELECT_ACCOUNT"
                else -> "UNKNOWN($state)"
            }
            Log.i(TAG, "Call state changed: $stateStr")
            GsmCallManager.onCallStateChanged(call, state)
            publish(call, state, openUi = state == Call.STATE_RINGING || state == Call.STATE_DIALING)
        }
    }

    private fun publish(call: Call, telecomState: Int, openUi: Boolean = false) {
        val number = call.details?.handle?.schemeSpecificPart ?: "Unknown"
        val id = GsmCallManager.activeCallId ?: DialerCallStateStore.snapshot().callId ?: "active"
        val existing = DialerCallStateStore.snapshot()
        val phase = when (telecomState) {
            Call.STATE_RINGING -> DialerCallState.Phase.RINGING
            Call.STATE_DIALING, Call.STATE_CONNECTING, Call.STATE_SELECT_PHONE_ACCOUNT -> DialerCallState.Phase.DIALING
            Call.STATE_ACTIVE -> DialerCallState.Phase.ACTIVE
            Call.STATE_HOLDING -> DialerCallState.Phase.HOLDING
            Call.STATE_DISCONNECTING -> DialerCallState.Phase.ENDING
            Call.STATE_DISCONNECTED -> DialerCallState.Phase.ENDED
            else -> existing.phase
        }
        val base = if (existing.callId == id) existing else if (telecomState == Call.STATE_RINGING) {
            DialerCallState.idle().incoming(id, number)
        } else {
            DialerCallState.idle().outgoing(id, number)
        }
        DialerCallStateStore.update(base.change(phase))
        sendBroadcast(Intent(DialerCallStateStore.ACTION_STATE).setPackage(packageName))
        if (openUi) {
            startActivity(
                Intent(this, InCallActivity::class.java)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP),
            )
        }
    }

    companion object {
        private const val TAG = "GsmCallService"
    }
}
