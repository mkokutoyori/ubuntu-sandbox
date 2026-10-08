/**
 * hostResolution — shared "which device answers to this address" lookup,
 * used by every client-side network tool the shells expose (ssh, sqlplus
 * over TNS, tnsping). Extracted from sshLauncher so the SSH and Oracle
 * Net clients resolve hosts identically instead of duplicating the walk.
 */

import { Equipment } from '@/network/equipment/Equipment';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { sviAddresses } from '@/network/protocols/ssh/sessionLiveness';

export function findEquipmentByIp(targetIp: string): Equipment | null {
  const all = EquipmentRegistry.getInstance().getAll();
  for (const eq of all) {
    if (sviAddresses(eq).includes(targetIp)
      && typeof (eq as unknown as { executeCommand?: unknown }).executeCommand === 'function') {
      return eq;
    }
    const portsObj = (eq as unknown as { ports?: Map<string, { getIPAddress: () => { toString(): string } | null }> }).ports;
    if (!portsObj) continue;
    for (const port of portsObj.values()) {
      const ip = port.getIPAddress?.();
      if (ip && ip.toString() === targetIp) {
        if (typeof (eq as unknown as { executeCommand?: unknown }).executeCommand === 'function') {
          return eq;
        }
      }
    }
  }
  return null;
}

export function findEquipmentByHostname(hostname: string): Equipment | null {
  const all = EquipmentRegistry.getInstance().getAll();
  for (const eq of all) {
    const dev = eq as unknown as { getHostname?: () => string };
    if (typeof dev.getHostname === 'function' && dev.getHostname() === hostname) {
      return eq;
    }
  }
  return null;
}
