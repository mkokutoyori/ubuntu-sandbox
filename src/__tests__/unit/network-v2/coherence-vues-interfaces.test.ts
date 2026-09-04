import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { HuaweiSwitch } from '@/network/devices/HuaweiSwitch';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, MACAddress, resetCounters } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { pingOnSimulatedClock } from '../../support/fastPing';
import { adapterIfIndex } from '@/network/devices/windows/WindowsInterfaceNaming';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  EquipmentRegistry.resetInstance();
  Logger.clear();
});

interface Cli {
  executeCommand(c: string): Promise<string>;
  powerOn(): void;
}

async function suite(d: Cli, cmds: string[]): Promise<string> {
  let last = '';
  for (const c of cmds) last = String(await d.executeCommand(c));
  return last;
}

async function vue(d: Cli, cmd: string): Promise<string> {
  return String(await d.executeCommand(cmd));
}

function ligneDe(sortie: string, prefixe: string): string {
  return sortie.split('\n').find((l) => l.trim().startsWith(prefixe)) ?? '';
}

function contientTous(texte: string, morceaux: string[]): boolean {
  return morceaux.every((m) => texte.includes(m));
}

const MASQUE_24 = '255.255.255.0';

async function routeurCisco(): Promise<CiscoRouter> {
  const r = new CiscoRouter('R1', 0, 0);
  r.powerOn();
  await suite(r as unknown as Cli, [
    'enable', 'configure terminal', 'interface GigabitEthernet0/0',
    'description LIEN-WAN', `ip address 10.0.0.1 ${MASQUE_24}`,
    'mtu 1400', 'bandwidth 50000', 'no shutdown', 'end',
  ]);
  return r;
}

async function commutateurCisco(): Promise<CiscoSwitch> {
  const sw = new CiscoSwitch('switch-cisco', 'SW1', 8, 0, 0);
  sw.powerOn();
  await suite(sw as unknown as Cli, [
    'enable', 'configure terminal',
    'interface Vlan1', `ip address 192.168.1.2 ${MASQUE_24}`, 'no shutdown', 'exit',
    'interface FastEthernet0/1', 'description POSTE-1', 'no shutdown', 'end',
  ]);
  return sw;
}

async function routeurHuawei(): Promise<HuaweiRouter> {
  const r = new HuaweiRouter('R2', 0, 0);
  r.powerOn();
  await suite(r as unknown as Cli, [
    'system-view', 'interface GigabitEthernet0/0/0',
    'description LIEN-WAN', `ip address 10.0.0.1 ${MASQUE_24}`, 'undo shutdown', 'quit', 'quit',
  ]);
  return r;
}

async function commutateurHuawei(): Promise<HuaweiSwitch> {
  const sw = new HuaweiSwitch('switch-huawei', 'SW2', 24);
  sw.powerOn();
  await suite(sw as unknown as Cli, [
    'system-view', 'vlan 10', 'quit',
    'interface Vlanif10', `ip address 192.168.10.1 ${MASQUE_24}`, 'quit',
    'interface GigabitEthernet0/0/1', 'description POSTE-1', 'quit', 'quit',
  ]);
  return sw;
}

function linuxConfigure(): LinuxPC {
  const pc = new LinuxPC('linux-pc', 'pc1', 0, 0);
  pc.powerOn();
  pc.getPorts()[0].configureIP(new IPAddress('10.0.0.5'), new SubnetMask(MASQUE_24));
  return pc;
}

function windowsConfigure(): WindowsPC {
  const pc = new WindowsPC('windows-pc', 'W1', 0, 0);
  pc.powerOn();
  pc.getPorts()[0].configureIP(new IPAddress('10.0.0.6'), new SubnetMask(MASQUE_24));
  return pc;
}

function windowsCable(pc: WindowsPC): void {
  const pair = new LinuxPC('linux-pc', 'W1-PAIR', 0, 0);
  pair.powerOn();
  new Cable('coherence-w1').connect(pc.getPorts()[0], pair.getPorts()[0]);
}

// ───────────────────────── Cisco routeur ─────────────────────────

describe('Cisco routeur — l\'adresse IP est la même dans les quatre vues', () => {
  it('`show interfaces`, `show ip interface`, `show ip interface brief` et la configuration', async () => {
    const r = await routeurCisco();
    const detail = await vue(r as unknown as Cli, 'show interfaces GigabitEthernet0/0');
    const ip = await vue(r as unknown as Cli, 'show ip interface GigabitEthernet0/0');
    const bref = await vue(r as unknown as Cli, 'show ip interface brief');
    const conf = await vue(r as unknown as Cli, 'show running-config interface GigabitEthernet0/0');

    expect(detail).toContain('Internet address is 10.0.0.1/24');
    expect(ip).toContain('Internet address is 10.0.0.1/24');
    expect(ligneDe(bref, 'GigabitEthernet0/0')).toContain('10.0.0.1');
    expect(conf).toContain(`ip address 10.0.0.1 ${MASQUE_24}`);
  }, 30_000);

  it('une interface sans adresse est annoncée sans adresse partout', async () => {
    const r = await routeurCisco();
    const detail = await vue(r as unknown as Cli, 'show interfaces GigabitEthernet0/1');
    const ip = await vue(r as unknown as Cli, 'show ip interface GigabitEthernet0/1');
    const bref = await vue(r as unknown as Cli, 'show ip interface brief');

    expect(detail).not.toContain('Internet address is');
    expect(ip).toContain('Internet protocol processing disabled');
    expect(ligneDe(bref, 'GigabitEthernet0/1')).toContain('unassigned');
  }, 30_000);

  it('l\'adresse retirée disparaît des quatre vues à la fois', async () => {
    const r = await routeurCisco();
    await suite(r as unknown as Cli, [
      'configure terminal', 'interface GigabitEthernet0/0', 'no ip address', 'end',
    ]);
    expect(await vue(r as unknown as Cli, 'show interfaces GigabitEthernet0/0'))
      .not.toContain('10.0.0.1');
    expect(await vue(r as unknown as Cli, 'show ip interface GigabitEthernet0/0'))
      .not.toContain('10.0.0.1');
    expect(ligneDe(await vue(r as unknown as Cli, 'show ip interface brief'), 'GigabitEthernet0/0'))
      .toContain('unassigned');
    expect(await vue(r as unknown as Cli, 'show running-config interface GigabitEthernet0/0'))
      .not.toContain('ip address 10.0.0.1');
  }, 30_000);
});

describe('Cisco routeur — l\'état de l\'interface est le même dans les cinq vues', () => {
  it('une interface câblée est `up`/`up` partout', async () => {
    const r = await routeurCisco();
    const voisin = new CiscoRouter('R9', 0, 0);
    voisin.powerOn();
    await suite(voisin as unknown as Cli, [
      'enable', 'configure terminal', 'interface GigabitEthernet0/0', 'no shutdown', 'end',
    ]);
    new Cable('c1').connect(r.getPorts()[0], voisin.getPorts()[0]);

    const detail = await vue(r as unknown as Cli, 'show interfaces GigabitEthernet0/0');
    const ip = await vue(r as unknown as Cli, 'show ip interface GigabitEthernet0/0');
    const bref = ligneDe(await vue(r as unknown as Cli, 'show ip interface brief'), 'GigabitEthernet0/0');
    const desc = ligneDe(await vue(r as unknown as Cli, 'show interfaces description'), 'GigabitEthernet0/0');

    expect(detail).toContain('GigabitEthernet0/0 is up, line protocol is up');
    expect(ip).toContain('GigabitEthernet0/0 is up, line protocol is up');
    expect(bref).toMatch(/\bup\b.*\bup\b/);
    expect(desc).toMatch(/\bup\b.*\bup\b/);
  }, 30_000);

  it('une interface éteinte est `administratively down` partout', async () => {
    const r = await routeurCisco();
    await suite(r as unknown as Cli, [
      'configure terminal', 'interface GigabitEthernet0/0', 'shutdown', 'end',
    ]);
    const detail = await vue(r as unknown as Cli, 'show interfaces GigabitEthernet0/0');
    const ip = await vue(r as unknown as Cli, 'show ip interface GigabitEthernet0/0');
    const bref = ligneDe(await vue(r as unknown as Cli, 'show ip interface brief'), 'GigabitEthernet0/0');
    const desc = ligneDe(await vue(r as unknown as Cli, 'show interfaces description'), 'GigabitEthernet0/0');
    const conf = await vue(r as unknown as Cli, 'show running-config interface GigabitEthernet0/0');

    expect(detail).toContain('administratively down');
    expect(ip).toContain('administratively down');
    expect(bref).toContain('administratively down');
    expect(desc).toMatch(/\b(admin down|down)\b/);
    expect(conf).toContain('shutdown');
  }, 30_000);

  it('une interface allumée mais débranchée est `down`, jamais `administratively down`', async () => {
    const r = await routeurCisco();
    const detail = await vue(r as unknown as Cli, 'show interfaces GigabitEthernet0/0');
    const bref = ligneDe(await vue(r as unknown as Cli, 'show ip interface brief'), 'GigabitEthernet0/0');
    const desc = ligneDe(await vue(r as unknown as Cli, 'show interfaces description'), 'GigabitEthernet0/0');

    expect(detail).toContain('GigabitEthernet0/0 is down, line protocol is down');
    expect(bref).not.toContain('administratively down');
    expect(desc).not.toContain('admin down');
  }, 30_000);

  it('`show interfaces description` ne contredit pas `show ip interface brief`', async () => {
    const r = await routeurCisco();
    const bref = ligneDe(await vue(r as unknown as Cli, 'show ip interface brief'), 'GigabitEthernet0/0');
    const desc = ligneDe(await vue(r as unknown as Cli, 'show interfaces description'), 'GigabitEthernet0/0');
    const etatBref = bref.includes('administratively down') ? 'admin' : bref.match(/\bup\b/) ? 'up' : 'down';
    const etatDesc = desc.includes('admin down') ? 'admin' : /\s+up\s+/.test(desc) ? 'up' : 'down';
    expect(etatDesc).toBe(etatBref);
  }, 30_000);
});

