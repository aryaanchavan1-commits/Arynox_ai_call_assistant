package com.callagent.gateway.usb

interface BootstrapPeer {
    val uid: Int
    val gid: Int
    fun close()
}

/** Platform-neutral admission loop; every failed client is closed and the listener re-arms. */
class BootstrapAcceptLoop(private val authorization: BootstrapAuthorizationWindow) {
    fun run(accept: () -> BootstrapPeer?, handle: (BootstrapPeer, Long) -> Unit): Boolean {
        while (authorization.isOpen()) {
            val peer = accept() ?: return false
            val claim = authorization.tryClaim(peer.uid, peer.gid)
            if (!claim.accepted) {
                peer.close()
                continue
            }
            try {
                handle(peer, claim.generation)
                return true
            } catch (_: Exception) {
                // A bad claimant does not consume the remaining authorization window.
            } finally {
                peer.close()
                authorization.release(claim.generation)
            }
        }
        return false
    }
}
