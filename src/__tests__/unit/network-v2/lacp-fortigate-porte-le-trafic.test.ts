/**
 * Une interface agregee FortiGate PORTE le trafic. Mesure de depart :
 * `execute ping` depuis un bond1 correctement negocie LEVAIT une
 * exception (`portMac` fait un `!` sur un port qui n'existe pas), donc
 * la CLI plantait au lieu de repondre.
 *
 * `lacp-ha-secondary` vaut `enable` par defaut sur FortiOS et c'est ce
 * qui garde les liens du secondaire dans l'agregat, donc ce qui rend un
 * basculement immediat.
 *
 * DISCRIMINATION : 9 des 15 cas tombent contre l'etat d'avant. Les 6
 * autres sont nommes plutot que laisses a decouvrir : « au seuil
 * exactement » et « `set type aggregate` reste dans la configuration »
 * etaient deja justes et gardent que le correctif ne les casse pas —
 * le second l'a d'ailleurs attrape en cours de route, la creation du
 * port faisant disparaitre l'attribut du rendu ; « lacp-speed fast »,
 * « algorithm L2 » et « actif par defaut » passent parce que la valeur
 * etait deja transportee ou absente ; et le dernier est le TEMOIN du
 * refus, dont c'est l'objet de passer des deux cotes.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { LinuxPC } from '@/network/devices/LinuxPC';
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

async function labo(extra: readonly string[] = []) {
  const fw = new FortiGate('firewall-fortinet', 'FW', 0, 0);
  const sw = new CiscoSwitch('switch-cisco', 'SW', 24, 300, 0);
  const pc = new LinuxPC('linux-pc', 'PC', 600, 0);
  fw.powerOn(); sw.powerOn(); pc.powerOn();
  const ports = fw.getPorts().map(p => p.getName());
  const cables: Cable[] = [];
  for (let i = 0; i < 2; i++) {
    const c = new Cable(`c${i}`);
    c.connect(fw.getPort(ports[2 + i])!, sw.getPort(`FastEthernet0/${i + 1}`)!);
    cables.push(c);
  }
  new Cable('cpc').connect(pc.getPorts()[0], sw.getPort('FastEthernet0/5')!);
  await taper(sw, ['enable', 'configure terminal']);
  for (let i = 1; i <= 2; i++) {
    await taper(sw, [`interface FastEthernet0/${i}`, 'channel-group 1 mode active', 'exit']);
  }
  await sw.executeCommand('end');
  await taper(fw, ['config system interface', 'edit bond1', 'set type aggregate',
    `set member ${ports[2]} ${ports[3]}`, 'set lacp-mode active',
    ...extra,
    'set ip 10.0.0.1 255.255.255.0', 'set allowaccess ping', 'next', 'end']);
  await pc.executeCommand('ip addr add 10.0.0.2/24 dev eth0');
  await vi.advanceTimersByTimeAsync(LACP_PERIODIC_MS);
  return { fw, sw, pc, ports, cables };
}

describe('l\'agregat est une interface a part entiere', () => {
  beforeEach(() => {
    resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
    vi.useFakeTimers();
  });
  afterEach(() => { vi.useRealTimers(); });

  it('l\'agregat porte un vrai port, et l\'adresse y est posee', async () => {
    const { fw } = await labo();
    expect(fw.getPort('bond1')).toBeTruthy();
    expect(fw.getPort('bond1')!.getIPAddress()?.toString()).toBe('10.0.0.1');
  }, 30_000);

  it('un membre porte l\'adresse de l\'agregat, et garde la sienne en reserve', async () => {
    const { fw, ports } = await labo();
    const bond = fw.getPort('bond1')!.getMAC().toString();
    for (const m of [ports[2], ports[3]]) {
      expect(fw.getPort(m)!.getMAC().toString(), m).toBe(bond);
    }
    expect(fw.permanentMacOf(ports[3])).not.toBe(bond);
  }, 30_000);

  it('`diagnose netlink aggregate name` rend l\'adresse PERMANENTE du membre', async () => {
    const { fw, ports } = await labo();
    const out = await fw.executeCommand('diagnose netlink aggregate name bond1');
    expect(out).toContain(`permanent MAC addr: ${fw.permanentMacOf(ports[2])}`);
  }, 30_000);

  it('`execute ping` traverse l\'agregat au lieu de lever', async () => {
    const { fw } = await labo();
    vi.useRealTimers();
    expect(await fw.executeCommand('execute ping 10.0.0.2'))
      .toContain('0% packet loss');
  }, 30_000);

  it('le voisin joint le pare-feu par son agregat', async () => {
    const { pc } = await labo();
    vi.useRealTimers();
    expect(await pc.executeCommand('ping -c 2 10.0.0.1')).toMatch(/, 0% packet loss/);
  }, 30_000);

  it('la trame sort par un MEMBRE, jamais par l\'agregat', async () => {
    const { fw, ports } = await labo();
    const vus: string[] = [];
    fw.attachCapture((t) => { if (t.direction === 'out') vus.push(t.iface); });
    vi.useRealTimers();
    await fw.executeCommand('execute ping 10.0.0.2');
    expect(vus.length).toBeGreaterThan(0);
    expect(vus).not.toContain('bond1');
    expect(vus.every(n => n === ports[2] || n === ports[3])).toBe(true);
  }, 30_000);

  it('un seul lien survivant porte encore le trafic', async () => {
    const { fw, cables } = await labo();
    cables[0].disconnect();
    await vi.advanceTimersByTimeAsync(LACP_PERIODIC_MS * 3);
    vi.useRealTimers();
    expect(await fw.executeCommand('execute ping 10.0.0.2')).toContain('0% packet loss');
  }, 30_000);

  it('`set type aggregate` reste dans la configuration rendue', async () => {
    const { fw } = await labo();
    expect(await fw.executeCommand('show system interface bond1'))
      .toContain('set type aggregate');
  }, 30_000);
});

describe('le seuil de liens et la cadence', () => {
  beforeEach(() => {
    resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
    vi.useFakeTimers();
  });
  afterEach(() => { vi.useRealTimers(); });

  it('`min-links` compte les liens GROUPES, pas les cables branches', async () => {
    const { fw, sw, ports } = await labo(['set min-links 2']);
    await taper(sw, ['enable', 'configure terminal', 'interface FastEthernet0/2',
      'no channel-group', 'end']);
    await vi.advanceTimersByTimeAsync(LACP_PERIODIC_MS * 3);
    expect(fw.activeAggregateMembers('bond1')).not.toContain(ports[3]);
    expect(await fw.executeCommand('diagnose netlink aggregate name bond1'))
      .toContain('status: down');
  }, 30_000);

  it('au seuil exactement, l\'agregat est up — la borne est INCLUSIVE', async () => {
    const { fw } = await labo(['set min-links 2']);
    expect(await fw.executeCommand('diagnose netlink aggregate name bond1'))
      .toContain('status: up');
  }, 30_000);

  it('`set lacp-speed fast` demande la cadence rapide au partenaire', async () => {
    const { fw, sw } = await labo(['set lacp-speed fast']);
    expect(fw.getLacpAgent().getConfig().fastRate).toBe(true);
    await vi.advanceTimersByTimeAsync(2_000);
    const chezSw = sw.getLacpAgent().getPortInfo('FastEthernet0/1');
    expect((chezSw?.partner?.state ?? 0) & 0x02).toBe(0x02);
  }, 30_000);

  it('`set algorithm L2` change la cle de repartition', async () => {
    const { fw } = await labo(['set algorithm L2']);
    expect(await fw.executeCommand('diagnose netlink aggregate name bond1'))
      .toContain('distribution algorithm: L2');
  }, 30_000);
});

describe('lacp-ha-secondary', () => {
  beforeEach(() => {
    resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
    vi.useFakeTimers();
  });
  afterEach(() => { vi.useRealTimers(); });

  it('l\'attribut est accepte et rendu quand il est coupe', async () => {
    const { fw } = await labo(['set lacp-ha-secondary disable']);
    expect(await fw.executeCommand('show system interface bond1'))
      .toContain('set lacp-ha-secondary disable');
  }, 30_000);

  it('actif par defaut, il n\'apparait pas dans la configuration', async () => {
    const { fw } = await labo();
    expect(await fw.executeCommand('show system interface bond1'))
      .not.toContain('lacp-ha-secondary');
  }, 30_000);

  it('un agregat inexistant est refuse — TEMOIN', async () => {
    const { fw } = await labo();
    expect(await fw.executeCommand('diagnose netlink aggregate name bond9'))
      .toBe('aggregate interface bond9 does not exist');
  }, 30_000);
});
