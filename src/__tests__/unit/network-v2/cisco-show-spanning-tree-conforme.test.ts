import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
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
  const a = new CiscoSwitch('switch-cisco', 'SW-A', 8, 0, 0);
  const b = new CiscoSwitch('switch-cisco', 'SW-B', 8, 200, 0);
  new Cable('l1').connect(a.getPort('FastEthernet0/1')!, b.getPort('FastEthernet0/1')!);
  new Cable('l2').connect(a.getPort('FastEthernet0/2')!, b.getPort('FastEthernet0/2')!);
  for (const d of [a, b]) {
    for (const c of ['enable', 'configure terminal',
      'interface range FastEthernet0/1 - 2', 'switchport mode trunk', 'exit', 'end']) {
      await run(d, c);
    }
  }
  return { a, b };
}

async function mode(sw: CiscoSwitch, valeur: string): Promise<void> {
  for (const c of ['configure terminal', `spanning-tree mode ${valeur}`, 'end']) {
    await run(sw, c);
  }
}

const ENTETE = 'Interface           Role Sts Cost      Prio.Nbr Type';
const FILET = '------------------- ---- --- --------- -------- '
  + '--------------------------------';

describe('le protocole annonce est celui que la machine execute', () => {
  it('en PVST, `ieee` — c est le nom de 802.1D', async () => {
    const { a } = await paire();
    expect(await run(a, 'show spanning-tree')).toContain('protocol ieee');
  });

  it('en rapid-pvst, `rstp` et non `ieee`', async () => {
    const { a } = await paire();
    await mode(a, 'rapid-pvst');
    const vu = await run(a, 'show spanning-tree');
    expect(vu).toContain('protocol rstp');
    expect(vu).not.toContain('protocol ieee');
  });

  it('en MST, `mstp`, et l instance se nomme MST0 et non VLAN0001', async () => {
    const { a } = await paire();
    await mode(a, 'mst');
    const vu = await run(a, 'show spanning-tree');
    expect(vu).toContain('protocol mstp');
    expect(vu).toContain('MST0');
    expect(vu).not.toContain('VLAN0001');
    expect(vu).not.toContain('protocol ieee');
  });

  it('revenir en PVST rend le nom de VLAN', async () => {
    const { a } = await paire();
    await mode(a, 'mst');
    await mode(a, 'pvst');
    const vu = await run(a, 'show spanning-tree');
    expect(vu).toContain('VLAN0001');
    expect(vu).toContain('protocol ieee');
  });
});

describe('le bloc rendu est celui d IOS, mesure sur une capture', () => {
  it('le bloc `Bridge ID` existe, avec son sys-id-ext', async () => {
    const { a } = await paire();
    const vu = await run(a, 'show spanning-tree');
    expect(vu).toContain('  Bridge ID  Priority    32769');
    expect(vu).toContain('(priority 32768 sys-id-ext 1)');
  });

  it('les minuteurs sont rendus, sous la racine ET sous le pont', async () => {
    const { a } = await paire();
    const vu = await run(a, 'show spanning-tree');
    const minuteurs = vu.split('\n')
      .filter(l => l.includes('Hello Time') && l.includes('Forward Delay'));
    expect(minuteurs).toHaveLength(2);
    expect(vu).toContain('Aging Time  300 sec');
  });

  it('le port racine porte son index et son nom COMPLET', async () => {
    const { b } = await paire();
    const vu = await run(b, 'show spanning-tree');
    expect(vu).toMatch(/ {13}Port {8}\d+ \(FastEthernet0\/1\)/);
  });

  it('une machine racine le dit au lieu de nommer un port', async () => {
    const { a } = await paire();
    const vu = await run(a, 'show spanning-tree');
    expect(vu).toContain('This bridge is the root');
    expect(vu).not.toContain('             Port  ');
  });

  it('les colonnes sont aux largeurs mesurees sur la capture', async () => {
    const { a } = await paire();
    const vu = await run(a, 'show spanning-tree');
    expect(vu).toContain(ENTETE);
    expect(vu).toContain(FILET);
  });

  it('une ligne de port se decoupe AUX BORNES des colonnes', async () => {
    const { b } = await paire();
    const vu = await run(b, 'show spanning-tree');
    const ligne = vu.split('\n').find(l => l.startsWith('Fa0/2'));
    expect(ligne).toBeDefined();
    expect(ligne!.slice(0, 19).trim()).toBe('Fa0/2');
    expect(ligne!.slice(20, 24).trim()).toBe('Altn');
    expect(ligne!.slice(25, 28).trim()).toBe('BLK');
    expect(ligne!.slice(39, 47).trim()).toBe('128.2');
  });
});
