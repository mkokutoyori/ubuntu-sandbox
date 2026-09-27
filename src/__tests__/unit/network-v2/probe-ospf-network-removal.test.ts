/**
 * Une instruction `network` se retire, et l'activation OSPF d'une
 * interface se configure, se rend et se retire.
 *
 * Mesure de depart (608a5653) : OSPFEngine.removeNetwork existait, mais
 * aucune CLI ne l'atteignait — ni `no network … area` (Cisco) ni
 * `undo network` (VRP) ; et il ne faisait que retirer l'instruction :
 * l'interface couverte restait active et annoncee. `ip ospf <pid> area
 * <aire>` activait l'interface sans rien retenir : la ligne manquait a
 * `show running-config`, `no ip ospf … area` n'existait pas, et changer
 * d'aire une interface deja active ne faisait que reecrire son champ.
 * En chemin : une aire atteinte seulement par `ip ospf … area` n'existait
 * pas pour le moteur (ni SPF ni resumes), et un ABR ne resumait pas ses
 * propres reseaux stub d'une aire vers l'autre — Loopback0 passee en aire
 * 1 disparaissait de R2 au lieu d'y revenir en O IA.
 *
 * Autorites : Cisco IOS, `network area` et `ip ospf area` (forme `no` :
 * l'interface quitte OSPF) ; Huawei VRP, `network` en vue d'aire (forme
 * `undo`) ; RFC 2328 §12.4 — une interface qui quitte OSPF change la
 * router-LSA ; §16.1 (2) — les liens stub du routeur de calcul lui-meme
 * donnent des routes intra-aire ; §12.4.3 — un ABR en fait des
 * summary-LSA dans ses autres aires.
 *
 * Discrimination, mesuree sur le commit de base (608a5653) avec ce
 * fichier copie : 7 des 8 cas tombent. Passe des deux cotes le TEMOIN :
 * l'adjacence apprend a R2 la loopback de R1.
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

async function pair() {
  const r1 = new CiscoRouter('R1', 0, 0);
  const r2 = new CiscoRouter('R2', 0, 0);
  new Cable('r1-r2').connect(r1.getPort('GigabitEthernet0/0')!, r2.getPort('GigabitEthernet0/0')!);
  await type(r1, ['enable', 'configure terminal',
    'interface GigabitEthernet0/0', 'ip address 10.0.12.1 255.255.255.0', 'no shutdown', 'exit',
    'interface Loopback0', 'ip address 1.1.1.1 255.255.255.255', 'exit',
    'interface Loopback5', 'ip address 5.5.5.5 255.255.255.255', 'exit',
    'router ospf 1', 'router-id 1.1.1.1',
    'network 10.0.12.0 0.0.0.255 area 0', 'network 1.1.1.1 0.0.0.0 area 0', 'end']);
  await type(r2, ['enable', 'configure terminal',
    'interface GigabitEthernet0/0', 'ip address 10.0.12.2 255.255.255.0', 'no shutdown', 'exit',
    'router ospf 1', 'router-id 2.2.2.2', 'network 10.0.12.0 0.0.0.255 area 0', 'end']);
  clock.advance(60_000);
  return { r1, r2 };
}

const ospfRoutes = (router: CiscoRouter) => router.executeCommand('show ip route ospf');

describe('Cisco: no network … area', () => {
  it('WITNESS: the adjacency teaches R2 the loopback of R1', async () => {
    const { r2 } = await pair();
    expect(await ospfRoutes(r2)).toContain('1.1.1.1/32');
  });

  it('withdrawing the loopback network withdraws the route from R2', async () => {
    const { r1, r2 } = await pair();
    await type(r1, ['configure terminal', 'router ospf 1', 'no network 1.1.1.1 0.0.0.0 area 0', 'end']);
    clock.advance(10_000);
    expect(await ospfRoutes(r2)).not.toContain('1.1.1.1/32');
  });

  it('the statement leaves the running configuration and the interface leaves OSPF', async () => {
    const { r1 } = await pair();
    await type(r1, ['configure terminal', 'router ospf 1', 'no network 1.1.1.1 0.0.0.0 area 0', 'end']);
    expect(await r1.executeCommand('show running-config')).not.toContain('network 1.1.1.1 0.0.0.0 area 0');
    expect(await r1.executeCommand('show ip ospf interface brief')).not.toMatch(/^Lo0 /m);
  });

  it('withdrawing the transit network tears the adjacency down', async () => {
    const { r1 } = await pair();
    await type(r1, ['configure terminal', 'router ospf 1', 'no network 10.0.12.0 0.0.0.255 area 0', 'end']);
    expect(await r1.executeCommand('show ip ospf neighbor')).not.toContain('2.2.2.2');
  });
});

describe('Cisco: ip ospf <pid> area <area> on an interface', () => {
  it('enables the interface and shows in the running configuration', async () => {
    const { r1, r2 } = await pair();
    await type(r1, ['configure terminal', 'interface Loopback5', 'ip ospf 1 area 0', 'end']);
    clock.advance(10_000);
    expect(await ospfRoutes(r2)).toContain('5.5.5.5/32');
    expect(await r1.executeCommand('show running-config')).toMatch(/interface Loopback5\n(?: .*\n)* ip ospf 1 area 0\n/);
  });

  it('no ip ospf <pid> area <area> takes the interface back out', async () => {
    const { r1, r2 } = await pair();
    await type(r1, ['configure terminal', 'interface Loopback5', 'ip ospf 1 area 0', 'end']);
    clock.advance(10_000);
    await type(r1, ['configure terminal', 'interface Loopback5', 'no ip ospf 1 area 0', 'end']);
    clock.advance(10_000);
    expect(await ospfRoutes(r2)).not.toContain('5.5.5.5/32');
  });

  it('moving an interface to another area re-announces it from there', async () => {
    const { r1, r2 } = await pair();
    await type(r1, ['configure terminal', 'interface Loopback0', 'ip ospf 1 area 1', 'end']);
    clock.advance(10_000);
    expect(await r1.executeCommand('show ip ospf interface Loopback0')).toMatch(/Area 1\b/);
    expect(await ospfRoutes(r2)).toMatch(/O IA\s+1\.1\.1\.1\/32/);
  });
});

describe('VRP: undo network', () => {
  it('withdrawing the transit network tears the adjacency down', async () => {
    const h1 = new HuaweiRouter('H1', 0, 0);
    const h2 = new HuaweiRouter('H2', 0, 0);
    new Cable('h1-h2').connect(h1.getPort('GE0/0/0')!, h2.getPort('GE0/0/0')!);
    for (const [router, octet] of [[h1, 3], [h2, 4]] as const) {
      await type(router, ['system-view',
        'interface GigabitEthernet0/0/0', `ip address 10.0.34.${octet} 255.255.255.0`, 'quit',
        `ospf 1 router-id ${octet}.${octet}.${octet}.${octet}`, 'area 0', 'network 10.0.34.0 0.0.0.255', 'return']);
    }
    clock.advance(60_000);
    await type(h1, ['system-view', 'ospf 1', 'area 0', 'undo network 10.0.34.0 0.0.0.255', 'return']);
    expect(await h1.executeCommand('display ospf peer brief')).not.toContain('4.4.4.4');
  });
});
