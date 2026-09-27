/**
 * `show ip route` rend sa table comme IOS 15 la rend : l'en-tete d'un
 * groupe a masque unique porte le masque des sous-reseaux, ses lignes
 * n'en portent pas, la colonne des codes a une largeur fixe, un
 * sur-reseau et une statique vers une interface s'ecrivent comme IOS les
 * ecrit, et deux chemins de meme cout se lisent tous les deux.
 *
 * Mesure de depart (327ff4d7) : `1.0.0.0/8 is subnetted, 1 subnets` puis
 * `O        1.1.1.1/32 [110/1] …` ; `S    192.168.60.0/24` (5 colonnes au
 * lieu de 6) ; `O IA       10.0.34.0/24` (11 au lieu de 9) ; un
 * sur-reseau 172.16.0.0/12 range sous un en-tete `172.16.0.0/16 is
 * subnetted` ; `S 192.168.70.0/24 [1/0] is directly connected, Null0` ;
 * une statique qui nomme son interface la taisait ; une adresse
 * secondaire n'avait pas de route locale `L …/32` ; et de deux statiques
 * de meme distance vers 192.168.90.0/24, une seule paraissait, alors que
 * le plan de donnees repartit sur les deux.
 *
 * Autorites : les sorties capturees d'IOS conservees par ntc-templates
 * (tests/cisco_ios/show_ip_route/*.raw) et les exemples de la reference
 * de commandes Cisco IP Routing (iri-cr-s1, `show ip route repair-paths`,
 * `next-hop-override`) :
 *       10.0.0.0/32 is subnetted, 3 subnets
 *   C        10.1.1.1 is directly connected, Loopback0
 *   B        10.2.2.2 [200/0] via 172.16.1.2, 00:31:07
 *                     [RPR][200/0] via 192.168.1.2, 00:31:07
 *   B     192.168.3.0/24 [200/0] via 172.16.1.2, 00:31:07
 *   S        10.10.10.0 is directly connected, Tunnel0
 *   B     172.16.0.0/12 [200/0] via 10.10.254.3, 1d05h
 *   B        10.12.1.0/27 [200/1000] via 192.168.12.5, 1w1d
 *                         [200/1000] via 192.168.12.1, 1w1d
 *
 * Discrimination, mesuree sur le commit de base (327ff4d7) avec ce
 * fichier copie : 10 des 12 cas tombent. Passent des deux cotes le TEMOIN
 * (un groupe a plusieurs masques garde le masque de chaque ligne) et la
 * NON-REGRESSION « la candidate par defaut garde son champ de six
 * colonnes », que le rendu imprimait deja ainsi.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { Cable } from '@/network/hardware/Cable';
import { VirtualTimeScheduler, __setDefaultScheduler } from '@/events/Scheduler';

interface Shell { executeCommand(command: string): Promise<string> }

async function type(device: Shell, commands: readonly string[]): Promise<void> {
  for (const command of commands) await device.executeCommand(command);
}

let clock: VirtualTimeScheduler;

beforeEach(() => {
  clock = new VirtualTimeScheduler();
  __setDefaultScheduler(clock);
});

async function lab() {
  const r1 = new CiscoRouter('R1', 0, 0);
  const r2 = new CiscoRouter('R2', 0, 0);
  const r3 = new CiscoRouter('R3', 0, 0);
  new Cable('r1-r2').connect(r1.getPort('GigabitEthernet0/0')!, r2.getPort('GigabitEthernet0/0')!);
  new Cable('r2-r3').connect(r2.getPort('GigabitEthernet0/1')!, r3.getPort('GigabitEthernet0/0')!);
  await type(r1, ['enable', 'configure terminal',
    'interface GigabitEthernet0/0', 'ip address 10.0.12.1 255.255.255.0', 'no shutdown', 'exit',
    'interface Loopback0', 'ip address 1.1.1.1 255.255.255.255', 'exit',
    'router ospf 1', 'router-id 1.1.1.1', 'network 10.0.12.0 0.0.0.255 area 0',
    'network 1.1.1.1 0.0.0.0 area 0', 'end']);
  await type(r3, ['enable', 'configure terminal',
    'interface GigabitEthernet0/0', 'ip address 10.0.23.3 255.255.255.0', 'no shutdown', 'exit',
    'interface Loopback1', 'ip address 10.0.34.3 255.255.255.0', 'exit',
    'router ospf 1', 'router-id 3.3.3.3', 'network 10.0.23.0 0.0.0.255 area 1',
    'network 10.0.34.0 0.0.0.255 area 1', 'end']);
  await type(r2, ['enable', 'configure terminal',
    'interface GigabitEthernet0/0', 'ip address 10.0.12.2 255.255.255.0', 'no shutdown', 'exit',
    'interface GigabitEthernet0/1', 'ip address 10.0.23.2 255.255.255.0', 'no shutdown',
    'ip address 172.31.0.2 255.255.255.0 secondary', 'exit',
    'ip route 0.0.0.0 0.0.0.0 10.0.12.1',
    'ip route 192.168.60.0 255.255.255.0 10.0.12.1',
    'ip route 172.16.0.0 255.240.0.0 10.0.12.1',
    'ip route 192.168.70.0 255.255.255.0 Null0',
    'ip route 192.168.80.0 255.255.255.0 GigabitEthernet0/0 10.0.12.1',
    'ip route 192.168.90.0 255.255.255.0 10.0.12.1',
    'ip route 192.168.90.0 255.255.255.0 10.0.23.3',
    'router ospf 1', 'router-id 2.2.2.2', 'network 10.0.12.0 0.0.0.255 area 0',
    'network 10.0.23.0 0.0.0.255 area 1', 'end']);
  clock.advance(25_000);
  return { r1, r2 };
}

describe('show ip route groups and columns as IOS 15 prints them', () => {
  it('WITNESS: a variably subnetted group lists its connected and local routes with their masks', async () => {
    const { r2 } = await lab();
    const table = await r2.executeCommand('show ip route');
    expect(table).toMatch(/^ {6}10\.0\.0\.0\/8 is variably subnetted, \d+ subnets, \d+ masks$/m);
    expect(table).toMatch(/^C {8}10\.0\.12\.0\/24 is directly connected, GigabitEthernet0\/0$/m);
    expect(table).toMatch(/^L {8}10\.0\.12\.2\/32 is directly connected, GigabitEthernet0\/0$/m);
  });

  it('a single-mask group names the mask its subnets share', async () => {
    const { r2 } = await lab();
    expect(await r2.executeCommand('show ip route')).toMatch(/^ {6}1\.0\.0\.0\/32 is subnetted, 1 subnets$/m);
  });

  it('the members of a single-mask group are printed without their mask', async () => {
    const { r2 } = await lab();
    expect(await r2.executeCommand('show ip route'))
      .toMatch(/^O {8}1\.1\.1\.1 \[110\/\d+\] via 10\.0\.12\.1, 00:00:25, GigabitEthernet0\/0$/m);
  });

  it('a two-word code keeps the nine-column field inside a group', async () => {
    const { r1 } = await lab();
    expect(await r1.executeCommand('show ip route'))
      .toMatch(/^O IA {5}10\.0\.23\.0\/24 \[110\/\d+\] via 10\.0\.12\.2, 00:00:25, GigabitEthernet0\/0$/m);
  });

  it('a network that is its own class is a top-level line in the six-column field', async () => {
    const { r2 } = await lab();
    expect(await r2.executeCommand('show ip route')).toMatch(/^S {5}192\.168\.60\.0\/24 \[1\/0\] via 10\.0\.12\.1$/m);
  });

  it('NON-REGRESSION: the candidate default keeps the six-column field', async () => {
    const { r2 } = await lab();
    expect(await r2.executeCommand('show ip route')).toMatch(/^S\* {4}0\.0\.0\.0\/0 \[1\/0\] via 10\.0\.12\.1$/m);
  });

  it('a supernet is a top-level line, never a group member', async () => {
    const { r2 } = await lab();
    const table = await r2.executeCommand('show ip route');
    expect(table).toMatch(/^S {5}172\.16\.0\.0\/12 \[1\/0\] via 10\.0\.12\.1$/m);
    expect(table).not.toContain('172.16.0.0/16 is subnetted');
  });

  it('a static route to an interface is directly connected, with no distance', async () => {
    const { r2 } = await lab();
    expect(await r2.executeCommand('show ip route')).toMatch(/^S {5}192\.168\.70\.0\/24 is directly connected, Null0$/m);
  });

  it('a secondary address has its own local route', async () => {
    const { r2 } = await lab();
    expect(await r2.executeCommand('show ip route'))
      .toMatch(/^L {8}172\.31\.0\.2\/32 is directly connected, GigabitEthernet0\/1$/m);
  });

  it('a static route that names its interface prints it after the next hop', async () => {
    const { r2 } = await lab();
    expect(await r2.executeCommand('show ip route'))
      .toMatch(/^S {5}192\.168\.80\.0\/24 \[1\/0\] via 10\.0\.12\.1, GigabitEthernet0\/0$/m);
  });
});

describe('equal-cost paths are all printed', () => {
  it('a second path of equal distance continues under the first', async () => {
    const { r2 } = await lab();
    expect(await r2.executeCommand('show ip route')).toContain([
      'S     192.168.90.0/24 [1/0] via 10.0.12.1',
      '                      [1/0] via 10.0.23.3',
    ].join('\n'));
  });

  it('the protocol filter keeps the continuation with its route', async () => {
    const { r2 } = await lab();
    expect(await r2.executeCommand('show ip route static')).toContain([
      'S     192.168.90.0/24 [1/0] via 10.0.12.1',
      '                      [1/0] via 10.0.23.3',
    ].join('\n'));
  });
});
