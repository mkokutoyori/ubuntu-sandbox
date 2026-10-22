/**
 * `show ip ospf neighbor` disait `FULL/  -` pour TOUS les voisins : le tiret est celui des liens point a point, ou
 * IOS n'elit ni DR ni BDR ; sur un segment Ethernet il dit le role du voisin vu de ce routeur -- `FULL/DR`,
 * `FULL/BDR`, `FULL/DROTHER`, ou `2WAY/DROTHER` entre deux routeurs qui ne sont ni l'un ni l'autre.  Le meme
 * routeur, interroge par `show ip ospf interface`, nommait pourtant bien le DR et le BDR : deux vues de la meme
 * machine qui se contredisaient.  Le moteur savait tout (`iface.dr` / `iface.bdr` portent l'adresse du DR et du
 * BDR, le voisin a la sienne) ; la commande ecrivait une chaine fixe.
 *
 * Trouve en configurant OSPF sur les deux routeurs d'une topologie d'utilisateur (R-AKWA / R-ISP, un /28 Ethernet :
 * R-AKWA est DR, R-ISP BDR, et les deux tableaux disaient `FULL/  -`).  Deux autres ecarts du meme tableau sont
 * corriges ici :
 *   - la priorite est alignee a droite sur trois cellules (`2.2.2.2           1   FULL/DR`), comme dans
 *     docs/tutoriel-ospf.md ; elle etait collee a gauche ;
 *   - l'etat `TwoWay` s'ecrivait `TWOWAY` (`toUpperCase()` du nom interne), IOS dit `2WAY` -- dans le tableau et
 *     dans `show ip ospf neighbor detail` ;
 *   - `show ipv6 ospf neighbor` ecrivait `FULL/ -` sans temps mort ni identifiant d'interface ; OSPFv3 elit un DR
 *     lui aussi (par identifiant de routeur), le tableau a les colonnes d'IOS (`Interface ID`).
 *
 * Deux tests de `ospf-full` epinglaient le defaut : l'un exigeait `FULL/  -` pour deux routeurs sur un /30 Ethernet
 * (« DR/BDR not applicable on p2p » -- le lien n'est pas point a point, c'est le type reseau par defaut,
 * `broadcast`), il attend a present `FULL/DR` ou `FULL/BDR` ; l'autre exigeait `FULL/ -` pour OSPFv3 sur un lien
 * Ethernet, il attend un role.  Le test IPv4 a reseau `point-to-point` declare garde le tiret.
 *
 * Discrimine par `git stash` sur src/network : 5 des 7 cas tombent avant.  Les 2 qui passent des deux cotes sont
 * des TEMOINS nommes ici : « un lien declare point-to-point garde le tiret » (la regle que la correction ne doit
 * pas casser) et « le DR de l'interface est bien celui que dit show ip ospf interface » (la verite contre laquelle
 * les autres cas comparent).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { VirtualTimeScheduler, __setDefaultScheduler } from '@/events/Scheduler';

let horloge: VirtualTimeScheduler;

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); Logger.reset();
  horloge = new VirtualTimeScheduler();
  __setDefaultScheduler(horloge);
});
afterEach(() => { __setDefaultScheduler(null); });

async function configure(router: CiscoRouter, lines: readonly string[]): Promise<void> {
  for (const line of ['enable', 'configure terminal', ...lines, 'end']) await router.executeCommand(line);
}

async function segment(priorities: readonly number[]): Promise<CiscoRouter[]> {
  const sw = new CiscoSwitch('switch-cisco', 'SW1', 24);
  const routers: CiscoRouter[] = [];
  for (let i = 0; i < priorities.length; i++) {
    const router = new CiscoRouter(`R${i + 1}`);
    await configure(router, [
      'interface GigabitEthernet0/0', `ip address 192.168.1.${i + 1} 255.255.255.0`, 'no shutdown',
      `ip ospf priority ${priorities[i]}`, 'exit',
      'router ospf 1', `router-id ${i + 1}.${i + 1}.${i + 1}.${i + 1}`, 'network 192.168.1.0 0.0.0.255 area 0',
    ]);
    new Cable(`c${i}`).connect(router.getPort('GigabitEthernet0/0')!, sw.getPort(`FastEthernet0/${i + 1}`)!);
    routers.push(router);
  }
  horloge.advance(45_000);
  return routers;
}

const rowOf = (table: string, routerId: string): string => table.split('\n').find((line) => line.startsWith(`${routerId} `)) ?? '';

describe('show ip ospf neighbor dit le role du voisin sur un segment Ethernet', () => {
  it('TEMOIN — le DR et le BDR de l interface sont ceux que nomme show ip ospf interface', async () => {
    const [r1, r2] = await segment([255, 100]);
    expect(await r1.executeCommand('show ip ospf interface GigabitEthernet0/0')).toContain('DR: 192.168.1.1');
    expect(await r1.executeCommand('show ip ospf interface GigabitEthernet0/0')).toContain('BDR: 192.168.1.2');
    expect(await r2.executeCommand('show ip ospf interface GigabitEthernet0/0')).toContain('DR: 192.168.1.1');
  });

  it('le DR voit son voisin BDR en FULL/BDR et le BDR voit le DR en FULL/DR', async () => {
    const [r1, r2] = await segment([255, 100]);
    expect(rowOf(await r1.executeCommand('show ip ospf neighbor'), '2.2.2.2')).toMatch(/ FULL\/BDR +\d\d:\d\d:\d\d +192\.168\.1\.2 +GigabitEthernet0\/0$/);
    expect(rowOf(await r2.executeCommand('show ip ospf neighbor'), '1.1.1.1')).toMatch(/ FULL\/DR +\d\d:\d\d:\d\d +192\.168\.1\.1 +GigabitEthernet0\/0$/);
  });

  it('un routeur qui n est ni DR ni BDR est FULL/DROTHER pour le DR et le BDR, et 2WAY/DROTHER pour son pair', async () => {
    const [r1, r2, r3, r4] = await segment([255, 100, 0, 0]);
    const fromR1 = await r1.executeCommand('show ip ospf neighbor');
    expect(rowOf(fromR1, '3.3.3.3')).toContain(' FULL/DROTHER ');
    expect(rowOf(fromR1, '4.4.4.4')).toContain(' FULL/DROTHER ');
    const fromR3 = await r3.executeCommand('show ip ospf neighbor');
    expect(rowOf(fromR3, '1.1.1.1')).toContain(' FULL/DR ');
    expect(rowOf(fromR3, '2.2.2.2')).toContain(' FULL/BDR ');
    expect(rowOf(fromR3, '4.4.4.4')).toContain(' 2WAY/DROTHER ');
    expect(rowOf(await r2.executeCommand('show ip ospf neighbor'), '4.4.4.4')).toContain(' FULL/DROTHER ');
    expect(rowOf(await r4.executeCommand('show ip ospf neighbor'), '3.3.3.3')).toContain(' 2WAY/DROTHER ');
  });

  it('la priorite est alignee a droite sur trois cellules, les colonnes sont celles de l en-tete', async () => {
    const [r1, , r3] = await segment([255, 100, 0]);
    const table = await r1.executeCommand('show ip ospf neighbor');
    const header = table.split('\n')[0];
    const row = rowOf(table, '2.2.2.2');
    expect(row.slice(16, 19)).toBe('100');
    expect(row.indexOf('FULL/BDR')).toBe(header.indexOf('State'));
    expect(row.indexOf('192.168.1.2')).toBe(header.indexOf('Address'));
    expect(rowOf(await r3.executeCommand('show ip ospf neighbor'), '1.1.1.1').slice(16, 19)).toBe('255');
    expect(rowOf(table, '3.3.3.3').slice(16, 19)).toBe('  0');
  });

  it('show ip ospf neighbor detail ecrit 2WAY et non TWOWAY', async () => {
    const [, , r3] = await segment([255, 100, 0, 0]);
    expect(await r3.executeCommand('show ip ospf neighbor detail')).toContain('State is 2WAY');
    expect(await r3.executeCommand('show ip ospf neighbor detail')).not.toContain('TWOWAY');
  });
});

describe('le tiret reste celui des liens point a point', () => {
  it('TEMOIN — deux routeurs en ip ospf network point-to-point : FULL/  - des deux cotes', async () => {
    const routers = [new CiscoRouter('R1'), new CiscoRouter('R2')];
    for (let i = 0; i < 2; i++) {
      await configure(routers[i], [
        'interface GigabitEthernet0/0', `ip address 10.0.0.${i + 1} 255.255.255.252`, 'ip ospf network point-to-point', 'no shutdown', 'exit',
        'router ospf 1', `router-id ${i + 1}.${i + 1}.${i + 1}.${i + 1}`, 'network 10.0.0.0 0.0.0.3 area 0',
      ]);
    }
    new Cable('c').connect(routers[0].getPort('GigabitEthernet0/0')!, routers[1].getPort('GigabitEthernet0/0')!);
    horloge.advance(45_000);
    expect(rowOf(await routers[0].executeCommand('show ip ospf neighbor'), '2.2.2.2')).toContain(' FULL/  -  ');
    expect(rowOf(await routers[1].executeCommand('show ip ospf neighbor'), '1.1.1.1')).toContain(' FULL/  -  ');
  });
});

describe('show ipv6 ospf neighbor suit la meme regle avec les colonnes d IOS', () => {
  it('un segment Ethernet : role du voisin, temps mort et identifiant d interface', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW1', 24);
    const routers = [new CiscoRouter('R1'), new CiscoRouter('R2')];
    for (let i = 0; i < 2; i++) {
      await configure(routers[i], [
        'ipv6 unicast-routing',
        'interface GigabitEthernet0/0', `ipv6 address 2001:db8:12::${i + 1}/64`, 'no shutdown', 'exit',
        'ipv6 router ospf 1', `router-id ${i + 1}.${i + 1}.${i + 1}.${i + 1}`, 'exit',
        'interface GigabitEthernet0/0', 'ipv6 ospf 1 area 0',
      ]);
      new Cable(`c${i}`).connect(routers[i].getPort('GigabitEthernet0/0')!, sw.getPort(`FastEthernet0/${i + 1}`)!);
    }
    horloge.advance(45_000);
    const engine1 = routers[0].getOspfIntegration().getOSPFv3Engine()!;
    const designated = engine1.getInterface('GigabitEthernet0/0')!.dr;
    const fromR1 = await routers[0].executeCommand('show ipv6 ospf neighbor');
    expect(fromR1.split('\n')[0]).toBe('Neighbor ID     Pri   State           Dead Time   Interface ID    Interface');
    expect(rowOf(fromR1, '2.2.2.2')).toMatch(designated === '2.2.2.2'
      ? /^2\.2\.2\.2 +1   FULL\/DR +\d\d:\d\d:\d\d +\d+ +GigabitEthernet0\/0$/
      : /^2\.2\.2\.2 +1   FULL\/BDR +\d\d:\d\d:\d\d +\d+ +GigabitEthernet0\/0$/);
  });
});
