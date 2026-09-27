/**
 * L'age d'une route apprise se lit sur l'horloge du routeur, dans les deux
 * vues d'IOS qui l'impriment.
 *
 * Mesure de depart (0611d93c) : `show ip route` n'imprimait AUCUN age —
 * `O 1.1.1.1/32 [110/1] via 10.0.12.1, GigabitEthernet0/0` — la ou IOS
 * ecrit `via 10.0.12.1, 00:00:25, GigabitEthernet0/0`. `show ip route
 * <prefixe>` en imprimait un, mais calcule sur Date.now() : sous
 * l'horloge virtuelle, 25 s apres l'apprentissage, il repondait
 * `00:00:00 ago`, et une route statique y portait une ligne
 * `Last update from …` qu'IOS ne lui donne pas — une statique n'a pas de
 * source de mise a jour. Toute reconvergence OSPF reinstallait chaque
 * route, si bien qu'une route inchangee aurait perdu son age a chaque
 * changement ailleurs dans le domaine ; EIGRP et BGP n'en posaient aucun.
 * `show ip route ospf` avait son propre rendu, sans legende ni passerelle
 * ni groupes ; la route par defaut apprise sortait en `O*` sans son type
 * externe, sans age, sans interface, et en DERNIER, si bien que le filtre
 * par protocole la rangeait sous l'en-tete du dernier reseau majeur.
 *
 * Autorite : les sorties capturees d'IOS conservees par ntc-templates
 * (cisco_ios_show_ip_route*.raw) — `O E2 4.4.0.0 [110/20] via 194.0.0.2,
 * 1d18h, FastEthernet0/0.100`, `B 6.6.0.0 [200/0] via 195.0.0.1, 00:00:04`
 * (BGP : pas d'interface), `B 11.1.0.0/17 [200/0], 2w0d, Null0`, et en
 * IOS 15 `B*    0.0.0.0/0 [200/0] via 10.10.254.3, 1d05h` imprime AVANT
 * les reseaux majeurs. Un age RIP est le temps depuis la derniere mise a
 * jour recue (RFC 2453 §3.8 : chaque reponse reinitialise la route).
 *
 * Discrimination, mesuree sur le commit de base (0611d93c) avec ce
 * fichier copie : 11 des 13 cas tombent. Passent des deux cotes : le
 * TEMOIN (l'adjacence apprend a R2 la loopback de R1) et la
 * NON-REGRESSION « une route statique n'imprime pas d'age dans la table ».
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

async function pair(first: readonly string[], second: readonly string[]) {
  const r1 = new CiscoRouter('R1', 0, 0);
  const r2 = new CiscoRouter('R2', 0, 0);
  new Cable('r1-r2').connect(r1.getPort('GigabitEthernet0/0')!, r2.getPort('GigabitEthernet0/0')!);
  await type(r1, ['enable', 'configure terminal',
    'interface GigabitEthernet0/0', 'ip address 10.0.12.1 255.255.255.0', 'no shutdown', 'exit',
    'interface Loopback0', 'ip address 1.1.1.1 255.255.255.255', 'exit',
    'interface Loopback1', 'ip address 172.16.1.1 255.255.255.0', 'exit',
    ...first, 'end']);
  await type(r2, ['enable', 'configure terminal',
    'interface GigabitEthernet0/0', 'ip address 10.0.12.2 255.255.255.0', 'no shutdown', 'exit',
    ...second, 'end']);
  return { r1, r2 };
}

const ospfPair = () => pair(
  ['ip route 0.0.0.0 0.0.0.0 Null0',
    'router ospf 1', 'router-id 1.1.1.1', 'network 10.0.12.0 0.0.0.255 area 0',
    'network 1.1.1.1 0.0.0.0 area 0', 'default-information originate', 'exit'],
  ['ip route 192.168.60.0 255.255.255.0 10.0.12.1',
    'router ospf 1', 'router-id 2.2.2.2', 'network 10.0.12.0 0.0.0.255 area 0', 'exit']);

const loopbackLine = (age: string) =>
  new RegExp(`^O\\s+1\\.1\\.1\\.1(?:/32)? \\[110/\\d+\\] via 10\\.0\\.12\\.1, ${age}, GigabitEthernet0/0$`, 'm');

describe('OSPF routes carry their age', () => {
  it('WITNESS: the adjacency teaches R2 the loopback of R1', async () => {
    const { r2 } = await ospfPair();
    expect(await r2.executeCommand('show ip route')).toMatch(/1\.1\.1\.1/);
  });

  it('show ip route prints the age read on the router clock', async () => {
    const { r2 } = await ospfPair();
    clock.advance(25_000);
    expect(await r2.executeCommand('show ip route')).toMatch(loopbackLine('00:00:25'));
  });

  it('an unchanged route keeps its age when the domain reconverges for another prefix', async () => {
    const { r1, r2 } = await ospfPair();
    clock.advance(25_000);
    await type(r1, ['configure terminal', 'interface Loopback5', 'ip address 5.5.5.5 255.255.255.255', 'exit',
      'router ospf 1', 'network 5.5.5.5 0.0.0.0 area 0', 'end']);
    clock.advance(15_000);
    const table = await r2.executeCommand('show ip route');
    expect(table).toMatch(/5\.5\.5\.5(?:\/32)? \[110\/\d+\] via 10\.0\.12\.1, 00:00:15, GigabitEthernet0\/0/);
    expect(table).toMatch(loopbackLine('00:00:40'));
  });

  it('a route whose metric changes starts a new age', async () => {
    const { r2 } = await ospfPair();
    clock.advance(25_000);
    await type(r2, ['configure terminal', 'interface GigabitEthernet0/0', 'ip ospf cost 50', 'end']);
    clock.advance(10_000);
    expect(await r2.executeCommand('show ip route')).toMatch(loopbackLine('00:00:10'));
  });

  it('show ip route <prefix> dates the last update on the router clock', async () => {
    const { r2 } = await ospfPair();
    clock.advance(25_000);
    expect(await r2.executeCommand('show ip route 1.1.1.1'))
      .toContain('Last update from 10.0.12.1 on GigabitEthernet0/0, 00:00:25 ago');
  });

  it('setting the calendar does not age a route', async () => {
    const { r2 } = await ospfPair();
    clock.advance(25_000);
    await r2.executeCommand('clock set 10:00:00 1 Jan 2030');
    expect(await r2.executeCommand('show ip route')).toMatch(loopbackLine('00:00:25'));
  });

  it('the learned default is printed first, with its external type, age and interface', async () => {
    const { r2 } = await ospfPair();
    clock.advance(25_000);
    const table = await r2.executeCommand('show ip route');
    const afterGateway = table.split('Gateway of last resort is 10.0.12.1 to network 0.0.0.0\n\n')[1] ?? '';
    expect(afterGateway.split('\n')[0])
      .toBe('O*E2  0.0.0.0/0 [110/1] via 10.0.12.1, 00:00:25, GigabitEthernet0/0');
  });

  it('show ip route ospf is the routing table filtered to OSPF, legend and ages included', async () => {
    const { r2 } = await ospfPair();
    clock.advance(25_000);
    const view = await r2.executeCommand('show ip route ospf');
    expect(view).toContain('Codes: L - local, C - connected, S - static');
    expect(view).toContain('Gateway of last resort is 10.0.12.1 to network 0.0.0.0');
    expect(view).toMatch(loopbackLine('00:00:25'));
    expect(view).not.toMatch(/^[CLS]\s/m);
  });
});

describe('static routes have no age and no update source', () => {
  it('NON-REGRESSION: the table prints no age on a static route', async () => {
    const { r2 } = await ospfPair();
    clock.advance(25_000);
    expect(await r2.executeCommand('show ip route')).toMatch(/^S\s+192\.168\.60\.0\/24 \[1\/0\] via 10\.0\.12\.1$/m);
  });

  it('show ip route <prefix> gives a static route no Last update line', async () => {
    const { r2 } = await ospfPair();
    clock.advance(25_000);
    expect(await r2.executeCommand('show ip route 192.168.60.1')).not.toContain('Last update');
  });
});

describe('RIP, EIGRP and BGP routes carry their age', () => {
  it('a RIP route is aged from the last update received', async () => {
    const { r2 } = await pair(
      ['router rip', 'version 2', 'no auto-summary', 'network 10.0.0.0', 'network 172.16.0.0', 'exit'],
      ['router rip', 'version 2', 'no auto-summary', 'network 10.0.0.0', 'exit']);
    clock.advance(52_000);
    expect(await r2.executeCommand('show ip route'))
      .toMatch(/^R\s+172\.16\.1\.0(?:\/24)? \[120\/1\] via 10\.0\.12\.1, 00:00:22, GigabitEthernet0\/0$/m);
  });

  it('an EIGRP route carries its age', async () => {
    const { r2 } = await pair(
      ['router eigrp 10', 'network 10.0.12.0 0.0.0.255', 'network 172.16.1.0 0.0.0.255', 'exit'],
      ['router eigrp 10', 'network 10.0.12.0 0.0.0.255', 'exit']);
    clock.advance(10_000);
    expect(await r2.executeCommand('show ip route'))
      .toMatch(/^D\s+172\.16\.1\.0(?:\/24)? \[90\/\d+\] via 10\.0\.12\.1, 00:00:10, GigabitEthernet0\/0$/m);
  });

  it('a BGP route carries its age and no interface', async () => {
    const { r2 } = await pair(
      ['router bgp 65001', 'neighbor 10.0.12.2 remote-as 65002', 'network 172.16.1.0 mask 255.255.255.0', 'exit'],
      ['router bgp 65002', 'neighbor 10.0.12.1 remote-as 65001', 'exit']);
    clock.advance(12_000);
    expect(await r2.executeCommand('show ip route'))
      .toMatch(/^B\s+172\.16\.1\.0(?:\/24)? \[20\/0\] via 10\.0\.12\.1, 00:00:12$/m);
  });
});
