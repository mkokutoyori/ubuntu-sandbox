import { describe, it, expect, beforeEach } from 'vitest';
import { createDevice, resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { MACAddress, resetCounters } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

interface Fw {
  executeCommand(command: string): Promise<string>;
  getIsPoweredOn(): boolean;
  powerOn(): void;
}

function fortigate(): Fw {
  const fw = createDevice('firewall-fortinet', 0, 0) as unknown as Fw;
  if (!fw.getIsPoweredOn()) fw.powerOn();
  return fw;
}

function valeur(sortie: string, cle: string): number | undefined {
  const ligne = sortie.split('\n').find(l => l.startsWith(`${cle}:`));
  if (ligne === undefined) return undefined;
  const m = ligne.match(/(\d+)\s+kB\s*$/);
  return m ? Number(m[1]) : undefined;
}

describe('`diagnose hardware sysinfo memory` rend /proc/meminfo', () => {
  it('la commande existe', async () => {
    const fw = fortigate();

    expect(await fw.executeCommand('diagnose hardware sysinfo memory'))
      .not.toMatch(/Unknown action/);
  });

  it('elle annonce `MemTotal`', async () => {
    const fw = fortigate();

    expect(await fw.executeCommand('diagnose hardware sysinfo memory'))
      .toMatch(/^MemTotal:\s+\d+ kB$/m);
  });

  it('et `MemFree`', async () => {
    const fw = fortigate();

    expect(await fw.executeCommand('diagnose hardware sysinfo memory'))
      .toMatch(/^MemFree:\s+\d+ kB$/m);
  });

  it('chaque ligne finit par ` kB`', async () => {
    const fw = fortigate();
    const lignes = (await fw.executeCommand('diagnose hardware sysinfo memory'))
      .split('\n').filter(l => l.trim().length > 0);

    expect(lignes.length).toBeGreaterThan(5);
    expect(lignes.every(l => / kB$/.test(l))).toBe(true);
  });
});

describe('les valeurs sont MESUREES, pas inventees', () => {
  it('`MemFree` ne depasse pas `MemTotal`', async () => {
    const fw = fortigate();
    const vue = await fw.executeCommand('diagnose hardware sysinfo memory');

    expect(valeur(vue, 'MemFree')!).toBeLessThanOrEqual(valeur(vue, 'MemTotal')!);
  });

  it('`MemTotal` s accorde avec `get system performance status`', async () => {
    const fw = fortigate();
    const meminfo = await fw.executeCommand('diagnose hardware sysinfo memory');
    const perf = await fw.executeCommand('get system performance status');
    const total = Number(perf.match(/Memory:\s*(\d+)k total/)?.[1]);

    expect(valeur(meminfo, 'MemTotal')).toBe(total);
  });

  it('et `MemFree` aussi', async () => {
    const fw = fortigate();
    const meminfo = await fw.executeCommand('diagnose hardware sysinfo memory');
    const perf = await fw.executeCommand('get system performance status');
    const libre = Number(perf.match(/(\d+)k free/)?.[1]);

    expect(valeur(meminfo, 'MemFree')).toBe(libre);
  });

  it('`LowTotal` vaut `MemTotal` — pas de zone haute sur 64 bits', async () => {
    const fw = fortigate();
    const vue = await fw.executeCommand('diagnose hardware sysinfo memory');

    expect(valeur(vue, 'LowTotal')).toBe(valeur(vue, 'MemTotal'));
    expect(valeur(vue, 'HighTotal')).toBe(0);
  });

  it('un FortiGate n a pas de swap', async () => {
    const fw = fortigate();
    const vue = await fw.executeCommand('diagnose hardware sysinfo memory');

    expect(valeur(vue, 'SwapTotal')).toBe(0);
    expect(valeur(vue, 'SwapFree')).toBe(0);
  });
});

describe('les autres sous-commandes de `diagnose hardware sysinfo`', () => {
  it('`diagnose hardware sysinfo conserve` existe deja', async () => {
    const fw = fortigate();

    expect(await fw.executeCommand('diagnose hardware sysinfo conserve'))
      .not.toMatch(/Unknown action/);
  });

  it('une sous-commande INCONNUE est refusee', async () => {
    const fw = fortigate();

    expect(await fw.executeCommand('diagnose hardware sysinfo zorglub'))
      .toMatch(/Unknown action|Command fail/);
  });
});
