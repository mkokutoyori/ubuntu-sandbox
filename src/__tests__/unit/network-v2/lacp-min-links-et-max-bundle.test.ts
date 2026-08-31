/**
 * Le seuil de liens actifs decide si un agregat PORTE, et le plafond
 * met les candidats en trop en attente. Mesure contre `bond_3ad.c`
 * (`bond_3ad_set_carrier` : porteuse coupee quand le nombre de ports
 * actifs est INFERIEUR a `min_links`) et contre le drapeau `H` de la
 * legende d'IOS, que ce simulateur imprimait sans jamais l'emettre.
 *
 * DISCRIMINATION : 17 des 25 cas tombent contre l'etat d'avant. Les 8
 * autres sont nommes plutot que laisses a decouvrir, et trois d'entre
 * eux donnent la BONNE reponse pour une mauvaise raison, ce qui est
 * exactement pourquoi il fallait les nommer : « un seul lien ne
 * satisfait pas min_links=2 » et « un lien monte mais NON groupe ne
 * compte pas » passaient par l'ancienne comparaison stricte, qui rendait
 * DOWN sur toute egalite ; « au seuil exactement, le faisceau monte »
 * passait parce que rien ne contraignait le faisceau. Les cinq autres
 * sont les deux TEMOINS sans seuil, le refus sur interface physique
 * (la commande entiere etait refusee avant), le cas de la priorite de
 * port (sans plafond, tout se groupait de toute facon) et la non-
 * regression du mode balance-rr.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { HuaweiSwitch } from '@/network/devices/HuaweiSwitch';
import { LinuxServer } from '@/network/devices/LinuxServer';
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

async function laboCisco(nb = 4) {
  const a = new CiscoSwitch('switch-cisco', 'A', 24, 0, 0);
  const b = new CiscoSwitch('switch-cisco', 'B', 24, 300, 0);
  a.powerOn(); b.powerOn();
  const cables: Cable[] = [];
  for (let i = 1; i <= nb; i++) {
    const c = new Cable(`c${i}`);
    c.connect(a.getPort(`FastEthernet0/${i}`)!, b.getPort(`FastEthernet0/${i}`)!);
    cables.push(c);
  }
  for (const d of [a, b] as Cmd[]) {
    await taper(d, ['enable', 'configure terminal']);
    for (let i = 1; i <= nb; i++) {
      await taper(d, [`interface FastEthernet0/${i}`, 'channel-group 1 mode active', 'exit']);
    }
    await d.executeCommand('end');
  }
  await vi.advanceTimersByTimeAsync(LACP_PERIODIC_MS);
  return { a, b, cables };
}

async function laboVrp(nb = 4) {
  const a = new HuaweiSwitch('switch-huawei', 'A', 24, 0, 0);
  const b = new HuaweiSwitch('switch-huawei', 'B', 24, 300, 0);
  a.powerOn(); b.powerOn();
  const cables: Cable[] = [];
  for (let i = 0; i < nb; i++) {
    const c = new Cable(`c${i}`);
    c.connect(a.getPort(`GigabitEthernet0/0/${i}`)!, b.getPort(`GigabitEthernet0/0/${i}`)!);
    cables.push(c);
  }
  for (const d of [a, b] as Cmd[]) {
    await taper(d, ['system-view', 'interface Eth-Trunk 1', 'mode lacp-static', 'quit']);
    for (let i = 0; i < nb; i++) {
      await taper(d, [`interface GigabitEthernet0/0/${i}`, 'eth-trunk 1', 'quit']);
    }
    await d.executeCommand('quit');
  }
  await vi.advanceTimersByTimeAsync(LACP_PERIODIC_MS);
  return { a, b, cables };
}

describe('Cisco — `port-channel min-links` decide si le faisceau monte', () => {
  beforeEach(() => {
    resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
    vi.useFakeTimers();
  });
  afterEach(() => { vi.useRealTimers(); });

  it('la commande est acceptee sur une interface Port-channel', async () => {
    const { a } = await laboCisco(2);
    expect(await taper(a, ['enable', 'configure terminal', 'interface port-channel 1',
      'port-channel min-links 2'])).toBe('');
  }, 30_000);

  it('elle est refusee sur une interface physique', async () => {
    const { a } = await laboCisco(2);
    expect(await taper(a, ['enable', 'configure terminal', 'interface FastEthernet0/1',
      'port-channel min-links 2'])).toContain('Invalid input');
  }, 30_000);

  it('une valeur hors plage est refusee dans les mots d\'IOS', async () => {
    const { a } = await laboCisco(2);
    expect(await taper(a, ['enable', 'configure terminal', 'interface port-channel 1',
      'port-channel min-links 9'])).toBe('% Invalid value, valid range is 1 to 8.');
  }, 30_000);

  it('sous le seuil, AUCUN membre ne se groupe', async () => {
    const { a, cables } = await laboCisco(2);
    await taper(a, ['enable', 'configure terminal', 'interface port-channel 1',
      'port-channel min-links 2', 'end']);
    cables[0].disconnect();
    await vi.advanceTimersByTimeAsync(LACP_PERIODIC_MS * 3);
    const out = await a.executeCommand('show etherchannel summary');
    expect(out).not.toMatch(/\(P\)/);
  }, 30_000);

  it('au seuil exactement, le faisceau monte — la borne est INCLUSIVE', async () => {
    const { a } = await laboCisco(2);
    await taper(a, ['enable', 'configure terminal', 'interface port-channel 1',
      'port-channel min-links 2', 'end']);
    await vi.advanceTimersByTimeAsync(LACP_PERIODIC_MS);
    expect(await a.executeCommand('show etherchannel summary'))
      .toMatch(/Fa0\/1\(P\) Fa0\/2\(P\)/);
  }, 30_000);

  it('`lacp max-bundle` met les membres en trop en Hot-standby', async () => {
    const { a } = await laboCisco(4);
    await taper(a, ['enable', 'configure terminal', 'interface port-channel 1',
      'lacp max-bundle 2', 'end']);
    await vi.advanceTimersByTimeAsync(LACP_PERIODIC_MS);
    const out = await a.executeCommand('show etherchannel summary');
    expect(out).toMatch(/Fa0\/1\(P\)/);
    expect(out).toMatch(/Fa0\/3\(H\)/);
    expect(out).toMatch(/Fa0\/4\(H\)/);
  }, 30_000);

  it('`show lacp internal` emploie les abreviations d\'IOS', async () => {
    const { a } = await laboCisco(4);
    await taper(a, ['enable', 'configure terminal', 'interface port-channel 1',
      'lacp max-bundle 2', 'end']);
    await vi.advanceTimersByTimeAsync(LACP_PERIODIC_MS);
    const out = await a.executeCommand('show lacp internal');
    expect(out).toContain('Channel group 1');
    expect(out).toContain(
      'Port      Flags   State     Priority      Key       Key     Number      State');
    expect(out).toMatch(/Fa0\/1\s+SA\s+bndl\s+32768\s+0x1\s+0x1\s+0x1\s+0x3D/);
    expect(out).toMatch(/Fa0\/3\s+SA\s+hot-sby\s+32768/);
  }, 30_000);

  it('l\'etat de port rendu est l\'octet de la norme, en hexadecimal', async () => {
    const { a } = await laboCisco(2);
    await vi.advanceTimersByTimeAsync(LACP_PERIODIC_MS);
    expect(await a.executeCommand('show lacp internal')).toContain('0x3D');
  }, 30_000);

  it('le membre en attente est nomme par `show etherchannel detail`', async () => {
    const { a } = await laboCisco(4);
    await taper(a, ['enable', 'configure terminal', 'interface port-channel 1',
      'lacp max-bundle 2', 'end']);
    await vi.advanceTimersByTimeAsync(LACP_PERIODIC_MS);
    expect(await a.executeCommand('show etherchannel detail'))
      .toContain('Hot-standby (max-bundle 2)');
  }, 30_000);

  it('la priorite de port decide QUI reste actif', async () => {
    const { a } = await laboCisco(4);
    await taper(a, ['enable', 'configure terminal',
      'interface FastEthernet0/4', 'lacp port-priority 100', 'exit',
      'interface port-channel 1', 'lacp max-bundle 1', 'end']);
    await vi.advanceTimersByTimeAsync(LACP_PERIODIC_MS);
    expect(await a.executeCommand('show etherchannel summary')).toMatch(/Fa0\/4\(P\)/);
  }, 30_000);

  it('les deux reglages sont rejoues par la configuration', async () => {
    const { a } = await laboCisco(2);
    await taper(a, ['enable', 'configure terminal', 'interface port-channel 1',
      'port-channel min-links 2', 'lacp max-bundle 4', 'end']);
    const cfg = await a.executeCommand('show running-config');
    expect(cfg).toContain('interface Port-channel1');
    expect(cfg).toContain(' port-channel min-links 2');
    expect(cfg).toContain(' lacp max-bundle 4');
  }, 30_000);

  it('sans seuil, deux liens suffisent — TEMOIN', async () => {
    const { a, cables } = await laboCisco(2);
    cables[0].disconnect();
    await vi.advanceTimersByTimeAsync(LACP_PERIODIC_MS * 3);
    expect(await a.executeCommand('show etherchannel summary')).toMatch(/Fa0\/2\(P\)/);
  }, 30_000);
});

describe('Huawei — `least`/`max active-linknumber` sont APPLIQUES', () => {
  beforeEach(() => {
    resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
    vi.useFakeTimers();
  });
  afterEach(() => { vi.useRealTimers(); });

  it('la vue lit le seuil au lieu d\'ecrire 1', async () => {
    const { a } = await laboVrp(4);
    await taper(a, ['system-view', 'interface Eth-Trunk 1',
      'least active-linknumber 3', 'max active-linknumber 3', 'quit', 'quit']);
    expect(await a.executeCommand('display eth-trunk 1'))
      .toMatch(/Least Active-linknumber: 3\s+Max Active-linknumber: 3/);
  }, 30_000);

  it('sous le seuil, le trunk tombe', async () => {
    const { a, cables } = await laboVrp(3);
    await taper(a, ['system-view', 'interface Eth-Trunk 1',
      'least active-linknumber 3', 'quit', 'quit']);
    cables[0].disconnect();
    await vi.advanceTimersByTimeAsync(LACP_PERIODIC_MS * 3);
    expect(await a.executeCommand('display eth-trunk 1'))
      .toContain('Operate status: down');
  }, 30_000);

  it('le plafond met les membres en trop hors du faisceau', async () => {
    const { a } = await laboVrp(4);
    await taper(a, ['system-view', 'interface Eth-Trunk 1',
      'max active-linknumber 2', 'quit', 'quit']);
    await vi.advanceTimersByTimeAsync(LACP_PERIODIC_MS);
    const out = await a.executeCommand('display eth-trunk 1');
    expect(out).toContain('Number Of Up Ports In Trunk: 2');
    expect(out).toMatch(/GigabitEthernet0\/0\/3\s+Unselect/);
  }, 30_000);

  it('une valeur hors plage est refusee', async () => {
    const { a } = await laboVrp(2);
    expect(await taper(a, ['system-view', 'interface Eth-Trunk 1',
      'least active-linknumber 99']))
      .toBe('Error: The value of the parameter is out of the range.');
  }, 30_000);

  it('`load-balance` etait range sans etre applique — la vue le lit', async () => {
    const { a } = await laboVrp(2);
    await taper(a, ['system-view', 'interface Eth-Trunk 1',
      'load-balance src-dst-mac', 'quit', 'quit']);
    expect(await a.executeCommand('display eth-trunk 1'))
      .toContain('Hash arithmetic: According to SA-XOR-DA');
  }, 30_000);

  it('`lacp timeout fast` demande la cadence rapide au partenaire', async () => {
    const { a } = await laboVrp(2);
    expect(await taper(a, ['system-view', 'interface Eth-Trunk 1',
      'lacp timeout fast'])).toBe('');
    expect(a.getLacpAgent().getConfig().fastRate).toBe(true);
  }, 30_000);

  it('`lacp preempt` est desactive d\'usine, et son delai n\'apparait qu\'active', async () => {
    const { a } = await laboVrp(2);
    expect(await a.executeCommand('display eth-trunk 1'))
      .toContain('Preempt Delay: Disabled');
    await taper(a, ['system-view', 'interface Eth-Trunk 1',
      'lacp preempt enable', 'lacp preempt delay 20', 'quit', 'quit']);
    expect(await a.executeCommand('display eth-trunk 1'))
      .toContain('Preempt Delay: 20');
    await taper(a, ['system-view', 'interface Eth-Trunk 1',
      'lacp preempt disable', 'quit', 'quit']);
    expect(await a.executeCommand('display eth-trunk 1'))
      .toContain('Preempt Delay: Disabled');
  }, 30_000);

  it('sans seuil, un lien coupe laisse le trunk debout — TEMOIN', async () => {
    const { a, cables } = await laboVrp(3);
    cables[0].disconnect();
    await vi.advanceTimersByTimeAsync(LACP_PERIODIC_MS * 3);
    expect(await a.executeCommand('display eth-trunk 1'))
      .toContain('Operate status: up');
  }, 30_000);
});

describe('Linux — `min_links` est une borne INFERIEURE inclusive', () => {
  beforeEach(() => {
    resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
    vi.useFakeTimers();
  });
  afterEach(() => { vi.useRealTimers(); });

  async function laboBond(minLinks: number) {
    const srv = new LinuxServer('linux-server', 'srv', 0, 0);
    const sw = new CiscoSwitch('switch-cisco', 'SW', 24, 300, 0);
    srv.powerOn(); sw.powerOn();
    const cables: Cable[] = [];
    for (let i = 1; i <= 2; i++) {
      const c = new Cable(`c${i}`);
      c.connect(srv.getPorts()[i - 1], sw.getPort(`FastEthernet0/${i}`)!);
      cables.push(c);
    }
    await taper(sw, ['enable', 'configure terminal']);
    for (let i = 1; i <= 2; i++) {
      await taper(sw, [`interface FastEthernet0/${i}`, 'channel-group 1 mode active', 'exit']);
    }
    await sw.executeCommand('end');
    await taper(srv, ['ip link add bond0 type bond',
      `ip link set bond0 type bond mode 802.3ad min_links ${minLinks}`,
      'ip link set eth0 master bond0', 'ip link set eth1 master bond0']);
    await vi.advanceTimersByTimeAsync(LACP_PERIODIC_MS);
    return { srv, cables };
  }

  it('deux liens groupes satisfont min_links=2', async () => {
    const { srv } = await laboBond(2);
    const out = await srv.executeCommand('cat /proc/net/bonding/bond0');
    expect(out.split('\n').find(l => l.startsWith('MII Status:'))).toBe('MII Status: up');
  }, 30_000);

  it('un seul lien ne satisfait pas min_links=2', async () => {
    const { srv, cables } = await laboBond(2);
    cables[0].disconnect();
    await vi.advanceTimersByTimeAsync(LACP_PERIODIC_MS * 3);
    const out = await srv.executeCommand('cat /proc/net/bonding/bond0');
    expect(out.split('\n').find(l => l.startsWith('MII Status:'))).toBe('MII Status: down');
  }, 30_000);

  it('min_links=1 monte sur un seul lien', async () => {
    const { srv, cables } = await laboBond(1);
    cables[0].disconnect();
    await vi.advanceTimersByTimeAsync(LACP_PERIODIC_MS * 3);
    const out = await srv.executeCommand('cat /proc/net/bonding/bond0');
    expect(out.split('\n').find(l => l.startsWith('MII Status:'))).toBe('MII Status: up');
  }, 30_000);

  it('un lien monte mais NON groupe ne compte pas', async () => {
    const srv = new LinuxServer('linux-server', 'srv', 0, 0);
    const sw = new CiscoSwitch('switch-cisco', 'SW', 24, 300, 0);
    srv.powerOn(); sw.powerOn();
    for (let i = 1; i <= 2; i++) {
      new Cable(`c${i}`).connect(srv.getPorts()[i - 1], sw.getPort(`FastEthernet0/${i}`)!);
    }
    await taper(sw, ['enable', 'configure terminal', 'interface FastEthernet0/1',
      'channel-group 1 mode active', 'end']);
    await taper(srv, ['ip link add bond0 type bond',
      'ip link set bond0 type bond mode 802.3ad min_links 2',
      'ip link set eth0 master bond0', 'ip link set eth1 master bond0']);
    await vi.advanceTimersByTimeAsync(LACP_PERIODIC_MS);
    const out = await srv.executeCommand('cat /proc/net/bonding/bond0');
    expect(out.split('\n').find(l => l.startsWith('MII Status:'))).toBe('MII Status: down');
  }, 30_000);

  it('le mode balance-rr ne compte pas le groupage — non-regression', async () => {
    const srv = new LinuxServer('linux-server', 'srv', 0, 0);
    const sw = new CiscoSwitch('switch-cisco', 'SW', 24, 300, 0);
    srv.powerOn(); sw.powerOn();
    for (let i = 1; i <= 2; i++) {
      new Cable(`c${i}`).connect(srv.getPorts()[i - 1], sw.getPort(`FastEthernet0/${i}`)!);
    }
    await taper(srv, ['ip link add bond0 type bond',
      'ip link set bond0 type bond mode balance-rr',
      'ip link set eth0 master bond0', 'ip link set eth1 master bond0']);
    await vi.advanceTimersByTimeAsync(1_000);
    const out = await srv.executeCommand('cat /proc/net/bonding/bond0');
    expect(out.split('\n').find(l => l.startsWith('MII Status:'))).toBe('MII Status: up');
  }, 30_000);
});
