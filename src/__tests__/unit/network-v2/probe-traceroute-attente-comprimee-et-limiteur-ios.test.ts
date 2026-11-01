/**
 * Un `traceroute -w S` attend S secondes les sondes d'un saut qui ne repondent pas ; le simulateur plafonne cette attente a
 * 100 ms (PROBE_WAIT_CAP_MS) pour ne pas figer l'interface. Le limiteur d'inaccessibles d'IOS (1 par 500 ms,
 * IcmpUnreachableRateLimit) lisait l'horloge du routeur, qui n'avancait donc que de 100 ms par saut sans reponse : le saut
 * suivant tombait encore dans la fenetre de 500 ms et etait lui aussi refuse (TODO.md [traceroute]). Mesure : deux
 * `traceroute -U -p 53 -q 1 -w 1 -m 3` de suite vers l'adresse d'un routeur Cisco rendaient `2 *` PUIS `3 *` ; un vrai `-w 1`
 * laisse passer 1 s entre les sauts, donc le saut 3 est admis. Les sondes d'un MEME saut partent ensemble (Linux : -N 16) :
 * elles restent refusees ensemble, ce que garde ios-icmp-unreachable-rate-limit (`X ms * *`).
 * Corrige : l'attente non effectuee (S - plafond) est ajoutee a l'horloge de trajet (PathClock.wait) une fois par saut qui
 * compte une sonde sans reponse, et le limiteur lit l'horloge du routeur PLUS l'horizon du trajet.
 *
 * Discrimine par `git stash` sur src/network : 1 des 3 cas tombe avant. TEMOINS : la premiere commande est admise, et sans
 * sonde sans reponse rien ne change.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';

let pc: LinuxPC;

beforeEach(() => {
  resetCounters(); resetDeviceCounters();
  const r1 = new CiscoRouter('R1');
  const r2 = new CiscoRouter('R2');
  pc = new LinuxPC('linux-pc', 'PC');
  r1.configureInterface('GigabitEthernet0/1', new IPAddress('10.0.2.1'), new SubnetMask('255.255.255.252'));
  r2.configureInterface('GigabitEthernet0/0', new IPAddress('10.0.2.2'), new SubnetMask('255.255.255.252'));
  r1.configureInterface('GigabitEthernet0/0', new IPAddress('10.0.1.1'), new SubnetMask('255.255.255.0'));
  pc.configureInterface('eth0', new IPAddress('10.0.1.2'), new SubnetMask('255.255.255.0'));
  pc.setDefaultGateway(new IPAddress('10.0.1.1'));
  r1.addStaticRoute(new IPAddress('10.0.3.0'), new SubnetMask('255.255.255.0'), new IPAddress('10.0.2.2'));
  r2.addStaticRoute(new IPAddress('10.0.1.0'), new SubnetMask('255.255.255.0'), new IPAddress('10.0.2.1'));
  new Cable('a').connect(r1.getPort('GigabitEthernet0/1')!, r2.getPort('GigabitEthernet0/0')!);
  new Cable('c').connect(pc.getPort('eth0')!, r1.getPort('GigabitEthernet0/0')!);
});

const asRoot = (command: string): Promise<string> => {
  const machine = pc as unknown as { executor: { runAsUser<T>(user: string, run: () => Promise<T>): Promise<T> } };
  return machine.executor.runAsUser('root', () => pc.executeCommand(command));
};

const TRACE = 'traceroute -n -U -p 53 -q 1 -w 1 -m 3 10.0.2.2';

describe('traceroute against the IOS unreachable rate limit', () => {
  it('WITNESS — the first UDP probe to the router address is answered', async () => {
    expect(await asRoot(TRACE)).toMatch(/\n 2 {2}10\.0\.2\.2 /);
  });

  it('a hop refused by the limit is a star, and the wait that follows lets the next hop through', async () => {
    await asRoot(TRACE);
    const lines = (await asRoot(TRACE)).split('\n');
    expect(lines.find((line) => line.startsWith(' 2'))?.trim()).toBe('2  *');
    expect(lines.find((line) => line.startsWith(' 3'))).toMatch(/^ 3 {2}10\.0\.2\.2 /);
  });

  it('WITNESS — with no unanswered probe nothing changes', async () => {
    expect(await asRoot('traceroute -n -q 1 -w 1 -m 2 10.0.2.2')).toMatch(/\n 2 {2}10\.0\.2\.2 /);
  });
});
