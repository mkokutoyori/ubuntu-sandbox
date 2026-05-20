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
}

/**
 * Resolve a hostname or IP to the equipment that owns that address.
 *
 * - Numeric addresses (`10.0.0.10`) match any port with that IP.
 * - Names are case-insensitively matched against the device's hostname
 *   field if exposed, then against the equipment's name as a fallback
 *   so authors can write `ssh server` in tests.
 */
export function findHostByAddress(addressOrName: string): RemoteHost | null {
  const registry = EquipmentRegistry.getInstance();
  const target = addressOrName.trim();
  if (!target) return null;

  // IPv4 numeric form → exact port match.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(target)) {
    for (const dev of registry.getAll()) {
      if (!dev.getIsPoweredOn()) continue;
      for (const port of dev.getPorts()) {
        const ip = port.getIPAddress();
        if (ip && ip.toString() === target) {
          return { device: dev, ip: target, resolvedFrom: target };
        }
      }
    }
    return null;
  }

  // Name form — match the device's hostname-like fields.
  const needle = target.toLowerCase();
  for (const dev of registry.getAll()) {
    if (!dev.getIsPoweredOn()) continue;
    const candidate = (dev as Equipment & { profile?: { hostname?: string } });
    const hostname = candidate.profile?.hostname?.toLowerCase();
    const name = dev.getName().toLowerCase();
    if (hostname === needle || name === needle) {
      const ip = dev.getPorts()
        .map(p => p.getIPAddress())
        .find(a => a !== null);
      if (ip) return { device: dev, ip: ip.toString(), resolvedFrom: target };
    }
  }
  return null;
}
