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
    if (peerIp && peerIp.toString() === dstIp) return true;
    for (const sibling of peerDev.getPorts()) {
      if (sibling !== peerPort) queue.push(sibling);
    }
  }
  return false;
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
