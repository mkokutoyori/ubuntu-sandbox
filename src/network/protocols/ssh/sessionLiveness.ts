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
