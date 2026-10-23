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

import { isPathReachable, topologyHoldsAddress } from '@/network/devices/linux/network/HostLookup';
import { IPAddress } from '@/network/core/types';
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
export function pathLiveness(
  sourceIp: string, peerIp: string, from?: Equipment | null,
): () => boolean {
  return () => isPathReachable(sourceIp, peerIp, from as never);
}

/**
 * A session is alive only while EVERY condition holds.
 *
 * One check is not enough, because the ways a session dies are not the
 * same fact. The client's own socket knows when the client's own link
 * drops — but nothing on this side notices when the cable at the FAR end
 * is pulled, when a switch in the middle loses power, or when the peer
 * itself is switched off. A real client learns all of those the same way,
 * on its next write; here the two questions are asked together so the
 * answer covers the same ground.
 */
export function everyLiveness(...checks: Array<() => boolean>): () => boolean {
  return () => checks.every((check) => check());
}

/**
 * Liveness of an established session, from both ends of what can break:
 * the socket this side holds, and the path that carries it.
 *
 * Deliberately NOT included: whether the peer's sshd is still running. A
 * Debian `ssh.service` is `KillMode=process`, so `systemctl stop ssh`
 * kills the listener and leaves every established session alone — which
 * is exactly why restarting sshd over ssh is safe, and why treating a
 * stopped daemon as a dead session would be wrong rather than stricter.
 */
export function establishedSessionLiveness(
  session: LiveTransport, sourceDevice: Equipment, peerHost: string,
): () => boolean {
  return everyLiveness(
    transportLiveness(session),
    peerLiveness(sourceDevice, peerHost),
  );
}

/** First address configured on any of a device's ports, if it has one. */
export function firstConfiguredIp(dev: Equipment): string | undefined {
  for (const port of dev.getPorts()) {
    const ip = port.getIPAddress?.();
    if (ip) return ip.toString();
  }
  return firstSviAddress(dev);
}

export function sviAddresses(dev: Equipment): string[] {
  const host = dev as unknown as {
    getSvis?: () => Array<{ ip?: { toString(): string } }>;
    isSviLineUp?: (svi: unknown) => boolean;
  };
  const addresses: string[] = [];
  for (const svi of host.getSvis?.() ?? []) {
    if (svi.ip && (host.isSviLineUp?.(svi) ?? true)) addresses.push(svi.ip.toString());
  }
  return addresses;
}

export function firstSviAddress(dev: Equipment): string | undefined {
  return sviAddresses(dev)[0];
}

function reachedThroughGateway(device: Equipment, address: string): boolean {
  if (!IPAddress.isValid(address)) return false;
  const stack = (device as unknown as { getTcpStack?: () => { hasEgressTo(ip: string): boolean } }).getTcpStack?.();
  if (!stack?.hasEgressTo(address)) return false;
  const target = new IPAddress(address);
  return !device.getPorts().some((port) => {
    const ip = port.getIPAddress();
    const mask = port.getSubnetMask();
    return ip !== null && mask !== null && ip.isInSameSubnet(target, mask);
  });
}

function isOwnAddress(device: Equipment, address: string): boolean {
  if (address === 'localhost' || address === '::1' || /^127\./.test(address)) return true;
  return device.getPorts().some((port) => port.getIPAddress()?.toString() === address);
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
  if (isOwnAddress(sourceDevice, peerHost)) return () => true;
  if (!topologyHoldsAddress(peerHost, sourceDevice) && reachedThroughGateway(sourceDevice, peerHost)) return () => true;
  return pathLiveness(sourceIp, peerHost, sourceDevice);
}
