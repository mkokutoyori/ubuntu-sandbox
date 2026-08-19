/**
 * BGP sur un pare-feu : le refus de la phase 10 etait le mien, et sa
 * premisse etait fausse.
 *
 * La note disait « le moteur BGP est reel, la session TCP ne lui est pas
 * ouverte ». Mesure : le pare-feu porte un `TcpStack` depuis la phase 7,
 * et la livraison locale TCP a ete branchee en phase 8. `setWire` est un
 * port etroit d'UNE methode. Il ne manquait rien.
 *
 * Ecrite A L'AVEUGLE contre ce qu'un vrai FortiGate fait :
 *
 *   1. **La session est une VRAIE session TCP/179.** Le voisin est un
 *      routeur Cisco du depot. Si la session ne s'ouvre pas, rien ne
 *      s'apprend — aucun raccourci d'objet a objet.
 *   2. **Une route apprise est une VRAIE route** : `B` dans
 *      `get router info routing-table all`, et un paquet la suit.
 *   3. **`get router info bgp summary`** rend l'en-tete du vrai
 *      (« BGP router identifier … , local AS number … », la ligne de
 *      compte final) et une ligne par voisin.
 *   4. **Le moteur est CELUI du depot** — un second moteur donnerait
 *      deux reponses a « cette route est-elle apprise ? ».
 *
 * Comme la phase 10, le laboratoire n'a AUCUNE commande de convergence :
 * les deux bouts portent de vrais minuteurs et le test avance une
 * horloge virtuelle.
 *
 * Discrimination (`git stash push -- src/network/`) : 10 des 11 cas
 * tombent avant correctif. Le onzieme est le temoin NEGATIF (« sans BGP
 * en face »), dont c'est l'objet de passer des deux cotes.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { FortiShell } from '@/network/devices/firewall/vendors/fortios/FortiShell';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
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

async function bgpSurVoisin(voisin: CiscoRouter): Promise<void> {
  await runOn(voisin, [
    'enable', 'configure terminal', 'router bgp 65002',
    'bgp router-id 2.2.2.2',
    'neighbor 10.0.0.1 remote-as 65001',
    'network 172.16.0.0 mask 255.255.255.0', 'end',
  ]);
}

function bgpSurPareFeu(sh: FortiShell): string {
  return run(sh,
    'config router bgp',
    'set as 65001',
    'set router-id 1.1.1.1',
    'config neighbor', 'edit "10.0.0.2"', 'set remote-as 65002', 'next', 'end',
    'config network', 'edit 1', 'set prefix 192.168.1.0 255.255.255.0', 'next', 'end',
    'end');
}

beforeEach(() => { Logger.reset(); });

describe('config router bgp', () => {
  it('la configuration est acceptee et `show` la reproduit', async () => {
    const { sh } = await laboratoire();

    bgpSurPareFeu(sh);

    const rendu = sh.execute('show router bgp');
    expect(rendu).toMatch(/set as 65001/);
    expect(rendu).toMatch(/edit "10\.0\.0\.2"/);
    expect(rendu).toMatch(/set remote-as 65002/);
    expect(rendu).toMatch(/set prefix 192\.168\.1\.0 255\.255\.255\.0/);
  });

  it('un numero de systeme autonome hors bornes est refuse', async () => {
    const { sh } = await laboratoire();

    const sortie = run(sh, 'config router bgp', 'set as 4294967296');

    expect(sortie).toMatch(/value parse error before '4294967296'/);
    expect(sortie).toMatch(/Command fail\. Return code -61/);
    run(sh, 'abort');
  });

  it('un voisin sans `remote-as` est refuse au commit', async () => {
    const { sh } = await laboratoire();

    const sortie = run(sh, 'config router bgp', 'set as 65001',
      'config neighbor', 'edit "10.0.0.2"', 'next', 'end', 'end');

    expect(sortie).toMatch(/Command fail/);
    expect(sortie).toMatch(/remote-as/);
    run(sh, 'abort');
  });

  it('la session TCP/179 s`ouvre vraiment avec le voisin Cisco', async () => {
    const { sh, voisin, horloge } = await laboratoire();
    await bgpSurVoisin(voisin);
    bgpSurPareFeu(sh);

    horloge.advance(CONVERGENCE_MS);

    const vue = sh.execute('get router info bgp summary');
    expect(vue).toMatch(/BGP router identifier 1\.1\.1\.1, local AS number 65001/);
    expect(vue).toMatch(/^10\.0\.0\.2\s+4\s+65002/m);
  });

  it('le voisin Cisco voit le pare-feu etabli, pas seulement l`inverse', async () => {
    const { sh, voisin, horloge } = await laboratoire();
    await bgpSurVoisin(voisin);
    bgpSurPareFeu(sh);

    horloge.advance(CONVERGENCE_MS);

    expect(await voisin.executeCommand('show ip bgp summary'))
      .toMatch(/10\.0\.0\.1\s+4\s+65001.*Established/);
  });

  it('le prefixe distant est appris et la vue le marque `B`', async () => {
    const { fw, sh, voisin, horloge } = await laboratoire();
    await bgpSurVoisin(voisin);
    bgpSurPareFeu(sh);

    horloge.advance(CONVERGENCE_MS);

    expect(fw.getRouteTable().all().some(r => r.network === '172.16.0.0')).toBe(true);
    expect(sh.execute('get router info routing-table all'))
      .toMatch(/^B\s+172\.16\.0\.0\/24/m);
  });

  it('un paquet suit la route apprise', async () => {
    const { sh, voisin, lan, horloge } = await laboratoire();
    await bgpSurVoisin(voisin);
    bgpSurPareFeu(sh);
    horloge.advance(CONVERGENCE_MS);

    run(sh, 'config firewall policy', 'edit 1',
      'set srcintf "port1"', 'set dstintf "port2"',
      'set srcaddr "all"', 'set dstaddr "all"',
      'set action accept', 'set schedule "always"', 'set service "ALL"',
      'next', 'end');

    expect(await pingOnSimulatedClock(lan, 'ping -c 1 172.16.0.10'))
      .toMatch(/, 0% packet loss/);
  });

  it('le prefixe local est ANNONCE au voisin, pas seulement declare', async () => {
    const { sh, voisin, horloge } = await laboratoire();
    await bgpSurVoisin(voisin);
    bgpSurPareFeu(sh);

    horloge.advance(CONVERGENCE_MS);

    expect(await voisin.executeCommand('show ip route'))
      .toMatch(/192\.168\.1\.0/);
  });

  it('sans BGP en face, aucune session et rien n`est appris', async () => {
    const { fw, sh, horloge } = await laboratoire();
    bgpSurPareFeu(sh);

    horloge.advance(CONVERGENCE_MS);

    expect(fw.getRouteTable().all().some(r => r.network === '172.16.0.0')).toBe(false);
    expect(sh.execute('get router info bgp summary')).not.toMatch(/Established/);
  });

  it('`get router info bgp neighbors` decrit le voisin configure', async () => {
    const { sh, voisin, horloge } = await laboratoire();
    await bgpSurVoisin(voisin);
    bgpSurPareFeu(sh);

    horloge.advance(CONVERGENCE_MS);

    const vue = sh.execute('get router info bgp neighbors');
    expect(vue).toMatch(/BGP neighbor is 10\.0\.0\.2, remote AS 65002, local AS 65001/);
  });

  it('`unset` d`un voisin ferme sa session', async () => {
    const { sh, voisin, horloge } = await laboratoire();
    await bgpSurVoisin(voisin);
    bgpSurPareFeu(sh);
    horloge.advance(CONVERGENCE_MS);

    expect(sh.execute('get router info bgp summary')).toMatch(/Established|00:00/);

    run(sh, 'config router bgp', 'config neighbor', 'delete "10.0.0.2"', 'end', 'end');
    horloge.advance(CONVERGENCE_MS);

    expect(sh.execute('get router info bgp summary')).not.toMatch(/^10\.0\.0\.2\s/m);
    expect(sh.execute('get router info bgp summary')).toMatch(/Total number of neighbors 0/);
  });
});
