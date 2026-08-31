/**
 * La cle d'un acteur LACP est LOCALE, et le partenaire ne la valide
 * pas. Mesure contre `ad_port_selection_logic` de `bond_3ad.c`, dont le
 * predicat est explicite : une agregation convient a un port quand
 * `actor_oper_aggregator_key == port->actor_oper_port_key` — la cle du
 * port contre celle de SON PROPRE agregat — et que le systeme, la
 * priorite et la cle du PARTENAIRE concordent. Rien n'y compare la cle
 * de l'acteur a celle du partenaire.
 *
 * LE DEFAUT MESURE : `runSelection` groupait sur
 * `p.partner.key === p.groupId`, c'est-a-dire la cle du partenaire
 * contre NOTRE numero de groupe. Consequence, sur le laboratoire le
 * plus repandu de tous : SWA en `channel-group 1` et SWB en
 * `channel-group 2` ne se groupaient PAS — `Fa0/1(I) Fa0/2(I)` des deux
 * cotes, sans un mot — alors qu'un vrai IOS groupe, le numero de
 * groupe etant local ; et un `channel-group 5` face a un `bond0` ne
 * groupait pas davantage.
 *
 * Le meme champ portait un second manquement : la cle etait le numero
 * de groupe alors que le noyau l'ENCODE — bit 0 le duplex, bits 1-5 la
 * vitesse, bits 6-15 `ad_user_port_key` (`ad_update_actor_keys`) — de
 * sorte que deux liens de vitesses differentes portent deux cles, donc
 * deux agregations, et qu'un seul des deux transporte.
 *
 * DISCRIMINATION : 11 des 16 cas tombent contre l'etat d'avant, mais
 * l'un des onze ne prouve rien et est nomme comme tel — la sonde
 * unitaire du codage tombe faute de l'export, pas faute du
 * comportement. Dix cas discriminent donc vraiment. Les cinq restants
 * sont nommes ici plutot que laisses a decouvrir : le TEMOIN a numeros
 * egaux, dont c'est l'objet de passer des deux cotes ; le refus d'une
 * cle utilisateur hors plage et celui d'une adresse multicast, qui
 * passaient parce que les DEUX options etaient refusees en bloc ;
 * `ad_actor_sys_prio 100`, deja accepte et deja rendu ; et surtout
 * « le trafic traverse une agregation aux numeros differents », qui
 * passait DEJA — la mesure le dit et l'intuition disait l'inverse :
 * des membres non groupes restent des liens ordinaires et le
 * commutateur en laisse passer un, donc le ping reussit sans qu'aucune
 * agregation existe. Le cas ne montre pas le defaut ; il garde que le
 * plan de donnees survit au correctif, ce qui est son role.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { adOperPortKey, adLinkSpeedCode } from '@/network/lacp/types';
import type { LacpAgent } from '@/network/lacp/LacpAgent';

interface Cmd { executeCommand(cmd: string): Promise<string> }
const PERIODIC_MS = 35_000;

async function taper(d: Cmd, cmds: string[]): Promise<string> {
  let last = '';
  for (const c of cmds) last = await d.executeCommand(c);
  return last;
}

function agentDe(d: unknown): LacpAgent {
  return (d as { getLacpAgent(): LacpAgent }).getLacpAgent();
}

async function deuxCommutateurs(groupeA: number, groupeB: number) {
  const a = new CiscoSwitch('switch-cisco', 'SWA', 24, 300, 0);
  const b = new CiscoSwitch('switch-cisco', 'SWB', 24, 300, 200);
  a.powerOn(); b.powerOn();
  for (let i = 1; i <= 2; i++) {
    new Cable(`x${i}`).connect(a.getPort(`FastEthernet0/${i}`)!, b.getPort(`FastEthernet0/${i}`)!);
  }
  await taper(a, ['enable', 'configure terminal', 'interface range FastEthernet0/1 - 2',
    `channel-group ${groupeA} mode active`, 'end']);
  await taper(b, ['enable', 'configure terminal', 'interface range FastEthernet0/1 - 2',
    `channel-group ${groupeB} mode active`, 'end']);
  await vi.advanceTimersByTimeAsync(PERIODIC_MS);
  return { a, b };
}

async function serveurEtCommutateur(groupe: number, forcer?: string) {
  const srv = new LinuxServer('linux-server', 'srv', 0, 0);
  const sw = new CiscoSwitch('switch-cisco', 'SW', 24, 300, 0);
  srv.powerOn(); sw.powerOn();
  await taper(sw, ['enable', 'configure terminal']);
  for (let i = 1; i <= 2; i++) {
    new Cable(`c${i}`).connect(srv.getPorts()[i - 1], sw.getPort(`FastEthernet0/${i}`)!);
    await taper(sw, [`interface FastEthernet0/${i}`, `channel-group ${groupe} mode active`, 'exit']);
  }
  if (forcer) await taper(sw, ['interface FastEthernet0/2', forcer, 'exit']);
  await sw.executeCommand('end');
  await taper(srv, ['ip link add bond0 type bond',
    'ip link set bond0 type bond mode 802.3ad',
    'ip link set eth0 master bond0', 'ip link set eth1 master bond0']);
  await vi.advanceTimersByTimeAsync(PERIODIC_MS);
  return { srv, sw };
}

describe('la cle d\'un acteur LACP est locale', () => {
  beforeEach(() => {
    resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
    vi.useFakeTimers();
  });
  afterEach(() => { vi.useRealTimers(); });

  it('deux commutateurs aux numeros de groupe differents se groupent', async () => {
    const { a, b } = await deuxCommutateurs(1, 2);
    expect(await a.executeCommand('show etherchannel summary')).toContain('Fa0/1(P) Fa0/2(P)');
    expect(await b.executeCommand('show etherchannel summary')).toContain('Fa0/1(P) Fa0/2(P)');
  });

  it('TEMOIN : a numeros egaux ils se groupent aussi', async () => {
    const { a, b } = await deuxCommutateurs(1, 1);
    expect(await a.executeCommand('show etherchannel summary')).toContain('Fa0/1(P) Fa0/2(P)');
    expect(await b.executeCommand('show etherchannel summary')).toContain('Fa0/1(P) Fa0/2(P)');
  });

  it('le trafic traverse une agregation aux numeros differents', async () => {
    const a = new CiscoSwitch('switch-cisco', 'SWA', 24, 300, 0);
    const b = new CiscoSwitch('switch-cisco', 'SWB', 24, 300, 200);
    const pc1 = new LinuxServer('linux-server', 'pc1', 0, 400);
    const pc2 = new LinuxServer('linux-server', 'pc2', 0, 500);
    [a, b, pc1, pc2].forEach(d => d.powerOn());
    for (let i = 1; i <= 2; i++) {
      new Cable(`x${i}`).connect(a.getPort(`FastEthernet0/${i}`)!, b.getPort(`FastEthernet0/${i}`)!);
    }
    new Cable('p1').connect(pc1.getPorts()[0], a.getPort('FastEthernet0/10')!);
    new Cable('p2').connect(pc2.getPorts()[0], b.getPort('FastEthernet0/10')!);
    await taper(a, ['enable', 'configure terminal', 'interface range FastEthernet0/1 - 2',
      'channel-group 1 mode active', 'end']);
    await taper(b, ['enable', 'configure terminal', 'interface range FastEthernet0/1 - 2',
      'channel-group 7 mode active', 'end']);
    await taper(pc1, ['ip addr add 10.0.0.1/24 dev eth0', 'ip link set eth0 up']);
    await taper(pc2, ['ip addr add 10.0.0.2/24 dev eth0', 'ip link set eth0 up']);
    await vi.advanceTimersByTimeAsync(PERIODIC_MS);
    vi.useRealTimers();
    expect(await pc1.executeCommand('ping -c 2 10.0.0.2')).toMatch(/, 0% packet loss/);
  });

  it('un bond0 se groupe avec un channel-group 5', async () => {
    const { srv, sw } = await serveurEtCommutateur(5);
    for (const n of ['eth0', 'eth1']) {
      expect(agentDe(srv).getPortInfo(n)?.bundled).toBe(true);
    }
    expect(await sw.executeCommand('show etherchannel summary')).toContain('Fa0/1(P) Fa0/2(P)');
  });

  it('la cle annoncee encode la vitesse et le duplex', async () => {
    const { srv } = await serveurEtCommutateur(1);
    expect(await srv.executeCommand('cat /proc/net/bonding/bond0')).toContain('port key: 7');
  });

  it('`ad_user_port_key` decale de six bits', async () => {
    const { srv } = await serveurEtCommutateur(1);
    expect(await srv.executeCommand('ip link set bond0 type bond ad_user_port_key 5')).toBe('');
    const proc = await srv.executeCommand('cat /proc/net/bonding/bond0');
    expect(proc).toContain('port key: 327');
    expect(proc).toContain('Actor Key: 327');
  });

  it('une cle utilisateur hors plage est refusee', async () => {
    const { srv } = await serveurEtCommutateur(1);
    expect(await srv.executeCommand('ip link set bond0 type bond ad_user_port_key 1024'))
      .toContain('is wrong: invalid value');
  });

  it('`ad_actor_system` remplace l\'adresse de systeme annoncee', async () => {
    const { srv } = await serveurEtCommutateur(1);
    expect(await srv.executeCommand('ip link set bond0 type bond ad_actor_system 02:11:22:33:44:55'))
      .toBe('');
    expect(await srv.executeCommand('cat /proc/net/bonding/bond0'))
      .toContain('System MAC address: 02:11:22:33:44:55');
  });

  it('une adresse multicast est refusee comme `ad_actor_system`', async () => {
    const { srv } = await serveurEtCommutateur(1);
    expect(await srv.executeCommand('ip link set bond0 type bond ad_actor_system 01:11:22:33:44:55'))
      .toContain('is wrong: invalid value');
  });

  it('`ad_actor_sys_prio 0` est refuse, la plage commencant a 1', async () => {
    const { srv } = await serveurEtCommutateur(1);
    expect(await srv.executeCommand('ip link set bond0 type bond ad_actor_sys_prio 0'))
      .toContain('is wrong: invalid value');
    expect(await srv.executeCommand('cat /proc/net/bonding/bond0'))
      .toContain('System priority: 65535');
  });

  it('`ad_actor_sys_prio 100` est accepte et rendu', async () => {
    const { srv } = await serveurEtCommutateur(1);
    expect(await srv.executeCommand('ip link set bond0 type bond ad_actor_sys_prio 100')).toBe('');
    expect(await srv.executeCommand('cat /proc/net/bonding/bond0'))
      .toContain('System priority: 100');
  });

  it('deux vitesses font deux cles, et une seule agregation transporte', async () => {
    const { srv } = await serveurEtCommutateur(1, 'speed 10');
    expect(srv.getPort('eth1')?.getNegotiatedSpeed()).toBe(10);
    expect(agentDe(srv).getPortInfo('eth0')?.bundled).toBe(true);
    expect(agentDe(srv).getPortInfo('eth1')?.bundled).toBe(false);
    expect(agentDe(srv).getPortInfo('eth1')?.state).toBe('suspended');
  });

  it('les deux vitesses portent deux identifiants d\'agregation', async () => {
    const { srv } = await serveurEtCommutateur(1, 'speed 10');
    const a = agentDe(srv);
    const id0 = a.aggregatorIdOf(a.getPortInfo('eth0')!);
    const id1 = a.aggregatorIdOf(a.getPortInfo('eth1')!);
    expect(id0).not.toBe(id1);
    const proc = await srv.executeCommand('cat /proc/net/bonding/bond0');
    expect(proc).toContain('port key: 7');
    expect(proc).toContain('port key: 5');
  });

  it('un lien en semi-duplex ne se groupe pas', async () => {
    const { srv } = await serveurEtCommutateur(1, 'duplex half');
    expect(srv.getPort('eth1')?.getNegotiatedDuplex()).toBe('half');
    expect(agentDe(srv).getPortInfo('eth0')?.bundled).toBe(true);
    expect(agentDe(srv).getPortInfo('eth1')?.bundled).toBe(false);
  });

  it('le codage de la cle suit `ad_update_actor_keys`', () => {
    expect(adLinkSpeedCode(100)).toBe(3);
    expect(adLinkSpeedCode(1000)).toBe(4);
    expect(adLinkSpeedCode(null)).toBe(0);
    expect(adOperPortKey(0, 100, 'full')).toBe(7);
    expect(adOperPortKey(0, 10, 'full')).toBe(5);
    expect(adOperPortKey(0, 100, 'half')).toBe(6);
    expect(adOperPortKey(5, 100, 'full')).toBe(327);
    expect(adOperPortKey(5, null, null)).toBe(320);
  });

  it('un lien tombe rend une cle sans vitesse ni duplex', async () => {
    const { srv } = await serveurEtCommutateur(1);
    await srv.executeCommand('ip link set bond0 type bond ad_user_port_key 5');
    const a = agentDe(srv);
    expect(a.actorKeyOf(a.getPortInfo('eth1')!)).toBe(327);
    await srv.executeCommand('ip link set eth1 down');
    await vi.advanceTimersByTimeAsync(PERIODIC_MS);
    expect(a.actorKeyOf(a.getPortInfo('eth1')!)).toBe(320);
    expect(await srv.executeCommand('cat /proc/net/bonding/bond0'))
      .toContain('Aggregator ID: N/A');
  });
});
