/**
 * Network host lookup — bridges hostname/IP to the Equipment instance.
 *
 * Used by client commands (`ssh`, `scp`, `sftp`, future `nc`) to find
 * the remote device on the simulated topology and reactively ask it
 * about its services (e.g. is sshd active?). Returns null when nothing
 * on the topology answers to that address.
 */

import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import type { Equipment } from '@/network/equipment/Equipment';
import { HostsFile } from '../../HostsFile';
import type { Port } from '@/network/hardware/Port';
import type { IPv4Packet, TCPPacket } from '@/network/core/types';
import { IPAddress, IP_PROTO_TCP, createIPv4Packet } from '@/network/core/types';

/**
 * BFS reachability across the physical topology: starting from any port
 * owning `srcIp`, walk cable-to-cable through intermediate devices and
 * return true only when a port owning `dstIp` is reachable AND every
 * device + port on the path is powered on and admin-up.
 */
export function isPathReachable(srcIp: string, dstIp: string): boolean {
  if (srcIp === dstIp) return true;
  if (!srcIp || srcIp === '127.0.0.1' || srcIp.startsWith('169.254.')) return true;
  const registry = EquipmentRegistry.getInstance();
  const startPorts: Port[] = [];
  for (const dev of registry.getAll()) {
    for (const port of dev.getPorts()) {
      const ip = port.getIPAddress();
      if (ip && ip.toString() === srcIp) startPorts.push(port);
    }
  }
  if (startPorts.length === 0) return true;
  // Topologies that wire ports without a Cable (legacy tests) are
  // treated as reachable — the simulator falls back to the old
  // registry-only behaviour when no cable plant exists.
  const anyCable = startPorts.some(p => p.getCable() !== null);
  if (!anyCable) return true;

  return findReachableHost(srcIp, dstIp) !== null;
}

/**
 * BFS the physical topology from any port owning `srcIp` and return the
 * powered-on, link-up Equipment that actually owns `dstIp` (on a physical
 * port or a line-up management SVI). Unlike `findHostByAddress`, this honours
 * the cable plant, so when several devices in the static registry share an IP
 * (e.g. test fixtures), it returns the one truly reachable over the wire.
 * Returns null when no cabled path terminates at `dstIp`.
 */
export function findReachableHost(srcIp: string, dstIp: string): Equipment | null {
  const registry = EquipmentRegistry.getInstance();
  const startPorts: Port[] = [];
  for (const dev of registry.getAll()) {
    for (const port of dev.getPorts()) {
      const ip = port.getIPAddress();
      if (ip && ip.toString() === srcIp) startPorts.push(port);
    }
  }

  const visited = new Set<string>();
  const queue: Port[] = [...startPorts];
  while (queue.length > 0) {
    const port = queue.shift()!;
    const key = `${port.getEquipmentId()}:${port.getName()}`;
    if (visited.has(key)) continue;
    visited.add(key);
    if (!port.getIsUp()) continue;
    const cable = port.getCable();
    if (!cable) continue;
    const peerPort = cable.getPortA() === port ? cable.getPortB() : cable.getPortA();
    if (!peerPort || !peerPort.getIsUp()) continue;
    const peerDev = registry.getById(peerPort.getEquipmentId());
    if (!peerDev || !peerDev.getIsPoweredOn()) continue;
    const peerIp = peerPort.getIPAddress();
    if (peerIp && peerIp.toString() === dstIp) return peerDev;
    // A switch management SVI carries its IP on no physical port. When the
    // destination is such an address, a reachable+up SVI on the peer device
    // terminates the path exactly like a physical NIC would.
    const sviPeer = peerDev as unknown as {
      getSvis?: () => Array<{ ip?: { toString(): string } }>;
      isSviLineUp?: (svi: unknown) => boolean;
    };
    for (const svi of sviPeer.getSvis?.() ?? []) {
      if (svi.ip && svi.ip.toString() === dstIp && sviPeer.isSviLineUp?.(svi)) return peerDev;
    }
    for (const sibling of peerDev.getPorts()) {
      if (sibling !== peerPort) queue.push(sibling);
    }
  }
  return null;
}

