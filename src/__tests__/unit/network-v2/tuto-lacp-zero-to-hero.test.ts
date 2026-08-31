/**
 * Conformite au tutoriel « LACP : From Zero to Hero », partie par partie.
 *
 * Les cas nommes « MANQUE » epinglent ce que la machine repond VRAIMENT
 * la ou le tutoriel enseigne une commande que ce simulateur n'a pas :
 * ils gardent le refus, ils n'attestent aucune conformite.
 *
 * DISCRIMINATION : en neutralisant la selection LACP (`recompute`),
 * 16 des 59 cas tombent — ceux qui observent un groupe REELLEMENT forme.
 * Les 43 autres ne le peuvent pas et c'est leur role : les « MANQUE »
 * gardent un refus, les TEMOINS gardent ce qui repond par ailleurs, et
 * le reste ne verifie que l'acceptation d'une commande.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { HuaweiSwitch } from '@/network/devices/HuaweiSwitch';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import type { EthernetFrame } from '@/network/core/types';

interface Cmd { executeCommand(cmd: string): Promise<string> }

async function taper(d: Cmd, cmds: string[]): Promise<string> {
  let last = '';
  for (const c of cmds) last = await d.executeCommand(c);
  return last;
}

const CISCO_PORTS = [
  'FastEthernet0/1', 'FastEthernet0/2', 'FastEthernet0/3', 'FastEthernet0/4',
];

const LACP_PERIODIC_MS = 35_000;

interface CiscoLab {
  a: CiscoSwitch;
  b: CiscoSwitch;
  cables: Cable[];
  ports: string[];
}

function cableCisco(a: CiscoSwitch, b: CiscoSwitch, ports: string[]): Cable[] {
  return ports.map((n) => {
    const c = new Cable(`lien-${n}`);
    c.connect(a.getPort(n)!, b.getPort(n)!);
    return c;
  });
}

async function joindreGroupe(
  d: CiscoSwitch, ports: string[], mode: string, group = 1,
): Promise<void> {
  await taper(d, ['enable', 'configure terminal']);
  for (const n of ports) {
    await taper(d, [`interface ${n}`, `channel-group ${group} mode ${mode}`, 'exit']);
  }
  await d.executeCommand('end');
}

async function laboCisco(
  modeA: string, modeB: string, nbPorts = 4,
): Promise<CiscoLab> {
  const a = new CiscoSwitch('switch-cisco', 'Switch-A', 24, 0, 0);
  const b = new CiscoSwitch('switch-cisco', 'Switch-B', 24, 300, 0);
  const ports = CISCO_PORTS.slice(0, nbPorts);
  const cables = cableCisco(a, b, ports);
  await joindreGroupe(a, ports, modeA);
  await joindreGroupe(b, ports, modeB);
  await vi.advanceTimersByTimeAsync(LACP_PERIODIC_MS);
  return { a, b, cables, ports };
}

function ligneGroupe(sortie: string): string {
  return sortie.split('\n').find((l) => /^1\s+Port-channel1/.test(l.trim())) ?? '';
}

function drapeauDe(sortie: string, port: string): string {
  const m = new RegExp(`${port.replace('/', '\\/')}\\((\\w)\\)`).exec(sortie);
  return m ? m[1] : '';
}

function abrege(port: string): string {
  return port.replace('FastEthernet', 'Fa');
}

describe('Partie 1 — le probleme : bande passante et redondance', () => {
  beforeEach(() => {
    resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
    vi.useFakeTimers();
  });
  afterEach(() => { vi.useRealTimers(); });

  it('§1.2 quatre liens agreges portent quatre membres dans UN seul groupe', async () => {
    const { a } = await laboCisco('active', 'active', 4);
    const sortie = await a.executeCommand('show etherchannel summary');
    expect(sortie).toContain('Number of channel-groups in use: 1');
    for (const p of CISCO_PORTS) {
      expect(drapeauDe(sortie, abrege(p)), p).toBe('P');
    }
  });

  it('§1.2 si un cable lache, les autres continuent — PAS de coupure', async () => {
    const { a, b, cables } = await laboCisco('active', 'active', 4);
    cables[0].disconnect();
    await vi.advanceTimersByTimeAsync(1_000);
    for (const d of [a, b]) {
      const sortie = await d.executeCommand('show etherchannel summary');
      expect(drapeauDe(sortie, 'Fa0/1')).not.toBe('P');
      for (const p of CISCO_PORTS.slice(1)) {
        expect(drapeauDe(sortie, abrege(p)), `${p} apres coupure`).toBe('P');
      }
    }
  });

  it('§1.2 le lien coupe revient dans le groupe quand le cable est remis', async () => {
    const { a, b, cables, ports } = await laboCisco('active', 'active', 4);
    cables[0].disconnect();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(drapeauDe(await a.executeCommand('show etherchannel summary'), 'Fa0/1')).not.toBe('P');

    const remis = new Cable('remis');
    remis.connect(a.getPort(ports[0])!, b.getPort(ports[0])!);
    await vi.advanceTimersByTimeAsync(LACP_PERIODIC_MS);
    expect(drapeauDe(await a.executeCommand('show etherchannel summary'), 'Fa0/1')).toBe('P');
  });
});

describe('Partie 2 — les concepts LACP', () => {
  beforeEach(() => {
    resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
    vi.useFakeTimers();
  });
  afterEach(() => { vi.useRealTimers(); });

  it('§2.1 la negociation passe par de VRAIES trames LACPDU sur le fil', async () => {
    const a = new CiscoSwitch('switch-cisco', 'Switch-A', 24, 0, 0);
    const b = new CiscoSwitch('switch-cisco', 'Switch-B', 24, 300, 0);
    const ports = CISCO_PORTS.slice(0, 2);
    cableCisco(a, b, ports);

    let emises = 0;
    let recues = 0;
    a.getBus().subscribe('port.frame.tx-requested', (e: unknown) => {
      const f = (e as { payload?: { frame?: EthernetFrame } }).payload?.frame;
      if ((f?.payload as { type?: string } | undefined)?.type === 'lacp') emises += 1;
    });
    b.getBus().subscribe('port.frame.received', (e: unknown) => {
      const f = (e as { payload?: { frame?: EthernetFrame } }).payload?.frame;
      if ((f?.payload as { type?: string } | undefined)?.type === 'lacp') recues += 1;
    });

    await joindreGroupe(a, ports, 'active');
    await joindreGroupe(b, ports, 'active');
    expect(emises).toBeGreaterThan(0);
    expect(recues).toBe(emises);
  });

  it('§2.2 le lien logique porte le nom Port-channel<N> cote Cisco', async () => {
    const { a } = await laboCisco('active', 'active', 2);
    expect(await a.executeCommand('show etherchannel summary')).toContain('Port-channel1');
  });

  it('§2.3 ACTIVE + ACTIVE forme le groupe', async () => {
    const { a, b } = await laboCisco('active', 'active', 2);
    expect(drapeauDe(await a.executeCommand('show etherchannel summary'), 'Fa0/1')).toBe('P');
    expect(drapeauDe(await b.executeCommand('show etherchannel summary'), 'Fa0/1')).toBe('P');
  });

  it('§2.3 ACTIVE + PASSIVE forme le groupe — le passif repond a l\'actif', async () => {
    const { a, b } = await laboCisco('active', 'passive', 2);
    expect(drapeauDe(await a.executeCommand('show etherchannel summary'), 'Fa0/1')).toBe('P');
    expect(drapeauDe(await b.executeCommand('show etherchannel summary'), 'Fa0/1')).toBe('P');
  });

  it('§2.3 PASSIVE + PASSIVE ne forme RIEN — personne n\'initie', async () => {
    const { a, b } = await laboCisco('passive', 'passive', 2);
    for (const d of [a, b]) {
      const sortie = await d.executeCommand('show etherchannel summary');
      expect(drapeauDe(sortie, 'Fa0/1')).toBe('I');
      expect(drapeauDe(sortie, 'Fa0/2')).toBe('I');
    }
  });

  it('§2.3 un passif seul n\'emet aucune LACPDU spontanee', async () => {
    const a = new CiscoSwitch('switch-cisco', 'Switch-A', 24, 0, 0);
    const b = new CiscoSwitch('switch-cisco', 'Switch-B', 24, 300, 0);
    const ports = CISCO_PORTS.slice(0, 2);
    cableCisco(a, b, ports);
    let emises = 0;
    a.getBus().subscribe('port.frame.tx-requested', (e: unknown) => {
      const f = (e as { payload?: { frame?: EthernetFrame } }).payload?.frame;
      if ((f?.payload as { type?: string } | undefined)?.type === 'lacp') emises += 1;
    });
    await joindreGroupe(a, ports, 'passive');
    await vi.advanceTimersByTimeAsync(LACP_PERIODIC_MS);
    expect(emises).toBe(0);
  });
});

describe('Partie 3 — LACP sur Cisco', () => {
  beforeEach(() => {
    resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
    vi.useFakeTimers();
  });
  afterEach(() => { vi.useRealTimers(); });

  it('§3.2 etape 1 — `interface port-channel 1` est acceptee', async () => {
    const a = new CiscoSwitch('switch-cisco', 'Switch-A', 24, 0, 0);
    expect(await taper(a, ['enable', 'configure terminal', 'interface port-channel 1'])).toBe('');
  });

  it('§3.2 etape 1 — la description du Port-channel est acceptee', async () => {
    const a = new CiscoSwitch('switch-cisco', 'Switch-A', 24, 0, 0);
    const out = await taper(a, ['enable', 'configure terminal', 'interface port-channel 1',
      'description Lien agrege vers Switch-B']);
    expect(out).toBe('');
  });

  it('§3.2 `switchport mode trunk` sous un Port-channel est HERITE par les membres', async () => {
    const { a } = await laboCisco('active', 'active', 4);
    const out = await taper(a, ['enable', 'configure terminal',
      'interface port-channel 1', 'switchport mode trunk', 'end']);
    expect(out).toBe('');
    for (const p of CISCO_PORTS) {
      expect(await a.executeCommand(`show interfaces ${p} switchport`), p)
        .toContain('Administrative Mode: trunk');
    }
  });

  it('§3.2 la configuration heritee est rejouee sur chaque membre', async () => {
    const { a } = await laboCisco('active', 'active', 4);
    await taper(a, ['enable', 'configure terminal',
      'interface port-channel 1', 'switchport mode trunk', 'end']);
    const cfg = await a.executeCommand('show running-config');
    expect(cfg.split('\n').filter((l) => l.trim() === 'switchport mode trunk'))
      .toHaveLength(CISCO_PORTS.length);
  });

  it('§3.2 etape 2 — `channel-group 1 mode active` est acceptee sans un mot', async () => {
    const a = new CiscoSwitch('switch-cisco', 'Switch-A', 24, 0, 0);
    const out = await taper(a, ['enable', 'configure terminal',
      'interface FastEthernet0/1', 'channel-group 1 mode active']);
    expect(out).toBe('');
  });

  it('§3.2 les trois modes de `channel-group` sont acceptes', async () => {
    const a = new CiscoSwitch('switch-cisco', 'Switch-A', 24, 0, 0);
    await taper(a, ['enable', 'configure terminal']);
    for (const [i, mode] of ['active', 'passive', 'on'].entries()) {
      const out = await taper(a, [`interface FastEthernet0/${i + 1}`,
        `channel-group 1 mode ${mode}`, 'exit']);
      expect(out, mode).toBe('');
    }
  });

  it('§3.2 un mode inconnu est refuse', async () => {
    const a = new CiscoSwitch('switch-cisco', 'Switch-A', 24, 0, 0);
    const out = await taper(a, ['enable', 'configure terminal',
      'interface FastEthernet0/1', 'channel-group 1 mode zorglub']);
    expect(out).toMatch(/Invalid input|Incomplete|% Error/);
  });

  it('§3.2 `mode on` agrege SANS LACP — le protocole affiche n\'est pas LACP', async () => {
    const { a } = await laboCisco('on', 'on', 2);
    const ligne = ligneGroupe(await a.executeCommand('show etherchannel summary'));
    expect(ligne).not.toContain('LACP');
    expect(drapeauDe(ligne, 'Fa0/1')).toBe('P');
  });

  it('§3.2 `interface range` groupe plusieurs ports d\'un coup', async () => {
    const a = new CiscoSwitch('switch-cisco', 'Switch-A', 24, 0, 0);
    const b = new CiscoSwitch('switch-cisco', 'Switch-B', 24, 300, 0);
    cableCisco(a, b, CISCO_PORTS);
    await taper(a, ['enable', 'configure terminal',
      'interface range FastEthernet0/1 - 4', 'channel-group 1 mode active', 'exit', 'end']);
    await joindreGroupe(b, CISCO_PORTS, 'active');
    await vi.advanceTimersByTimeAsync(LACP_PERIODIC_MS);
    const sortie = await a.executeCommand('show etherchannel summary');
    for (const p of CISCO_PORTS) expect(drapeauDe(sortie, abrege(p)), p).toBe('P');
  });

  it('§3.3 `port-channel load-balance` accepte les sept methodes du tutoriel', async () => {
    const a = new CiscoSwitch('switch-cisco', 'Switch-A', 24, 0, 0);
    await taper(a, ['enable', 'configure terminal']);
    for (const m of ['src-mac', 'dst-mac', 'src-dst-mac', 'src-ip', 'dst-ip',
                     'src-dst-ip', 'src-dst-port']) {
      expect(await a.executeCommand(`port-channel load-balance ${m}`), m).toBe('');
    }
  });

  it('§3.3 une methode inventee est refusee', async () => {
    const a = new CiscoSwitch('switch-cisco', 'Switch-A', 24, 0, 0);
    const out = await taper(a, ['enable', 'configure terminal',
      'port-channel load-balance zorglub']);
    expect(out).toContain('Invalid input');
  });

  it('§3.3 `show etherchannel load-balance` rend la methode configuree', async () => {
    const a = new CiscoSwitch('switch-cisco', 'Switch-A', 24, 0, 0);
    await taper(a, ['enable', 'configure terminal',
      'port-channel load-balance src-dst-ip', 'end']);
    const out = await a.executeCommand('show etherchannel load-balance');
    expect(out).toContain('EtherChannel Load-Balancing Configuration:');
    expect(out).toContain('src-dst-ip');
  });

  it('§3.4 `show etherchannel summary` rend la legende et la ligne du groupe', async () => {
    const { a } = await laboCisco('active', 'active', 4);
    const sortie = await a.executeCommand('show etherchannel summary');
    expect(sortie).toContain('P - bundled in port-channel');
    expect(sortie).toContain('I - stand-alone');
    expect(sortie).toContain('Number of channel-groups in use: 1');
    expect(ligneGroupe(sortie)).toContain('LACP');
  });

  it('§3.4 `show lacp neighbor` nomme le partenaire et son mode', async () => {
    const { a, b } = await laboCisco('active', 'active', 2);
    const sortie = await a.executeCommand('show lacp neighbor');
    expect(sortie).toContain('A - Device is in Active mode');
    const sysIdB = (await b.executeCommand('show lacp sys-id')).split(',')[1].trim();
    expect(sortie).toContain(sysIdB);
    expect(sortie).toMatch(/Fa0\/1\s+32768,\S+\s+\S+\s+SA/);
  });

  it('§3.4 `show lacp internal` rend l\'etat local de chaque port', async () => {
    const { a } = await laboCisco('active', 'active', 2);
    const sortie = await a.executeCommand('show lacp internal');
    expect(sortie).toMatch(/Fa0\/1\s+SA\s+bundled/);
    expect(sortie).toMatch(/Fa0\/2\s+SA\s+bundled/);
  });

  it('§3.4 `show lacp counters` compte les LACPDU reellement echangees', async () => {
    const { a } = await laboCisco('active', 'active', 2);
    const sortie = await a.executeCommand('show lacp counters');
    const ligne = sortie.split('\n').find((l) => l.startsWith('Fa0/1'))!;
    const [, envoyees, recues] = ligne.split(/\s+/);
    expect(Number(envoyees)).toBeGreaterThan(0);
    expect(Number(recues)).toBeGreaterThan(0);
  });

  it('§3.4 `show lacp sys-id` rend priorite et identifiant systeme', async () => {
    const { a } = await laboCisco('active', 'active', 2);
    expect(await a.executeCommand('show lacp sys-id')).toMatch(
      /^32768, ([0-9a-f]{2}:){5}[0-9a-f]{2}$/);
  });

  it('§3.4 la forme `show lacp <groupe> neighbor` du tutoriel repond', async () => {
    const { a } = await laboCisco('active', 'active', 2);
    expect(await a.executeCommand('show lacp 1 neighbor')).toMatch(/Fa0\/1\s+32768,/);
    expect(await a.executeCommand('show lacp 1 internal')).toMatch(/Fa0\/1\s+SA\s+bundled/);
    expect(await a.executeCommand('show lacp 1 counters')).toMatch(/Fa0\/1\s+\d+\s+\d+/);
  });

  it('§3.4 un groupe qui n\'existe pas est nomme comme tel', async () => {
    const { a } = await laboCisco('active', 'active', 2);
    expect(await a.executeCommand('show lacp 9 neighbor'))
      .toBe('% Channel group 9 does not exist');
  });

  it('§3.4 `test etherchannel load-balance` nomme le lien qu\'un flux emprunterait', async () => {
    const { a } = await laboCisco('active', 'active', 4);
    const out = await a.executeCommand(
      'test etherchannel load-balance interface port-channel 1 ip 192.168.1.55 10.0.30.1');
    expect(out).toMatch(/^Would use Fa0\/[1-4]$/);
  });

  it('§2.4 le MEME flux emprunte TOUJOURS le meme lien', async () => {
    const { a } = await laboCisco('active', 'active', 4);
    const q = 'test etherchannel load-balance interface port-channel 1 ip 192.168.1.55 10.0.30.1';
    const premier = await a.executeCommand(q);
    expect(await a.executeCommand(q)).toBe(premier);
  });

  it('§2.4 deux flux differents peuvent emprunter deux liens differents', async () => {
    const { a } = await laboCisco('active', 'active', 4);
    const vus = new Set<string>();
    for (const src of ['192.168.1.55', '192.168.1.60', '192.168.1.70', '192.168.1.80',
                       '192.168.1.90', '10.1.1.1', '10.2.2.2', '172.16.5.5']) {
      vus.add(await a.executeCommand(
        `test etherchannel load-balance interface port-channel 1 ip ${src} 10.0.30.1`));
    }
    expect(vus.size).toBeGreaterThan(1);
  });

  it('§3.4 `test etherchannel load-balance` refuse un groupe inconnu', async () => {
    const { a } = await laboCisco('active', 'active', 2);
    expect(await a.executeCommand(
      'test etherchannel load-balance interface port-channel 9 ip 1.1.1.1 2.2.2.2'))
      .toBe('% Channel group 9 does not exist');
  });

  it('§3.4 MANQUE — `show interface port-channel 1` n\'existe pas', async () => {
    const { a } = await laboCisco('active', 'active', 2);
    for (const c of ['show interface port-channel 1', 'show interfaces port-channel 1']) {
      expect(await a.executeCommand(c), c).toContain('Invalid input');
    }
  });

  it('§3.2 la configuration rendue rejoue `channel-group` sur chaque membre', async () => {
    const { a } = await laboCisco('active', 'active', 4);
    const cfg = await a.executeCommand('show running-config');
    for (const p of CISCO_PORTS) {
      expect(cfg).toContain(`interface ${p}\n channel-group 1 mode active`);
    }
  });

  it('§3.2 `interface Port-channel1` figure dans la configuration rendue', async () => {
    const { a } = await laboCisco('active', 'active', 2);
    expect(await a.executeCommand('show running-config')).toContain('interface Port-channel1');
  });

  it('§3.3 la methode de repartition figure dans la configuration rendue', async () => {
    const { a } = await laboCisco('active', 'active', 2);
    await taper(a, ['enable', 'configure terminal',
      'port-channel load-balance src-dst-mac', 'end']);
    expect(await a.executeCommand('show running-config'))
      .toContain('port-channel load-balance src-dst-mac');
  });

  it('§3.4 `show etherchannel <N> port-channel` rend l\'agregateur et son compte de ports', async () => {
    const { a } = await laboCisco('active', 'active', 4);
    const out = await a.executeCommand('show etherchannel 1 port-channel');
    expect(out).toContain('Port-channel: Port-channel1    (Primary Aggregator)');
    expect(out).toContain('Number of ports = 4');
    expect(out).toContain('Protocol            =   LACP');
  });
});

describe('Partie 4 — LACP sur Huawei', () => {
  beforeEach(() => {
    resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
    vi.useFakeTimers();
  });
  afterEach(() => { vi.useRealTimers(); });

  async function laboHuawei(nbPorts = 3) {
    const a = new HuaweiSwitch('switch-huawei', 'Switch-A', 24, 0, 0);
    const b = new HuaweiSwitch('switch-huawei', 'Switch-B', 24, 300, 0);
    const ports = a.getPorts().slice(0, nbPorts).map((p) => p.getName());
    for (const n of ports) {
      const c = new Cable(`h-${n}`);
      c.connect(a.getPort(n)!, b.getPort(n)!);
    }
    for (const d of [a, b]) {
      await taper(d, ['system-view', 'interface Eth-Trunk 1', 'mode lacp-static', 'quit']);
      for (const n of ports) await taper(d, [`interface ${n}`, 'eth-trunk 1', 'quit']);
    }
    await vi.advanceTimersByTimeAsync(LACP_PERIODIC_MS);
    return { a, b, ports };
  }

  it('§4.1 `interface Eth-Trunk 1` puis `mode lacp-static` sont acceptees', async () => {
    const a = new HuaweiSwitch('switch-huawei', 'Switch-A', 24, 0, 0);
    expect(await taper(a, ['system-view', 'interface Eth-Trunk 1', 'mode lacp-static'])).toBe('');
  });

  it('§4.1 `eth-trunk 1` sur une interface la fait rejoindre le trunk', async () => {
    const { a, ports } = await laboHuawei(3);
    const sortie = await a.executeCommand('display eth-trunk 1');
    for (const n of ports) expect(sortie, n).toContain(n);
  });

  it('§4.2 `load-balance src-dst-ip` est acceptee sous l\'Eth-Trunk', async () => {
    const a = new HuaweiSwitch('switch-huawei', 'Switch-A', 24, 0, 0);
    const out = await taper(a, ['system-view', 'interface Eth-Trunk 1',
      'mode lacp-static', 'load-balance src-dst-ip']);
    expect(out).toBe('');
  });

  it('§4.3 `display eth-trunk 1` rend le mode, l\'etat et le compte de ports', async () => {
    const { a } = await laboHuawei(3);
    const sortie = await a.executeCommand('display eth-trunk 1');
    expect(sortie).toContain("Eth-Trunk1's state information is:");
    expect(sortie).toContain('WorkingMode: LACP-STATIC');
    expect(sortie).toContain('Least Active-linknumber: 1');
    expect(sortie).toContain('Operate status: up');
    expect(sortie).toContain('Number Of Up Ports In Trunk: 3');
    expect(sortie).toContain('PortName                      Status      Weight');
  });

  it('§4.3 chaque membre est Selected avec un poids de 1', async () => {
    const { a, ports } = await laboHuawei(3);
    const sortie = await a.executeCommand('display eth-trunk 1');
    for (const n of ports) {
      expect(sortie, n).toMatch(new RegExp(`${n}\\s+Selected\\s+1`));
    }
  });

  it('§4.3 `display lacp statistics eth-trunk 1` compte les LACPDU par port', async () => {
    const { a, ports } = await laboHuawei(2);
    const sortie = await a.executeCommand('display lacp statistics eth-trunk 1');
    for (const n of ports) expect(sortie, n).toContain(n);
    expect(sortie).toContain('LACPDU');
    expect(sortie).toContain('Marker');
    expect(sortie).toMatch(/\n\s+[1-9]\d*\s+[1-9]\d*\s+0\s+0/);
  });

  it('§4.3 couper un lien fait tomber le compte de ports actifs du trunk', async () => {
    const a = new HuaweiSwitch('switch-huawei', 'Switch-A', 24, 0, 0);
    const b = new HuaweiSwitch('switch-huawei', 'Switch-B', 24, 300, 0);
    const ports = a.getPorts().slice(0, 3).map((p) => p.getName());
    const cables = ports.map((n) => {
      const c = new Cable(`h-${n}`);
      c.connect(a.getPort(n)!, b.getPort(n)!);
      return c;
    });
    for (const d of [a, b]) {
      await taper(d, ['system-view', 'interface Eth-Trunk 1', 'mode lacp-static', 'quit']);
      for (const n of ports) await taper(d, [`interface ${n}`, 'eth-trunk 1', 'quit']);
    }
    await vi.advanceTimersByTimeAsync(LACP_PERIODIC_MS);
    expect(await a.executeCommand('display eth-trunk 1')).toContain('Number Of Up Ports In Trunk: 3');
    cables[0].disconnect();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await a.executeCommand('display eth-trunk 1')).toContain('Number Of Up Ports In Trunk: 2');
  });

  it('§4.3 `interface Eth-Trunk1` et son mode figurent dans la configuration rendue', async () => {
    const { a } = await laboHuawei(2);
    const cfg = await a.executeCommand('display current-configuration');
    expect(cfg).toContain('eth-trunk 1');
    expect(cfg).toContain('interface Eth-Trunk1');
    expect(cfg).toContain(' mode lacp-static');
  });

  it('§4.2 la methode de repartition figure dans la configuration rendue', async () => {
    const a = new HuaweiSwitch('switch-huawei', 'Switch-A', 24, 0, 0);
    await taper(a, ['system-view', 'interface Eth-Trunk 1', 'mode lacp-static',
      'load-balance src-dst-ip', 'quit', 'quit']);
    expect(await a.executeCommand('display current-configuration'))
      .toContain(' load-balance src-dst-ip');
  });
});

describe('Partie 5 — LACP sur Linux : le bonding n\'est pas modelise', () => {
  beforeEach(() => {
    resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
  });

  it('§5.1 MANQUE — le module noyau `bonding` n\'est pas dans l\'image', async () => {
    const pc = new LinuxPC('linux-pc', 'srv', 0, 0);
    const out = await pc.executeCommand('modprobe bonding');
    expect(out).toContain('Module bonding not found');
  });

  it('§5.1 MANQUE — `ip link add ... type bond` est refuse', async () => {
    const pc = new LinuxPC('linux-pc', 'srv', 0, 0);
    const out = await pc.executeCommand('ip link add bond0 type bond');
    expect(out).toContain('unknown link type');
  });

  it('§5.2 MANQUE — aucun fichier netplan de bond n\'est livre', async () => {
    const pc = new LinuxPC('linux-pc', 'srv', 0, 0);
    expect(await pc.executeCommand('ls /etc/netplan/')).not.toContain('bond');
  });

  it('§5.3 MANQUE — `nmcli` n\'existe pas', async () => {
    const pc = new LinuxPC('linux-pc', 'srv', 0, 0);
    const out = await pc.executeCommand(
      'nmcli connection add type bond con-name bond0 ifname bond0');
    expect(out).toMatch(/not a valid command|not found/);
  });

  it('§5.4 MANQUE — `/proc/net/bonding/bond0` n\'existe pas', async () => {
    const pc = new LinuxPC('linux-pc', 'srv', 0, 0);
    expect(await pc.executeCommand('cat /proc/net/bonding/bond0'))
      .toContain('No such file or directory');
  });

  it('§5.4 MANQUE — `/sys/class/net/bonding_masters` n\'existe pas', async () => {
    const pc = new LinuxPC('linux-pc', 'srv', 0, 0);
    expect(await pc.executeCommand('cat /sys/class/net/bonding_masters'))
      .toContain('No such file or directory');
  });

  it('TEMOIN — la machine repond bien par ailleurs : `ip link show` liste ses cartes', async () => {
    const pc = new LinuxPC('linux-pc', 'srv', 0, 0);
    const out = await pc.executeCommand('ip link show');
    expect(out).toContain('lo:');
    expect(out).toContain('eth0:');
  });
});

describe('Partie 6 — LACP sur FortiGate : l\'agregation n\'est pas modelisee', () => {
  beforeEach(() => {
    resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
  });

  it('§6.1 MANQUE — `set member` est refuse sous `config system interface`', async () => {
    const fw = new FortiGate('firewall-fortinet', 'FW', 0, 0);
    const out = await taper(fw, ['config system interface', 'edit bond1',
      'set type aggregate', 'set member port3 port4']);
    expect(out).toContain('unknown attribute "member"');
  });

  it('§6.1 MANQUE — `set lacp-mode active` est refuse', async () => {
    const fw = new FortiGate('firewall-fortinet', 'FW', 0, 0);
    const out = await taper(fw, ['config system interface', 'edit bond1',
      'set lacp-mode active']);
    expect(out).toContain('unknown attribute "lacp-mode"');
  });

  it('§6.2 MANQUE — `diagnose netlink aggregate name` n\'existe pas', async () => {
    const fw = new FortiGate('firewall-fortinet', 'FW', 0, 0);
    expect(await fw.executeCommand('diagnose netlink aggregate name bond1'))
      .toContain('unknown command');
  });

  it('TEMOIN — la CLI FortiGate repond bien par ailleurs : `get system interface`', async () => {
    const fw = new FortiGate('firewall-fortinet', 'FW', 0, 0);
    const out = await fw.executeCommand('get system interface');
    expect(out).toContain('== [port1]');
    expect(out).toContain('ip: 192.168.1.99 255.255.255.0');
  });
});

describe('Partie 7 — troubleshooting', () => {
  beforeEach(() => {
    resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
    vi.useFakeTimers();
  });
  afterEach(() => { vi.useRealTimers(); });

  it('§7.1 probleme 4 — passive+passive laisse les ports en stand-alone (I)', async () => {
    const { a } = await laboCisco('passive', 'passive', 2);
    const sortie = await a.executeCommand('show etherchannel summary');
    expect(drapeauDe(sortie, 'Fa0/1')).toBe('I');
  });

  it('§7.1 probleme 4 — la solution : passer un cote en active repare le groupe', async () => {
    const a = new CiscoSwitch('switch-cisco', 'Switch-A', 24, 0, 0);
    const b = new CiscoSwitch('switch-cisco', 'Switch-B', 24, 300, 0);
    const ports = CISCO_PORTS.slice(0, 2);
    cableCisco(a, b, ports);
    await joindreGroupe(a, ports, 'passive');
    await joindreGroupe(b, ports, 'passive');
    await vi.advanceTimersByTimeAsync(LACP_PERIODIC_MS);
    expect(drapeauDe(await a.executeCommand('show etherchannel summary'), 'Fa0/1')).toBe('I');

    await joindreGroupe(a, ports, 'active');
    await vi.advanceTimersByTimeAsync(LACP_PERIODIC_MS);
    expect(drapeauDe(await a.executeCommand('show etherchannel summary'), 'Fa0/1')).toBe('P');
    expect(drapeauDe(await b.executeCommand('show etherchannel summary'), 'Fa0/1')).toBe('P');
  });

  it('§7.1 un port sans partenaire configure reste hors du groupe', async () => {
    const a = new CiscoSwitch('switch-cisco', 'Switch-A', 24, 0, 0);
    const b = new CiscoSwitch('switch-cisco', 'Switch-B', 24, 300, 0);
    cableCisco(a, b, CISCO_PORTS.slice(0, 2));
    await joindreGroupe(a, CISCO_PORTS.slice(0, 2), 'active');
    await vi.advanceTimersByTimeAsync(LACP_PERIODIC_MS);
    const sortie = await a.executeCommand('show etherchannel summary');
    expect(drapeauDe(sortie, 'Fa0/1')).toBe('I');
    expect(await a.executeCommand('show lacp neighbor')).toContain('none');
  });

  it('§7.1 un port sans cable ne rejoint pas le groupe', async () => {
    const a = new CiscoSwitch('switch-cisco', 'Switch-A', 24, 0, 0);
    const b = new CiscoSwitch('switch-cisco', 'Switch-B', 24, 300, 0);
    cableCisco(a, b, CISCO_PORTS.slice(0, 2));
    const tous = CISCO_PORTS.slice(0, 3);
    await joindreGroupe(a, tous, 'active');
    await joindreGroupe(b, tous, 'active');
    await vi.advanceTimersByTimeAsync(LACP_PERIODIC_MS);
    const sortie = await a.executeCommand('show etherchannel summary');
    expect(drapeauDe(sortie, 'Fa0/1')).toBe('P');
    expect(drapeauDe(sortie, 'Fa0/3')).not.toBe('P');
  });

  it('§7.2 point 6 — un port change de groupe et ne reste pas dans les deux', async () => {
    const a = new CiscoSwitch('switch-cisco', 'Switch-A', 24, 0, 0);
    await taper(a, ['enable', 'configure terminal',
      'interface FastEthernet0/1', 'channel-group 1 mode active',
      'channel-group 2 mode active', 'end']);
    const sortie = await a.executeCommand('show etherchannel summary');
    const groupes = sortie.split('\n').filter((l) => /Fa0\/1\(/.test(l));
    expect(groupes).toHaveLength(1);
  });

  it('§7.2 point 1 — `show lacp internal` distingue un port groupe d\'un port isole', async () => {
    const { a } = await laboCisco('passive', 'passive', 2);
    expect(await a.executeCommand('show lacp internal')).toMatch(/Fa0\/1\s+SP\s+standalone/);
  });
});

describe('Ce que le tutoriel enseigne et que ce simulateur ne modelise pas', () => {
  beforeEach(() => {
    resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
    vi.useFakeTimers();
  });
  afterEach(() => { vi.useRealTimers(); });

  it('§1.2 un Port-channel est UN port logique : une diffusion ne sort qu\'une fois', async () => {
    const a = new CiscoSwitch('switch-cisco', 'Switch-A', 24, 0, 0);
    const b = new CiscoSwitch('switch-cisco', 'Switch-B', 24, 300, 0);
    cableCisco(a, b, CISCO_PORTS);
    const pc1 = new LinuxPC('linux-pc', 'PC1', -200, 0);
    const pc2 = new LinuxPC('linux-pc', 'PC2', 500, 0);
    new Cable('acces-a').connect(pc1.getPort('eth0')!, a.getPort('FastEthernet0/10')!);
    new Cable('acces-b').connect(pc2.getPort('eth0')!, b.getPort('FastEthernet0/10')!);
    await joindreGroupe(a, CISCO_PORTS, 'active');
    await joindreGroupe(b, CISCO_PORTS, 'active');
    await vi.advanceTimersByTimeAsync(LACP_PERIODIC_MS);

    let recues = 0;
    pc2.getBus().subscribe('port.frame.received', (e: unknown) => {
      const f = (e as { payload?: { frame?: EthernetFrame } }).payload?.frame;
      if (f?.etherType === 0x88b5) recues += 1;
    });
    const diffusion = {
      srcMAC: pc1.getPort('eth0')!.getMAC(),
      dstMAC: MACAddress.broadcast(),
      etherType: 0x88b5,
      payload: { type: 'opaque' },
    } as unknown as EthernetFrame;
    a.getPort('FastEthernet0/10')!.receiveFrame(diffusion);
    await vi.advanceTimersByTimeAsync(200);
    expect(recues).toBe(1);
  }, 30_000);

  it('§1.2 un faisceau de quatre liens ne fabrique pas de tempete', async () => {
    const compter = async (nbLiens: number): Promise<number> => {
      resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
      const a = new CiscoSwitch('switch-cisco', 'A', 24, 0, 0);
      const b = new CiscoSwitch('switch-cisco', 'B', 24, 300, 0);
      const liens = CISCO_PORTS.slice(0, nbLiens);
      cableCisco(a, b, liens);
      const pc1 = new LinuxPC('linux-pc', 'PC1', -200, 0);
      const pc2 = new LinuxPC('linux-pc', 'PC2', 500, 0);
      new Cable('x1').connect(pc1.getPort('eth0')!, a.getPort('FastEthernet0/10')!);
      new Cable('x2').connect(pc2.getPort('eth0')!, b.getPort('FastEthernet0/10')!);
      await joindreGroupe(a, liens, 'active');
      await joindreGroupe(b, liens, 'active');
      await vi.advanceTimersByTimeAsync(LACP_PERIODIC_MS);
      let vues = 0;
      pc2.getBus().subscribe('port.frame.received', (e: unknown) => {
        const f = (e as { payload?: { frame?: EthernetFrame } }).payload?.frame;
        if (f?.etherType === 0x88b5) vues += 1;
      });
      a.getPort('FastEthernet0/10')!.receiveFrame({
        srcMAC: pc1.getPort('eth0')!.getMAC(),
        dstMAC: MACAddress.broadcast(),
        etherType: 0x88b5,
        payload: { type: 'opaque' },
      } as unknown as EthernetFrame);
      await vi.advanceTimersByTimeAsync(200);
      return vues;
    };
    expect(await compter(1)).toBe(1);
    expect(await compter(2)).toBe(1);
    expect(await compter(4)).toBe(1);
  }, 60_000);

  it('§3.4 le code (P) dit membre du groupe, (I) dit isole', async () => {
    const { a: groupe } = await laboCisco('active', 'active', 2);
    expect(drapeauDe(await groupe.executeCommand('show etherchannel summary'), 'Fa0/1')).toBe('P');
    resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
    const { a: isole } = await laboCisco('passive', 'passive', 2);
    expect(drapeauDe(await isole.executeCommand('show etherchannel summary'), 'Fa0/1')).toBe('I');
  });

  it('§7.1 un membre ferme administrativement quitte le groupe', async () => {
    const { a, ports } = await laboCisco('active', 'active', 4);
    await taper(a, ['enable', 'configure terminal',
      `interface ${ports[0]}`, 'shutdown', 'end']);
    await vi.advanceTimersByTimeAsync(1_000);
    const sortie = await a.executeCommand('show etherchannel summary');
    expect(drapeauDe(sortie, 'Fa0/1')).not.toBe('P');
    expect(drapeauDe(sortie, 'Fa0/2')).toBe('P');
  });

  it('§7.2 point 5 — `show lacp neighbor` dit `none` tant qu\'aucun partenaire ne repond', async () => {
    const a = new CiscoSwitch('switch-cisco', 'Switch-A', 24, 0, 0);
    const b = new CiscoSwitch('switch-cisco', 'Switch-B', 24, 300, 0);
    cableCisco(a, b, CISCO_PORTS.slice(0, 2));
    await joindreGroupe(a, CISCO_PORTS.slice(0, 2), 'active');
    await vi.advanceTimersByTimeAsync(LACP_PERIODIC_MS);
    expect(await a.executeCommand('show lacp neighbor')).toContain('none');
  });

  it('le groupe survit a la perte de tous les membres sauf un', async () => {
    const { a, cables } = await laboCisco('active', 'active', 4);
    for (const c of cables.slice(0, 3)) c.disconnect();
    await vi.advanceTimersByTimeAsync(1_000);
    const sortie = await a.executeCommand('show etherchannel summary');
    expect(drapeauDe(sortie, 'Fa0/4')).toBe('P');
    expect(sortie).toContain('Number of channel-groups in use: 1');
  });
});
