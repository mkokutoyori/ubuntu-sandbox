/**
 * Un Port-channel PORTE sa configuration de niveau 2 et ses membres la
 * PRENNENT en arrivant, comme sur IOS. Signale par un utilisateur avec
 * la sequence exacte des trois premiers cas.
 *
 * DISCRIMINATION : 9 des 13 cas tombent contre l'etat d'avant. Les 4
 * autres sont nommes : le TEMOIN sur interface physique, la
 * `description` — qui etait la SEULE commande a passer sur un
 * Port-channel avant le correctif —, « configurer le faisceau APRES
 * coup » (les membres etaient deja la, donc la commande atteignait
 * directement leurs ports) et « un membre hors du faisceau n'herite de
 * rien », qui n'heritait de rien non plus quand rien n'heritait.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

interface Cmd { executeCommand(cmd: string): Promise<string> }
const LACP_PERIODIC_MS = 35_000;

async function taper(d: Cmd, cmds: string[]): Promise<string> {
  let last = '';
  for (const c of cmds) last = await d.executeCommand(c);
  return last;
}

async function labo(nb = 2) {
  const a = new CiscoSwitch('switch-cisco', 'Switch1', 24, 0, 0);
  const b = new CiscoSwitch('switch-cisco', 'SWB', 24, 300, 0);
  a.powerOn(); b.powerOn();
  for (let i = 1; i <= nb; i++) {
    new Cable(`c${i}`).connect(a.getPort(`FastEthernet0/${i}`)!, b.getPort(`FastEthernet0/${i}`)!);
  }
  return { a, b };
}

describe('la sequence signalee par l\'utilisateur', () => {
  beforeEach(() => {
    resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
    vi.useFakeTimers();
  });
  afterEach(() => { vi.useRealTimers(); });

  it('`description` sur un Port-channel est acceptee', async () => {
    const { a } = await labo();
    expect(await taper(a, ['enable', 'configure terminal', 'interface Port-channel 1',
      'description "Lien Agrege vers SWB"'])).toBe('');
  }, 30_000);

  it('`switchport mode trunk` sur un Port-channel ne rend plus `% Error`', async () => {
    const { a } = await labo();
    expect(await taper(a, ['enable', 'configure terminal', 'interface Port-channel 1',
      'switchport mode trunk'])).toBe('');
  }, 30_000);

  it('`switchport trunk allowed vlan` non plus', async () => {
    const { a } = await labo();
    expect(await taper(a, ['enable', 'configure terminal', 'interface Port-channel 1',
      'switchport mode trunk', 'switchport trunk allowed vlan 10,20'])).toBe('');
  }, 30_000);
});

describe('un membre PREND la configuration du faisceau', () => {
  beforeEach(() => {
    resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
    vi.useFakeTimers();
  });
  afterEach(() => { vi.useRealTimers(); });

  async function laboConfigure() {
    const { a, b } = await labo();
    await taper(a, ['enable', 'configure terminal', 'interface Port-channel 1',
      'switchport mode trunk', 'switchport trunk allowed vlan 10,20', 'exit',
      'interface range FastEthernet0/1 - 2', 'channel-group 1 mode active', 'end']);
    return { a, b };
  }

  it('le mode du faisceau descend sur chaque membre', async () => {
    const { a } = await laboConfigure();
    for (const p of ['FastEthernet0/1', 'FastEthernet0/2']) {
      const out = await a.executeCommand(`show interfaces ${p} switchport`);
      expect(out, p).toContain('Administrative Mode: trunk');
    }
  }, 30_000);

  it('la liste de VLAN autorises descend aussi', async () => {
    const { a } = await laboConfigure();
    expect(await a.executeCommand('show interfaces FastEthernet0/1 switchport'))
      .toContain('Trunking VLANs Enabled: 10,20');
  }, 30_000);

  it('la configuration rendue reproduit ce que chaque membre porte', async () => {
    const { a } = await laboConfigure();
    const cfg = await a.executeCommand('show running-config');
    expect(cfg).toContain('interface FastEthernet0/1\n switchport mode trunk\n'
      + ' switchport trunk allowed vlan 10,20\n channel-group 1 mode active');
  }, 30_000);

  it('un membre ajoute APRES coup herite lui aussi', async () => {
    const { a } = await labo(3);
    await taper(a, ['enable', 'configure terminal', 'interface Port-channel 1',
      'switchport mode trunk', 'exit',
      'interface FastEthernet0/1', 'channel-group 1 mode active', 'exit',
      'interface FastEthernet0/3', 'channel-group 1 mode active', 'end']);
    expect(await a.executeCommand('show interfaces FastEthernet0/3 switchport'))
      .toContain('Administrative Mode: trunk');
  }, 30_000);

  it('configurer le faisceau APRES coup redescend sur les membres deja la', async () => {
    const { a } = await labo();
    await taper(a, ['enable', 'configure terminal',
      'interface range FastEthernet0/1 - 2', 'channel-group 1 mode active', 'exit',
      'interface Port-channel 1', 'switchport mode trunk', 'end']);
    expect(await a.executeCommand('show interfaces FastEthernet0/2 switchport'))
      .toContain('Administrative Mode: trunk');
  }, 30_000);

  it('le faisceau porte vraiment le trafic etiquete des deux cotes', async () => {
    const { a, b } = await labo();
    for (const d of [a, b] as Cmd[]) {
      await taper(d, ['enable', 'configure terminal', 'vlan 10', 'exit',
        'interface Port-channel 1', 'switchport mode trunk', 'exit',
        'interface range FastEthernet0/1 - 2', 'channel-group 1 mode active', 'end']);
    }
    await vi.advanceTimersByTimeAsync(LACP_PERIODIC_MS);
    expect(await a.executeCommand('show etherchannel summary'))
      .toMatch(/Fa0\/1\(P\) Fa0\/2\(P\)/);
    expect(await a.executeCommand('show interfaces FastEthernet0/1 switchport'))
      .toContain('Operational Mode: trunk');
  }, 30_000);
});

describe('les bornes du mecanisme', () => {
  beforeEach(() => {
    resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
    vi.useFakeTimers();
  });
  afterEach(() => { vi.useRealTimers(); });

  it('une interface physique garde son comportement — TEMOIN', async () => {
    const { a } = await labo();
    expect(await taper(a, ['enable', 'configure terminal', 'interface FastEthernet0/3',
      'switchport mode trunk'])).toBe('');
    expect(await a.executeCommand('show interfaces FastEthernet0/3 switchport'))
      .toContain('Administrative Mode: trunk');
  }, 30_000);

  it('un membre hors du faisceau n\'herite de rien', async () => {
    const { a } = await labo(3);
    await taper(a, ['enable', 'configure terminal', 'interface Port-channel 1',
      'switchport mode trunk', 'exit',
      'interface FastEthernet0/1', 'channel-group 1 mode active', 'end']);
    expect(await a.executeCommand('show interfaces FastEthernet0/3 switchport'))
      .toContain('Administrative Mode: static access');
  }, 30_000);

  it('un VLAN d\'acces descend comme un mode trunk', async () => {
    const { a } = await labo();
    await taper(a, ['enable', 'configure terminal', 'vlan 30', 'exit',
      'interface Port-channel 1', 'switchport mode access', 'switchport access vlan 30',
      'exit', 'interface FastEthernet0/1', 'channel-group 1 mode active', 'end']);
    expect(await a.executeCommand('show interfaces FastEthernet0/1 switchport'))
      .toContain('Access Mode VLAN: 30');
  }, 30_000);

  it('un Port-channel inexistant se configure quand meme, comme sur IOS', async () => {
    const { a } = await labo();
    expect(await taper(a, ['enable', 'configure terminal', 'interface Port-channel 9',
      'switchport mode trunk'])).toBe('');
  }, 30_000);
});