interface RouterAclSurface {
  getInterfaceACL?(ifName: string, direction: 'in' | 'out'): number | string | null;
  evaluateACLByName?(name: string, ipPkt: IPv4Packet): 'permit' | 'deny' | null;
}

/**
 * Walk the physical topology from any port owning `srcIp` to any port
 * owning `dstIp`, and for every transit router along the way, evaluate
 * its inbound ACL on the ingress interface and outbound ACL on the
 * egress interface against a synthesized TCP SYN packet
 * `(srcIp, dstIp, dstPort)`. Returns true as soon as any binding
 * denies the packet — the model is "single deny wins", matching how a
 * real router silently drops the SYN before the destination ever sees
 * it. Returns false when no path is found (let the caller's existing
 * reachability check name the failure) or when no binding denies.
 *
 * This is what makes `ssh: connect to host … port 22: Connection timed
 * out` reachable through the topology-bypass shortcut: the SSH client
 * still gets the same time-out feeling a real client gets when a
 * Cisco ACL eats the SYN.
 */
export function transitTcpAclVerdict(
  srcIp: string, dstIp: string, dstPort: number,
): 'permit' | 'deny' {
  if (srcIp === dstIp) return 'permit';
  const registry = EquipmentRegistry.getInstance();
  const startPorts: Port[] = [];
  for (const dev of registry.getAll()) {
    for (const port of dev.getPorts()) {
      const ip = port.getIPAddress();
      if (ip && ip.toString() === srcIp) startPorts.push(port);
    }
  }
  if (startPorts.length === 0) return 'permit';

  const synth = synthSynPacket(srcIp, dstIp, dstPort);
  const visited = new Set<string>();
  const queue: Port[] = [...startPorts];
  while (queue.length > 0) {
    const port = queue.shift()!;
    const key = `${port.getEquipmentId()}:${port.getName()}`;
    if (visited.has(key)) continue;
    visited.add(key);
    if (!port.getIsUp()) continue;
    const cable = port.getCable();
    if (!cable) continue;
    const peerPort = cable.getPortA() === port ? cable.getPortB() : cable.getPortA();
    if (!peerPort || !peerPort.getIsUp()) continue;
    const peerDev = registry.getById(peerPort.getEquipmentId());
    if (!peerDev || !peerDev.getIsPoweredOn()) continue;
    const peerIp = peerPort.getIPAddress();
    if (peerIp && peerIp.toString() === dstIp) return 'permit';
    const router = peerDev as unknown as RouterAclSurface;
    if (typeof router.getInterfaceACL === 'function' && typeof router.evaluateACLByName === 'function') {
      const ingressIface = peerPort.getName();
      const inbound = router.getInterfaceACL(ingressIface, 'in');
      if (inbound !== null) {
        const verdict = router.evaluateACLByName(String(inbound), synth);
        if (verdict === 'deny') return 'deny';
      }
      for (const sibling of peerDev.getPorts()) {
        if (sibling === peerPort) continue;
        const outbound = router.getInterfaceACL(sibling.getName(), 'out');
        if (outbound !== null) {
          const verdict = router.evaluateACLByName(String(outbound), synth);
          if (verdict === 'deny') return 'deny';
        }
        queue.push(sibling);
      }
      continue;
    }
    for (const sibling of peerDev.getPorts()) {
      if (sibling !== peerPort) queue.push(sibling);
    }
  }
  return 'permit';
}

function synthSynPacket(srcIp: string, dstIp: string, dstPort: number): IPv4Packet {
  const tcp: TCPPacket = {
    type: 'tcp',
    sourcePort: 49152,
    destinationPort: dstPort,
    sequenceNumber: 0,
    acknowledgementNumber: 0,
    flags: { syn: true, ack: false, fin: false, rst: false, psh: false, urg: false },
    windowSize: 65535,
    checksum: 0,
    payload: null,
  };
  return createIPv4Packet(
    new IPAddress(srcIp),
    new IPAddress(dstIp),
    IP_PROTO_TCP,
    64,
    tcp,
    20,
  );
}

