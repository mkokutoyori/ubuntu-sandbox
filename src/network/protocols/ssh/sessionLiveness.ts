/**
 * sessionLiveness — how an *established* session decides its transport
 * is still there.
 *
 * A real SSH client never reconnects to find out. It writes on the
 * channel it already holds and learns from the failure; when the link
 * under it drops, the kernel resets the socket and the next write
 * reports a broken pipe. Probing with a fresh TCP handshake would make
 * the server log an accept/close pair for every single command typed —
 * which is exactly what it did before this module existed.
 *
 * So liveness is read, never provoked: from the session's own socket
 * where one is held, and otherwise from the topology (is there still a
 * cabled, operational path to the peer) — a question that moves no
 * frames and writes no log line.
 */

import { isPathReachable } from '@/network/devices/linux/network/HostLookup';
import type { Equipment } from '@/network/equipment/Equipment';

/** Anything that knows whether its own transport is still up. */
export interface LiveTransport {
  readonly isConnected: boolean;
}

/**
 * Liveness of a session we hold the socket for. The socket is reset by
 * the link-down path, so this reflects a pulled cable without asking
 * the network anything.
 */
export function transportLiveness(session: LiveTransport): () => boolean {
  return () => session.isConnected;
}

/**
 * Liveness for a peer we do NOT hold a socket for (a detached `ssh host
 * cmd` job). Answered from the cabled topology rather than a handshake,
 * so it costs no connection and no server-side log line.
 */
export function pathLiveness(sourceIp: string, peerIp: string): () => boolean {
  return () => isPathReachable(sourceIp, peerIp);
}

/** First address configured on any of a device's ports, if it has one. */
export function firstConfiguredIp(dev: Equipment): string | undefined {
  for (const port of dev.getPorts()) {
    const ip = port.getIPAddress?.();
    if (ip) return ip.toString();
  }
  return undefined;
}

/**
 * Liveness of a peer reached from `sourceDevice`, for callers that hold
 * the two endpoints rather than a socket. Same topology question as
 * `pathLiveness`, with the source address resolved off the device.
 * A device with no address, or a peer that is not an address we can
 * place on the topology, is reported alive — absence of evidence is not
 * a dead link.
 */
export function peerLiveness(sourceDevice: Equipment, peerHost: string): () => boolean {
  const sourceIp = firstConfiguredIp(sourceDevice);
  if (!sourceIp) return () => true;
  return pathLiveness(sourceIp, peerHost);
}
