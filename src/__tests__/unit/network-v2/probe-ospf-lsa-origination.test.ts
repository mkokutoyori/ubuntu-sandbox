/**
 * Chaque LSA a sa propre sequence, une LSA n'est reoriginee que si son
 * contenu change, MinLSInterval differe l'instance suivante au lieu de la
 * taire, un routeur reprend ses LSA d'avant un redemarrage, et une LSA
 * traverse le fil par copie.
 *
 * Mesure de depart (a063be27), routeurs Cisco R1 et R2 :
 * - un compteur unique numerotait toutes les LSA d'un routeur : R1 seul,
 *   apres un `network`, montrait sa router-LSA en 0x80000002, apres un
 *   second en 0x80000004 ; la network-LSA de R1 prenait 0x80000009 ;
 * - une adresse posee sur une interface qu'OSPF ne couvre pas faisait
 *   passer la router-LSA de 0x80000004 a 0x80000005, sans changement ;
 * - MinLSInterval installait la nouvelle instance chez soi et taisait
 *   son inondation : le voisin gardait l'ancienne ;
 * - R2 tenait le MEME objet LSA que R1 : pendant une coupure, R1 vidait
 *   sa network-LSA (age 3600, sequence augmentee) et R2 la voyait videe
 *   sans avoir recu une trame ;
 * - apres `no router ospf 1` puis une configuration sans le reseau de
 *   Loopback0, R2 gardait l'ancienne router-LSA de R1 (0x8000000c, deux
 *   liens) et routait encore 1.1.1.1/32 vers R1.
 *
 * Autorites : RFC 2328 §12.1.6 (une sequence par LSA, a partir de
 * InitialSequenceNumber 0x80000001), §12.4 (une instance nouvelle si et
 * seulement si le contenu change ; deux instances espacees d'au moins
 * MinLSInterval, la suivante etant retardee), §13.2 (ce qui compte comme
 * changement de contenu), §13.4 (une LSA auto-originee recue plus recente
 * que la derniere instance originee : avancer la sequence au-dela et
 * reoriginer, ou la vider), §14.1 (vider une LSA : age MaxAge, meme
 * sequence).
 *
 * Discrimination, mesuree sur le commit de base (a063be27) avec ce
 * fichier copie : 8 des 9 cas tombent. Passe des deux cotes le TEMOIN :
 * l'adjacence apprend a R2 la loopback de R1.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { Cable } from '@/network/hardware/Cable';
import { VirtualTimeScheduler, __setDefaultScheduler } from '@/events/Scheduler';
import type { RouterLSA } from '@/network/ospf/types';

interface Shell { executeCommand(command: string): Promise<string> }

async function type(device: Shell, commands: readonly string[]): Promise<void> {
  for (const command of commands) await device.executeCommand(command);
}

let clock: VirtualTimeScheduler;

beforeEach(() => {
  clock = new VirtualTimeScheduler();
  __setDefaultScheduler(clock);
});

const R1_BASE = ['enable', 'configure terminal',
  'interface GigabitEthernet0/0', 'ip address 10.0.12.1 255.255.255.0', 'no shutdown', 'exit',
  'interface Loopback0', 'ip address 1.1.1.1 255.255.255.255', 'exit',
  'router ospf 1', 'router-id 1.1.1.1', 'network 1.1.1.1 0.0.0.0 area 0', 'end'];

async function pair() {
  const r1 = new CiscoRouter('R1', 0, 0);
  const r2 = new CiscoRouter('R2', 0, 0);
  const link = new Cable('r1-r2');
  link.connect(r1.getPort('GigabitEthernet0/0')!, r2.getPort('GigabitEthernet0/0')!);
  await type(r1, R1_BASE);
  await type(r1, ['configure terminal', 'router ospf 1', 'network 10.0.12.0 0.0.0.255 area 0', 'end']);
  await type(r2, ['enable', 'configure terminal',
    'interface GigabitEthernet0/0', 'ip address 10.0.12.2 255.255.255.0', 'no shutdown', 'exit',
    'router ospf 1', 'router-id 2.2.2.2', 'network 10.0.12.0 0.0.0.255 area 0', 'end']);
  clock.advance(60_000);
  return { r1, r2, link };
}

const routerLsaOf = (holder: CiscoRouter, rid: string) =>
  holder._getOSPFEngineInternal()!.lookupLSA('0', 1, rid, rid) as RouterLSA | undefined;

const sequenceLine = (database: string, linkId: string) =>
  database.split('\n').find((line) => line.startsWith(linkId)) ?? '';

describe('each LSA has its own sequence and changes only with its contents', () => {
  it('WITNESS: the adjacency teaches R2 the loopback of R1', async () => {
    const { r2 } = await pair();
    expect(await r2.executeCommand('show ip route ospf')).toContain('1.1.1.1/32');
  });

  it('a lone router originates its router-LSA at 0x80000001', async () => {
    const r1 = new CiscoRouter('R1', 0, 0);
    await type(r1, R1_BASE);
    expect(sequenceLine(await r1.executeCommand('show ip ospf database router'), '1.1.1.1'))
      .toContain('0x80000001');
  });

  it('a second network statement makes it 0x80000002', async () => {
    const r1 = new CiscoRouter('R1', 0, 0);
    await type(r1, R1_BASE);
    await type(r1, ['configure terminal', 'router ospf 1', 'network 10.0.12.0 0.0.0.255 area 0', 'end']);
    expect(sequenceLine(await r1.executeCommand('show ip ospf database router'), '1.1.1.1'))
      .toContain('0x80000002');
  });

  it('an address on an interface OSPF does not cover leaves the router-LSA as it was', async () => {
    const r1 = new CiscoRouter('R1', 0, 0);
    await type(r1, R1_BASE);
    const before = await r1.executeCommand('show ip ospf database router');
    await type(r1, ['configure terminal', 'interface Loopback5', 'ip address 5.5.5.5 255.255.255.255', 'end']);
    expect(await r1.executeCommand('show ip ospf database router')).toBe(before);
  });

  it('the network-LSA starts its own sequence at 0x80000001', async () => {
    const { r1 } = await pair();
    expect(sequenceLine(await r1.executeCommand('show ip ospf database network'), '10.0.12.1'))
      .toContain('0x80000001');
  });
});

describe('an LSA crosses the wire by copy', () => {
  it('R2 holds its own copy of the router-LSA of R1', async () => {
    const { r1, r2 } = await pair();
    expect(routerLsaOf(r2, '1.1.1.1')).toBeDefined();
    expect(routerLsaOf(r2, '1.1.1.1')).not.toBe(routerLsaOf(r1, '1.1.1.1'));
  });

  it('a partition leaves the copy of R2 as R2 last received it', async () => {
    const { r2, link } = await pair();
    const before = sequenceLine(await r2.executeCommand('show ip ospf database network'), '10.0.12.1');
    link.setPacketLossRate(1);
    clock.advance(50_000);
    expect(sequenceLine(await r2.executeCommand('show ip ospf database network'), '10.0.12.1')).toBe(before);
  });
});

describe('origination follows MinLSInterval and takes back stale instances', () => {
  it('a change inside MinLSInterval reaches the neighbour once the interval elapses', async () => {
    const { r1, r2 } = await pair();
    const engine = r1._getOSPFEngineInternal()!;
    const transitMetric = () => routerLsaOf(r2, '1.1.1.1')!.links.find((link) => link.type === 2)?.metric;
    engine.setInterfaceCost('GigabitEthernet0/0', 20);
    engine.setInterfaceCost('GigabitEthernet0/0', 30);
    expect(transitMetric()).toBe(20);
    clock.advance(5_000);
    expect(transitMetric()).toBe(30);
  });

  it('after a restart without Loopback0, R2 drops the old router-LSA of R1', async () => {
    const { r1, r2 } = await pair();
    const before = routerLsaOf(r2, '1.1.1.1')!.lsSequenceNumber;
    await type(r1, ['configure terminal', 'no router ospf 1',
      'router ospf 1', 'router-id 1.1.1.1', 'network 10.0.12.0 0.0.0.255 area 0', 'end']);
    clock.advance(60_000);
    expect(routerLsaOf(r2, '1.1.1.1')!.lsSequenceNumber).toBeGreaterThan(before);
    expect(await r2.executeCommand('show ip route ospf')).not.toContain('1.1.1.1/32');
  });
});