export interface RemoteHost {
  device: Equipment;
  ip: string;
  /** Hostname provided by the caller (or the IP itself if numeric). */
  resolvedFrom: string;
  /** True when the IP is configured but the device is powered off — ssh returns "No route to host". */
  poweredOff?: boolean;
  /**
   * True when the IP is configured on an administratively-down NIC. Such an
   * interface does not answer ARP, so a peer trying to reach it gets
   * "No route to host" exactly as it would on real hardware.
   */
  interfaceDown?: boolean;
}

/**
 * Resolve a hostname or IP to the equipment that owns that address.
 *
 * - Numeric addresses (`10.0.0.10`) match any port with that IP.
 * - Names are case-insensitively matched against the device's hostname
 *   field if exposed, then against the equipment's name as a fallback
 *   so authors can write `ssh server` in tests.
 */
export function findHostByAddress(
  addressOrName: string,
  resolverVfs?: { readFile: (p: string) => string | null },
): RemoteHost | null {
  const registry = EquipmentRegistry.getInstance();
  const target = addressOrName.trim();
  if (!target) return null;

  // IPv4 numeric form → exact port match.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(target)) {
    let off: RemoteHost | null = null;
    for (const dev of registry.getAll()) {
      for (const port of dev.getPorts()) {
        const ip = port.getIPAddress();
        if (ip && ip.toString() === target) {
          if (!dev.getIsPoweredOn()) {
            off = { device: dev, ip: target, resolvedFrom: target, poweredOff: true };
            continue;
          }
          if (!port.getIsUp()) {
            off = { device: dev, ip: target, resolvedFrom: target, interfaceDown: true };
            continue;
          }
          return { device: dev, ip: target, resolvedFrom: target };
        }
      }
      // Switch management SVIs (`interface Vlan N`) carry IPs that live on no
      // physical port — resolve them too.
      const sviHost = dev as unknown as {
        getSvis?: () => Array<{ ip?: { toString(): string }; vlan: number }>;
        isSviLineUp?: (svi: unknown) => boolean;
      };
      for (const svi of sviHost.getSvis?.() ?? []) {
        if (!svi.ip || svi.ip.toString() !== target) continue;
        if (!dev.getIsPoweredOn()) {
          off = { device: dev, ip: target, resolvedFrom: target, poweredOff: true };
        } else if (!sviHost.isSviLineUp?.(svi)) {
          off = { device: dev, ip: target, resolvedFrom: target, interfaceDown: true };
        } else {
          return { device: dev, ip: target, resolvedFrom: target };
        }
      }
    }
    return off;
  }

  // Name form — match the device's hostname-like fields. Tries
  //   1. /etc/hosts on the calling machine (if `resolverVfs` provided)
  //   2. exact hostname / device name match
  //   3. short-name component when the input is FQDN-like (foo.bar.lan)
  const needle = target.toLowerCase();
  const shortNeedle = needle.split('.')[0];

  // Static hosts table of the caller — checked first to match real
  // resolver order. Both the Linux (`/etc/hosts`) and Windows
  // (`drivers\etc\hosts`) locations are consulted so the lookup is
  // OS-agnostic for whatever device issued the command.
  if (resolverVfs) {
    const hostsRaw =
      resolverVfs.readFile('/etc/hosts') ??
      resolverVfs.readFile('C:\\Windows\\System32\\drivers\\etc\\hosts');
    for (const entry of HostsFile.parse(hostsRaw).entries) {
      if (entry.hasName(needle) || entry.hasName(shortNeedle)) {
        const dev = registry.getAll().find(d =>
          d.getIsPoweredOn() &&
          d.getPorts().some(p => p.getIPAddress()?.toString() === entry.ip),
        );
        if (dev) return { device: dev, ip: entry.ip, resolvedFrom: target };
      }
    }
  }

  for (const dev of registry.getAll()) {
    if (!dev.getIsPoweredOn()) continue;
    const candidate = (dev as Equipment & { profile?: { hostname?: string } });
    const hostname = candidate.profile?.hostname?.toLowerCase();
    const name = dev.getName().toLowerCase();
    if (
      hostname === needle || hostname === shortNeedle ||
      name === needle || name === shortNeedle
    ) {
      const ip = dev.getPorts()
        .map(p => p.getIPAddress())
        .find(a => a !== null);
      if (ip) return { device: dev, ip: ip.toString(), resolvedFrom: target };
    }
  }
  return null;
}
