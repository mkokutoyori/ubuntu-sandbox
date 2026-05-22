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

  // /etc/hosts of the caller — checked first to match real resolver order.
  if (resolverVfs) {
    const hosts = resolverVfs.readFile('/etc/hosts') ?? '';
    for (const line of hosts.split('\n')) {
      const trimmed = line.replace(/#.*/, '').trim();
      if (!trimmed) continue;
      const tokens = trimmed.split(/\s+/);
      const [ip, ...names] = tokens;
      if (names.some(n => n.toLowerCase() === needle || n.toLowerCase() === shortNeedle)) {
        const dev = registry.getAll().find(d =>
          d.getIsPoweredOn() && d.getPorts().some(p => p.getIPAddress()?.toString() === ip),
        );
        if (dev) return { device: dev, ip, resolvedFrom: target };
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
