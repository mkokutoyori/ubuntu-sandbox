/**
 * Chaque VDOM d'une FortiGate a son routage dynamique : OSPF et BGP
 * vivent sur les interfaces du VDOM et installent dans sa table.
 *
 * Mesure de depart (670eee17) : FirewallRouting n'avait qu'une instance
 * pour la machine. Sur une FortiGate dont customer possede port2 (face a
 * un routeur Cisco en OSPF) et root possede port1 (10.1.5.1/24) :
 * - OSPF configure dans customer installait ses routes dans la table du
 *   VDOM de la CLI : `get router info routing-table all` de customer ne
 *   montrait rien d'OSPF, celle de root montrait
 *   « O 172.20.0.1/32 [110/1] via 10.1.0.2, port2 » ;
 * - le reseau 10.1.0.0/16 de customer activait OSPF sur port1, interface
 *   de root ;
 * - `config router bgp` de root puis de customer ecrivaient la meme
 *   instance : root repondait « local AS number 65002 », celui de
 *   customer, et la configuration de root etait perdue.
 *
 * Autorite : guide d'administration FortiOS 7.6, « Virtual Domains » —
 * chaque VDOM a sa table de routage et son routage dynamique, configure
 * sous `config vdom` / `edit` ; la reference CLI range `config router
 * ospf` et `config router bgp` parmi les commandes de VDOM.
 *
 * Discrimination, mesuree sur le commit de base (670eee17) avec ce
 * fichier copie : 4 des 5 cas tombent. Passe des deux cotes le TEMOIN :
 * l'adjacence OSPF de customer avec R1 s'etablit — l'instance unique de
 * la base la montait aussi —, sans quoi aucun des autres cas ne
 * mesurerait rien.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { Cable } from '@/network/hardware/Cable';
import { VirtualTimeScheduler, __setDefaultScheduler } from '@/events/Scheduler';

interface Shell { executeCommand(command: string): Promise<string> }

async function type(device: Shell, commands: readonly string[]): Promise<string[]> {
  const outputs: string[] = [];
  for (const command of commands) outputs.push(await device.executeCommand(command));
  return outputs;
}

let clock: VirtualTimeScheduler;

beforeEach(() => {
  clock = new VirtualTimeScheduler();
  __setDefaultScheduler(clock);
});

const CONVERGENCE_MS = 60_000;

async function inVdom(firewall: FortiGate, vdom: string, command: string): Promise<string> {
  const [, output] = await type(firewall, [`execute enter ${vdom}`, command]);
  return output;
}

async function twoVdoms(): Promise<{ firewall: FortiGate; neighbour: CiscoRouter }> {
  const firewall = new FortiGate('firewall-fortinet', 'FGT', 0, 0);
  const neighbour = new CiscoRouter('R1', 0, 0);
  new Cable('fgt-r1').connect(firewall.getPort('port2')!, neighbour.getPort('GigabitEthernet0/1')!);
  await type(neighbour, ['enable', 'configure terminal',
    'interface GigabitEthernet0/1', 'ip address 10.1.0.2 255.255.255.0', 'no shutdown', 'exit',
    'interface Loopback1', 'ip address 172.20.0.1 255.255.255.0', 'end']);
  await type(firewall, ['config system global', 'set vdom-mode multi-vdom', 'end',
    'config vdom', 'edit customer', 'next', 'end', 'config global', 'config system interface',
    'edit port1', 'set ip 10.1.5.1 255.255.255.0', 'next',
    'edit port2', 'set vdom customer', 'set ip 10.1.0.1 255.255.255.0', 'set allowaccess ping', 'next',
    'end', 'end']);
  return { firewall, neighbour };
}

async function ospfInCustomer(firewall: FortiGate, neighbour: CiscoRouter): Promise<void> {
  await type(neighbour, ['configure terminal', 'router ospf 1', 'router-id 2.2.2.2',
    'network 10.1.0.0 0.0.0.255 area 0', 'network 172.20.0.0 0.0.0.255 area 0', 'end']);
  await type(firewall, ['config vdom', 'edit customer', 'config router ospf', 'set router-id 1.1.1.1',
    'config area', 'edit 0.0.0.0', 'next', 'end',
    'config network', 'edit 1', 'set prefix 10.1.0.0 255.255.0.0', 'set area 0.0.0.0', 'next', 'end',
    'end', 'next', 'end']);
  clock.advance(CONVERGENCE_MS);
}

describe('OSPF lives in the VDOM that configures it', () => {
  it('WITNESS: customer\'s OSPF becomes adjacent with R1', async () => {
    const { firewall, neighbour } = await twoVdoms();
    await ospfInCustomer(firewall, neighbour);
    expect(await inVdom(firewall, 'customer', 'get router info ospf neighbor')).toContain('2.2.2.2');
  });

  it('the route it learns is in customer\'s table, and none in root\'s', async () => {
    const { firewall, neighbour } = await twoVdoms();
    await ospfInCustomer(firewall, neighbour);
    expect(await inVdom(firewall, 'customer', 'get router info routing-table all'))
      .toMatch(/^O\s+172\.20\.0\.1\/32 \[110\/\d+\] via 10\.1\.0\.2, port2/m);
    expect(await inVdom(firewall, 'root', 'get router info routing-table all')).not.toMatch(/^O\s/m);
  });

  it('it runs only on customer\'s interfaces, not on root\'s port1 inside the same network', async () => {
    const { firewall, neighbour } = await twoVdoms();
    await ospfInCustomer(firewall, neighbour);
    const interfaces = await inVdom(firewall, 'customer', 'get router info ospf interface');
    expect(interfaces).toMatch(/^port2 is up/m);
    expect(interfaces).not.toMatch(/^port1 is/m);
  });
});

describe('BGP lives in the VDOM that configures it', () => {
  async function bgpInBothVdoms(firewall: FortiGate): Promise<void> {
    await type(firewall, ['config vdom',
      'edit customer', 'config router bgp', 'set as 65002', 'set router-id 1.1.1.1',
      'config neighbor', 'edit "10.1.0.2"', 'set remote-as 65100', 'next', 'end', 'end', 'next',
      'edit root', 'config router bgp', 'set as 65001', 'set router-id 9.9.9.1', 'end', 'next', 'end']);
  }

  it('root and customer keep their own autonomous system', async () => {
    const { firewall } = await twoVdoms();
    await bgpInBothVdoms(firewall);
    expect(await inVdom(firewall, 'root', 'get router info bgp summary'))
      .toContain('BGP router identifier 9.9.9.1, local AS number 65001');
    expect(await inVdom(firewall, 'customer', 'get router info bgp summary'))
      .toContain('BGP router identifier 1.1.1.1, local AS number 65002');
  });

  it('a peer of customer establishes with customer\'s BGP, configured before root\'s', async () => {
    const { firewall, neighbour } = await twoVdoms();
    await type(neighbour, ['configure terminal', 'router bgp 65100', 'bgp router-id 2.2.2.2',
      'neighbor 10.1.0.1 remote-as 65002', 'end']);
    await bgpInBothVdoms(firewall);
    clock.advance(CONVERGENCE_MS);
    expect(await neighbour.executeCommand('show ip bgp summary')).toMatch(/10\.1\.0\.1\s+4\s+65002.*Established/);
    expect(await inVdom(firewall, 'customer', 'get router info bgp summary'))
      .toMatch(/^10\.1\.0\.2\s+4\s+65100(\s+\d+){5}\s+\d{2}:\d{2}:\d{2}\s+\d+$/m);
  });
});
