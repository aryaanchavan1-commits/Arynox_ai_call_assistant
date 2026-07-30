package com.callagent.gateway.usb

/**
 * Thrown when a CONTROL frame payload is not a strict, well-formed command
 * object: malformed JSON, non-UTF-8, unknown command name, unknown field,
 * wrong field type, missing required field, or an over-bound idempotencyKey.
 *
 * The gateway treats this as a protocol error: close the connection and run
 * cleanup. The message never includes raw phone numbers or DTMF digits — use
 * [RedactingLog] when surfacing command details in logs or EVENT payloads.
 */
class CommandProtocolException(message: String) : Exception(message)
