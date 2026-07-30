# AgentCall keeps Android Telecom entry points because the platform constructs
# them from the manifest rather than through ordinary Kotlin references.
-keep class com.callagent.gateway.gsm.GsmCallService { *; }
-keep class com.callagent.gateway.usb.UsbGatewayService { *; }
