/**
 * Une interface qu'une instruction `network` ajoute a EIGRP emet ses
 * hellos periodiques, et l'adjacence tient sans que personne ne tape rien.
 *
 * Mesure de depart (aa1d6480), deux Cisco relies, `router eigrp 10` puis
 * `network 10.0.12.0 0.0.0.255` : la CLI poussait l'instruction dans la
 * configuration du moteur sans le prevenir ; ses minuteries de hello
 * avaient ete armees a `router eigrp`, quand aucune interface n'etait
 * active, et rien ne les armait ensuite. Apres la ronde de convergence de
 * la commande, plus aucun hello : 15 s plus tard (temps de maintien) les
 * deux voisins se declaraient « holding time expired », la route apprise
 * quittait la RIB, et la commande suivante — une lecture comprise —
 * reformait l'adjacence. `passive-interface` et `no network` passaient
 * par le meme contournement.
 *
 * Autorite : RFC 7868 §5.3.1 — chaque interface active multicaste un
 * hello a son intervalle (5 s par defaut), et l'expiration du temps de
 * maintien est ce qui declare un voisin silencieux perdu ; Cisco IOS,
 * `network` en mode `router eigrp`.
 *
 * Discrimination, mesuree sur le commit de base (aa1d6480) avec ce
 * fichier copie : 5 des 6 cas tombent — deux expirations du temps de
 * maintien en une minute de silence, aucun hello periodique, la route
 * quittant la RIB. Passe des deux cotes le TEMOIN : l'adjacence se forme
 * a la configuration.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { Cable } from '@/network/hardware/Cable';
import { Logger } from '@/network/core/Logger';
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
    'interface Loopback1', 'ip address 172.16.1.1 255.255.255.0', 'exit',
    'router eigrp 10', 'network 10.0.12.0 0.0.0.255', 'network 172.16.1.0 0.0.0.255', 'end']);
  await type(r2, ['enable', 'configure terminal',
    'interface GigabitEthernet0/0', 'ip address 10.0.12.2 255.255.255.0', 'no shutdown', 'exit',
    'router eigrp 10', 'network 10.0.12.0 0.0.0.255', 'end']);
  return { r1, r2 };
}

const learned = (router: CiscoRouter) => router.getRoutingTable()
  .filter((route) => route.type === 'eigrp').map((route) => `${route.network}/${route.mask.toCIDR()}`);

const holdExpiries = () => Logger.getLogs()
  .filter((entry) => entry.event === 'eigrp:hold-expired').length;

describe('EIGRP hellos keep an adjacency alive with nobody at the CLI', () => {
  it('WITNESS: the adjacency forms at configuration', async () => {
    const { r2 } = await pair();
    expect(learned(r2)).toContain('172.16.1.0/24');
  });

  it('a minute of silence expires no neighbour', async () => {
    await pair();
    clock.advance(60_000);
    expect(holdExpiries()).toBe(0);
  });

  it('the learned route is still in the RIB a minute later, without a read to revive it', async () => {
    const { r2 } = await pair();
    clock.advance(60_000);
    expect(learned(r2)).toContain('172.16.1.0/24');
  });

  it('each active interface multicasts a hello every five seconds', async () => {
    const { r1 } = await pair();
    const before = r1.getEIGRPEngine().getInterfaceTraffic('GigabitEthernet0/0').helloSent;
    clock.advance(60_000);
    const sent = r1.getEIGRPEngine().getInterfaceTraffic('GigabitEthernet0/0').helloSent - before;
    expect(sent).toBeGreaterThanOrEqual(12);
  });
});

describe('the engine hears every change to its interface set', () => {
  it('an interface taken back from passive resumes its hellos', async () => {
    const { r1, r2 } = await pair();
    await type(r1, ['configure terminal', 'router eigrp 10', 'passive-interface GigabitEthernet0/0', 'end']);
    await type(r1, ['configure terminal', 'router eigrp 10', 'no passive-interface GigabitEthernet0/0', 'end']);
    clock.advance(60_000);
    expect(learned(r2)).toContain('172.16.1.0/24');
  });

  it('removing the network statement drops the neighbour at once', async () => {
    const { r2 } = await pair();
    await type(r2, ['configure terminal', 'router eigrp 10', 'no network 10.0.12.0', 'end']);
    expect(r2.getEIGRPEngine().getNeighbors().map((n) => n.address)).not.toContain('10.0.12.1');
    expect(learned(r2)).not.toContain('172.16.1.0/24');
  });
});
