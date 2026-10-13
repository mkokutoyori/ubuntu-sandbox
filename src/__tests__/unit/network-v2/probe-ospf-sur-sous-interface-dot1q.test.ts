/**
 * Mesure de depart (laboratoire « Akwa » d'un utilisateur) : un routeur de succursale porte ses
 * VLAN sur des sous-interfaces dot1Q d'un seul port physique, dont une, `.99`, est le VLAN de
 * transit vers le routeur central. La configuration est correcte, et pourtant OSPF ne formait
 * jamais l'adjacence : le central voyait la succursale en INIT, la succursale ne voyait personne,
 * et un PC de la succursale recevait « Destination net unreachable » de sa passerelle.
 *
 * Cause : une sous-interface dot1Q n'a pas de cable — le cable est au port physique parent. Deux
 * lecteurs la jugeaient pourtant sur son propre cable. `RouterOSPFIntegration.isCabled` la
 * classait « virtuelle » (reservee aux tunnels) et ne lui envoyait donc aucun Hello filaire ;
 * `Router` refusait d'emettre un ping, un paquet IPv4 ou un sondage IP SLA depuis une
 * sous-interface parce que SON port n'avait pas de porteuse, la ou `iosInterfaceStatus` sait
 * deja la lire sur le parent (`carrierBearer`). Les deux lisent maintenant la porteuse du parent.
 *
 * Laboratoire : R1 (Gi0/0 LAN 192.168.10.0/24, Gi0/1 10.0.20.1/24 en acces VLAN 99), un
 * commutateur (Fa0/1 acces 99, Fa0/2 trunk 30,99, Fa0/3 acces 30), R2 (Gi0/0.99 10.0.20.2/24,
 * Gi0/0.30 192.168.50.1/24) et un PC de chaque cote, horloge de simulation installee comme
 * l'application le fait. Sur les huit cas, deux tombent avant la correction : le ping emis depuis la
 * sous-interface de R2 et l'adjacence deja FULL des la derniere commande `network`. Les six autres
 * passent dans les deux etats : le temoin « R1 joint R2 en 10.0.20.2 » prouve que le trunk, le
 * VLAN 99 et le cablage sont sains, et les Hello periodiques de l'horloge de simulation finissent
 * par former l'adjacence meme sans la correction, au bout de 10 a 20 s simulees (non-regression).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { SimulationClock, installSimulationClock, __resetSimulationClock } from '@/events/SimulationClock';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

interface Cmd { executeCommand(cmd: string): Promise<string> }
const run = async (d: Cmd, cmds: string[]) => { for (const c of cmds) await d.executeCommand(c); };

let clock: SimulationClock;
let r1: CiscoRouter;
let r2: CiscoRouter;
let h1: LinuxPC;
let h2: LinuxPC;

beforeEach(async () => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
  clock = installSimulationClock(new SimulationClock());
  r1 = new CiscoRouter('R1', 0, 0);
  r2 = new CiscoRouter('R2', 0, 0);
  const sw = new CiscoSwitch('switch-cisco', 'SW', 26, 0, 0);
  h1 = new LinuxPC('linux-pc', 'H1', 0, 0);
  h2 = new LinuxPC('linux-pc', 'H2', 0, 0);
  new Cable('h1').connect(h1.getPort('eth0')!, r1.getPort('GigabitEthernet0/0')!);
  new Cable('r1').connect(r1.getPort('GigabitEthernet0/1')!, sw.getPort('FastEthernet0/1')!);
  new Cable('r2').connect(r2.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/2')!);
  new Cable('h2').connect(h2.getPort('eth0')!, sw.getPort('FastEthernet0/3')!);

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
});

afterEach(() => { __resetSimulationClock(); });

describe('OSPF through a router-on-a-stick transit VLAN', () => {
  it('witness: R1 reaches the branch subinterface across the trunk', async () => {
    expect(await r1.executeCommand('ping 10.0.20.2')).toContain('!!!!');
  });

  it('R2 reaches R1 from its own subinterface', async () => {
    expect(await r2.executeCommand('ping 10.0.20.1')).toContain('!!!!');
  });

  it('the adjacency is already Full when the last network statement is typed, before any simulated time', async () => {
    expect(await r2.executeCommand('show ip ospf neighbor')).toMatch(/FULL.*GigabitEthernet0\/0\.99/);
  });

  it('R2 forms a Full adjacency with R1 on the subinterface', async () => {
    await clock.advance(30_000);
    const neighbors = await r2.executeCommand('show ip ospf neighbor');
    expect(neighbors).toMatch(/1\.1\.1\.1|10\.0\.20\.1/);
    expect(neighbors).toMatch(/FULL.*GigabitEthernet0\/0\.99/);
  });

  it('R1 sees R2 Full, not stuck in INIT', async () => {
    await clock.advance(30_000);
    const neighbors = await r1.executeCommand('show ip ospf neighbor');
    expect(neighbors).toMatch(/FULL.*GigabitEthernet0\/1/);
    expect(neighbors).not.toMatch(/INIT/);
  });

  it('R2 learns the head-office LAN through OSPF', async () => {
    await clock.advance(30_000);
    expect(await r2.executeCommand('show ip route')).toMatch(/O\s+192\.168\.10\.0\/24.*via 10\.0\.20\.1.*GigabitEthernet0\/0\.99/);
  });

  it('a branch host reaches a head-office host and back', async () => {
    await clock.advance(30_000);
    expect(await h2.executeCommand('ping -c 1 192.168.10.2')).toContain('1 received');
    expect(await h1.executeCommand('ping -c 1 192.168.50.2')).toContain('1 received');
  });

  it('the adjacency is still Full five minutes later', async () => {
    await clock.advance(30_000);
    await clock.advance(300_000);
    expect(await r2.executeCommand('show ip ospf neighbor')).toMatch(/FULL.*GigabitEthernet0\/0\.99/);
    expect(await h2.executeCommand('ping -c 1 192.168.10.2')).toContain('1 received');
  });
});
