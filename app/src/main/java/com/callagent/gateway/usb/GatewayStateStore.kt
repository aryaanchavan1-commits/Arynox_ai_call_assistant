package com.callagent.gateway.usb

import android.content.Context
import android.content.Intent

object GatewayStateStore {
    const val ACTION_STATE = "com.callagent.gateway.USB_STATE"

    @Volatile private var value: GatewayUiState = GatewayUiState.initial()

    fun snapshot(): GatewayUiState = value

    @Synchronized
    fun update(context: Context, event: GatewayUiEvent): GatewayUiState {
        value = value.reduce(event)
        context.sendBroadcast(Intent(ACTION_STATE).apply {
            setPackage(context.packageName)
        })
        return value
    }
}
