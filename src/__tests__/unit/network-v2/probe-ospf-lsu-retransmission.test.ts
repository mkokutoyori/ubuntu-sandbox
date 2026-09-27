/**
 * Une LSU perdue sur le fil est retransmise jusqu'a son acquittement, et
 * le moteur OSPF compte le temps sur l'horloge du simulateur.
 *
 * Mesure de depart (ca2505cc), routeur Cisco R1 adjacent a une FortiGate
 * sur port2 : un reseau ajoute sur R1 apres l'adjacence (Loopback2 et
 * `network`) n'atteignait jamais la table de la FortiGate. R1 plaçait ses
 * LSA sur la liste de retransmission du voisin sans jamais armer de
 * minuterie : une LSU perdue, ou ecartee par MinLSArrival chez le
 * recepteur, n'etait jamais renvoyee, et `ip ospf retransmit-interval`
 * etait garde sans rien regler. Un acquittement retirait de la liste
 * toutes les instances d'une LSA, meme plus recentes que celle acquittee,
 * et un doublon recu n'etait ni un acquittement implicite ni acquitte.
 * MinLSArrival, MinLSInterval, le compte a rebours du voisin, l'horodatage
 * des captures et le delai de propagation lisaient l'horloge murale, si
 * bien qu'une seconde de temps simule ne comptait pas. `show ip ospf
 * neighbor detail` affichait « number of retransmission 0 » en dur,
 * `show ip ospf retransmission-list` et `request-list` un tableau invente,
 * et `display ospf retrans-queue` / `request-queue` repondaient toujours
 * « queue is empty ». Cote VRP, `network` n'activait OSPF sur aucune
 * interface — un routeur Huawei face a la FortiGate restait muet — et
 * `area 0` etait garde tel quel au lieu de l'identifiant 0.0.0.0.
 *
 * Autorites :
 * - RFC 2328 §13 etape 5(a) (MinLSArrival), 5(c) (l'ancienne instance
 *   quitte toutes les listes de retransmission), 7(a) (acquittement
 *   implicite), §13.5 (acquittement direct d'un doublon), §13.6 (LSU
 *   retransmise en unicast toutes les RxmtInterval jusqu'a
 *   l'acquittement), §13.7 (un acquittement ne retire que la meme
 *   instance), §A.3.1 (l'Area ID est un champ de 32 bits) ;
 * - Cisco IOS OSPF Command Reference, `show ip ospf neighbor detail`
 *   (« number of retransmission » : nombre de fois ou des LSU ont ete
 *   renvoyees ; « Last retransmission scan length » : nombre de LSA du
 *   dernier paquet de retransmission) et `show ip ospf
 *   retransmission-list` / `request-list` (exemples de sortie) ;
 * - Huawei, `display ospf retrans-queue` et `display ospf request-queue`
 *   (exemples de sortie).
 *
 * Discrimination, mesuree sur le commit de base (ca2505cc) avec ce
 * fichier copie : 13 des 15 cas tombent. Passent des deux cotes les
 * TEMOINS : l'adjacence apprend Loopback1 a la FortiGate, et la LSU
 * perdue ne l'atteint pas tant que l'intervalle de retransmission n'est
 * pas ecoule.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { Cable } from '@/network/hardware/Cable';
import { VirtualTimeScheduler, __setDefaultScheduler } from '@/events/Scheduler';
import { OspfCaptureActor } from '@/network/ospf/actors';

interface Shell { executeCommand(command: string): Promise<string> }

async function type(device: Shell, commands: readonly string[]): Promise<void> {
  for (const command of commands) await device.executeCommand(command);
}

let clock: VirtualTimeScheduler;

beforeEach(() => {
  clock = new VirtualTimeScheduler();
  __setDefaultScheduler(clock);
});

async function fortigateOnPort2(): Promise<FortiGate> {
  const firewall = new FortiGate('firewall-fortinet', 'FGT', 0, 0);
  await type(firewall, ['config system interface',
    'edit port2', 'set ip 10.1.0.1 255.255.255.0', 'set allowaccess ping', 'next', 'end',
    'config router ospf', 'set router-id 1.1.1.1', 'config area', 'edit 0.0.0.0', 'next', 'end',
    'config network', 'edit 1', 'set prefix 10.1.0.0 255.255.255.0', 'set area 0.0.0.0', 'next', 'end', 'end']);
  return firewall;
}

async function ciscoAdjacency() {
  const neighbour = new CiscoRouter('R1', 0, 0);
  const firewall = await fortigateOnPort2();
  const link = new Cable('transit');
  link.connect(firewall.getPort('port2')!, neighbour.getPort('GigabitEthernet0/1')!);
  await type(neighbour, ['enable', 'configure terminal',
    'interface GigabitEthernet0/1', 'ip address 10.1.0.2 255.255.255.0', 'no shutdown', 'exit',
    'interface Loopback1', 'ip address 172.20.0.1 255.255.255.0', 'exit',
    'router ospf 1', 'router-id 2.2.2.2',
    'network 10.1.0.0 0.0.0.255 area 0', 'network 172.20.0.0 0.0.0.255 area 0', 'end']);
  clock.advance(60_000);
  const announceLoopback2 = async () => {
    link.setPacketLossRate(1);
    await type(neighbour, ['configure terminal',
      'interface Loopback2', 'ip address 172.21.0.1 255.255.255.0', 'exit',
      'router ospf 1', 'network 172.21.0.0 0.0.0.255 area 0', 'end']);
    link.setPacketLossRate(0);
  };
  return { firewall, neighbour, announceLoopback2 };
}

async function huaweiAdjacency() {
  const neighbour = new HuaweiRouter('AR1', 0, 0);
  const firewall = await fortigateOnPort2();
  const link = new Cable('transit');
  link.connect(firewall.getPort('port2')!, neighbour.getPort('GE0/0/0')!);
  await type(neighbour, ['system-view',
    'interface GigabitEthernet0/0/0', 'ip address 10.1.0.2 255.255.255.0', 'undo shutdown', 'quit',
    'ospf 1 router-id 3.3.3.3', 'area 0', 'network 10.1.0.0 0.0.0.255', 'quit', 'quit', 'return']);
  clock.advance(60_000);
  const announceLoopback2 = async () => {
    link.setPacketLossRate(1);
    await type(neighbour, ['system-view',
      'interface LoopBack2', 'ip address 172.21.0.1 255.255.255.0', 'quit',
      'ospf 1', 'area 0', 'network 172.21.0.0 0.0.0.255', 'quit', 'quit', 'return']);
    link.setPacketLossRate(0);
  };
  return { firewall, neighbour, announceLoopback2 };
}

const ospfRoutes = (firewall: FortiGate) => firewall.executeCommand('get router info routing-table ospf');

describe('an LSU lost on the wire is retransmitted until acknowledged', () => {
  it('WITNESS: the adjacency teaches Loopback1 to the FortiGate', async () => {
    const { firewall } = await ciscoAdjacency();
    expect(await ospfRoutes(firewall)).toContain('172.20.0.1/32');
  });

  it('WITNESS: the lost LSU does not reach the FortiGate before RxmtInterval', async () => {
    const { firewall, announceLoopback2 } = await ciscoAdjacency();
    await announceLoopback2();
    clock.advance(4_000);
    expect(await ospfRoutes(firewall)).not.toContain('172.21.0.1/32');
  });

  it('the Cisco neighbour resends it once RxmtInterval elapses', async () => {
    const { firewall, announceLoopback2 } = await ciscoAdjacency();
    await announceLoopback2();
    clock.advance(6_000);
    expect(await ospfRoutes(firewall)).toContain('O       172.21.0.1/32 [110/1] via 10.1.0.2, port2');
  });

  it('ip ospf retransmit-interval decides how soon the lost LSU is resent', async () => {
    const { firewall, neighbour, announceLoopback2 } = await ciscoAdjacency();
    await type(neighbour, ['configure terminal',
      'interface GigabitEthernet0/1', 'ip ospf retransmit-interval 2', 'end']);
    await announceLoopback2();
    clock.advance(1_500);
    expect(await ospfRoutes(firewall)).not.toContain('172.21.0.1/32');
    clock.advance(1_000);
    expect(await ospfRoutes(firewall)).toContain('172.21.0.1/32');
  });

  it('the Huawei neighbour resends it once RxmtInterval elapses', async () => {
    const { firewall, announceLoopback2 } = await huaweiAdjacency();
    await announceLoopback2();
    clock.advance(6_000);
    expect(await ospfRoutes(firewall)).toContain('172.21.0.1/32');
  });
});

describe('a VRP network statement runs OSPF on the interfaces it covers', () => {
  it('the adjacency with the FortiGate comes up without any other command', async () => {
    const { firewall } = await huaweiAdjacency();
    expect(await firewall.executeCommand('get router info ospf neighbor')).toMatch(/3\.3\.3\.3 +1 +Full/);
  });

  it('area 0 is kept as the 32-bit area 0.0.0.0', async () => {
    const { neighbour } = await huaweiAdjacency();
    expect(await neighbour.executeCommand('display ospf lsdb')).toContain('Area: 0.0.0.0');
  });
});

describe('OSPF counts time on the simulator clock', () => {
  it('the neighbour dead time counts down as simulated seconds pass', async () => {
    const { neighbour } = await ciscoAdjacency();
    clock.advance(7_000);
    expect(await neighbour.executeCommand('show ip ospf neighbor')).toMatch(/1\.1\.1\.1 .* 00:00:33 +10\.1\.0\.1/);
  });

  it('a packet capture is stamped with the simulated time', async () => {
    const { neighbour } = await ciscoAdjacency();
    const capture = new OspfCaptureActor(neighbour.getBus());
    capture.start();
    clock.advance(10_000);
    expect(capture.size()).toBeGreaterThan(0);
    expect(capture.getCapture().every(({ timestamp }) => timestamp > 60_000 && timestamp <= 70_000)).toBe(true);
  });

  it('a propagation delay holds the resent LSU for simulated milliseconds', async () => {
    const { firewall, neighbour, announceLoopback2 } = await ciscoAdjacency();
    await announceLoopback2();
    neighbour._getOSPFEngineInternal()!.getInterface('GigabitEthernet0/1')!.propagationDelayMs = 3_000;
    clock.advance(6_000);
    expect(await ospfRoutes(firewall)).not.toContain('172.21.0.1/32');
    clock.advance(3_000);
    expect(await ospfRoutes(firewall)).toContain('172.21.0.1/32');
  });
});

describe('the retransmission list is what every view shows', () => {
  it('show ip ospf retransmission-list lists the pending router-LSA in the IOS layout', async () => {
    const { neighbour, announceLoopback2 } = await ciscoAdjacency();
    await announceLoopback2();
    clock.advance(1_500);
    const list = await neighbour.executeCommand('show ip ospf retransmission-list');
    expect(list).toContain('  Neighbor 1.1.1.1, interface GigabitEthernet0/1 address 10.1.0.1');
    expect(list).toMatch(/ {2}Link state retransmission due in 3500 msec, Queue length \d+/);
    expect(list).toContain('  Type  LS ID             ADV RTR           Seq NO      Age    Checksum');
    expect(list).toMatch(/\n {5}1 {2}2\.2\.2\.2 {11}2\.2\.2\.2 {11}0x8000[0-9A-F]{4} {2}/);
  });

  it('the list empties once the FortiGate acknowledges the retransmission', async () => {
    const { neighbour, announceLoopback2 } = await ciscoAdjacency();
    await announceLoopback2();
    clock.advance(6_000);
    expect(await neighbour.executeCommand('show ip ospf retransmission-list'))
      .toBe('\n            OSPF Router with ID (2.2.2.2) (Process ID 1)\n');
  });

  it('show ip ospf neighbor detail counts the resent update packets', async () => {
    const { neighbour, announceLoopback2 } = await ciscoAdjacency();
    await announceLoopback2();
    clock.advance(6_000);
    const detail = await neighbour.executeCommand('show ip ospf neighbor detail');
    expect(detail).toMatch(/number of retransmission [1-9]\d*/);
    expect(detail).toMatch(/Last retransmission scan length is [1-9]\d*, maximum is [1-9]\d*/);
  });

  it('display ospf retrans-queue lists the pending router-LSA in the VRP layout', async () => {
    const { neighbour, announceLoopback2 } = await huaweiAdjacency();
    await announceLoopback2();
    const queue = await neighbour.executeCommand('display ospf retrans-queue');
    expect(queue).toContain('                 OSPF Retransmit List');
    expect(queue).toContain("  The Router's Neighbor is Router ID 1.1.1.1  Address 10.1.0.1");
    expect(queue).toContain('  Interface 10.1.0.2         Area 0.0.0.0');
    expect(queue).toMatch(/\n {7}Router {5}3\.3\.3\.3 {11}3\.3\.3\.3 {11}8000[0-9a-f]{4} {3}\d+/);
  });

  it('show ip ospf request-list keeps the IOS header when nothing is requested', async () => {
    const { neighbour } = await ciscoAdjacency();
    expect(await neighbour.executeCommand('show ip ospf request-list'))
      .toBe('\n            OSPF Router with ID (2.2.2.2) (Process ID 1)\n');
  });
});