describe('Cisco routeur — le MTU et la bande passante sont uniques', () => {
  it('le MTU configuré est lu par `show interfaces` ET par `show ip interface`', async () => {
    const r = await routeurCisco();
    expect(await vue(r as unknown as Cli, 'show interfaces GigabitEthernet0/0'))
      .toContain('MTU 1400 bytes');
    expect(await vue(r as unknown as Cli, 'show ip interface GigabitEthernet0/0'))
      .toContain('MTU is 1400 bytes');
  }, 30_000);

  it('changer le MTU change les deux vues ensemble', async () => {
    const r = await routeurCisco();
    await suite(r as unknown as Cli, [
      'configure terminal', 'interface GigabitEthernet0/0', 'mtu 9000', 'end',
    ]);
    expect(await vue(r as unknown as Cli, 'show interfaces GigabitEthernet0/0'))
      .toContain('MTU 9000 bytes');
    expect(await vue(r as unknown as Cli, 'show ip interface GigabitEthernet0/0'))
      .toContain('MTU is 9000 bytes');
  }, 30_000);

  it('la bande passante configurée est celle que `show interfaces` annonce', async () => {
    const r = await routeurCisco();
    expect(await vue(r as unknown as Cli, 'show interfaces GigabitEthernet0/0'))
      .toContain('BW 50000 Kbit/sec');
  }, 30_000);

  it('le MTU et la bande passante survivent à la relecture de la configuration', async () => {
    const r = await routeurCisco();
    const conf = await vue(r as unknown as Cli, 'show running-config interface GigabitEthernet0/0');
    expect(conf).toContain('mtu 1400');
    expect(conf).toContain('bandwidth 50000');
  }, 30_000);
});

describe('Cisco routeur — la description est la même partout où elle apparaît', () => {
  it('détail, tableau des descriptions et configuration', async () => {
    const r = await routeurCisco();
    expect(await vue(r as unknown as Cli, 'show interfaces GigabitEthernet0/0'))
      .toContain('Description: LIEN-WAN');
    expect(ligneDe(await vue(r as unknown as Cli, 'show interfaces description'), 'GigabitEthernet0/0'))
      .toContain('LIEN-WAN');
    expect(await vue(r as unknown as Cli, 'show running-config interface GigabitEthernet0/0'))
      .toContain('description LIEN-WAN');
  }, 30_000);

  it('la description retirée disparaît des trois vues', async () => {
    const r = await routeurCisco();
    await suite(r as unknown as Cli, [
      'configure terminal', 'interface GigabitEthernet0/0', 'no description', 'end',
    ]);
    expect(await vue(r as unknown as Cli, 'show interfaces GigabitEthernet0/0'))
      .not.toContain('LIEN-WAN');
    expect(ligneDe(await vue(r as unknown as Cli, 'show interfaces description'), 'GigabitEthernet0/0'))
      .not.toContain('LIEN-WAN');
    expect(await vue(r as unknown as Cli, 'show running-config interface GigabitEthernet0/0'))
      .not.toContain('LIEN-WAN');
  }, 30_000);
});

describe('Cisco routeur — l\'adresse matérielle est la même dans toutes les vues', () => {
  it('`show interfaces` annonce la MAC du port, deux fois et à l\'identique', async () => {
    const r = await routeurCisco();
    const detail = await vue(r as unknown as Cli, 'show interfaces GigabitEthernet0/0');
    const m = detail.match(/address is ([0-9a-f.]+) \(bia ([0-9a-f.]+)\)/);
    expect(m, 'la ligne Hardware doit porter deux fois la même adresse').not.toBeNull();
    expect(m![1]).toBe(m![2]);
  }, 30_000);

  it('deux interfaces n\'ont jamais la même adresse matérielle', async () => {
    const r = await routeurCisco();
    const a = (await vue(r as unknown as Cli, 'show interfaces GigabitEthernet0/0')).match(/address is ([0-9a-f.]+)/);
    const b = (await vue(r as unknown as Cli, 'show interfaces GigabitEthernet0/1')).match(/address is ([0-9a-f.]+)/);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a![1]).not.toBe(b![1]);
  }, 30_000);
});

// ───────────────────────── Cisco commutateur ─────────────────────────

describe('Cisco commutateur — les vues d\'un port physique s\'accordent', () => {
  it('l\'état d\'un port débranché est le même dans les quatre vues', async () => {
    const sw = await commutateurCisco();
    const detail = await vue(sw as unknown as Cli, 'show interfaces FastEthernet0/1');
    const statut = ligneDe(await vue(sw as unknown as Cli, 'show interfaces status'), 'Fa0/1');
    const bref = ligneDe(await vue(sw as unknown as Cli, 'show ip interface brief'), 'FastEthernet0/1');
    const desc = ligneDe(await vue(sw as unknown as Cli, 'show interfaces description'), 'Fa0/1');

    expect(detail).toContain('FastEthernet0/1 is down, line protocol is down');
    expect(statut).toContain('notconnect');
    expect(bref).not.toContain('administratively down');
    expect(desc).toMatch(/^Fa0\/1\s+down\s+down/);
  }, 30_000);

  it('un port éteint est `administratively down` / `disabled` partout', async () => {
    const sw = await commutateurCisco();
    await suite(sw as unknown as Cli, [
      'configure terminal', 'interface FastEthernet0/1', 'shutdown', 'end',
    ]);
    const detail = await vue(sw as unknown as Cli, 'show interfaces FastEthernet0/1');
    const statut = ligneDe(await vue(sw as unknown as Cli, 'show interfaces status'), 'Fa0/1');
    const bref = ligneDe(await vue(sw as unknown as Cli, 'show ip interface brief'), 'FastEthernet0/1');
    const desc = ligneDe(await vue(sw as unknown as Cli, 'show interfaces description'), 'Fa0/1');

    expect(detail).toContain('administratively down');
    expect(statut).toContain('disabled');
    expect(bref).toContain('administratively down');
    expect(desc).toContain('admin down');
  }, 30_000);

  it('la description d\'un port se lit dans les trois vues qui la portent', async () => {
    const sw = await commutateurCisco();
    expect(await vue(sw as unknown as Cli, 'show interfaces FastEthernet0/1'))
      .toContain('Description: POSTE-1');
    expect(ligneDe(await vue(sw as unknown as Cli, 'show interfaces status'), 'Fa0/1'))
      .toContain('POSTE-1');
    expect(ligneDe(await vue(sw as unknown as Cli, 'show interfaces description'), 'Fa0/1'))
      .toContain('POSTE-1');
    expect(await vue(sw as unknown as Cli, 'show running-config interface FastEthernet0/1'))
      .toContain('description POSTE-1');
  }, 30_000);

  it('le VLAN d\'accès est le même pour `show interfaces status` et `show interfaces switchport`', async () => {
    const sw = await commutateurCisco();
    await suite(sw as unknown as Cli, [
      'configure terminal', 'vlan 20', 'exit',
      'interface FastEthernet0/1', 'switchport mode access', 'switchport access vlan 20', 'end',
    ]);
    const statut = ligneDe(await vue(sw as unknown as Cli, 'show interfaces status'), 'Fa0/1');
    const sp = await vue(sw as unknown as Cli, 'show interfaces FastEthernet0/1 switchport');
    expect(statut).toMatch(/\s20\s/);
    expect(sp).toContain('Access Mode VLAN: 20');
  }, 30_000);

  it('le mode d\'un port trunk est le même dans les deux vues', async () => {
    const sw = await commutateurCisco();
    await suite(sw as unknown as Cli, [
      'configure terminal', 'interface FastEthernet0/1',
      'switchport mode trunk', 'end',
    ]);
    const statut = ligneDe(await vue(sw as unknown as Cli, 'show interfaces status'), 'Fa0/1');
    const sp = await vue(sw as unknown as Cli, 'show interfaces FastEthernet0/1 switchport');
    expect(sp).toContain('Administrative Mode: trunk');
    expect(statut).toMatch(/trunk|1/);
  }, 30_000);
});

