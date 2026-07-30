package com.callagent.gateway.usb

interface RecordingArtifactReceiver {
    fun begin(command: GatewayCommand.RecordingArtifactBegin): Boolean
    fun append(payload: ByteArray): Boolean
    fun commit(command: GatewayCommand.RecordingArtifactCommit): Boolean
    fun abort()

    object NONE : RecordingArtifactReceiver {
        override fun begin(command: GatewayCommand.RecordingArtifactBegin) = false
        override fun append(payload: ByteArray) = false
        override fun commit(command: GatewayCommand.RecordingArtifactCommit) = false
        override fun abort() = Unit
    }
}
