package com.callagent.gateway.usb

import android.content.Context
import com.callagent.gateway.gsm.GsmCallManager

class AndroidTelecomPort(private val context: Context) : TelecomPort {
    override fun dial(destination: String): Boolean = runCatching {
        GsmCallManager.makeCall(context, destination)
    }.getOrDefault(false)

    override fun answer(): Boolean = withActiveCall {
        GsmCallManager.answerCall(it)
    }

    override fun reject(): Boolean = withActiveCall {
        GsmCallManager.rejectCall(it)
    }

    override fun hangup(): Boolean = withActiveCall {
        GsmCallManager.hangupCall(it)
    }

    override fun sendDtmf(digits: String): Boolean = runCatching {
        GsmCallManager.sendDtmf(digits)
    }.getOrDefault(false)

    private inline fun withActiveCall(action: (android.telecom.Call) -> Unit): Boolean {
        val call = GsmCallManager.activeCall ?: return false
        return runCatching { action(call); true }.getOrDefault(false)
    }
}
