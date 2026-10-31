/**
 * Linux net/core/neighbour.c : l'émission vers une entrée STALE la passe en DELAY (delay_first_probe_time = 5 s) ; si rien ne la
 * confirme, elle passe en PROBE (ucast_solicit = 3 requêtes unicast, une par seconde) ; une réponse la rend REACHABLE, le silence la
 * rend FAILED.
 * Mesure de départ : l'entrée restait STALE après l'usage. 4 des 5 cas tombent avant le correctif ; le témoin (une entrée fraîche reste
 * REACHABLE à l'usage) passe dans les deux états.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { labo } from './_nginxProxyLab';

beforeEach(() => { EquipmentRegistry.getInstance().clear(); });

const neighbour = async (lab: ReturnType<typeof labo>): Promise<string> =>
  (await lab.front.executeCommand('ip neigh show 10.0.0.2')).trim();

async function ageEntry(lab: ReturnType<typeof labo>): Promise<void> {
  await lab.front.executeCommand('ping -c 1 10.0.0.2');
  const entry = (lab.front as unknown as { getARPTableFull(): Map<string, { timestamp: number }> }).getARPTableFull().get('10.0.0.2')!;
  entry.timestamp -= 60_000;
}

describe('NUD : STALE, DELAY, PROBE', () => {
  it('une entrée vieille de soixante secondes est STALE', async () => {
    const lab = labo();
    await ageEntry(lab);
    expect(await neighbour(lab)).toContain('STALE');
  });

  it('l\'usage d\'une entrée STALE la passe en DELAY', async () => {
    const lab = labo();
    await ageEntry(lab);
    await lab.front.executeCommand('ping -c 1 10.0.0.2');
    expect(await neighbour(lab)).toContain('DELAY');
  });

  it('cinq secondes plus tard la sonde unicast reçoit sa réponse : REACHABLE', async () => {
    const lab = labo();
    await ageEntry(lab);
    await lab.front.executeCommand('ping -c 1 10.0.0.2');
    await new Promise((resolve) => setTimeout(resolve, 5500));
    expect(await neighbour(lab)).toContain('REACHABLE');
  }, 20_000);

  it('sans réponse, trois sondes unicast puis FAILED', async () => {
    const lab = labo();
    await ageEntry(lab);
    await lab.front.executeCommand('ping -c 1 10.0.0.2');
    await lab.back.executeCommand('ip link set eth0 down');
    await new Promise((resolve) => setTimeout(resolve, 8800));
    expect(await neighbour(lab)).toContain('FAILED');
  }, 30_000);

  it('témoin : une entrée fraîche reste REACHABLE à l\'usage', async () => {
    const lab = labo();
    await lab.front.executeCommand('ping -c 1 10.0.0.2');
    await lab.front.executeCommand('ping -c 1 10.0.0.2');
    expect(await neighbour(lab)).toContain('REACHABLE');
  });
});
