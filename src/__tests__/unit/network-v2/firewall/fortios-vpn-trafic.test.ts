/**
 * FGT-VPN-3 : un paquet TRAVERSE le tunnel, pour de bon.
 *
 * La phase 8 avait livre la declaration, la programmation du moteur et le
 * diagnostic ; elle laissait ouvert le seul point qui prouve qu'un tunnel
 * existe — qu'un paquet parti d'un poste derriere le pare-feu A ressorte
 * derriere le pare-feu B, chiffre sur le fil entre les deux.
 *
 * Ecrite A L'AVEUGLE contre ce qu'un vrai FortiGate fait :
 *
 *   1. **L'interface de tunnel est une interface de plein droit** : la
 *      route la designe sans passerelle (elle est point a point), et la
 *      politique la nomme dans `srcintf`/`dstintf`. Sans politique, le
 *      trafic ne passe pas — c'est ce qui distingue le mode route du
 *      mode politique.
 *   2. **Ce qui sort sur le lien WAN est de l'ESP** (protocole 50), et
 *      l'adresse interne n'y parait jamais en clair : si le paquet
 *      interieur restait visible, il n'y aurait pas de tunnel mais une
 *      route.
 *   3. **Les compteurs de `diagnose vpn tunnel list` sont une mesure** :
 *      `txp`/`rxp` bougent parce que des paquets sont passes, pas parce
 *      qu'une commande a ete tapee.
 *   4. **Le selecteur de phase 2 decide** : une destination hors
 *      `dst-subnet` n'est pas chiffree.
 *
 * Deux defauts trouves en la mesurant ne sont PAS propres au VPN et sont
 * eprouves ici parce que c'est la sonde qui les a leves : `delete <n>`
 * sous `config router static` retirait la route de la configuration et la
 * laissait dans la table de transfert (`removeStaticRoute` avait un corps
 * VIDE), et changer le `dst` d'une route existante en laissait une
 * seconde derriere — la suppression cherchait la NOUVELLE destination.
 *
 * Discriminee par `git stash push -- src/network/` : 8 des 12 cas
 * tombent avant correctif. Les 4 restants sont nommes ici plutot que
 * laisses a decouvrir, et aucun ne prouve le mecanisme — ils passaient
 * parce que RIEN ne sortait : « sans politique du cote distant »,
 * « sans route vers le tunnel », « une destination hors du selecteur »
 * et « l'adresse interieure ne parait jamais sur le lien WAN ».
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { FortiShell } from '@/network/devices/firewall/vendors/fortios/FortiShell';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress, IP_PROTO_ESP, type IPv4Packet } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { pingOnSimulatedClock } from '../../../support/fastPing';

interface Cmd { executeCommand(cmd: string): Promise<string> }

const runOn = (d: Cmd, cmds: string[]) =>
  cmds.reduce(async (p, c) => { await p; await d.executeCommand(c); }, Promise.resolve<unknown>(undefined));

function run(sh: FortiShell, ...lines: string[]): string {
  let last = '';
  for (const line of lines) last = sh.execute(line);
  return last;
}

const PSK = 'SecretPartage2026';

interface Site {
  fw: FortiGate;
  sh: FortiShell;
  pc: LinuxPC;
}

function site(
  name: string, lan: string, wan: string, at: number,
): Site {
  const fw = new FortiGate('firewall-fortinet', name, at, 0);
  const sh = new FortiShell(fw);
  const pc = new LinuxPC('linux-pc', `PC-${name}`, at, 120);

  run(sh,
    'config system interface',
    'edit "port1"', 'set mode static',
    `set ip ${lan}.1 255.255.255.0`, 'set allowaccess ping', 'next',
    'edit "port2"', 'set mode static',
    `set ip ${wan} 255.255.255.0`, 'set allowaccess ping', 'next', 'end');

  return { fw, sh, pc };
}

function tunnel(
  s: Site, name: string, peer: string, localLan: string, remoteLan: string,
): void {
  run(s.sh,
    'config vpn ipsec phase1-interface',
    `edit "${name}"`,
    'set interface "port2"',
    'set ike-version 2',
    `set remote-gw ${peer}`,
    `set psksecret "${PSK}"`,
    'set proposal aes256-sha256',
    'set dhgrp 14',
    'next', 'end',
    'config vpn ipsec phase2-interface',
    `edit "${name}-p2"`,
    `set phase1name "${name}"`,
    `set src-subnet ${localLan}.0 255.255.255.0`,
    `set dst-subnet ${remoteLan}.0 255.255.255.0`,
    'next', 'end',
    'config router static',
    'edit 1',
    `set dst ${remoteLan}.0 255.255.255.0`,
    `set device "${name}"`,
    'next', 'end');
}

function politiques(s: Site, name: string): void {
  run(s.sh,
    'config firewall policy',
    'edit 1',
    'set name "vers-tunnel"',
    'set srcintf "port1"', `set dstintf "${name}"`,
    'set srcaddr "all"', 'set dstaddr "all"',
    'set action accept', 'set schedule "always"', 'set service "ALL"',
    'next',
    'edit 2',
    'set name "depuis-tunnel"',
    `set srcintf "${name}"`, 'set dstintf "port1"',
    'set srcaddr "all"', 'set dstaddr "all"',
    'set action accept', 'set schedule "always"', 'set service "ALL"',
    'next', 'end');
}

async function laboratoire(options: { politiqueRetour?: boolean } = {}) {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();

  const a = site('FGT-A', '192.168.1', '203.0.113.1', -200);
  const b = site('FGT-B', '192.168.2', '203.0.113.2', 200);

  new Cable('lan-a').connect(a.pc.getPort('eth0')!, a.fw.getPort('port1')!);
  new Cable('lan-b').connect(b.pc.getPort('eth0')!, b.fw.getPort('port1')!);
  new Cable('wan').connect(a.fw.getPort('port2')!, b.fw.getPort('port2')!);

  tunnel(a, 'vers_b', '203.0.113.2', '192.168.1', '192.168.2');
  tunnel(b, 'vers_a', '203.0.113.1', '192.168.2', '192.168.1');

  politiques(a, 'vers_b');
  if (options.politiqueRetour !== false) politiques(b, 'vers_a');

  await runOn(a.pc, ['ip link set eth0 up', 'ip addr add 192.168.1.10/24 dev eth0',
    'ip route add default via 192.168.1.1']);
  await runOn(b.pc, ['ip link set eth0 up', 'ip addr add 192.168.2.10/24 dev eth0',
    'ip route add default via 192.168.2.1']);

  return { a, b };
}

function tramesWan(s: Site): IPv4Packet[] {
  return s.fw.getPacketCapture()
    .select({ iface: 'port2', filter: {}, limit: 0 })
    .map(entry => entry.frame.payload as IPv4Packet)
    .filter(packet => packet?.type === 'ipv4');
}

beforeEach(() => { Logger.reset(); });

describe('FGT-VPN-3 — le trafic traverse le tunnel', () => {
  it('un poste derriere A joint un poste derriere B', async () => {
    const { a, b } = await laboratoire();

    const sortie = await pingOnSimulatedClock(a.pc, 'ping -c 2 192.168.2.10');

    expect(sortie).toMatch(/, 0% packet loss/);
    expect(b.fw.getPacketCapture().count()).toBeGreaterThan(0);
  });

  it('ce qui sort sur le lien WAN est de l`ESP', async () => {
    const { a } = await laboratoire();

    await pingOnSimulatedClock(a.pc, 'ping -c 1 192.168.2.10');

    const esp = tramesWan(a).filter(p => p.protocol === IP_PROTO_ESP);
    expect(esp.length).toBeGreaterThan(0);
    expect(esp[0].sourceIP.toString()).toBe('203.0.113.1');
    expect(esp[0].destinationIP.toString()).toBe('203.0.113.2');
  });

  it('l`adresse interieure ne parait jamais sur le lien WAN', async () => {
    const { a } = await laboratoire();

    await pingOnSimulatedClock(a.pc, 'ping -c 1 192.168.2.10');

    const enClair = tramesWan(a).filter(
      p => p.destinationIP.toString() === '192.168.2.10'
        || p.sourceIP.toString() === '192.168.1.10');
    expect(enClair).toHaveLength(0);
  });

  it('les compteurs du tunnel sont une mesure, pas un affichage', async () => {
    const { a } = await laboratoire();

    const avant = a.sh.execute('diagnose vpn tunnel list');
    expect(avant).toMatch(/txp=0/);

    await pingOnSimulatedClock(a.pc, 'ping -c 2 192.168.2.10');

    const apres = a.sh.execute('diagnose vpn tunnel list');
    expect(apres).not.toMatch(/txp=0 /);
    expect(apres).toMatch(/name=vers_b/);
  });

  it('le tunnel passe a l`etat up quand du trafic l`emprunte', async () => {
    const { a } = await laboratoire();

    await pingOnSimulatedClock(a.pc, 'ping -c 1 192.168.2.10');

    expect(a.sh.execute('diagnose vpn tunnel summary')).toMatch(/vers_b\s+203\.0\.113\.2\s+up/);
  });

  it('sans politique du cote distant, le trafic n`arrive pas', async () => {
    const { a } = await laboratoire({ politiqueRetour: false });

    const sortie = await pingOnSimulatedClock(a.pc, 'ping -c 1 192.168.2.10');

    expect(sortie).toMatch(/, 100% packet loss/);
  });

  it('sans route vers le tunnel, rien n`est chiffre', async () => {
    const { a } = await laboratoire();
    run(a.sh, 'config router static', 'delete 1', 'end');

    await pingOnSimulatedClock(a.pc, 'ping -c 1 192.168.2.10');

    expect(tramesWan(a).filter(p => p.protocol === IP_PROTO_ESP)).toHaveLength(0);
  });

  it('une destination hors du selecteur de phase 2 n`est pas chiffree', async () => {
    const { a } = await laboratoire();
    run(a.sh,
      'config router static', 'edit 2',
      'set dst 198.51.100.0 255.255.255.0', 'set device "vers_b"', 'next', 'end');

    await pingOnSimulatedClock(a.pc, 'ping -c 1 198.51.100.10');

    const esp = tramesWan(a).filter(p => p.protocol === IP_PROTO_ESP);
    expect(esp).toHaveLength(0);
  });

  it('le retour emprunte le tunnel lui aussi', async () => {
    const { a, b } = await laboratoire();

    await pingOnSimulatedClock(a.pc, 'ping -c 1 192.168.2.10');

    const esp = tramesWan(b).filter(p => p.protocol === IP_PROTO_ESP);
    expect(esp.some(p => p.sourceIP.toString() === '203.0.113.2')).toBe(true);
  });

  it('`delete` retire la route de la table de transfert, pas seulement de la configuration', async () => {
    const { a } = await laboratoire();
    expect(a.fw.getRouteTable().all().some(r => r.iface === 'vers_b')).toBe(true);

    run(a.sh, 'config router static', 'delete 1', 'end');

    expect(a.fw.getRouteTable().all().some(r => r.iface === 'vers_b')).toBe(false);
    expect(a.sh.execute('show router static')).not.toMatch(/edit 1/);
  });

  it('changer la destination d`une route ne laisse pas l`ancienne derriere', async () => {
    const { a } = await laboratoire();
    run(a.sh,
      'config router static', 'edit 1',
      'set dst 172.16.0.0 255.255.0.0', 'next', 'end');

    const destinations = a.fw.getRouteTable().all().map(r => r.network);
    expect(destinations).toContain('172.16.0.0');
    expect(destinations).not.toContain('192.168.2.0');
  });

  it('la session ouverte cote B entre par le tunnel, pas par le port physique', async () => {
    const { a, b } = await laboratoire();

    await pingOnSimulatedClock(a.pc, 'ping -c 1 192.168.2.10');

    const sessions = b.fw.getVdom().sessions.view().all();
    expect(sessions.some(s => s.ingressInterface === 'vers_a')).toBe(true);
  });
});