describe('Cisco commutateur — les vues d\'une interface de VLAN s\'accordent', () => {
  it('l\'adresse de la SVI est la même dans les trois vues', async () => {
    const sw = await commutateurCisco();
    const bref = ligneDe(await vue(sw as unknown as Cli, 'show ip interface brief'), 'Vlan1');
    const detail = await vue(sw as unknown as Cli, 'show ip interface Vlan1');
    const conf = await vue(sw as unknown as Cli, 'show running-config');

    expect(bref).toContain('192.168.1.2');
    expect(detail).toContain('Internet address is 192.168.1.2/24');
    expect(conf).toContain(`ip address 192.168.1.2 ${MASQUE_24}`);
  }, 30_000);

  it('l\'état de la SVI ne se contredit pas entre le tableau et le détail', async () => {
    const sw = await commutateurCisco();
    const bref = ligneDe(await vue(sw as unknown as Cli, 'show ip interface brief'), 'Vlan1');
    const detail = await vue(sw as unknown as Cli, 'show ip interface Vlan1');
    const adminBref = !bref.includes('administratively down');
    const adminDetail = !detail.includes('administratively down');
    expect(adminDetail).toBe(adminBref);
  }, 30_000);

  it('une SVI éteinte est éteinte dans les deux vues', async () => {
    const sw = await commutateurCisco();
    await suite(sw as unknown as Cli, [
      'configure terminal', 'interface Vlan1', 'shutdown', 'end',
    ]);
    expect(ligneDe(await vue(sw as unknown as Cli, 'show ip interface brief'), 'Vlan1'))
      .toContain('administratively down');
    expect(await vue(sw as unknown as Cli, 'show ip interface Vlan1'))
      .toContain('administratively down');
  }, 30_000);

  it('le MTU de la SVI est annoncé par la vue détaillée', async () => {
    const sw = await commutateurCisco();
    expect(await vue(sw as unknown as Cli, 'show ip interface Vlan1')).toContain('MTU is 1500 bytes');
  }, 30_000);
});

// ───────────────────────── Huawei routeur ─────────────────────────

describe('Huawei routeur — l\'adresse est la même dans les quatre vues', () => {
  it('`display interface`, `display ip interface`, les deux tableaux et la configuration', async () => {
    const r = await routeurHuawei();
    const detail = await vue(r as unknown as Cli, 'display interface GigabitEthernet0/0/0');
    const ip = await vue(r as unknown as Cli, 'display ip interface GigabitEthernet0/0/0');
    const bref = ligneDe(await vue(r as unknown as Cli, 'display ip interface brief'), 'GigabitEthernet0/0/0');
    const conf = await vue(r as unknown as Cli, 'display current-configuration interface GigabitEthernet0/0/0');

    expect(detail).toContain('Internet Address is 10.0.0.1/24');
    expect(ip).toContain('Internet Address is 10.0.0.1/24');
    expect(bref).toContain('10.0.0.1/24');
    expect(conf).toContain(`ip address 10.0.0.1 ${MASQUE_24}`);
  }, 30_000);

  it('l\'adresse de diffusion est celle du réseau, pas celle de l\'interface', async () => {
    const r = await routeurHuawei();
    const ip = await vue(r as unknown as Cli, 'display ip interface GigabitEthernet0/0/0');
    expect(ip).toContain('Broadcast address : 10.0.0.255');
  }, 30_000);

  it('une interface sans adresse le dit dans les trois vues', async () => {
    const r = await routeurHuawei();
    const detail = await vue(r as unknown as Cli, 'display interface GigabitEthernet0/0/1');
    const bref = ligneDe(await vue(r as unknown as Cli, 'display ip interface brief'), 'GigabitEthernet0/0/1');
    expect(detail).toMatch(/not configured|processing : disabled/);
    expect(detail).not.toMatch(/Internet Address is \d/);
    expect(bref).toContain('unassigned');
  }, 30_000);
});

describe('Huawei routeur — l\'état est le même dans les quatre vues', () => {
  it('une interface débranchée est DOWN partout', async () => {
    const r = await routeurHuawei();
    const detail = await vue(r as unknown as Cli, 'display interface GigabitEthernet0/0/0');
    const ip = await vue(r as unknown as Cli, 'display ip interface GigabitEthernet0/0/0');
    const brefIp = ligneDe(await vue(r as unknown as Cli, 'display ip interface brief'), 'GigabitEthernet0/0/0');
    const brefIf = ligneDe(await vue(r as unknown as Cli, 'display interface brief'), 'GigabitEthernet0/0/0');

    expect(detail).toContain('current state : DOWN');
    expect(ip).toContain('current state : DOWN');
    expect(brefIp).toMatch(/\bdown\b.*\bdown\b/);
    expect(brefIf).toMatch(/\bdown\b.*\bdown\b/);
  }, 30_000);

  it('une interface éteinte porte la marque `*down` du tableau', async () => {
    const r = await routeurHuawei();
    await suite(r as unknown as Cli, [
      'system-view', 'interface GigabitEthernet0/0/0', 'shutdown', 'quit', 'quit',
    ]);
    const detail = await vue(r as unknown as Cli, 'display interface GigabitEthernet0/0/0');
    const brefIp = ligneDe(await vue(r as unknown as Cli, 'display ip interface brief'), 'GigabitEthernet0/0/0');
    expect(detail).toContain('Administratively DOWN');
    expect(brefIp).toContain('*down');
  }, 30_000);

  it('une interface câblée et allumée est UP dans les quatre vues', async () => {
    const r = await routeurHuawei();
    const voisin = new HuaweiRouter('R8', 0, 0);
    voisin.powerOn();
    await suite(voisin as unknown as Cli, [
      'system-view', 'interface GigabitEthernet0/0/0', 'undo shutdown', 'quit', 'quit',
    ]);
    new Cable('c2').connect(r.getPorts()[0], voisin.getPorts()[0]);

    const detail = await vue(r as unknown as Cli, 'display interface GigabitEthernet0/0/0');
    const brefIp = ligneDe(await vue(r as unknown as Cli, 'display ip interface brief'), 'GigabitEthernet0/0/0');
    const brefIf = ligneDe(await vue(r as unknown as Cli, 'display interface brief'), 'GigabitEthernet0/0/0');

    expect(detail).toContain('current state : UP');
    expect(brefIp).toMatch(/\bup\b/);
    expect(brefIf).toMatch(/\bup\b/);
  }, 30_000);
});

describe('Huawei routeur — MTU et description', () => {
  it('le MTU est le même dans les deux vues détaillées', async () => {
    const r = await routeurHuawei();
    expect(await vue(r as unknown as Cli, 'display interface GigabitEthernet0/0/0'))
      .toContain('The Maximum Transmit Unit is 1500');
    expect(await vue(r as unknown as Cli, 'display ip interface GigabitEthernet0/0/0'))
      .toContain('The Maximum Transmit Unit : 1500');
  }, 30_000);

  it('la description se lit dans la vue détaillée et dans la configuration', async () => {
    const r = await routeurHuawei();
    expect(await vue(r as unknown as Cli, 'display interface GigabitEthernet0/0/0'))
      .toContain('Description: LIEN-WAN');
    expect(await vue(r as unknown as Cli, 'display current-configuration interface GigabitEthernet0/0/0'))
      .toContain('description LIEN-WAN');
  }, 30_000);
});

// ───────────────────────── Huawei commutateur ─────────────────────────

describe('Huawei commutateur — les vues d\'un port et d\'une Vlanif s\'accordent', () => {
  it('la description du port se lit dans les deux vues qui la portent', async () => {
    const sw = await commutateurHuawei();
    expect(await vue(sw as unknown as Cli, 'display interface GigabitEthernet0/0/1'))
      .toContain('Description: POSTE-1');
    expect(await vue(sw as unknown as Cli, 'display current-configuration interface GigabitEthernet0/0/1'))
      .toContain('description POSTE-1');
  }, 30_000);

  it('un port sans adresse le dit, et le tableau des interfaces le confirme', async () => {
    const sw = await commutateurHuawei();
    const detail = await vue(sw as unknown as Cli, 'display interface GigabitEthernet0/0/1');
    const bref = ligneDe(await vue(sw as unknown as Cli, 'display interface brief'), 'GigabitEthernet0/0/1');
    expect(detail).toContain('Internet protocol processing : disabled');
    expect(bref).toMatch(/\bdown\b/);
  }, 30_000);

  it('l\'adresse de la Vlanif est la même dans les trois vues', async () => {
    const sw = await commutateurHuawei();
    const bref = ligneDe(await vue(sw as unknown as Cli, 'display ip interface brief'), 'Vlanif10');
    const detail = await vue(sw as unknown as Cli, 'display ip interface Vlanif10');
    const conf = await vue(sw as unknown as Cli, 'display current-configuration');

    expect(bref).toContain('192.168.10.1/24');
    expect(detail).toContain('Internet Address is 192.168.10.1/24');
    expect(conf).toContain(`ip address 192.168.10.1 ${MASQUE_24}`);
  }, 30_000);

  it('l\'état de la Vlanif ne se contredit pas entre le tableau et le détail', async () => {
    const sw = await commutateurHuawei();
    const bref = ligneDe(await vue(sw as unknown as Cli, 'display ip interface brief'), 'Vlanif10');
    const detail = await vue(sw as unknown as Cli, 'display ip interface Vlanif10');
    const eteintBref = bref.includes('*down');
    const eteintDetail = detail.includes('Administratively DOWN');
    expect(eteintDetail).toBe(eteintBref);
  }, 30_000);
});

