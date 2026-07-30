package com.callagent.gateway.dialer

data class DialerCallState(
    val callId: String?,
    val number: String,
    val direction: Direction?,
    val phase: Phase,
) {
    enum class Direction { INCOMING, OUTGOING }
    enum class Phase { IDLE, RINGING, DIALING, ACTIVE, HOLDING, ENDING, ENDED }

    val canAnswer: Boolean get() = phase == Phase.RINGING
    val canReject: Boolean get() = phase == Phase.RINGING
    val canHangup: Boolean get() = phase in setOf(Phase.DIALING, Phase.ACTIVE, Phase.HOLDING, Phase.ENDING)

    fun incoming(id: String, fullNumber: String) = copy(
        callId = id,
        number = fullNumber,
        direction = Direction.INCOMING,
        phase = Phase.RINGING,
    )

    fun outgoing(id: String, fullNumber: String) = copy(
        callId = id,
        number = fullNumber,
        direction = Direction.OUTGOING,
        phase = Phase.DIALING,
    )

    fun change(next: Phase) = copy(phase = next)

    companion object {
        fun idle() = DialerCallState(null, "", null, Phase.IDLE)
    }
}

object DialerCallStateStore {
    const val ACTION_STATE = "com.callagent.gateway.DIALER_CALL_STATE"
    private val lock = Any()
    @Volatile private var current = DialerCallState.idle()

    fun snapshot(): DialerCallState = current

    fun update(next: DialerCallState) {
        synchronized(lock) { current = next }
    }

    fun clear() = update(DialerCallState.idle())
}
