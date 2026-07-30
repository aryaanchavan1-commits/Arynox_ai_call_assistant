package com.callagent.gateway.dialer

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Bundle
import android.view.View
import android.widget.Button
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import com.callagent.gateway.R
import com.callagent.gateway.gsm.GsmCallManager

class InCallActivity : AppCompatActivity() {
    private lateinit var name: TextView
    private lateinit var number: TextView
    private lateinit var state: TextView
    private lateinit var answer: Button
    private lateinit var reject: Button
    private lateinit var end: Button
    private lateinit var keypad: View

    private val receiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) = render()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_in_call)
        name = findViewById(R.id.tvInCallName)
        number = findViewById(R.id.tvInCallNumber)
        state = findViewById(R.id.tvInCallState)
        answer = findViewById(R.id.btnInCallAnswer)
        reject = findViewById(R.id.btnInCallReject)
        end = findViewById(R.id.btnInCallEnd)
        keypad = findViewById(R.id.inCallKeypad)
        answer.setOnClickListener { GsmCallManager.answerCall() }
        reject.setOnClickListener { GsmCallManager.rejectCall() }
        end.setOnClickListener { GsmCallManager.hangupCall() }
        DTMF_BUTTONS.forEach { (id, digit) ->
            findViewById<Button>(id).setOnClickListener { GsmCallManager.sendDtmf(digit) }
        }
        render()
    }

    override fun onStart() {
        super.onStart()
        ContextCompat.registerReceiver(
            this,
            receiver,
            IntentFilter(DialerCallStateStore.ACTION_STATE),
            ContextCompat.RECEIVER_NOT_EXPORTED,
        )
        render()
    }

    override fun onStop() {
        unregisterReceiver(receiver)
        super.onStop()
    }

    private fun render() {
        val call = DialerCallStateStore.snapshot()
        val contactName = ContactResolver.displayName(this, call.number)
        name.text = contactName ?: getString(R.string.unknown_caller)
        number.text = call.number
        state.text = when (call.phase) {
            DialerCallState.Phase.RINGING -> getString(R.string.incoming_call)
            DialerCallState.Phase.DIALING -> getString(R.string.calling)
            DialerCallState.Phase.ACTIVE -> getString(R.string.call_active)
            DialerCallState.Phase.HOLDING -> getString(R.string.call_on_hold)
            DialerCallState.Phase.ENDING -> getString(R.string.ending_call)
            DialerCallState.Phase.ENDED -> getString(R.string.call_ended)
            DialerCallState.Phase.IDLE -> getString(R.string.no_active_call)
        }
        answer.visibility = if (call.canAnswer) View.VISIBLE else View.GONE
        reject.visibility = if (call.canReject) View.VISIBLE else View.GONE
        end.visibility = if (call.canHangup) View.VISIBLE else View.GONE
        keypad.visibility = if (call.phase == DialerCallState.Phase.ACTIVE) View.VISIBLE else View.GONE
    }

    private companion object {
        val DTMF_BUTTONS = mapOf(
            R.id.btnDtmf1 to "1", R.id.btnDtmf2 to "2", R.id.btnDtmf3 to "3",
            R.id.btnDtmf4 to "4", R.id.btnDtmf5 to "5", R.id.btnDtmf6 to "6",
            R.id.btnDtmf7 to "7", R.id.btnDtmf8 to "8", R.id.btnDtmf9 to "9",
            R.id.btnDtmfStar to "*", R.id.btnDtmf0 to "0", R.id.btnDtmfHash to "#",
        )
    }
}
