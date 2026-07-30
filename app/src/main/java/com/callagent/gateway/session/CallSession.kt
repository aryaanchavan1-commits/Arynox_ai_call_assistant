package com.callagent.gateway.session

/**
 * Pure reducer state machine for one USB↔cellular gateway call.
 *
 * This is the call-agent FSM: a direct USB agent (no SIP, no Asterisk, no RTP,
 * no sockets) bridges audio between a USB-attached host agent and the phone's
 * cellular modem. The reducer is deterministic: (state, command) -> (state',
 * effects). No side effects; the orchestrator owns I/O and applies effects.
 *
 * States (one entry per phase, no overloaded meanings):
 *  - IDLE           : no call. The only state a new call can start from.
 *  - RINGING        : inbound cellular call ringing; agent not yet answered.
 *  - DIALING        : outbound cellular call being placed.
 *  - ACTIVE_NO_MEDIA: cellular call connected, USB media not yet streaming.
 *  - STREAMING       : cellular connected AND USB media flowing (audio bridged).
 *  - TEARING_DOWN   : end requested, orchestrator is hanging up + releasing.
 *  - ERROR          : unrecoverable failure; RecoverFromError is the only exit.
 *
 * Invariants enforced by the reducer:
 *  - A new call may start only from IDLE (or ERROR via RecoverFromError -> IDLE).
 *  - Media (STREAMING) requires BOTH an active cellular call AND USB media
 *    ready; either missing keeps the call in ACTIVE_NO_MEDIA. Media never starts
 *    before the cellular call is connected, so audio is never bridged onto a
 *    call that does not yet exist.
 *  - USB media loss is a typed transition, not an exception. The caller chooses
 *    a [UsbLossPolicy]: preserve the cellular call (drop to ACTIVE_NO_MEDIA) or
 *    hang it up (full teardown). There is exactly one teardown path.
 *  - Every mutating command carries an idempotency key ([dialKey]). A duplicate
 *    key in a non-IDLE state replays the prior outcome (no-op ack) instead of
 *    starting a second call or throwing. A different key while non-IDLE is a
 *    typed rejection ([CallReject.NotIdle]), not an exception.
 *  - Invalid transitions return a typed [CallReject] so the orchestrator can
 *    route, log, and retry without try/catch on a control path.
 *
 * ponytail: a sealed when over (state, command). One synchronized monitor is
 * NOT used here because the reducer is pure — the orchestrator that owns the
 * session serializes commands. If a future lane shares a session across
 * threads, wrap the holder, not this reducer.
 */