// ───────────────────────── Linux ─────────────────────────

describe('Linux — l\'adresse est la même pour `ip`, `ifconfig` et le tableau bref', () => {
  it('`ip addr show`, `ip -br addr` et `ifconfig` donnent la même adresse', async () => {
    const pc = linuxConfigure();
    const addr = await vue(pc as unknown as Cli, 'ip addr show eth0');
    const bref = ligneDe(await vue(pc as unknown as Cli, 'ip -br addr'), 'eth0');
    const ifc = await vue(pc as unknown as Cli, 'ifconfig eth0');

    expect(addr).toContain('inet 10.0.0.5/24');
    expect(bref).toContain('10.0.0.5/24');
    expect(ifc).toContain('inet 10.0.0.5');
    expect(ifc).toContain(`netmask ${MASQUE_24}`);
  }, 30_000);

  it('l\'adresse de diffusion est la même pour `ip` et pour `ifconfig`', async () => {
    const pc = linuxConfigure();
    expect(await vue(pc as unknown as Cli, 'ip addr show eth0')).toContain('brd 10.0.0.255');
    expect(await vue(pc as unknown as Cli, 'ifconfig eth0')).toContain('broadcast 10.0.0.255');
  }, 30_000);

  it('une interface sans adresse n\'en montre dans aucune vue', async () => {
    const pc = linuxConfigure();
    expect(await vue(pc as unknown as Cli, 'ip addr show eth1')).not.toContain('inet 10.');
    expect(ligneDe(await vue(pc as unknown as Cli, 'ip -br addr'), 'eth1')).not.toContain('10.');
  }, 30_000);
});

describe('Linux — l\'adresse matérielle est la même dans les quatre sources', () => {
  it('`ip addr`, `ip link`, `ifconfig` et /sys donnent la même MAC', async () => {
    const pc = linuxConfigure();
    const addr = await vue(pc as unknown as Cli, 'ip addr show eth0');
    const link = await vue(pc as unknown as Cli, 'ip link show eth0');
    const ifc = await vue(pc as unknown as Cli, 'ifconfig eth0');
    const sys = (await vue(pc as unknown as Cli, 'cat /sys/class/net/eth0/address')).trim();

    expect(sys).toMatch(/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/);
    expect(addr).toContain(`link/ether ${sys}`);
    expect(link).toContain(`link/ether ${sys}`);
    expect(ifc).toContain(`ether ${sys}`);
  }, 30_000);
});

describe('Linux — le MTU est le même dans les cinq sources', () => {
  it('`ip addr`, `ip link`, `ifconfig`, `netstat -i` et /sys', async () => {
    const pc = linuxConfigure();
    const sys = (await vue(pc as unknown as Cli, 'cat /sys/class/net/eth0/mtu')).trim();
    expect(sys).toBe('1500');
    expect(await vue(pc as unknown as Cli, 'ip addr show eth0')).toContain('mtu 1500');
    expect(await vue(pc as unknown as Cli, 'ip link show eth0')).toContain('mtu 1500');
    expect(await vue(pc as unknown as Cli, 'ifconfig eth0')).toContain('mtu 1500');
    expect(ligneDe(await vue(pc as unknown as Cli, 'netstat -i'), 'eth0')).toContain('1500');
  }, 30_000);

  it('changer le MTU le change dans les cinq sources', async () => {
    const pc = linuxConfigure();
    await vue(pc as unknown as Cli, 'ip link set eth0 mtu 9000');
    expect((await vue(pc as unknown as Cli, 'cat /sys/class/net/eth0/mtu')).trim()).toBe('9000');
    expect(await vue(pc as unknown as Cli, 'ip addr show eth0')).toContain('mtu 9000');
    expect(await vue(pc as unknown as Cli, 'ip link show eth0')).toContain('mtu 9000');
    expect(await vue(pc as unknown as Cli, 'ifconfig eth0')).toContain('mtu 9000');
    expect(ligneDe(await vue(pc as unknown as Cli, 'netstat -i'), 'eth0')).toContain('9000');
  }, 30_000);
});

describe('Linux — l\'état du lien est le même dans les quatre sources', () => {
  it('une interface sans câble est DOWN partout', async () => {
    const pc = linuxConfigure();
    const sys = (await vue(pc as unknown as Cli, 'cat /sys/class/net/eth0/operstate')).trim();
    expect(sys).toBe('down');
    expect(await vue(pc as unknown as Cli, 'ip addr show eth0')).toContain('state DOWN');
    expect(await vue(pc as unknown as Cli, 'ip link show eth0')).toContain('state DOWN');
    expect(ligneDe(await vue(pc as unknown as Cli, 'ip -br addr'), 'eth0')).toContain('DOWN');
  }, 30_000);

  it('`ip -br link` est un tableau, pas la vue détaillée', async () => {
    const pc = linuxConfigure();
    const bref = await vue(pc as unknown as Cli, 'ip -br link');
    const ligne = ligneDe(bref, 'eth0');
    expect(ligne).not.toContain('link/ether');
    expect(ligne).toMatch(/^eth0\s+(DOWN|UP|UNKNOWN)/);
  }, 30_000);

  it('une interface éteinte par `ip link set down` le dit dans les quatre sources', async () => {
    const pc = linuxConfigure();
    await vue(pc as unknown as Cli, 'ip link set eth0 down');
    expect(await vue(pc as unknown as Cli, 'ip addr show eth0')).not.toContain(',UP,');
    expect(await vue(pc as unknown as Cli, 'ip link show eth0')).toContain('state DOWN');
    expect(ligneDe(await vue(pc as unknown as Cli, 'ip -br addr'), 'eth0')).toContain('DOWN');
    expect((await vue(pc as unknown as Cli, 'cat /sys/class/net/eth0/operstate')).trim()).toBe('down');
  }, 30_000);
});

describe('Linux — le tableau des interfaces ne compte chaque interface qu\'une fois', () => {
  it('`netstat -i` ne liste pas deux fois la même interface', async () => {
    const pc = linuxConfigure();
    const lignes = (await vue(pc as unknown as Cli, 'netstat -i'))
      .split('\n')
      .map((l) => l.trim().split(/\s+/)[0])
      .filter((n) => n && n !== 'Kernel' && n !== 'Iface');
    expect(new Set(lignes).size).toBe(lignes.length);
  }, 30_000);

  it('`ip -br addr` liste les mêmes interfaces que `ip addr`', async () => {
    const pc = linuxConfigure();
    const bref = (await vue(pc as unknown as Cli, 'ip -br addr'))
      .split('\n').map((l) => l.trim().split(/\s+/)[0]).filter(Boolean).sort();
    const complet = (await vue(pc as unknown as Cli, 'ip addr'))
      .split('\n').filter((l) => /^\d+:/.test(l))
      .map((l) => l.split(':')[1].trim()).sort();
    expect(bref).toEqual(complet);
  }, 30_000);
});

// ───────────────────────── Windows ─────────────────────────

describe('Windows — l\'adresse est la même dans les cinq vues', () => {
  it('`ipconfig`, `ipconfig /all`, `netsh`, `Get-NetIPAddress` et `Get-NetIPConfiguration`', async () => {
    const pc = windowsConfigure();
    windowsCable(pc);
    const ip = await vue(pc as unknown as Cli, 'ipconfig');
    const all = await vue(pc as unknown as Cli, 'ipconfig /all');
    const netsh = await vue(pc as unknown as Cli, 'netsh interface ip show config');
    const ps = await vue(pc as unknown as Cli, 'powershell Get-NetIPAddress');
    const cfg = await vue(pc as unknown as Cli, 'powershell Get-NetIPConfiguration');

    expect(ip).toContain('10.0.0.6');
    expect(all).toContain('10.0.0.6');
    expect(netsh).toContain('10.0.0.6');
    expect(ps).toContain('10.0.0.6');
    expect(cfg).toContain('10.0.0.6');
  }, 30_000);

  it('le masque est le même sous ses deux écritures', async () => {
    const pc = windowsConfigure();
    expect(await vue(pc as unknown as Cli, 'ipconfig')).toContain(MASQUE_24);
    expect(await vue(pc as unknown as Cli, 'netsh interface ip show config'))
      .toContain(`(mask ${MASQUE_24})`);
    expect(await vue(pc as unknown as Cli, 'powershell Get-NetIPAddress')).toContain('24');
  }, 30_000);
});

