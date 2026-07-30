package com.callagent.gateway.usb

/** Pure permission gate so asynchronous Activity permission results fail closed. */
object GatewayPermissionGate {
    fun mayStart(grants: List<Boolean>): Boolean = grants.isNotEmpty() && grants.all { it }
}
