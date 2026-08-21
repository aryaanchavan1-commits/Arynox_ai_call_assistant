package com.callagent.gateway

import android.app.Application
import android.util.Log

class GatewayApp : Application() {
    override fun onCreate() {
        super.onCreate()
        Log.i("GatewayApp", "Arynox USB cellular gateway v${BuildConfig.VERSION_NAME} started")
    }
}
