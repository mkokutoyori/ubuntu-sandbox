/**
 * Lire l'etat OSPF ne le change pas, et une commande de configuration
 * prend effet sans qu'on la lise.
 *
 * Mesure de depart (2ca116ce), deux routeurs Cisco adjacents :
 * - chaque `show ip ospf database` relançait la convergence : R1
 *   reoriginait ses LSA et les deux routeurs mettaient 18 trames sur le
 *   fil ; entre deux lectures, la router-LSA de R1 passait de 0x8000000b
 *   a 0x8000000d ;
 * - `show ip ospf neighbor`, en poussant des Hello, remettait a zero le
 *   temps mort : 00:00:40 sept secondes apres le dernier Hello ;
 * - `ip ospf cost 50` n'avait pas d'effet par lui-meme : dix secondes plus
 *   tard la table portait encore la metrique 1, et c'est le `show ip
 *   route` suivant qui l'appliquait ;
 * - vingt-deux vues Cisco (show ip ospf …, show ip route …, show ipv6 …)
 *   et onze vues VRP (display ospf …) convergeaient ainsi.
 *
 * Autorites : une commande `show` ou `display` est une lecture (Cisco
 * IOS, « show » commands ; Huawei, « display » commands) ; RFC 2328 §9.5
 * et §10.2 — les Hello partent au rythme de HelloInterval et le temps mort
 * court depuis le dernier Hello recu ; §12.4 — un changement de cout
 * d'interface change la router-LSA.
 *
 * Les cas de configuration sont lus par l'API du routeur
 * (`getRoutingTable()`), justement parce qu'une lecture CLI convergeait
 * sur la base et masquait le defaut.
 *
 * Discrimination, mesuree sur le commit de base (2ca116ce) avec ce
 * fichier copie : 6 des 8 cas tombent. Passent des deux cotes les
 * TEMOINS : R1 apprend la loopback de R2, et une lecture VRP sans
 * convergence (`display ospf lsdb` non type) ne change rien.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
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

async function ciscoPair() {
  const r1 = new CiscoRouter('R1', 0, 0);
  const r2 = new CiscoRouter('R2', 0, 0);
  new Cable('r1-r2').connect(r1.getPort('GigabitEthernet0/0')!, r2.getPort('GigabitEthernet0/0')!);
  for (const [router, octet] of [[r1, 1], [r2, 2]] as const) {
    await type(router, ['enable', 'configure terminal',
      'interface GigabitEthernet0/0', `ip address 10.0.12.${octet} 255.255.255.0`, 'no shutdown', 'exit',
      'interface Loopback0', `ip address ${octet}.${octet}.${octet}.${octet} 255.255.255.255`, 'exit',
      'router ospf 1', `router-id ${octet}.${octet}.${octet}.${octet}`,
      'network 10.0.12.0 0.0.0.255 area 0', `network ${octet}.${octet}.${octet}.${octet} 0.0.0.0 area 0`, 'end']);
  }
  clock.advance(60_000);
  const framesOnTheWire = () => r1.getPort('GigabitEthernet0/0')!.getCounters().framesOut
    + r2.getPort('GigabitEthernet0/0')!.getCounters().framesOut;
  return { r1, r2, framesOnTheWire };
}

async function huaweiPair() {
  const h1 = new HuaweiRouter('H1', 0, 0);
  const h2 = new HuaweiRouter('H2', 0, 0);
  new Cable('h1-h2').connect(h1.getPort('GE0/0/0')!, h2.getPort('GE0/0/0')!);
  for (const [router, octet] of [[h1, 3], [h2, 4]] as const) {
    await type(router, ['system-view',
      'interface GigabitEthernet0/0/0', `ip address 10.0.34.${octet} 255.255.255.0`, 'quit',
      `ospf 1 router-id ${octet}.${octet}.${octet}.${octet}`, 'area 0', 'network 10.0.34.0 0.0.0.255', 'return']);
  }
  clock.advance(60_000);
  const framesOnTheWire = () => h1.getPort('GE0/0/0')!.getCounters().framesOut
    + h2.getPort('GE0/0/0')!.getCounters().framesOut;
  return { h1, framesOnTheWire };
}

const ospfMetricTo = (router: CiscoRouter, network: string) => router.getRoutingTable()
  .find((route) => route.type === 'ospf' && String(route.network) === network)?.metric;

describe('a read leaves OSPF as it found it', () => {
  it('WITNESS: R1 learns the loopback of R2', async () => {
    const { r1 } = await ciscoPair();
    expect(ospfMetricTo(r1, '2.2.2.2')).toBeDefined();
  });

  it('show ip ospf database puts no frame on the wire', async () => {
    const { r1, framesOnTheWire } = await ciscoPair();
    const before = framesOnTheWire();
    await r1.executeCommand('show ip ospf database');
    expect(framesOnTheWire() - before).toBe(0);
  });

  it('two reads of the database print the same sequence numbers', async () => {
    const { r1 } = await ciscoPair();
    const first = await r1.executeCommand('show ip ospf database');
    expect(await r1.executeCommand('show ip ospf database')).toBe(first);
  });

  it('show ip route puts no frame on the wire', async () => {
    const { r1, framesOnTheWire } = await ciscoPair();
    const before = framesOnTheWire();
    await r1.executeCommand('show ip route');
    expect(framesOnTheWire() - before).toBe(0);
  });

  it('the dead time counts down from the last Hello received', async () => {
    const { r1 } = await ciscoPair();
    clock.advance(7_000);
    expect(await r1.executeCommand('show ip ospf neighbor')).toMatch(/2\.2\.2\.2 .* 00:00:33 +10\.0\.12\.2/);
  });

  it('WITNESS: display ospf lsdb puts no frame on the wire', async () => {
    const { h1, framesOnTheWire } = await huaweiPair();
    const before = framesOnTheWire();
    await h1.executeCommand('display ospf lsdb');
    expect(framesOnTheWire() - before).toBe(0);
  });

  it('display ospf lsdb router puts no frame on the wire', async () => {
    const { h1, framesOnTheWire } = await huaweiPair();
    const before = framesOnTheWire();
    await h1.executeCommand('display ospf lsdb router');
    expect(framesOnTheWire() - before).toBe(0);
  });
});

describe('a configuration command takes effect without being read', () => {
  it('ip ospf cost reaches the routing table by itself', async () => {
    const { r1 } = await ciscoPair();
    const before = ospfMetricTo(r1, '2.2.2.2')!;
    await type(r1, ['configure terminal', 'interface GigabitEthernet0/0', 'ip ospf cost 50', 'end']);
    clock.advance(10_000);
    expect(ospfMetricTo(r1, '2.2.2.2')).toBe(before + 49);
  });
});
