/**
 * Linux (ip-sysctl.rst, neigh/default/mcast_solicit = 3, retrans_time_ms = 1000) : une résolution ARP sans réponse émet TROIS requêtes
 * espacées d'une seconde avant d'échouer, soit environ 3 s avant « Destination Host Unreachable ».
 *
 * Mesure de départ : une seule requête, puis l'échec aussitôt après le délai de l'appelant (2 s). 2 des 3 cas tombent avant ;
 * le témoin (un voisin qui répond à la première requête n'en reçoit qu'une) passe dans les deux états.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { labo } from './_nginxProxyLab';

beforeEach(() => { EquipmentRegistry.getInstance().clear(); });

function countRequests(lab: ReturnType<typeof labo>, target: string): { count: () => number } {
  let n = 0;
  const bus = lab.front.getBus();
  bus.subscribe('host.arp.request-sent', (e) => {
    if (e.payload.deviceId === lab.front.id && e.payload.targetIp === target) n++;
  });
  return { count: () => n };
}

describe('mcast_solicit', () => {
  it('trois requêtes pour un voisin muet', async () => {
    const lab = labo();
    const seen = countRequests(lab, '10.0.0.99');
    await lab.front.executeCommand('ping -c 1 10.0.0.99');
    expect(seen.count()).toBe(3);
  }, 20_000);

  it('l\'échec prend environ trois secondes', async () => {
    const lab = labo();
    const started = Date.now();
    const out = await lab.front.executeCommand('ping -c 1 10.0.0.99');
    expect(out).toContain('Destination Host Unreachable');
    expect(Date.now() - started).toBeGreaterThanOrEqual(2900);
  }, 20_000);

  it('témoin : un voisin présent ne reçoit qu\'une requête', async () => {
    const lab = labo();
    const seen = countRequests(lab, '10.0.0.2');
    await lab.front.executeCommand('ping -c 1 10.0.0.2');
    expect(seen.count()).toBe(1);
  }, 20_000);
});
