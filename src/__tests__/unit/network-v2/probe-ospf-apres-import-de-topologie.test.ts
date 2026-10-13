/**
 * Mesure de depart (suite du lab « Akwa ») : importer une topologie rejoue la configuration
 * appareil par appareil, dans l'ordre du fichier. Les routeurs y precedent le commutateur, donc
 * la convergence OSPF declenchee par leurs commandes `network` s'execute AVANT que le trunk et
 * le VLAN de transit du commutateur existent : les Hello partent dans le vide. Rien ne la
 * rejoue ensuite, et le lab importe reste a « RT01 voit Akwa en INIT, Akwa ne voit personne »
 * jusqu'a ce que l'horloge de simulation ait avance de 10 a 20 s, ou qu'un `no shutdown` relance
 * la convergence a la main. Un reseau reel ne depend pas de l'ordre dans lequel on branche ses
 * equipements : une fois tout en place, les voisins se forment.
 *
 * Laboratoire : celui de probe-ospf-sur-sous-interface-dot1q (R1, commutateur, R2 en
 * router-on-a-stick), exporte avec les routeurs AVANT le commutateur puis reimporte dans un
 * registre vide, horloge de simulation installee et non avancee, entree du commutateur sans la liste
 * `switchports` (comme dans le fichier de l'utilisateur, ou le trunk et le VLAN d'acces ne vivent
 * que dans le texte de configuration rejoue en dernier). Sur les cinq cas, quatre tombent avant
 * la correction ; le temoin « le lab source est FULL avant export » passe dans les deux etats et
 * prouve que l'export decrit un reseau sain. La correction : `importTopology` fait reconverger
 * chaque routeur une fois toute la configuration rejouee (`Router.reconvergeRouting`).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { LinuxPC } from '@/network/devices/LinuxPC';
import type { Equipment } from '@/network/equipment/Equipment';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { buildConnection } from '@/store/networkStore';
import { exportTopology, importTopology } from '@/store/topologySerializer';
import { SimulationClock, installSimulationClock, __resetSimulationClock } from '@/events/SimulationClock';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

interface Cmd { executeCommand(cmd: string): Promise<string> }
const run = async (d: Cmd, cmds: string[]) => { for (const c of cmds) await d.executeCommand(c); };

let clock: SimulationClock;
let imported: Map<string, Equipment>;
let source: { r1: CiscoRouter; r2: CiscoRouter };

const named = (name: string) => [...imported.values()].find((d) => d.getName() === name) as unknown as
  Cmd & { getName(): string };

async function buildAndReimport(): Promise<void> {
  const r1 = new CiscoRouter('R1', 0, 0);
  const r2 = new CiscoRouter('R2', 0, 0);
  const sw = new CiscoSwitch('switch-cisco', 'SW', 26, 0, 0);
  const h1 = new LinuxPC('linux-pc', 'H1', 0, 0);
  const h2 = new LinuxPC('linux-pc', 'H2', 0, 0);
  const connections = [
    buildConnection(h1, 'eth0', r1, 'GigabitEthernet0/0', 'ethernet'),
    buildConnection(r1, 'GigabitEthernet0/1', sw, 'FastEthernet0/1', 'ethernet'),
    buildConnection(r2, 'GigabitEthernet0/0', sw, 'FastEthernet0/2', 'ethernet'),
    buildConnection(h2, 'eth0', sw, 'FastEthernet0/3', 'ethernet'),
  ].filter((c) => c !== null);

  await run(sw, ['enable', 'configure terminal', 'vlan 30', 'exit', 'vlan 99', 'exit',
    'interface FastEthernet0/1', 'switchport mode access', 'switchport access vlan 99', 'exit',
    'interface FastEthernet0/2', 'switchport trunk encapsulation dot1q', 'switchport mode trunk',
    'switchport trunk allowed vlan 30,99', 'exit',
    'interface FastEthernet0/3', 'switchport mode access', 'switchport access vlan 30', 'exit', 'end']);
  await run(r1, ['enable', 'configure terminal',
    'interface GigabitEthernet0/0', 'ip address 192.168.10.1 255.255.255.0', 'no shutdown', 'exit',
    'interface GigabitEthernet0/1', 'ip address 10.0.20.1 255.255.255.0', 'no shutdown', 'exit',
    'router ospf 1', 'router-id 1.1.1.1',
    'network 192.168.10.0 0.0.0.255 area 0', 'network 10.0.20.0 0.0.0.255 area 0', 'end']);
  await run(r2, ['enable', 'configure terminal',
    'interface GigabitEthernet0/0', 'no ip address', 'no shutdown', 'exit',
    'interface GigabitEthernet0/0.99', 'encapsulation dot1Q 99', 'ip address 10.0.20.2 255.255.255.0', 'exit',
    'interface GigabitEthernet0/0.30', 'encapsulation dot1Q 30', 'ip address 192.168.50.1 255.255.255.0', 'exit',
    'router ospf 1', 'router-id 2.2.2.2',
    'network 192.168.50.0 0.0.0.255 area 0', 'network 10.0.20.0 0.0.0.255 area 0', 'end']);
  await run(h1, ['ip link set eth0 up', 'ip addr add 192.168.10.2/24 dev eth0', 'ip route add default via 192.168.10.1']);
  await run(h2, ['ip link set eth0 up', 'ip addr add 192.168.50.2/24 dev eth0', 'ip route add default via 192.168.50.1']);
  await clock.advance(30_000);
  source = { r1, r2 };

  const ordered = new Map<string, Equipment>([r1, r2, sw, h1, h2].map((d) => [d.getId(), d]));
  const exported = exportTopology('lab', ordered, connections);
  const switchEntry = exported.devices.find((d) => d.name === 'SW')!;
  delete switchEntry.switchports;
  EquipmentRegistry.resetInstance();
  __resetSimulationClock();
  clock = installSimulationClock(new SimulationClock());
  imported = (await importTopology(JSON.parse(JSON.stringify(exported)))).deviceInstances;
}

beforeEach(async () => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
  EquipmentRegistry.resetInstance();
  clock = installSimulationClock(new SimulationClock());
  await buildAndReimport();
});

afterEach(() => { __resetSimulationClock(); });

describe('OSPF after a topology import (routers replayed before the switch)', () => {
  it('witness: the source lab was Full before it was exported', async () => {
    expect(await source.r2.executeCommand('show ip ospf neighbor')).toMatch(/FULL.*GigabitEthernet0\/0\.99/);
  });

  it('R2 is Full with R1 as soon as the import returns', async () => {
    expect(await named('R2').executeCommand('show ip ospf neighbor')).toMatch(/FULL.*GigabitEthernet0\/0\.99/);
  });

  it('R1 sees R2 Full, not INIT', async () => {
    const neighbors = await named('R1').executeCommand('show ip ospf neighbor');
    expect(neighbors).toMatch(/FULL.*GigabitEthernet0\/1/);
    expect(neighbors).not.toMatch(/INIT|EXSTART/);
  });

  it('R2 holds the head-office route as soon as the import returns', async () => {
    expect(await named('R2').executeCommand('show ip route')).toMatch(/O\s+192\.168\.10\.0\/24/);
  });

  it('the branch host reaches the head-office host without any simulated time', async () => {
    expect(await named('H2').executeCommand('ping -c 1 192.168.10.2')).toContain('1 received');
  });
});