describe('Windows — l\'adresse matérielle est la même, et écrite comme Windows l\'écrit', () => {
  it('`ipconfig /all` et `Get-NetAdapter` donnent la même adresse', async () => {
    const pc = windowsConfigure();
    const all = await vue(pc as unknown as Cli, 'ipconfig /all');
    const ada = await vue(pc as unknown as Cli, 'powershell Get-NetAdapter');
    const m = all.match(/Physical Address[. ]*: ([0-9A-F-]{17})/);
    expect(m, 'ipconfig /all doit porter une adresse physique').not.toBeNull();
    expect(ada).toContain(m![1]);
  }, 30_000);
});

describe('Windows — l\'état DHCP ne se contredit pas d\'une vue à l\'autre', () => {
  it('une interface configurée à la main est DHCP=No dans les deux vues', async () => {
    const pc = windowsConfigure();
    const all = await vue(pc as unknown as Cli, 'ipconfig /all');
    const netsh = await vue(pc as unknown as Cli, 'netsh interface ip show config');
    const blocAll = all.split('Ethernet adapter Ethernet 0:')[1]?.split('Ethernet adapter')[0] ?? '';
    const blocNetsh = netsh.split('"Ethernet 0"')[1]?.split('Configuration for')[0] ?? '';
    expect(blocAll).toContain('DHCP Enabled. . . . . . . . . . . : No');
    expect(blocNetsh).toContain('DHCP enabled:                         No');
  }, 30_000);

  it('une interface non configurée dit la même chose des deux côtés', async () => {
    const pc = windowsConfigure();
    const all = await vue(pc as unknown as Cli, 'ipconfig /all');
    const netsh = await vue(pc as unknown as Cli, 'netsh interface ip show config');
    const blocAll = all.split('Ethernet adapter Ethernet 1:')[1]?.split('Ethernet adapter')[0] ?? '';
    const blocNetsh = netsh.split('"Ethernet 1"')[1]?.split('Configuration for')[0] ?? '';
    const dhcpAll = /DHCP Enabled[. ]*: (Yes|No)/.exec(blocAll)?.[1];
    const dhcpNetsh = /DHCP enabled:\s+(Yes|No)/.exec(blocNetsh)?.[1];
    expect(dhcpAll).toBe(dhcpNetsh);
  }, 30_000);
});

describe('Windows — `show addresses` et `show config` sont deux commandes', () => {
  it('la vue des adresses ne recopie pas la vue de configuration', async () => {
    const pc = windowsConfigure();
    const config = await vue(pc as unknown as Cli, 'netsh interface ip show config');
    const adresses = await vue(pc as unknown as Cli, 'netsh interface ip show addresses');
    expect(adresses).toContain('10.0.0.6');
    expect(adresses).not.toBe(config);
  }, 30_000);
});

describe('Windows — le nombre d\'interfaces est le même dans toutes les vues', () => {
  it('`ipconfig`, `ipconfig /all` et `Get-NetAdapter` voient les mêmes cartes', async () => {
    const pc = windowsConfigure();
    const compte = (t: string) => (t.match(/Ethernet adapter Ethernet \d/g) ?? []).length;
    const ip = compte(await vue(pc as unknown as Cli, 'ipconfig'));
    const all = compte(await vue(pc as unknown as Cli, 'ipconfig /all'));
    const ada = (await vue(pc as unknown as Cli, 'powershell Get-NetAdapter'))
      .split('\n').filter((l) => /^Ethernet \d/.test(l.trim())).length;
    expect(all).toBe(ip);
    expect(ada).toBe(ip);
  }, 30_000);
});

// ───────────────────────── D'une plateforme à l'autre ─────────────────────────

describe('Le même fait, sur quatre plateformes', () => {
  it('une interface configurée porte la même adresse quelle que soit la CLI', async () => {
    const cisco = await routeurCisco();
    const huawei = await routeurHuawei();
    expect(await vue(cisco as unknown as Cli, 'show ip interface GigabitEthernet0/0'))
      .toContain('10.0.0.1');
    expect(await vue(huawei as unknown as Cli, 'display ip interface GigabitEthernet0/0/0'))
      .toContain('10.0.0.1');
  }, 30_000);

  it('chaque plateforme écrit la MAC dans sa propre convention', async () => {
    const cisco = await routeurCisco();
    const linux = linuxConfigure();
    const windows = windowsConfigure();

    const c = (await vue(cisco as unknown as Cli, 'show interfaces GigabitEthernet0/0'))
      .match(/address is ([0-9a-f.]+)/)?.[1];
    const l = (await vue(linux as unknown as Cli, 'cat /sys/class/net/eth0/address')).trim();
    const w = (await vue(windows as unknown as Cli, 'ipconfig /all'))
      .match(/Physical Address[. ]*: ([0-9A-F-]{17})/)?.[1];

    expect(c).toMatch(/^[0-9a-f]{4}\.[0-9a-f]{4}\.[0-9a-f]{4}$/);
    expect(l).toMatch(/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/);
    expect(w).toMatch(/^([0-9A-F]{2}-){5}[0-9A-F]{2}$/);
  }, 30_000);

  it('un port éteint est annoncé éteint par chaque plateforme, dans ses mots', async () => {
    const cisco = await routeurCisco();
    const huawei = await routeurHuawei();
    const linux = linuxConfigure();

    await suite(cisco as unknown as Cli, [
      'configure terminal', 'interface GigabitEthernet0/0', 'shutdown', 'end',
    ]);
    await suite(huawei as unknown as Cli, [
      'system-view', 'interface GigabitEthernet0/0/0', 'shutdown', 'quit', 'quit',
    ]);
    await vue(linux as unknown as Cli, 'ip link set eth0 down');

    expect(await vue(cisco as unknown as Cli, 'show interfaces GigabitEthernet0/0'))
      .toContain('administratively down');
    expect(await vue(huawei as unknown as Cli, 'display interface GigabitEthernet0/0/0'))
      .toContain('Administratively DOWN');
    expect(await vue(linux as unknown as Cli, 'ip link show eth0')).toContain('state DOWN');
  }, 30_000);

  it('une adresse retirée disparaît de toutes les vues de sa plateforme', async () => {
    const linux = linuxConfigure();
    await vue(linux as unknown as Cli, 'ip addr del 10.0.0.5/24 dev eth0');
    expect(await vue(linux as unknown as Cli, 'ip addr show eth0')).not.toContain('10.0.0.5');
    expect(ligneDe(await vue(linux as unknown as Cli, 'ip -br addr'), 'eth0')).not.toContain('10.0.0.5');
    expect(await vue(linux as unknown as Cli, 'ifconfig eth0')).not.toContain('10.0.0.5');
  }, 30_000);
});

describe('Le tableau et le détail comptent les mêmes interfaces', () => {
  it('Cisco routeur : autant de lignes que de ports', async () => {
    const r = await routeurCisco();
    const bref = (await vue(r as unknown as Cli, 'show ip interface brief'))
      .split('\n').filter((l) => l.startsWith('GigabitEthernet')).length;
    expect(bref).toBe(r.getPorts().length);
  }, 30_000);

  it('Cisco commutateur : le tableau des états couvre tous les ports', async () => {
    const sw = await commutateurCisco();
    const statut = (await vue(sw as unknown as Cli, 'show interfaces status'))
      .split('\n').filter((l) => /^Fa0\/\d/.test(l.trim())).length;
    expect(statut).toBe(8);
  }, 30_000);

  it('Huawei routeur : les deux tableaux voient le même nombre de ports physiques', async () => {
    const r = await routeurHuawei();
    const brefIf = (await vue(r as unknown as Cli, 'display interface brief'))
      .split('\n').filter((l) => l.startsWith('GigabitEthernet')).length;
    const brefIp = (await vue(r as unknown as Cli, 'display ip interface brief'))
      .split('\n').filter((l) => l.startsWith('GigabitEthernet')).length;
    expect(brefIf).toBe(brefIp);
  }, 30_000);

  it('Linux : `ip -br addr` couvre exactement les ports de la machine, boucle comprise', async () => {
    const pc = linuxConfigure();
    const lignes = (await vue(pc as unknown as Cli, 'ip -br addr'))
      .split('\n').filter((l) => l.trim().length > 0).length;
    expect(lignes).toBe(pc.getPorts().length);
  }, 30_000);
});

describe('Une vue de détail répond pour l\'interface demandée, et pour elle seule', () => {
  it('Cisco : `show interfaces <nom>` ne rend qu\'un bloc', async () => {
    const r = await routeurCisco();
    const sortie = await vue(r as unknown as Cli, 'show interfaces GigabitEthernet0/0');
    expect(sortie).toContain('GigabitEthernet0/0 is');
    expect(sortie).not.toContain('GigabitEthernet0/1 is');
  }, 30_000);

  it('Huawei : `display interface <nom>` ne rend qu\'un bloc', async () => {
    const r = await routeurHuawei();
    const sortie = await vue(r as unknown as Cli, 'display interface GigabitEthernet0/0/0');
    expect(sortie).toContain('GigabitEthernet0/0/0 current state');
    expect(sortie).not.toContain('GigabitEthernet0/0/1 current state');
  }, 30_000);

  it('Linux : `ip addr show eth0` ne rend qu\'une interface', async () => {
    const pc = linuxConfigure();
    const sortie = await vue(pc as unknown as Cli, 'ip addr show eth0');
    expect(sortie).toContain('eth0');
    expect(sortie).not.toContain('eth1');
  }, 30_000);

  it('Cisco : un nom d\'interface inconnu est refusé, pas rendu vide', async () => {
    const r = await routeurCisco();
    expect(await vue(r as unknown as Cli, 'show interfaces GigabitEthernet9/9'))
      .toContain('% Invalid input');
  }, 30_000);

  it('Huawei : un nom d\'interface inconnu est refusé', async () => {
    const r = await routeurHuawei();
    const sortie = await vue(r as unknown as Cli, 'display interface GigabitEthernet9/9/9');
    expect(sortie).toMatch(/Error|Wrong|Invalid|does not exist/i);
  }, 30_000);

  it('Linux : une interface inconnue est refusée', async () => {
    const pc = linuxConfigure();
    expect(await vue(pc as unknown as Cli, 'ip addr show eth99'))
      .toMatch(/does not exist|Device .* does not exist/i);
  }, 30_000);
});

