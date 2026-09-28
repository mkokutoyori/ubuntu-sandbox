/*
 * `timeout` n'arretait rien.
 *
 * Mesure de depart, sur deux postes Linux d'un meme LAN, horloge
 * virtuelle :
 *
 *   timeout 1 sleep 5; echo rc=$?        rc=0
 *   timeout 2 ping 10.0.0.2; echo rc=$?  4 echos, les statistiques, rc=0,
 *                                        3000 ms d'horloge
 *
 * La duree etait lue puis ignoree (regle 6), et le chemin synchrone
 * portait en dur une reponse fabriquee : toute ligne `timeout … ssh …
 * trap … INT … sleep` rendait `caught` et 130 sans rien executer.
 *
 * L'AUTORITE EST COREUTILS (`src/timeout.c`, `src/operand2sig.c`, lus
 * sur coreutils/coreutils) :
 *  - a l'echeance, `cleanup` envoie le signal (TERM par defaut, `-s`) au
 *    processus surveille, et `-k` arme un second delai apres lequel part
 *    un KILL ;
 *  - la sortie vaut 124 (`EXIT_TIMEDOUT`) si le delai a expire, sauf
 *    `--preserve-status`, et une mort par KILL force la preservation :
 *    `128 + signal` ;
 *  - une duree est un nombre, suivi au plus d'un suffixe s, m, h ou d ;
 *    sinon « invalid time interval 'X' » et 125 (`EXIT_CANCELED`), comme
 *    un signal inconnu (« 'X': invalid signal ») et un operande manquant
 *    (la seule ligne « Try 'timeout --help' … ») ;
 *  - `-v` ecrit « sending signal TERM to command 'X' ».
 * Et iputils : `ping` n'attrape que SIGINT et SIGALRM (`sigexit`) ; sous
 * SIGTERM il meurt sans statistiques, sous SIGINT il les ecrit et sort
 * par `finish`.
 *
 * Ecrite a l'aveugle contre ces sources, avant de toucher l'executeur.
 *
 * Et tcpdump : sous `timeout`, la capture tenait une fenetre de 200 ms
 * de temps REEL, puis rendait la main ; elle court maintenant jusqu'au
 * signal, et SIGTERM la termine proprement (`cleanup`, avec son pied).
 *
 * Discriminee contre l'etat d'avant (`git stash push -- src/network`) :
 * 10 des 13 cas tombent. Passent des deux cotes les trois TEMOINS : une
 * commande finie a temps garde son statut (`sleep 1`, `ping -c 1`), et
 * une duree a unite (`0.5m`) plus longue que la commande — l'ancien
 * `timeout` n'arretant jamais rien, ils ne pouvaient pas tomber, et ils
 * prouvent que le nouveau n'arrete pas ce qu'il ne doit pas arreter.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resetCounters, MACAddress } from '@/network/core/types';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { VirtualTimeScheduler, __setDefaultScheduler } from '@/events/Scheduler';

let scheduler: VirtualTimeScheduler;

beforeEach(() => {
  resetCounters();
  MACAddress.resetCounter();
  resetDeviceCounters();
  Logger.reset();
  EquipmentRegistry.resetInstance();
  scheduler = new VirtualTimeScheduler();
  __setDefaultScheduler(scheduler);
});

afterEach(() => { __setDefaultScheduler(null); });

const run = (pc: LinuxPC, command: string): Promise<string> =>
  scheduler.advanceUntilSettled(Promise.resolve(pc.executeCommand(command)));

async function twoHosts(): Promise<{ a: LinuxPC; b: LinuxPC }> {
  const sw = new GenericSwitch('switch-generic', 'SW', 4, 0, 0);
  const a = new LinuxPC('linux-pc', 'A', 0, 0);
  const b = new LinuxPC('linux-pc', 'B', 0, 0);
  new Cable('a').connect(a.getPorts()[0], sw.getPorts()[0]);
  new Cable('b').connect(b.getPorts()[0], sw.getPorts()[1]);
  await run(a, 'sudo ip addr add 10.0.0.1/24 dev eth0');
  await run(b, 'sudo ip addr add 10.0.0.2/24 dev eth0');
  return { a, b };
}

const lab = async (): Promise<LinuxPC> => (await twoHosts()).a;

const TRY = "Try 'timeout --help' for more information.";

describe('timeout stops what it wraps', () => {
  it('a command that outlives the duration is killed: 124', async () => {
    expect(await run(await lab(), 'timeout 1 sleep 5; echo rc=$?')).toMatch(/^rc=124$/m);
  });

  it('a command that ends in time keeps its own status — WITNESS', async () => {
    expect(await run(await lab(), 'timeout 5 sleep 1; echo rc=$?')).toMatch(/^rc=0$/m);
  });

  it('--preserve-status gives the status of the killed command: 128 + TERM', async () => {
    expect(await run(await lab(), 'timeout --preserve-status 1 sleep 5; echo rc=$?')).toMatch(/^rc=143$/m);
  });

  it('a command killed by KILL always shows it: 137', async () => {
    expect(await run(await lab(), 'timeout -s KILL 1 sleep 5; echo rc=$?')).toMatch(/^rc=137$/m);
  });

  it('a duration takes a unit — WITNESS', async () => {
    expect(await run(await lab(), 'timeout 0.5m sleep 20; echo rc=$?')).toMatch(/^rc=0$/m);
  });

  it('-v says which signal it sends', async () => {
    expect(await run(await lab(), 'timeout -v 1 sleep 5'))
      .toContain("timeout: sending signal TERM to command 'sleep'");
  });
});

describe('timeout refuses what it cannot read', () => {
  it('a duration that is not one', async () => {
    const pc = await lab();

    expect(await run(pc, 'timeout 1x sleep 5')).toBe(`timeout: invalid time interval '1x'\n${TRY}`);
    expect(await run(pc, 'timeout 1x sleep 5; echo rc=$?')).toMatch(/^rc=125$/m);
  });

  it('a signal that is not one', async () => {
    expect(await run(await lab(), 'timeout -s FOO 1 sleep 5')).toBe(`timeout: 'FOO': invalid signal\n${TRY}`);
  });

  it('a missing command', async () => {
    const pc = await lab();

    expect(await run(pc, 'timeout 5')).toBe(TRY);
    expect(await run(pc, 'timeout 5; echo rc=$?')).toMatch(/^rc=125$/m);
  });
});

describe('timeout around a network command', () => {
  it('ping is stopped at the deadline, without statistics', async () => {
    const out = await run(await lab(), 'timeout 2 ping 10.0.0.2; echo rc=$?');

    expect(out.split('\n').filter((l) => /^64 bytes from/.test(l))).toHaveLength(2);
    expect(out).not.toContain('ping statistics');
    expect(out).toMatch(/^rc=124$/m);
  });

  it('under SIGINT ping writes its statistics before leaving', async () => {
    const out = await run(await lab(), 'timeout -s INT 2 ping 10.0.0.2; echo rc=$?');

    expect(out).toMatch(/^2 packets transmitted, 2 received, 0% packet loss/m);
    expect(out).toMatch(/^rc=124$/m);
  });

  it('tcpdump captures until the deadline, then writes its footer', async () => {
    const { a, b } = await twoHosts();
    const capture = Promise.resolve(a.executeCommand('sudo timeout 3 tcpdump -i eth0 -n icmp; echo rc=$?'));
    await run(b, 'ping -c 2 10.0.0.1');
    const out = await scheduler.advanceUntilSettled(capture);

    expect(out.split('\n').filter((l) => /ICMP echo request/.test(l))).toHaveLength(2);
    expect(out).toMatch(/^4 packets captured$/m);
    expect(out).toMatch(/^rc=124$/m);
  });

  it('a ping that ends in time is left alone — WITNESS', async () => {
    const out = await run(await lab(), 'timeout 5 ping -c 1 10.0.0.2; echo rc=$?');

    expect(out).toMatch(/^1 packets transmitted, 1 received/m);
    expect(out).toMatch(/^rc=0$/m);
  });
});