data class CallSession(
    val sessionId: Int,
    val state: CallState,
    val dialKey: String?,
    val cellularActive: Boolean,
    val usbMediaReady: Boolean,
    /** Signature of the last accepted command, used for exact replay suppression. */
    val lastCommandSignature: String?,
) {
    companion object {
        fun create(sessionId: Int): CallSession =
            CallSession(
                sessionId,
                CallState.IDLE,
                dialKey = null,
                cellularActive = false,
                usbMediaReady = false,
                lastCommandSignature = null,
            )
    }

    /**
     * Apply [command] and return either the next [Accepted] state+effects, or a
     * typed [CallReject] describing why the command was refused. Never throws
     * for a control-flow reason.
     */
    fun reduce(command: CallCommand): CallResult {
        // The dial key identifies one call, not every step in its lifecycle.
        // Only an exact repeat of the last accepted command is suppressed.
        val signature = command.signature()
        if (signature == lastCommandSignature && state != CallState.IDLE) {
            return Accepted(this, effects = emptyList(), replayed = true)
        }
        // A second start request may never attach itself to a live call.
        if (
            state != CallState.IDLE &&
            (command is CallCommand.StartInbound || command is CallCommand.StartOutbound)
        ) {
            return CallReject.NotIdle(state, sessionId, requireNotNull(command.dialKey))
        }
        val result = when (command) {
            is CallCommand.StartInbound -> startInbound(command)
            is CallCommand.AcknowledgeInbound -> acknowledgeInbound(command)
            is CallCommand.StartOutbound -> startOutbound(command)
            is CallCommand.DialOutbound -> dialOutbound(command)
            is CallCommand.ActivateCellular -> activateCellular(command)
            is CallCommand.StartUsbMedia -> startUsbMedia(command)
            is CallCommand.StopUsbMedia -> stopUsbMedia(command)
            is CallCommand.EndCall -> endCall(command)
            is CallCommand.RecoverFromError -> recoverFromError(command)
        }
        return if (result is Accepted) {
            result.copy(session = result.session.copy(lastCommandSignature = signature))
        } else {
            result
        }
    }

    // ---- inbound ----

    private fun startInbound(c: CallCommand.StartInbound): CallResult {
        if (state != CallState.IDLE) return CallReject.NotIdle(state, sessionId, c.dialKey)
        val next = copy(state = CallState.RINGING, dialKey = c.dialKey)
        return Accepted(next, listOf(CallEffect.NotifyAgentInbound(c.dialKey)))
    }

    private fun acknowledgeInbound(c: CallCommand.AcknowledgeInbound): CallResult {
        if (state != CallState.RINGING) return CallReject.NotRinging(state, sessionId)
        // Agent answered the inbound call -> answer cellular, which (on success)
        // the orchestrator reports back via ActivateCellular. Stay RINGING until
        // the cellular leg actually connects.
        return Accepted(this, listOf(CallEffect.AnswerAgent(c.dialKey)))
    }

    // ---- outbound ----

    private fun startOutbound(c: CallCommand.StartOutbound): CallResult {
        if (state != CallState.IDLE) return CallReject.NotIdle(state, sessionId, c.dialKey)
        val next = copy(state = CallState.DIALING, dialKey = c.dialKey)
        return Accepted(next, listOf(CallEffect.DialAgent(c.dialKey)))
    }

    private fun dialOutbound(c: CallCommand.DialOutbound): CallResult {
        if (state != CallState.DIALING) return CallReject.NotDialing(state, sessionId)
        // Orchestrator dials the cellular destination; ActivateCellular will
        // follow once the remote answers.
        return Accepted(this, listOf(CallEffect.ActivateCellularCall(c.dialKey)))
    }

    // ---- activation + media gating ----

    private fun activateCellular(c: CallCommand.ActivateCellular): CallResult {
        when (state) {
            CallState.RINGING, CallState.DIALING -> {
                val next = copy(state = CallState.ACTIVE_NO_MEDIA, cellularActive = true)
                val effects = if (next.usbMediaReady) {
                    listOf(CallEffect.BeginUsbStreaming(c.dialKey))
                } else emptyList()
                return Accepted(maybeStreaming(next), effects)
            }
            CallState.ACTIVE_NO_MEDIA, CallState.STREAMING -> {
                // Idempotent re-activation: cellular already active.
                return Accepted(this, emptyList())
            }
            else -> return CallReject.NoActiveCall(state, sessionId)
        }
    }

    private fun startUsbMedia(c: CallCommand.StartUsbMedia): CallResult {
        if (!cellularActive) return CallReject.NoActiveCall(state, sessionId)
        if (state != CallState.ACTIVE_NO_MEDIA && state != CallState.STREAMING) {
            return CallReject.NoActiveCall(state, sessionId)
        }
        val next = copy(usbMediaReady = true)
        return Accepted(maybeStreaming(next), listOf(CallEffect.BeginUsbStreaming(c.dialKey)))
    }

    private fun stopUsbMedia(c: CallCommand.StopUsbMedia): CallResult {
        if (state != CallState.STREAMING && state != CallState.ACTIVE_NO_MEDIA) {
            return CallReject.NotStreaming(state, sessionId)
        }
        val stopped = copy(usbMediaReady = false, state = CallState.ACTIVE_NO_MEDIA)
        return when (c.policy) {
            UsbLossPolicy.PreserveCellularCall ->
                Accepted(stopped, listOf(CallEffect.StopUsbStreaming(c.dialKey)))
            UsbLossPolicy.HangUpCellularCall ->
                Accepted(
                    copy(state = CallState.TEARING_DOWN, usbMediaReady = false),
                    listOf(CallEffect.StopUsbStreaming(c.dialKey), CallEffect.HangUpCellularCall(c.dialKey))
                )
        }
    }

    // ---- teardown (exactly one path) ----

    private fun endCall(c: CallCommand.EndCall): CallResult {
        if (state == CallState.IDLE) return CallReject.AlreadyIdle(sessionId)
        if (state == CallState.TEARING_DOWN) return Accepted(this, emptyList()) // idempotent
        val next = copy(state = CallState.TEARING_DOWN)
        val effects = mutableListOf<CallEffect>(CallEffect.HangUpCellularCall(c.dialKey))
        if (usbMediaReady) effects.add(CallEffect.StopUsbStreaming(c.dialKey))
        effects.add(CallEffect.ReleaseAgent(c.dialKey))
        return Accepted(next, effects)
    }

    private fun recoverFromError(c: CallCommand.RecoverFromError): CallResult {
        if (state != CallState.ERROR && state != CallState.TEARING_DOWN) {
            return CallReject.NotInError(state, sessionId)
        }
        return Accepted(
            CallSession.create(sessionId),
            listOf(CallEffect.ReleaseAgent(c.dialKey))
        )
    }

    /** Promote to STREAMING iff both the cellular call and USB media are ready. */
    private fun maybeStreaming(s: CallSession): CallSession =
        if (s.cellularActive && s.usbMediaReady) s.copy(state = CallState.STREAMING)
        else if (s.state == CallState.STREAMING && (!s.cellularActive || !s.usbMediaReady)) s.copy(state = CallState.ACTIVE_NO_MEDIA)
        else s
}

/** Top-level call lifecycle. One entry per phase; no overloaded meanings. */
enum class CallState { IDLE, RINGING, DIALING, ACTIVE_NO_MEDIA, STREAMING, TEARING_DOWN, ERROR }