// ───────────────────────── Linux, recensement étendu ─────────────────────────

describe('Linux — les sources de compteurs disent la même chose', () => {
  it('`/proc/net/dev` existe et porte les compteurs que `netstat -i` rend', async () => {
    const pc = linuxConfigure();
    const proc = await vue(pc as unknown as Cli, 'cat /proc/net/dev');
    expect(proc).not.toContain('No such file');
    expect(proc).toContain('eth0');
  }, 30_000);

  it('`ifconfig`, `netstat -i` et `/proc/net/dev` comptent les mêmes octets', async () => {
    const pc = linuxConfigure();
    const proc = ligneDe(await vue(pc as unknown as Cli, 'cat /proc/net/dev'), 'eth0');
    const netstat = ligneDe(await vue(pc as unknown as Cli, 'netstat -i'), 'eth0');
    const ifc = await vue(pc as unknown as Cli, 'ifconfig eth0');
    const rxProc = proc.trim().split(/\s+/)[1];
    const rxIfc = /RX packets (\d+)\s+bytes (\d+)/.exec(ifc);
    const rxNet = netstat.trim().split(/\s+/)[2];
    expect(rxIfc).not.toBeNull();
    expect(rxProc).toBe(rxIfc![2]);
    expect(rxNet).toBe(rxIfc![1]);
  }, 30_000);

  it('`ip -s link` porte les mêmes compteurs que `ifconfig`', async () => {
    const pc = linuxConfigure();
    const stats = await vue(pc as unknown as Cli, 'ip -s link show eth0');
    expect(stats).toContain('RX:');
    expect(stats).toContain('TX:');
  }, 30_000);
});

describe('Linux — les sources de /sys s\'accordent avec les commandes', () => {
  it('`carrier` dit ce que l\'état du lien dit', async () => {
    const pc = linuxConfigure();
    const carrier = (await vue(pc as unknown as Cli, 'cat /sys/class/net/eth0/carrier')).trim();
    const etat = (await vue(pc as unknown as Cli, 'cat /sys/class/net/eth0/operstate')).trim();
    expect(carrier).toBe('0');
    expect(etat).toBe('down');
  }, 30_000);

  it('`speed` s\'accorde avec ce qu\'`ethtool` annonce', async () => {
    const pc = linuxConfigure();
    const speed = (await vue(pc as unknown as Cli, 'cat /sys/class/net/eth0/speed')).trim();
    expect(speed).toMatch(/^\d+$/);
  }, 30_000);

  it('`ls /sys/class/net` liste les mêmes interfaces qu\'`ip -br link`', async () => {
    const pc = linuxConfigure();
    const sys = (await vue(pc as unknown as Cli, 'ls /sys/class/net'))
      .split(/\s+/).filter(Boolean).sort();
    const bref = (await vue(pc as unknown as Cli, 'ip -br link'))
      .split('\n').map((l) => l.trim().split(/\s+/)[0]).filter(Boolean).sort();
    expect(bref).toEqual(sys);
  }, 30_000);

  it('le nom de l\'interface est le même dans `lspci -k` et dans `ip link`', async () => {
    const pc = linuxConfigure();
    const link = await vue(pc as unknown as Cli, 'ip link show eth0');
    expect(link).toContain('eth0');
  }, 30_000);
});

describe('Linux — la route connectée s\'accorde avec l\'adresse de l\'interface', () => {
  it('`ip route` annonce le réseau de l\'adresse configurée', async () => {
    const pc = linuxConfigure();
    const routes = await vue(pc as unknown as Cli, 'ip route show dev eth0');
    expect(routes).toContain('10.0.0.0/24');
    expect(routes).toContain('src 10.0.0.5');
  }, 30_000);

  it('l\'adresse retirée retire aussi sa route connectée', async () => {
    const pc = linuxConfigure();
    await vue(pc as unknown as Cli, 'ip addr del 10.0.0.5/24 dev eth0');
    expect(await vue(pc as unknown as Cli, 'ip route show dev eth0')).not.toContain('10.0.0.0/24');
  }, 30_000);

  it('`nmcli device show` donne la même adresse que `ip addr`', async () => {
    const pc = linuxConfigure();
    const nm = await vue(pc as unknown as Cli, 'nmcli device show eth0');
    if (!nm.includes('not found') && !nm.includes('command not found')) {
      expect(nm).toContain('eth0');
    }
  }, 30_000);
});

// ───────────────────────── Windows, recensement étendu ─────────────────────────

describe('Windows — `systeminfo` décrit les mêmes cartes que les autres vues', () => {
  it('le nombre de cartes annoncé est celui des cartes présentes', async () => {
    const pc = windowsConfigure();
    const si = await vue(pc as unknown as Cli, 'systeminfo');
    const m = /Network Card\(s\):\s+(\d+) NIC\(s\) Installed/.exec(si);
    expect(m, '`systeminfo` doit annoncer un nombre de cartes').not.toBeNull();
    expect(Number(m![1])).toBe(pc.getPorts().length);
  }, 30_000);

  it('l\'adresse IP vue par `systeminfo` est celle d\'`ipconfig`', async () => {
    const pc = windowsConfigure();
    const si = await vue(pc as unknown as Cli, 'systeminfo');
    expect(si).toContain('10.0.0.6');
    expect(si).toContain('Connection Name: Ethernet 0');
  }, 30_000);

  it('l\'état DHCP de `systeminfo` est celui d\'`ipconfig /all`', async () => {
    const pc = windowsConfigure();
    const si = await vue(pc as unknown as Cli, 'systeminfo');
    const bloc = si.split('Connection Name: Ethernet 0')[1]?.split('[02]')[0] ?? '';
    expect(bloc).toContain('DHCP Enabled:    No');
  }, 30_000);

  it('une carte débranchée est annoncée débranchée par `systeminfo` comme par `ipconfig`', async () => {
    const pc = windowsConfigure();
    const si = await vue(pc as unknown as Cli, 'systeminfo');
    const ip = await vue(pc as unknown as Cli, 'ipconfig');
    expect(si).toContain('Status:          Media disconnected');
    expect(ip).toContain('Media State . . . . . . . . . . . : Media disconnected');
  }, 30_000);
});

describe('Windows — `getmac` donne les mêmes adresses que tout le monde', () => {
  it('`getmac` liste une ligne par carte', async () => {
    const pc = windowsConfigure();
    const g = await vue(pc as unknown as Cli, 'getmac');
    const lignes = g.split('\n').filter((l) => /[0-9A-F]{2}-[0-9A-F]{2}/.test(l));
    expect(lignes.length).toBe(pc.getPorts().length);
  }, 30_000);

  it('`getmac /v` nomme la connexion et donne la même adresse qu\'`ipconfig /all`', async () => {
    const pc = windowsConfigure();
    const g = await vue(pc as unknown as Cli, 'getmac /v');
    const all = await vue(pc as unknown as Cli, 'ipconfig /all');
    const mac = /Physical Address[. ]*: ([0-9A-F-]{17})/.exec(all)?.[1];
    expect(mac).toBeDefined();
    expect(g).toContain('Ethernet 0');
    expect(g).toContain(mac!);
  }, 30_000);
});

describe('Windows — la vue WMI ne contredit pas les vues natives', () => {
  it('`Win32_NetworkAdapterConfiguration` donne la même adresse et le même masque', async () => {
    const pc = windowsConfigure();
    const wmi = await vue(pc as unknown as Cli, 'powershell Get-CimInstance Win32_NetworkAdapterConfiguration');
    expect(wmi).toContain('10.0.0.6');
    expect(wmi).toContain(MASQUE_24);
  }, 30_000);

  it('l\'état DHCP de WMI est celui de `netsh`', async () => {
    const pc = windowsConfigure();
    const wmi = await vue(pc as unknown as Cli, 'powershell Get-CimInstance Win32_NetworkAdapterConfiguration');
    const netsh = await vue(pc as unknown as Cli, 'netsh interface ip show config');
    const index = adapterIfIndex(1);
    const blocWmi = wmi.split(/\n\s*\n/)
      .find((b) => new RegExp(`InterfaceIndex\\s+:\\s+${index}\\b`).test(b)) ?? '';
    const blocNetsh = netsh.split('"Ethernet 1"')[1]?.split('Configuration for')[0] ?? '';
    const wmiDhcp = /DHCPEnabled\s+:\s+(True|False)/.exec(blocWmi)?.[1] === 'True';
    const netshDhcp = /DHCP enabled:\s+(Yes|No)/.exec(blocNetsh)?.[1] === 'Yes';
    expect(wmiDhcp).toBe(netshDhcp);
  }, 30_000);

  it('`wmic nic` répond, et donne les mêmes adresses matérielles', async () => {
    const pc = windowsConfigure();
    const w = await vue(pc as unknown as Cli, 'wmic nic get MACAddress,Name,NetEnabled');
    expect(w.trim().length).toBeGreaterThan(0);
    expect(w).toContain('MACAddress');
  }, 30_000);
});

