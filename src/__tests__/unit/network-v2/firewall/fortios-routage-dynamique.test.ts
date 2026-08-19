/**
 * RIP et OSPF sur un pare-feu : les moteurs du depot, tels quels.
 *
 * Une note de perimetre attribuait au BRD §22.3 un refus de ces deux
 * protocoles au motif d'un couplage a la classe `Router`. §22.3 ne dit
 * rien de tel (elle traite du partage entre VDOM) et §19.3 disait deja
 * l'inverse : « les moteurs existent, le travail est de les brancher ».
 * La mesure le confirme : `OSPFEngine` se construit avec un numero de
 * processus et parle au fil par un `setSendCallback`, et `RIPEngine` se
 * construit avec une interface `RIPCallbacks` qui EST deja un port
 * etroit. Ce qui est propre a `Router`, c'est la GLU d'integration — et
 * un pare-feu a besoin de la sienne, pas d'un decouplage.
 *
 * Ecrite A L'AVEUGLE contre ce qu'un vrai FortiGate fait :
 *
 *   1. **Une route apprise est une VRAIE route** : elle parait dans
 *      `get router info routing-table all` sous son code de protocole,
 *      et un paquet la suit.
 *   2. **Les paquets traversent le fil** : le voisin est un routeur
 *      Cisco du depot, pas un second pare-feu complaisant. Si les deux
 *      bouts parlent le meme protocole pour de bon, l'adjacence se
 *      forme ; sinon rien ne se passe.
 *   3. **Le moteur est CELUI du depot.** Un second moteur donnerait deux
 *      reponses possibles a « cette route est-elle apprise ? ».
 *   4. **BGP n'est plus refuse.** La note de cette phase disait « la
 *      session TCP ne lui est pas ouverte » ; c'etait faux, le pare-feu
 *      porte un `TcpStack` depuis la phase 7. Voir `fortios-bgp.test.ts`.
 *
 * Discrimination (`git stash push -- src/network/`) : 11 des 15 cas
 * tombent avant correctif. Les 4 autres sont nommes ici plutot que
 * laisses a decouvrir — deux sont les temoins NEGATIFS (« sans RIP en
 * face », « sans OSPF en face »), dont c'est l'objet de passer des deux
 * cotes ; le cas BGP restant porte sur la phase 11 et non sur
 * celle-ci.
 *
 * Le laboratoire n'a AUCUNE commande de convergence : les deux bouts
 * portent de vrais minuteurs, et le test avance une horloge virtuelle.
 * Un `convergeDynamicRouting()` — qu'un vrai FortiGate n'a pas — aurait
 * cache le seul defaut qui comptait : sans minuteur qui tourne, une
 * adjacence ne se forme pas, et une commande qui la forme quand meme ne
 * mesure que sa propre complaisance.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { FortiShell } from '@/network/devices/firewall/vendors/fortios/FortiShell';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress, IP_PROTO_OSPF } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { VirtualTimeScheduler, __setDefaultScheduler } from '@/events/Scheduler';
import { pingOnSimulatedClock } from '../../../support/fastPing';

interface Cmd { executeCommand(cmd: string): Promise<string> }

const runOn = (d: Cmd, cmds: string[]) =>
  cmds.reduce(async (p, c) => { await p; await d.executeCommand(c); }, Promise.resolve<unknown>(undefined));

function run(sh: FortiShell, ...lines: string[]): string {
  let last = '';
  for (const line of lines) last = sh.execute(line);
  return last;
}

const CONVERGENCE_MS = 45_000;

function trames(fw: FortiGate, protocole: number, port?: number): number {
  return fw.getPacketCapture().select({ iface: 'any', filter: {}, limit: 0 })
    .filter(entree => entree.direction === 'out')
    .filter(entree => {
      const paquet = entree.frame.payload as {
        type?: string; protocol?: number; payload?: { destinationPort?: number };
      } | undefined;
      if (paquet?.type !== 'ipv4' || paquet.protocol !== protocole) return false;
      return port === undefined || paquet.payload?.destinationPort === port;
    }).length;
}

async function laboratoire() {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
  const horloge = new VirtualTimeScheduler();
  __setDefaultScheduler(horloge);

  const fw = new FortiGate('firewall-fortinet', 'FGT', 0, 0);
  const sh = new FortiShell(fw);
  const voisin = new CiscoRouter('R1', 200, 0);
  const lan = new LinuxPC('linux-pc', 'LAN', -150, 0);
  const distant = new LinuxPC('linux-pc', 'DISTANT', 350, 0);

  new Cable('lan').connect(lan.getPort('eth0')!, fw.getPort('port1')!);
  new Cable('transit').connect(
    fw.getPort('port2')!, voisin.getPort('GigabitEthernet0/0')!);
  new Cable('distant').connect(
    voisin.getPort('GigabitEthernet0/1')!, distant.getPort('eth0')!);

  run(sh,
    'config system interface',
    'edit "port1"', 'set mode static',
    'set ip 192.168.1.1 255.255.255.0', 'set allowaccess ping', 'next',
    'edit "port2"', 'set mode static',
    'set ip 10.0.0.1 255.255.255.0', 'set allowaccess ping', 'next', 'end');

  await runOn(voisin, [
    'enable', 'configure terminal',
    'interface GigabitEthernet0/0', 'ip address 10.0.0.2 255.255.255.0',
    'no shutdown', 'exit',
    'interface GigabitEthernet0/1', 'ip address 172.16.0.1 255.255.255.0',
    'no shutdown', 'exit', 'end',
  ]);

  await runOn(lan, ['ip link set eth0 up', 'ip addr add 192.168.1.10/24 dev eth0',
    'ip route add default via 192.168.1.1']);
  await runOn(distant, ['ip link set eth0 up', 'ip addr add 172.16.0.10/24 dev eth0',
    'ip route add default via 172.16.0.1']);

  return { fw, sh, voisin, lan, distant, horloge };
}

async function ripSurVoisin(voisin: CiscoRouter): Promise<void> {
  await runOn(voisin, [
    'enable', 'configure terminal', 'router rip', 'version 2',
    'network 10.0.0.0', 'network 172.16.0.0', 'no auto-summary', 'end',
  ]);
}

async function ospfSurVoisin(voisin: CiscoRouter): Promise<void> {
  await runOn(voisin, [
    'enable', 'configure terminal', 'router ospf 1', 'router-id 2.2.2.2',
    'network 10.0.0.0 0.0.0.255 area 0',
    'network 172.16.0.0 0.0.0.255 area 0', 'end',
  ]);
}

function ripSurPareFeu(sh: FortiShell): string {
  return run(sh,
    'config router rip',
    'set version 2',
    'config network', 'edit 1', 'set prefix 10.0.0.0 255.255.255.0', 'next',
    'edit 2', 'set prefix 192.168.1.0 255.255.255.0', 'next', 'end',
    'end');
}

function ospfSurPareFeu(sh: FortiShell): string {
  return run(sh,
    'config router ospf',
    'set router-id 1.1.1.1',
    'config area', 'edit 0.0.0.0', 'next', 'end',
    'config network',
    'edit 1', 'set prefix 10.0.0.0 255.255.255.0', 'set area 0.0.0.0', 'next',
    'edit 2', 'set prefix 192.168.1.0 255.255.255.0', 'set area 0.0.0.0', 'next',
    'end',
    'end');
}

beforeEach(() => { Logger.reset(); });

describe('config router rip', () => {
  it('la configuration est acceptee et `show` la reproduit', async () => {
    const { sh } = await laboratoire();

    ripSurPareFeu(sh);

    const rendu = sh.execute('show router rip');
    expect(rendu).toMatch(/set version 2/);
    expect(rendu).toMatch(/set prefix 10\.0\.0\.0 255\.255\.255\.0/);
  });

  it('de vraies trames RIP partent sur le fil', async () => {
    const { fw, sh, voisin, horloge } = await laboratoire();
    await ripSurVoisin(voisin);
    ripSurPareFeu(sh);

    horloge.advance(CONVERGENCE_MS);

    expect(trames(fw, 17, 520)).toBeGreaterThan(0);
  });

  it('le prefixe distant est appris et parait dans la table', async () => {
    const { fw, sh, voisin, horloge } = await laboratoire();
    await ripSurVoisin(voisin);
    ripSurPareFeu(sh);

    horloge.advance(CONVERGENCE_MS);

    expect(fw.getRouteTable().all().some(r => r.network === '172.16.0.0')).toBe(true);
  });

  it('la vue de routage la marque `R`', async () => {
    const { sh, voisin, horloge } = await laboratoire();
    await ripSurVoisin(voisin);
    ripSurPareFeu(sh);

    horloge.advance(CONVERGENCE_MS);

    expect(sh.execute('get router info routing-table all'))
      .toMatch(/^R\s+172\.16\.0\.0\/24/m);
  });

  it('sans RIP en face, rien n`est appris', async () => {
    const { fw, sh, horloge } = await laboratoire();
    ripSurPareFeu(sh);

    horloge.advance(CONVERGENCE_MS);

    expect(fw.getRouteTable().all().some(r => r.network === '172.16.0.0')).toBe(false);
  });
});

describe('config router ospf', () => {
  it('la configuration est acceptee et `show` la reproduit', async () => {
    const { sh } = await laboratoire();

    ospfSurPareFeu(sh);

    const rendu = sh.execute('show router ospf');
    expect(rendu).toMatch(/set router-id 1\.1\.1\.1/);
    expect(rendu).toMatch(/edit 0\.0\.0\.0/);
  });

  it('un identifiant de routeur nul est refuse', async () => {
    const { sh } = await laboratoire();

    const sortie = run(sh, 'config router ospf', 'set router-id 0.0.0.0', 'end');

    expect(sortie).toMatch(/Command fail|Invalid/);
    run(sh, 'abort');
  });

  it('de vraies trames OSPF partent sur le fil', async () => {
    const { fw, sh, voisin, horloge } = await laboratoire();
    await ospfSurVoisin(voisin);
    ospfSurPareFeu(sh);

    horloge.advance(CONVERGENCE_MS);

    expect(trames(fw, IP_PROTO_OSPF)).toBeGreaterThan(0);
  });

  it('l`adjacence se forme avec le voisin Cisco', async () => {
    const { sh, voisin, horloge } = await laboratoire();
    await ospfSurVoisin(voisin);
    ospfSurPareFeu(sh);

    horloge.advance(CONVERGENCE_MS);

    const vue = sh.execute('get router info ospf neighbor');
    expect(vue).toMatch(/2\.2\.2\.2/);
    expect(vue).toMatch(/Full/);
  });

  it('le voisin Cisco voit le pare-feu, pas seulement l`inverse', async () => {
    const { voisin, sh, horloge } = await laboratoire();
    await ospfSurVoisin(voisin);
    ospfSurPareFeu(sh);

    horloge.advance(CONVERGENCE_MS);

    expect(await voisin.executeCommand('show ip ospf neighbor'))
      .toMatch(/1\.1\.1\.1\s+\d+\s+FULL/);
  });

  it('le prefixe distant est appris et la vue le marque `O`', async () => {
    const { fw, sh, voisin, horloge } = await laboratoire();
    await ospfSurVoisin(voisin);
    ospfSurPareFeu(sh);

    horloge.advance(CONVERGENCE_MS);

    expect(fw.getRouteTable().all().some(r => r.network === '172.16.0.0')).toBe(true);
    expect(sh.execute('get router info routing-table all'))
      .toMatch(/^O\s+172\.16\.0\.0\/24/m);
  });

  it('un paquet suit la route apprise', async () => {
    const { sh, voisin, lan, horloge } = await laboratoire();
    await ospfSurVoisin(voisin);
    ospfSurPareFeu(sh);
    horloge.advance(CONVERGENCE_MS);

    run(sh, 'config firewall policy', 'edit 1',
      'set srcintf "port1"', 'set dstintf "port2"',
      'set srcaddr "all"', 'set dstaddr "all"',
      'set action accept', 'set schedule "always"', 'set service "ALL"',
      'next', 'end');

    expect(await pingOnSimulatedClock(lan, 'ping -c 1 172.16.0.10'))
      .toMatch(/, 0% packet loss/);
  });

  it('sans OSPF en face, aucune adjacence', async () => {
    const { sh, horloge } = await laboratoire();
    ospfSurPareFeu(sh);

    horloge.advance(CONVERGENCE_MS);

    expect(sh.execute('get router info ospf neighbor')).not.toMatch(/Full/);
  });
});

describe('BGP n`est plus refuse — voir fortios-bgp.test.ts', () => {
  it('`config router bgp` est accepte', async () => {
    const { sh } = await laboratoire();

    const sortie = run(sh, 'config router bgp', 'set as 65001', 'end');

    expect(sortie).not.toMatch(/Command fail/);
    expect(sh.execute('show router bgp')).toMatch(/set as 65001/);
  });
});
