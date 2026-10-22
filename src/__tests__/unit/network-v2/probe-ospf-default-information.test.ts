/**
 * `default-information originate` : ses mots-cles sont evalues, la ligne se
 * rend, et le routeur se declare ASBR.
 *
 * Mesure de depart : la commande ne gardait que `always` et un `metric-type`
 * lu comme un entier quelconque (`metric-type 7` etait accepte) ; `metric N`
 * etait avale puis ignore (LSA a metrique 1 en dur) et `route-map` n'etait
 * meme pas un mot de la commande. Rien n'etait rendu par `show
 * running-config`, donc perdu a l'export ; `show ip ospf` ne disait pas que
 * le routeur est un ASBR ; la section Type-5 manquait a `show ip ospf
 * database` alors que `database-summary` comptait la LSA ; le detail
 * d'une LSA externe ecrivait `MTRIC:` au lieu de `Metric:`, sans la ligne
 * `TOS: 0`, et `database external <id>` fabriquait une ligne quand la base
 * etait vide. Enfin aucune LSA externe n'etait jamais retiree : `no
 * default-information originate`, `no redistribute static` ou la disparition
 * de la route par defaut laissaient la LSA Type-5 dans toute la base.
 *
 * Autorites (docs officielles Cisco et RFC seulement) : Cisco IOS IP Routing
 * OSPF Command Reference, `default-information originate (OSPF)` — syntaxe
 * `[always] [metric v] [metric-type t] [route-map m]`, metrique 10 si ni
 * `metric` ni `default-metric`, type 2 par defaut, `always` ignore avec une
 * route-map, la route par defaut doit exister sauf `always` — ; `show ip
 * ospf` (« It is an autonomous system boundary router ») ; `show ip ospf
 * database external` (`Metric Type`, `TOS: 0`, `Metric:`, `Forward
 * Address`, `External Route Tag`) ; RFC 2328 §14.1 (retrait par
 * vieillissement premature d'une LSA propre).
 *
 * Limite assumee et enregistree : la route-map est stockee, rendue, et
 * dispense la route par defaut d'exister ; ses clauses `match` ne sont
 * evaluees nulle part dans le simulateur (voir TODO.md).
 *
 * Discrimination, mesuree sur le commit de base avec ce fichier copie :
 * 24 des 29 cas tombent. Passent des deux cotes cinq cas, nommes : les
 * TEMOINS (le laboratoire — adjacence Full et route O*E2 chez R2 avec la
 * commande nue —, `always` sans route par defaut, un routeur sans commande
 * qui n'est pas ASBR et dont la base n'a pas de section Type-5) et le refus
 * « sans route par defaut ni always, rien n'est originee », structurel : le
 * comportement de base est deja celui-la.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { Cable } from '@/network/hardware/Cable';
import { VirtualTimeScheduler, __setDefaultScheduler } from '@/events/Scheduler';

interface Shell { executeCommand(command: string): Promise<string> }

async function type(device: Shell, commands: readonly string[]): Promise<string> {
  let last = '';
  for (const command of commands) last = await device.executeCommand(command);
  return last;
}

let clock: VirtualTimeScheduler;

beforeEach(() => {
  clock = new VirtualTimeScheduler();
  __setDefaultScheduler(clock);
});

const UPSTREAM_DEFAULT = 'ip route 0.0.0.0 0.0.0.0 203.0.113.1';

async function lab(routerOspf: readonly string[], options: { defaultRoute?: boolean } = {}) {
  const r1 = new CiscoRouter('R1', 0, 0);
  const r2 = new CiscoRouter('R2', 0, 0);
  new Cable('r1-r2').connect(r1.getPort('GigabitEthernet0/0')!, r2.getPort('GigabitEthernet0/0')!);
  await type(r1, ['enable', 'configure terminal',
    'interface GigabitEthernet0/0', 'ip address 10.0.0.1 255.255.255.252',
    'ip ospf network point-to-point', 'no shutdown', 'exit',
    'interface GigabitEthernet0/1', 'ip address 203.0.113.2 255.255.255.0', 'no shutdown', 'exit',
    ...(options.defaultRoute === false ? [] : [UPSTREAM_DEFAULT]),
    'router ospf 1', 'router-id 1.1.1.1', 'network 10.0.0.0 0.0.0.3 area 0', ...routerOspf, 'end']);
  await type(r2, ['enable', 'configure terminal',
    'interface GigabitEthernet0/0', 'ip address 10.0.0.2 255.255.255.252',
    'ip ospf network point-to-point', 'no shutdown', 'exit',
    'router ospf 1', 'router-id 2.2.2.2', 'network 10.0.0.0 0.0.0.3 area 0', 'end']);
  clock.advance(60_000);
  return { r1, r2 };
}

const config = (r1: CiscoRouter, lines: readonly string[]) =>
  type(r1, ['configure terminal', 'router ospf 1', ...lines, 'end']);

const externalDetail = (router: CiscoRouter) => router.executeCommand('show ip ospf database external detail');
const ospfRoutes = (router: CiscoRouter) => router.executeCommand('show ip route ospf');
const summaryExternalCount = async (router: CiscoRouter) =>
  /Type-5 Ext\s+(\d+)/.exec(await router.executeCommand('show ip ospf database database-summary'))?.[1];

describe('LSA du routeur de bordure', () => {
  it('WITNESS: la commande nue originate une route par defaut que R2 apprend', async () => {
    const { r1, r2 } = await lab(['default-information originate']);
    expect(await r1.executeCommand('show ip ospf neighbor')).toContain('FULL');
    expect(await r2.executeCommand('show ip ospf neighbor')).toContain('FULL');
    expect(await ospfRoutes(r2)).toMatch(/^O\*E2\s+0\.0\.0\.0\/0 \[110\//m);
  });

  it('la metrique vaut 10 si ni metric ni default-metric', async () => {
    const { r2 } = await lab(['default-information originate']);
    const detail = await externalDetail(r2);
    expect(detail).toContain('Metric: 10');
    expect(detail).toContain('Metric Type: 2');
    expect(await ospfRoutes(r2)).toMatch(/^O\*E2\s+0\.0\.0\.0\/0 \[110\/10\]/m);
  });

  it('default-metric fournit la metrique quand metric est omis', async () => {
    const { r2 } = await lab(['default-metric 30', 'default-information originate']);
    expect(await externalDetail(r2)).toContain('Metric: 30');
  });

  it('metric l\'emporte sur default-metric', async () => {
    const { r2 } = await lab(['default-metric 30', 'default-information originate metric 7']);
    expect(await externalDetail(r2)).toContain('Metric: 7');
  });

  it('metric 100 metric-type 1 : la LSA porte les deux et la route est E1 a 100 + cout', async () => {
    const { r2 } = await lab(['default-information originate metric 100 metric-type 1']);
    const detail = await externalDetail(r2);
    expect(detail).toContain('Metric Type: 1 (Comparable directly to link state metric)');
    expect(detail).toContain('Metric: 100');
    expect(await ospfRoutes(r2)).toMatch(/^O\*E1\s+0\.0\.0\.0\/0 \[110\/101\]/m);
  });

  it('les mots se tapent dans n\'importe quel ordre', async () => {
    const { r2 } = await lab(['default-information originate metric-type 1 always metric 55']);
    const detail = await externalDetail(r2);
    expect(detail).toContain('Metric: 55');
    expect(detail).toContain('Metric Type: 1');
  });
});

describe('quand la route par defaut est originee', () => {
  it('sans route par defaut ni always, rien n\'est originee', async () => {
    const { r2 } = await lab(['default-information originate'], { defaultRoute: false });
    expect(await summaryExternalCount(r2)).toBe('0');
    expect(await ospfRoutes(r2)).not.toContain('0.0.0.0/0');
  });

  it('WITNESS: always originate sans route par defaut', async () => {
    const { r2 } = await lab(['default-information originate always'], { defaultRoute: false });
    expect(await summaryExternalCount(r2)).toBe('1');
    expect(await ospfRoutes(r2)).toMatch(/^O\*E2\s+0\.0\.0\.0\/0/m);
  });

  it('une route-map dispense la route par defaut d\'exister et ignore always', async () => {
    const { r2 } = await lab(['default-information originate route-map ISP-UP'], { defaultRoute: false });
    expect(await summaryExternalCount(r2)).toBe('1');
  });

  it('la route par defaut qui disparait retire la LSA de toute la base', async () => {
    const { r1, r2 } = await lab(['default-information originate']);
    expect(await summaryExternalCount(r2)).toBe('1');
    await type(r1, ['configure terminal', 'no ip route 0.0.0.0 0.0.0.0 203.0.113.1', 'end']);
    clock.advance(5_000);
    expect(await summaryExternalCount(r2)).toBe('0');
    expect(await ospfRoutes(r2)).not.toContain('0.0.0.0/0');
  });

  it('la route par defaut qui apparait fait originer la LSA', async () => {
    const { r1, r2 } = await lab(['default-information originate'], { defaultRoute: false });
    expect(await summaryExternalCount(r2)).toBe('0');
    await type(r1, ['configure terminal', UPSTREAM_DEFAULT, 'end']);
    clock.advance(5_000);
    expect(await summaryExternalCount(r2)).toBe('1');
  });
});

describe('no default-information originate', () => {
  it('retire la LSA, la ligne et la qualite d\'ASBR', async () => {
    const { r1, r2 } = await lab(['default-information originate metric 20']);
    expect(await summaryExternalCount(r2)).toBe('1');
    await config(r1, ['no default-information originate']);
    clock.advance(5_000);
    expect(await summaryExternalCount(r2)).toBe('0');
    expect(await r1.executeCommand('show running-config | section router ospf')).not.toContain('default-information');
    expect(await r1.executeCommand('show ip ospf')).not.toContain('autonomous system boundary router');
  });

  it('accepte la meme grammaire que la forme positive', async () => {
    const { r1 } = await lab(['default-information originate always metric 5']);
    expect(await r1.executeCommand('show running-config | section router ospf')).toContain('default-information originate always metric 5');
    await config(r1, ['no default-information originate always metric 5']);
    expect(await r1.executeCommand('show running-config | section router ospf')).not.toContain('default-information');
  });
});

describe('grammaire', () => {
  it('metric-type n\'accepte que 1 et 2', async () => {
    const { r1 } = await lab([]);
    const reply = await type(r1, ['configure terminal', 'router ospf 1', 'default-information originate metric-type 7']);
    expect(reply).toContain('% Invalid input detected');
    expect(await r1.executeCommand('show running-config | section router ospf')).not.toContain('default-information');
  });

  it('un mot-cle sans valeur est incomplet', async () => {
    const { r1 } = await lab([]);
    await type(r1, ['configure terminal', 'router ospf 1']);
    expect(await r1.executeCommand('default-information originate metric')).toContain('% Incomplete command.');
    expect(await r1.executeCommand('default-information originate route-map')).toContain('% Incomplete command.');
  });

  it('un mot inconnu, une valeur hors plage et un mot repete sont refuses', async () => {
    const { r1 } = await lab([]);
    await type(r1, ['configure terminal', 'router ospf 1']);
    expect(await r1.executeCommand('default-information originate zorglub')).toContain('% Invalid input detected');
    expect(await r1.executeCommand('default-information originate metric 16777215')).toContain('% Invalid input detected');
    expect(await r1.executeCommand('default-information originate metric 1 metric 2')).toContain('% Invalid input detected');
  });
});

describe('running-config', () => {
  it('rend la ligne complete dans l\'ordre du manuel, sans le type 2 par defaut', async () => {
    const { r1 } = await lab(['default-information originate route-map ISP-UP metric-type 1 metric 100 always']);
    expect(await r1.executeCommand('show running-config | section router ospf'))
      .toContain(' default-information originate always metric 100 metric-type 1 route-map ISP-UP');
  });

  it('default-metric se rend, se retire par no default-metric', async () => {
    const { r1 } = await lab(['default-metric 30']);
    expect(await r1.executeCommand('show running-config | section router ospf')).toContain(' default-metric 30');
    await config(r1, ['no default-metric']);
    expect(await r1.executeCommand('show running-config | section router ospf')).not.toContain('default-metric');
  });

  it('rejouee sur un routeur neuf, la ligne rend le meme etat', async () => {
    const { r1 } = await lab(['default-metric 12', 'default-information originate always metric 9 metric-type 1']);
    const rendered = await r1.executeCommand('show running-config | section router ospf');
    expect(rendered).toContain(' default-information originate always metric 9 metric-type 1');
    const lines = rendered.split('\n').filter(line => line.startsWith(' ')).map(line => line.trim());
    const replica = new CiscoRouter('R9', 0, 0);
    await type(replica, ['enable', 'configure terminal', 'router ospf 1', ...lines, 'end']);
    expect(await replica.executeCommand('show running-config | section router ospf')).toBe(rendered);
  });
});

describe('show ip ospf', () => {
  it('WITNESS: un routeur sans commande n\'est pas un ASBR', async () => {
    const { r1, r2 } = await lab([]);
    expect(await r1.executeCommand('show ip ospf')).not.toContain('autonomous system boundary router');
    expect(await r2.executeCommand('show ip ospf')).not.toContain('autonomous system boundary router');
  });

  it('default-information originate fait de R1 un ASBR, pas de R2', async () => {
    const { r1, r2 } = await lab(['default-information originate']);
    expect(await r1.executeCommand('show ip ospf')).toContain(' It is an autonomous system boundary router');
    expect(await r2.executeCommand('show ip ospf')).not.toContain('autonomous system boundary router');
  });

  it('redistribute static fait aussi d\'R1 un ASBR', async () => {
    const { r1 } = await lab(['redistribute static subnets']);
    expect(await r1.executeCommand('show ip ospf')).toContain('It is an autonomous system boundary router');
  });
});

describe('show ip ospf database', () => {
  it('liste la LSA Type-5 sur l\'originateur comme sur son voisin', async () => {
    const { r1, r2 } = await lab(['default-information originate']);
    for (const router of [r1, r2]) {
      const database = await router.executeCommand('show ip ospf database');
      expect(database).toContain('Type-5 AS External Link States');
      expect(database).toMatch(/^0\.0\.0\.0\s+1\.1\.1\.1\s+\d+\s+0x8000000\d/m);
    }
  });

  it('WITNESS: sans LSA externe, pas de section Type-5', async () => {
    const { r2 } = await lab([]);
    expect(await r2.executeCommand('show ip ospf database')).not.toContain('Type-5');
  });

  it('le detail ecrit Metric: et TOS: 0 comme le manuel', async () => {
    const { r2 } = await lab(['default-information originate']);
    const detail = await externalDetail(r2);
    expect(detail).toContain('TOS: 0');
    expect(detail).toContain('Metric: 10');
    expect(detail).not.toContain('MTRIC');
  });

  it('une base sans LSA externe ne fabrique ni ligne ni message', async () => {
    const { r2 } = await lab([]);
    const output = await r2.executeCommand('show ip ospf database external 9.9.9.9');
    expect(output).not.toContain('9.9.9.9');
    expect(output).not.toContain('No external LSAs');
  });
});

describe('retrait d\'une LSA externe', () => {
  it('no redistribute static retire les LSA Type-5 de R2', async () => {
    const { r1, r2 } = await lab(['redistribute static subnets'], { defaultRoute: false });
    await type(r1, ['configure terminal', 'ip route 192.168.77.0 255.255.255.0 203.0.113.1', 'end']);
    clock.advance(5_000);
    expect(await summaryExternalCount(r2)).toBe('1');
    await config(r1, ['no redistribute static']);
    clock.advance(5_000);
    expect(await summaryExternalCount(r2)).toBe('0');
  });
});

describe('Huawei default-route-advertise', () => {
  async function huaweiLab(command: string) {
    const h1 = new HuaweiRouter('H1', 0, 0);
    const r2 = new CiscoRouter('R2', 0, 0);
    new Cable('h1-r2').connect(h1.getPort('GE0/0/0')!, r2.getPort('GigabitEthernet0/0')!);
    await type(h1, ['system-view',
      'interface GigabitEthernet0/0/0', 'ip address 10.0.34.3 255.255.255.0', 'quit',
      'ospf 1 router-id 3.3.3.3', 'area 0', 'network 10.0.34.0 0.0.0.255', 'quit', command, 'return']);
    await type(r2, ['enable', 'configure terminal',
      'interface GigabitEthernet0/0', 'ip address 10.0.34.4 255.255.255.0', 'no shutdown', 'exit',
      'router ospf 1', 'router-id 4.4.4.4', 'network 10.0.34.0 0.0.0.255 area 0', 'end']);
    clock.advance(60_000);
    return r2;
  }

  it('WITNESS: la commande nue originate avec la metrique 1 du simulateur', async () => {
    const r2 = await huaweiLab('default-route-advertise always');
    expect(await externalDetail(r2)).toContain('Metric: 1');
  });

  it('cost et type sont evalues', async () => {
    const r2 = await huaweiLab('default-route-advertise always cost 5 type 1');
    const detail = await externalDetail(r2);
    expect(detail).toContain('Metric: 5');
    expect(detail).toContain('Metric Type: 1');
  });
});
