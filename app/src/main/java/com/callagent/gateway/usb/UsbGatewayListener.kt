package com.callagent.gateway.usb

interface UsbGatewayListener {
    fun onListenerStarted(port: Int) {}
    fun onDesktopConnected() {}
    fun onDesktopConnected(generation: Long) = onDesktopConnected()
    fun onDesktopDisconnected(reason: String) {}
    fun onDesktopDisconnected(generation: Long, reason: String) = onDesktopDisconnected(reason)
    fun onError(reason: String) {}
    fun onAuthenticationFailed(reason: String) {}

    companion object {
        val NONE = object : UsbGatewayListener {}
    }
}