/** What to do with the cellular call when USB media is lost. */
enum class UsbLossPolicy { PreserveCellularCall, HangUpCellularCall }

/** Typed rejection of a [CallCommand]. The orchestrator routes these, no try/catch. */
sealed interface CallReject : CallResult {
    override val session: CallSession? get() = null
    val state: CallState
    val sessionId: Int

    /** A new call was started while another is in progress. */
    data class NotIdle(override val state: CallState, override val sessionId: Int, val attemptedKey: String) : CallReject
    /** An inbound acknowledgement arrived outside RINGING. */
    data class NotRinging(override val state: CallState, override val sessionId: Int) : CallReject
    /** A dial step arrived outside DIALING. */
    data class NotDialing(override val state: CallState, override val sessionId: Int) : CallReject
    /** A media/activation step needs an active cellular call that is not present. */
    data class NoActiveCall(override val state: CallState, override val sessionId: Int) : CallReject
    /** A USB-media stop arrived while not streaming/active. */
    data class NotStreaming(override val state: CallState, override val sessionId: Int) : CallReject
    /** EndCall on an already-idle session. */
    data class AlreadyIdle(override val sessionId: Int) : CallReject {
        override val state: CallState = CallState.IDLE
    }
    /** RecoverFromError outside an error/teardown state. */
    data class NotInError(override val state: CallState, override val sessionId: Int) : CallReject
}

/** Accepted command: next state plus effects the orchestrator must apply. */
data class Accepted(
    override val session: CallSession,
    val effects: List<CallEffect>,
    val replayed: Boolean = false,
) : CallResult

/** Union of accepted and rejected outcomes. [session] is non-null only when accepted. */
sealed interface CallResult {
    val session: CallSession?
}

/** Side effects the orchestrator applies after a command is accepted. */
sealed interface CallEffect {
    /** Notify the USB agent of an inbound cellular call. */
    data class NotifyAgentInbound(val dialKey: String) : CallEffect
    /** Answer the agent leg of an inbound call. */
    data class AnswerAgent(val dialKey: String) : CallEffect
    /** Dial the agent leg of an outbound call. */
    data class DialAgent(val dialKey: String) : CallEffect
    /** Activate (answer) the cellular call leg. */
    data class ActivateCellularCall(val dialKey: String) : CallEffect
    /** Begin USB audio streaming (both legs connected, media ready). */
    data class BeginUsbStreaming(val dialKey: String) : CallEffect
    /** Stop USB audio streaming. */
    data class StopUsbStreaming(val dialKey: String) : CallEffect
    /** Hang up the cellular call leg. */
    data class HangUpCellularCall(val dialKey: String) : CallEffect
    /** Release the agent leg and free session resources. */
    data class ReleaseAgent(val dialKey: String) : CallEffect
}

/**
 * Inputs to the reducer. Every mutating command carries a [dialKey] idempotency
 * token so a retried command (network redelivery, agent restart) is de-duplicated
 * instead of starting a second call.
 */
sealed interface CallCommand {
    val dialKey: String?

    /** Inbound: a cellular call started ringing. */
    data class StartInbound(override val dialKey: String) : CallCommand
    /** Inbound: the agent acknowledged (answered) the ringing call. */
    data class AcknowledgeInbound(override val dialKey: String) : CallCommand
    /** Outbound: start placing a call to the agent. */
    data class StartOutbound(override val dialKey: String) : CallCommand
    /** Outbound: dial the cellular destination. */
    data class DialOutbound(override val dialKey: String) : CallCommand
    /** Cellular leg went active (remote answered). */
    data class ActivateCellular(override val dialKey: String) : CallCommand
    /** USB media path is ready. */
    data class StartUsbMedia(override val dialKey: String) : CallCommand
    /** USB media path was lost; [policy] decides the cellular call's fate. */
    data class StopUsbMedia(override val dialKey: String, val policy: UsbLossPolicy) : CallCommand
    /** End the call (the single teardown entry point). */
    data class EndCall(override val dialKey: String) : CallCommand
    /** Recover from ERROR/TEARING_DOWN back to IDLE. */
    data class RecoverFromError(override val dialKey: String) : CallCommand
}

/** Stable semantic signature for exact replay detection. */
private fun CallCommand.signature(): String = when (this) {
    is CallCommand.StartInbound -> "StartInbound:$dialKey"
    is CallCommand.AcknowledgeInbound -> "AcknowledgeInbound:$dialKey"
    is CallCommand.StartOutbound -> "StartOutbound:$dialKey"
    is CallCommand.DialOutbound -> "DialOutbound:$dialKey"
    is CallCommand.ActivateCellular -> "ActivateCellular:$dialKey"
    is CallCommand.StartUsbMedia -> "StartUsbMedia:$dialKey"
    is CallCommand.StopUsbMedia -> "StopUsbMedia:$dialKey:$policy"
    is CallCommand.EndCall -> "EndCall:$dialKey"
    is CallCommand.RecoverFromError -> "RecoverFromError:$dialKey"
}
