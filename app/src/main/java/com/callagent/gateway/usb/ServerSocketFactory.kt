package com.callagent.gateway.usb

import java.net.ServerSocket

/**
 * Injectable factory for the gateway's [ServerSocket]. Production binds a real
 * loopback socket on [UsbGatewayServer.BIND_ADDRESS]:[UsbGatewayServer.BIND_PORT];
 * unit tests inject a stub to assert bind config without touching the network,
 * or a real loopback socket to drive the accept/read path.
 *
 * ponytail: a single-method interface is the smallest seam that lets bind-config
 * tests stay pure. No factory-of-factories: there is exactly one product here.
 */
fun interface ServerSocketFactory {
    fun create(host: String, port: Int): ServerSocket
}