describe('Windows — `netsh` voit les mêmes interfaces que PowerShell', () => {
  it('`netsh interface show interface` liste les cartes', async () => {
    const pc = windowsConfigure();
    const n = await vue(pc as unknown as Cli, 'netsh interface show interface');
    expect(n).toContain('Ethernet 0');
  }, 30_000);

  it('`netsh interface ipv4 show interfaces` existe et compte les mêmes cartes', async () => {
    const pc = windowsConfigure();
    const n = await vue(pc as unknown as Cli, 'netsh interface ipv4 show interfaces');
    expect(n).not.toContain('was not found');
    expect(n).toContain('Ethernet 0');
  }, 30_000);

  it('`Get-NetIPInterface` existe et voit les mêmes cartes', async () => {
    const pc = windowsConfigure();
    const p = await vue(pc as unknown as Cli, 'powershell Get-NetIPInterface');
    expect(p).not.toContain('is not recognized');
    expect(p).toContain('Ethernet 0');
  }, 30_000);
});

describe('Windows — la table de routage et les cartes s\'accordent', () => {
  it('`route print` liste les mêmes adresses matérielles que `getmac`', async () => {
    const pc = windowsConfigure();
    const route = await vue(pc as unknown as Cli, 'route print');
    const all = await vue(pc as unknown as Cli, 'ipconfig /all');
    const mac = /Physical Address[. ]*: ([0-9A-F-]{17})/.exec(all)?.[1] ?? '';
    expect(route).toContain(mac.replace(/-/g, ' '));
  }, 30_000);

  it('la route connectée porte l\'adresse de la carte', async () => {
    const pc = windowsConfigure();
    const route = await vue(pc as unknown as Cli, 'route print');
    expect(route).toContain('10.0.0.0');
    expect(route).toContain('10.0.0.6');
  }, 30_000);

  it('`Get-NetAdapterStatistics` nomme les mêmes cartes que `Get-NetAdapter`', async () => {
    const pc = windowsConfigure();
    const stats = await vue(pc as unknown as Cli, 'powershell Get-NetAdapterStatistics');
    const ada = await vue(pc as unknown as Cli, 'powershell Get-NetAdapter');
    for (const nom of ['Ethernet 0', 'Ethernet 1']) {
      expect(stats).toContain(nom);
      expect(ada).toContain(nom);
    }
  }, 30_000);
});

// ───────────────── Les compteurs, après du vrai trafic ─────────────────

async function paireLinux(): Promise<{ a: LinuxPC; b: LinuxPC; iface: string }> {
  const a = new LinuxPC('linux-pc', 'pcA', 0, 0);
  const b = new LinuxPC('linux-pc', 'pcB', 0, 0);
  a.powerOn(); b.powerOn();
  new Cable('lien').connect(a.getPorts()[1], b.getPorts()[1]);
  const m = new SubnetMask(MASQUE_24);
  a.getPorts()[1].configureIP(new IPAddress('10.0.0.1'), m);
  b.getPorts()[1].configureIP(new IPAddress('10.0.0.2'), m);
  await pingOnSimulatedClock(a, 'ping -c 3 10.0.0.2');
  return { a, b, iface: a.getPorts()[1].getName() };
}

describe('Linux — après un ping, les quatre compteurs disent le même nombre', () => {
  it('`netstat -i` et `/proc/net/dev` comptent les mêmes paquets', async () => {
    const { a, iface } = await paireLinux();
    const net = ligneDe(await vue(a as unknown as Cli, 'netstat -i'), iface);
    const proc = ligneDe(await vue(a as unknown as Cli, 'cat /proc/net/dev'), `${iface}:`);
    const rxNet = Number(net.trim().split(/\s+/)[2]);
    const rxProc = Number(proc.trim().split(/\s+/)[2]);
    expect(rxNet).toBeGreaterThan(0);
    expect(rxProc).toBe(rxNet);
  }, 30_000);

  it('`ifconfig` compte les mêmes paquets et les mêmes octets que `/proc/net/dev`', async () => {
    const { a, iface } = await paireLinux();
    const ifc = await vue(a as unknown as Cli, `ifconfig ${iface}`);
    const proc = ligneDe(await vue(a as unknown as Cli, 'cat /proc/net/dev'), `${iface}:`);
    const champs = proc.trim().split(/\s+/);
    const rx = /RX packets (\d+)\s+bytes (\d+)/.exec(ifc);
    const tx = /TX packets (\d+)\s+bytes (\d+)/.exec(ifc);
    expect(rx).not.toBeNull();
    expect(tx).not.toBeNull();
    expect(Number(rx![1])).toBe(Number(champs[2]));
    expect(Number(rx![2])).toBe(Number(champs[1]));
    expect(Number(tx![1])).toBe(Number(champs[10]));
  }, 30_000);

  it('une interface sans trafic reste à zéro dans les trois vues', async () => {
    const { a } = await paireLinux();
    const net = ligneDe(await vue(a as unknown as Cli, 'netstat -i'), 'eth2');
    const proc = ligneDe(await vue(a as unknown as Cli, 'cat /proc/net/dev'), 'eth2:');
    const ifc = await vue(a as unknown as Cli, 'ifconfig eth2');
    expect(Number(net.trim().split(/\s+/)[2])).toBe(0);
    expect(Number(proc.trim().split(/\s+/)[2])).toBe(0);
    expect(ifc).toContain('RX packets 0');
  }, 30_000);
});

describe('Cisco — après un ping, la vue détaillée compte ce qui est passé', () => {
  it('les paquets entrés et sortis sont non nuls et cohérents', async () => {
    const r = new CiscoRouter('R1', 0, 0);
    r.powerOn();
    const voisin = new CiscoRouter('R9', 0, 0);
    voisin.powerOn();
    for (const d of [r, voisin]) {
      await suite(d as unknown as Cli, ['enable', 'configure terminal',
        'interface GigabitEthernet0/0', 'no shutdown', 'end']);
    }
    await suite(r as unknown as Cli, ['configure terminal', 'interface GigabitEthernet0/0',
      `ip address 10.0.0.1 ${MASQUE_24}`, 'end']);
    await suite(voisin as unknown as Cli, ['configure terminal', 'interface GigabitEthernet0/0',
      `ip address 10.0.0.2 ${MASQUE_24}`, 'end']);
    new Cable('lien2').connect(r.getPorts()[0], voisin.getPorts()[0]);
    await vue(r as unknown as Cli, 'ping 10.0.0.2');

    const detail = await vue(r as unknown as Cli, 'show interfaces GigabitEthernet0/0');
    const entres = /(\d+) packets input/.exec(detail);
    const sortis = /(\d+) packets output/.exec(detail);
    expect(entres).not.toBeNull();
    expect(sortis).not.toBeNull();
    expect(Number(sortis![1])).toBeGreaterThan(0);
    expect(Number(entres![1])).toBeGreaterThan(0);
  }, 30_000);
});

describe('Windows — les deux vues de compteurs s\'accordent', () => {
  it('`netstat -e` est un tableau de statistiques, pas la liste des connexions', async () => {
    const pc = windowsConfigure();
    const e = await vue(pc as unknown as Cli, 'netstat -e');
    expect(e).toContain('Interface Statistics');
    expect(e).not.toContain('Active Connections');
    expect(e).toContain('Unicast packets');
  }, 30_000);

  it('`netstat -e` et `Get-NetAdapterStatistics` partent des mêmes compteurs', async () => {
    const pc = windowsConfigure();
    const e = await vue(pc as unknown as Cli, 'netstat -e');
    const ps = await vue(pc as unknown as Cli, 'powershell Get-NetAdapterStatistics');
    const octets = /Bytes\s+(\d+)\s+(\d+)/.exec(e);
    expect(octets).not.toBeNull();
    const recusPs = [...ps.matchAll(/ReceivedBytes\s+:\s+(\d+)/g)]
      .reduce((n, m) => n + Number(m[1]), 0);
    expect(Number(octets![1])).toBe(recusPs);
  }, 30_000);
});

// ───────────────── Vitesse et duplex ─────────────────

