import { boundedInteger } from '@/cli/ArgumentTypes';
import { parseVlanId } from '../../switch/VlanSet';

/**
 * Le domaine d'une liste ecrite a la mode d'IOS.
 *
 * `1,3-5,7` est la meme GRAMMAIRE pour un VLAN et pour une instance
 * MST, et ce sont deux DOMAINES : un VLAN commence a 1, une instance
 * MST a 0 — l'instance 0 est l'IST, celle qui existe toujours. Lire une
 * liste d'instances avec le lecteur de VLAN refusait donc `spanning-tree
 * mst 0 priority 32768`, la forme la plus tapee de la commande. La
 * grammaire reste ecrite une fois ; la borne est ce que l'appelant
 * apporte.
 */
export const MST_INSTANCE_BOUNDS: readonly [number, number] = [0, 4094];

/**
 * La liste de VLAN d'IOS : `10`, `10,20`, `20-24`, et leurs melanges.
 *
 * C'est une AUTRE grammaire que celle de VRP (`10 20 to 24`, dans
 * `VlanSet.parseVlanList`) : les deux constructeurs ecrivent une liste
 * differemment, et les fondre accepterait sur l'un ce que l'autre
 * refuse. Ce qu'elles partagent — la plage 1-4094 de l'IEEE 802.1Q —
 * est lu au meme endroit par les deux.
 */
export function parseVlanList(
  input: string, bounds?: readonly [number, number],
): Set<number> | null {
  const lire = bounds === undefined
    ? parseVlanId
    : (token: string | undefined) => boundedInteger(token, bounds[0], bounds[1]);
  const vlans = new Set<number>();
  const parts = input.split(',');
  if (parts.length === 0) return null;
  for (const part of parts) {
    if (part.includes('-')) {
      const [debut, fin] = part.split('-').map((b) => lire(b));
      if (debut === null || fin === null || fin < debut) return null;
      for (let i = debut; i <= fin; i++) vlans.add(i);
    } else {
      const num = lire(part);
      if (num === null) return null;
      vlans.add(num);
    }
  }
  return vlans.size > 0 ? vlans : null;
}

export function compactVlanList(sorted: readonly number[]): string {
  if (sorted.length === 0) return '';
  const ranges: string[] = [];
  let start = sorted[0], end = sorted[0];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] === end + 1) {
      end = sorted[i];
    } else {
      ranges.push(start === end ? String(start) : `${start}-${end}`);
      start = end = sorted[i];
    }
  }
  ranges.push(start === end ? String(start) : `${start}-${end}`);
  return ranges.join(',');
}
