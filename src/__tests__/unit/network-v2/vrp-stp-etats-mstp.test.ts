import { describe, it, expect, beforeEach } from 'vitest';
import { HuaweiSwitch } from '@/network/devices/HuaweiSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
});

const run = (d: unknown, c: string) =>
  (d as { executeCommand(c: string): Promise<string> }).executeCommand(c);

async function paire() {
  const a = new HuaweiSwitch('switch-huawei', 'SW-A', 6, 0, 0);
  const b = new HuaweiSwitch('switch-huawei', 'SW-B', 6, 200, 0);
  new Cable('l1').connect(a.getPort('GigabitEthernet0/0/1')!, b.getPort('GigabitEthernet0/0/1')!);
  new Cable('l2').connect(a.getPort('GigabitEthernet0/0/2')!, b.getPort('GigabitEthernet0/0/2')!);
  return { a, b };
}

const ETATS_MSTP = ['DISCARDING', 'LEARNING', 'FORWARDING'];

function etatsDe(sortie: string): string[] {
  return sortie.split('\n')
    .filter(l => /^\s+\d+\s+\S+\s+\S+\s+\S+/.test(l))
    .map(l => l.trim().split(/\s+/)[3]);
}

describe('en MSTP, une vue n emploie que les TROIS etats de MSTP', () => {
  it('`display stp brief` n ecrit jamais LISTENING', async () => {
    const { a } = await paire();
    const vu = await run(a, 'display stp brief');
    expect(vu).not.toContain('LISTENING');
    expect(vu).not.toContain('BLOCKING');
  });

  it('chaque etat rendu appartient au vocabulaire de MSTP', async () => {
    const { a, b } = await paire();
    for (const sw of [a, b]) {
      const etats = etatsDe(await run(sw, 'display stp brief'));
      expect(etats.length).toBeGreaterThan(0);
      for (const etat of etats) expect(ETATS_MSTP).toContain(etat);
    }
  });

  it('un port sans lien est DISCARDING, pas un etat de 802.1D', async () => {
    const { a } = await paire();
    const ligne = (await run(a, 'display stp brief')).split('\n')
      .find(l => l.includes('GigabitEthernet0/0/4'));
    expect(ligne).toBeDefined();
    expect(ligne).toContain('DISA');
    expect(ligne).toContain('DISCARDING');
  });

  it('le lien redondant est ALTE DISCARDING, et le port racine FORWARDING', async () => {
    const { b } = await paire();
    const vu = await run(b, 'display stp brief');
    expect(vu).toMatch(/GigabitEthernet0\/0\/1\s+ROOT\s+FORWARDING/);
    expect(vu).toMatch(/GigabitEthernet0\/0\/2\s+ALTE\s+DISCARDING/);
  });

  it('`display stp interface` emploie le meme vocabulaire', async () => {
    const { a } = await paire();
    const vu = await run(a, 'display stp interface GigabitEthernet0/0/4');
    expect(vu).not.toContain('LISTENING');
  });

  it('`display stp instance 0` aussi', async () => {
    const { b } = await paire();
    const vu = await run(b, 'display stp instance 0');
    expect(vu).not.toContain('LISTENING');
    const etats = etatsDe(vu);
    for (const etat of etats) expect(ETATS_MSTP).toContain(etat);
  });
});