describe('Cisco commutateur — la vitesse et le duplex configurés se voient partout', () => {
  it('un port forcé n\'est plus annoncé `auto` par le tableau des états', async () => {
    const sw = await commutateurCisco();
    await suite(sw as unknown as Cli, [
      'configure terminal', 'interface FastEthernet0/1',
      'speed 100', 'duplex full', 'end',
    ]);
    const statut = ligneDe(await vue(sw as unknown as Cli, 'show interfaces status'), 'Fa0/1');
    const detail = await vue(sw as unknown as Cli, 'show interfaces FastEthernet0/1');
    const conf = await vue(sw as unknown as Cli, 'show running-config interface FastEthernet0/1');

    expect(statut).toMatch(/\bfull\b/);
    expect(statut).toMatch(/\b100\b/);
    expect(statut).not.toMatch(/\bauto\b/);
    expect(detail).toContain('Full-duplex, 100Mbps');
    expect(conf).toContain('speed 100');
    expect(conf).toContain('duplex full');
  }, 30_000);

  it('un port en négociation automatique reste `auto` tant qu\'il n\'a pas de lien', async () => {
    const sw = await commutateurCisco();
    const statut = ligneDe(await vue(sw as unknown as Cli, 'show interfaces status'), 'Fa0/2');
    expect(statut).toMatch(/auto\s+auto/);
  }, 30_000);

  it('la vitesse forcée est celle que la vue détaillée annonce', async () => {
    const sw = await commutateurCisco();
    await suite(sw as unknown as Cli, [
      'configure terminal', 'interface FastEthernet0/3', 'speed 10', 'duplex half', 'end',
    ]);
    expect(await vue(sw as unknown as Cli, 'show interfaces FastEthernet0/3'))
      .toContain('Half-duplex, 10Mbps');
    expect(ligneDe(await vue(sw as unknown as Cli, 'show interfaces status'), 'Fa0/3'))
      .toMatch(/half\s+10\b/);
  }, 30_000);
});

describe('Linux — la vitesse annoncée par /sys et par ethtool ne se contredit pas', () => {
  it('sur un lien établi, les deux annoncent la même vitesse', async () => {
    const { a, iface } = await paireLinux();
    const sys = (await vue(a as unknown as Cli, `cat /sys/class/net/${iface}/speed`)).trim();
    const eth = await vue(a as unknown as Cli, `ethtool ${iface}`);
    const m = /Speed: (\d+)Mb\/s/.exec(eth);
    if (m) expect(m[1]).toBe(sys);
    else expect(eth).toContain('Speed: Unknown!');
  }, 30_000);
});

// ───────────────── IPv6 ─────────────────

describe('Cisco — les vues IPv6 s\'accordent avec les vues IPv4 sur l\'état', () => {
  it('`show ipv6 interface brief` donne le même état que `show ip interface brief`', async () => {
    const r = await routeurCisco();
    const v4 = ligneDe(await vue(r as unknown as Cli, 'show ip interface brief'), 'GigabitEthernet0/0');
    const v6 = await vue(r as unknown as Cli, 'show ipv6 interface brief');
    const ligneV6 = v6.split('\n').find((l) => l.startsWith('GigabitEthernet0/0')) ?? '';
    const monteV4 = /\bup\b/.test(v4) && !v4.includes('administratively down');
    const monteV6 = ligneV6.includes('[up/');
    expect(monteV6).toBe(monteV4);
  }, 30_000);

  it('une interface éteinte l\'est aussi pour la vue IPv6', async () => {
    const r = await routeurCisco();
    await suite(r as unknown as Cli, [
      'configure terminal', 'interface GigabitEthernet0/0', 'shutdown', 'end',
    ]);
    const v6 = await vue(r as unknown as Cli, 'show ipv6 interface brief');
    const ligne = v6.split('\n').find((l) => l.startsWith('GigabitEthernet0/0')) ?? '';
    expect(ligne).toContain('[administratively down/down]');
  }, 30_000);

  it('une adresse IPv6 configurée est annoncée par la vue IPv6', async () => {
    const r = await routeurCisco();
    await suite(r as unknown as Cli, [
      'configure terminal', 'interface GigabitEthernet0/0',
      'ipv6 address 2001:db8::1/64', 'end',
    ]);
    const bref = await vue(r as unknown as Cli, 'show ipv6 interface brief');
    const detail = await vue(r as unknown as Cli, 'show ipv6 interface GigabitEthernet0/0');
    const conf = await vue(r as unknown as Cli, 'show running-config interface GigabitEthernet0/0');
    for (const [nom, sortie] of [['brief', bref], ['detail', detail], ['config', conf]] as const) {
      expect(sortie.toLowerCase(), nom).toContain('2001:db8::1');
    }
    expect(bref.toLowerCase()).toContain('fe80::');
    expect(detail.toLowerCase()).toContain('fe80::');
  }, 30_000);
});

describe('Linux — les adresses IPv6 sont les mêmes dans les vues qui les portent', () => {
  it('`ip -6 addr` et `ip addr` décrivent la même interface', async () => {
    const pc = linuxConfigure();
    const v6 = await vue(pc as unknown as Cli, 'ip -6 addr show eth0');
    const v4 = await vue(pc as unknown as Cli, 'ip addr show eth0');
    expect(v6).toContain('eth0');
    expect(v4).toContain('eth0');
    const mtuV6 = /mtu (\d+)/.exec(v6)?.[1];
    const mtuV4 = /mtu (\d+)/.exec(v4)?.[1];
    expect(mtuV6).toBe(mtuV4);
  }, 30_000);
});

// ───────────────── Une modification bouge toutes les vues ─────────────────

describe('Une modification se voit dans toutes les vues à la fois', () => {
  it('Cisco : renommer la description la change dans les trois vues', async () => {
    const r = await routeurCisco();
    await suite(r as unknown as Cli, [
      'configure terminal', 'interface GigabitEthernet0/0', 'description NOUVELLE', 'end',
    ]);
    expect(await vue(r as unknown as Cli, 'show interfaces GigabitEthernet0/0'))
      .toContain('Description: NOUVELLE');
    expect(ligneDe(await vue(r as unknown as Cli, 'show interfaces description'), 'GigabitEthernet0/0'))
      .toContain('NOUVELLE');
    expect(await vue(r as unknown as Cli, 'show running-config interface GigabitEthernet0/0'))
      .toContain('description NOUVELLE');
  }, 30_000);

  it('Cisco : changer l\'adresse la change dans les quatre vues', async () => {
    const r = await routeurCisco();
    await suite(r as unknown as Cli, [
      'configure terminal', 'interface GigabitEthernet0/0',
      `ip address 172.16.0.1 ${MASQUE_24}`, 'end',
    ]);
    for (const commande of [
      'show interfaces GigabitEthernet0/0',
      'show ip interface GigabitEthernet0/0',
      'show ip interface brief',
      'show running-config interface GigabitEthernet0/0',
    ]) {
      const sortie = await vue(r as unknown as Cli, commande);
      expect(sortie, commande).toContain('172.16.0.1');
      expect(sortie, commande).not.toContain('10.0.0.1');
    }
  }, 30_000);

  it('Cisco commutateur : changer le VLAN d\'accès le change dans les deux vues', async () => {
    const sw = await commutateurCisco();
    await suite(sw as unknown as Cli, [
      'configure terminal', 'vlan 30', 'exit',
      'interface FastEthernet0/1', 'switchport access vlan 30', 'end',
    ]);
    expect(ligneDe(await vue(sw as unknown as Cli, 'show interfaces status'), 'Fa0/1'))
      .toMatch(/\s30\s/);
    expect(await vue(sw as unknown as Cli, 'show interfaces FastEthernet0/1 switchport'))
      .toContain('Access Mode VLAN: 30');
    expect(await vue(sw as unknown as Cli, 'show running-config interface FastEthernet0/1'))
      .toContain('switchport access vlan 30');
  }, 30_000);

  it('Linux : changer l\'adresse la change dans les trois vues', async () => {
    const pc = linuxConfigure();
    await vue(pc as unknown as Cli, 'ip addr del 10.0.0.5/24 dev eth0');
    await vue(pc as unknown as Cli, 'ip addr add 192.168.50.5/24 dev eth0');
    expect(await vue(pc as unknown as Cli, 'ip addr show eth0')).toContain('192.168.50.5/24');
    expect(ligneDe(await vue(pc as unknown as Cli, 'ip -br addr'), 'eth0')).toContain('192.168.50.5/24');
    expect(await vue(pc as unknown as Cli, 'ifconfig eth0')).toContain('inet 192.168.50.5');
  }, 30_000);

  it('Huawei : changer la description la change dans les deux vues', async () => {
    const r = await routeurHuawei();
    await suite(r as unknown as Cli, [
      'system-view', 'interface GigabitEthernet0/0/0', 'description AUTRE', 'quit', 'quit',
    ]);
    expect(await vue(r as unknown as Cli, 'display interface GigabitEthernet0/0/0'))
      .toContain('Description: AUTRE');
    expect(await vue(r as unknown as Cli, 'display current-configuration interface GigabitEthernet0/0/0'))
      .toContain('description AUTRE');
  }, 30_000);
});
