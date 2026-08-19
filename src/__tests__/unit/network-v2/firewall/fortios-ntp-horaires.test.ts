/**
 * Les trois derniers points ouverts de la phase 2 : `config system ntp`,
 * `config firewall schedule onetime`, `config firewall schedule group`.
 *
 * Ecrite A L'AVEUGLE contre ce qu'un vrai FortiGate fait :
 *
 *   1. **Un horaire ponctuel est une FENETRE ABSOLUE** — `HH:MM
 *      YYYY/MM/DD` des deux cotes, verifie contre la reference CLI de
 *      Fortinet. Avant sa date il ne s'applique pas, pendant si, apres
 *      plus. Un horaire qui serait toujours actif ne serait pas un
 *      horaire ponctuel.
 *   2. **Un groupe d'horaires est l'UNION de ses membres** : la regle
 *      passe des qu'UN membre est actif.
 *   3. **Une politique liee a un horaire inactif NE LAISSE PAS PASSER.**
 *      C'est le seul controle qui compte : un horaire qui s'affiche mais
 *      ne filtre pas est un decor.
 *   4. **`config system ntp` regle un vrai agent** — le socle NTP existe
 *      et sert deja le routeur ; ce qui manquait etait le branchement.
 *
 * Discrimination (`git stash push -- src/network/`) : 9 des 12 cas
 * tombent avant correctif. Les 3 autres sont nommes ici plutot que
 * laisses a decouvrir, et AUCUN ne prouve quoi que ce soit du mecanisme :
 * les deux cas « laisse passer » et le cas du membre inexistant passaient
 * parce que la table entiere etait absente, donc `set schedule "<nom>"`
 * etait refuse et la politique gardait son defaut `always` — le paquet
 * passait pour la raison inverse de celle qu'on mesure.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { FortiShell } from '@/network/devices/firewall/vendors/fortios/FortiShell';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { pingOnSimulatedClock } from '../../../support/fastPing';

interface Cmd { executeCommand(cmd: string): Promise<string> }

const runOn = (d: Cmd, cmds: string[]) =>
  cmds.reduce(async (p, c) => { await p; await d.executeCommand(c); }, Promise.resolve<unknown>(undefined));

function run(sh: FortiShell, ...lines: string[]): string {
  let last = '';
  for (const line of lines) last = sh.execute(line);
  return last;
}

async function laboratoire(maintenant?: number) {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();

  const horloge = { valeur: maintenant ?? Date.parse('2026-08-20T12:00:00Z') };
  const fw = new FortiGate('firewall-fortinet', 'FGT', 0, 0, {
    now: () => horloge.valeur,
  });
  const sh = new FortiShell(fw);
  const poste = new LinuxPC('linux-pc', 'PC', -150, 0);
  const cible = new LinuxPC('linux-pc', 'CIBLE', 150, 0);

  new Cable('a').connect(poste.getPort('eth0')!, fw.getPort('port1')!);
  new Cable('b').connect(cible.getPort('eth0')!, fw.getPort('port2')!);

  run(sh,
    'config system interface',
    'edit "port1"', 'set mode static',
    'set ip 192.168.1.1 255.255.255.0', 'set allowaccess ping', 'next',
    'edit "port2"', 'set mode static',
    'set ip 203.0.113.1 255.255.255.0', 'set allowaccess ping', 'next', 'end');

  await runOn(poste, ['ip link set eth0 up', 'ip addr add 192.168.1.10/24 dev eth0',
    'ip route add default via 192.168.1.1']);
  await runOn(cible, ['ip link set eth0 up', 'ip addr add 203.0.113.10/24 dev eth0',
    'ip route add default via 203.0.113.1']);

  return { fw, sh, poste, cible, horloge };
}

function politique(sh: FortiShell, horaire: string): string {
  return run(sh, 'config firewall policy', 'edit 1',
    'set srcintf "port1"', 'set dstintf "port2"',
    'set srcaddr "all"', 'set dstaddr "all"',
    'set action accept', `set schedule "${horaire}"`, 'set service "ALL"',
    'next', 'end');
}

beforeEach(() => { Logger.reset(); });

describe('config firewall schedule onetime', () => {
  it('la configuration est acceptee et `show` la reproduit', async () => {
    const { sh } = await laboratoire();

    run(sh, 'config firewall schedule onetime', 'edit "maintenance"',
      'set start 23:00 2026/12/31', 'set end 01:00 2027/01/01', 'next', 'end');

    const rendu = sh.execute('show firewall schedule onetime');
    expect(rendu).toMatch(/edit "maintenance"/);
    expect(rendu).toMatch(/set start 23:00 2026\/12\/31/);
    expect(rendu).toMatch(/set end 01:00 2027\/01\/01/);
  });

  it('pendant sa fenetre, la politique laisse passer', async () => {
    const { sh, poste } = await laboratoire(Date.parse('2026-08-20T12:00:00Z'));

    run(sh, 'config firewall schedule onetime', 'edit "fenetre"',
      'set start 00:00 2026/08/20', 'set end 23:59 2026/08/20', 'next', 'end');
    politique(sh, 'fenetre');

    expect(await pingOnSimulatedClock(poste, 'ping -c 1 203.0.113.10'))
      .toMatch(/, 0% packet loss/);
  });

  it('AVANT sa fenetre, la politique ne laisse pas passer', async () => {
    const { sh, poste } = await laboratoire(Date.parse('2026-08-20T12:00:00Z'));

    run(sh, 'config firewall schedule onetime', 'edit "plus-tard"',
      'set start 00:00 2026/09/01', 'set end 23:59 2026/09/02', 'next', 'end');
    politique(sh, 'plus-tard');

    expect(await pingOnSimulatedClock(poste, 'ping -c 1 203.0.113.10'))
      .toMatch(/, 100% packet loss/);
  });

  it('APRES sa fenetre, la politique ne laisse plus passer', async () => {
    const { sh, poste } = await laboratoire(Date.parse('2026-08-20T12:00:00Z'));

    run(sh, 'config firewall schedule onetime', 'edit "passe"',
      'set start 00:00 2026/01/01', 'set end 23:59 2026/01/02', 'next', 'end');
    politique(sh, 'passe');

    expect(await pingOnSimulatedClock(poste, 'ping -c 1 203.0.113.10'))
      .toMatch(/, 100% packet loss/);
  });

  it('une date malformee est refusee', async () => {
    const { sh } = await laboratoire();

    const sortie = run(sh, 'config firewall schedule onetime', 'edit "bancal"',
      'set start 25:99 pas-une-date', 'next', 'end');

    expect(sortie).toMatch(/Command fail|value parse error|Invalid/i);
    run(sh, 'abort');
  });
});

describe('config firewall schedule group', () => {
  it('la configuration est acceptee et `show` la reproduit', async () => {
    const { sh } = await laboratoire();

    run(sh, 'config firewall schedule recurring', 'edit "matin"',
      'set day monday', 'set start 08:00', 'set end 12:00', 'next', 'end');
    run(sh, 'config firewall schedule group', 'edit "bureau"',
      'set member "matin"', 'next', 'end');

    const rendu = sh.execute('show firewall schedule group');
    expect(rendu).toMatch(/edit "bureau"/);
    expect(rendu).toMatch(/set member "matin"/);
  });

  it('le groupe est l`UNION de ses membres — un membre actif suffit', async () => {
    const { sh, poste } = await laboratoire(Date.parse('2026-08-20T12:00:00Z'));

    run(sh, 'config firewall schedule onetime', 'edit "inactif"',
      'set start 00:00 2026/01/01', 'set end 23:59 2026/01/02', 'next', 'end');
    run(sh, 'config firewall schedule onetime', 'edit "actif"',
      'set start 00:00 2026/08/20', 'set end 23:59 2026/08/20', 'next', 'end');
    run(sh, 'config firewall schedule group', 'edit "melange"',
      'set member "inactif" "actif"', 'next', 'end');
    politique(sh, 'melange');

    expect(await pingOnSimulatedClock(poste, 'ping -c 1 203.0.113.10'))
      .toMatch(/, 0% packet loss/);
  });

  it('un groupe dont AUCUN membre n`est actif bloque', async () => {
    const { sh, poste } = await laboratoire(Date.parse('2026-08-20T12:00:00Z'));

    run(sh, 'config firewall schedule onetime', 'edit "vieux"',
      'set start 00:00 2026/01/01', 'set end 23:59 2026/01/02', 'next', 'end');
    run(sh, 'config firewall schedule group', 'edit "aucun"',
      'set member "vieux"', 'next', 'end');
    politique(sh, 'aucun');

    expect(await pingOnSimulatedClock(poste, 'ping -c 1 203.0.113.10'))
      .toMatch(/, 100% packet loss/);
  });

  it('un membre inexistant est refuse', async () => {
    const { sh } = await laboratoire();

    run(sh, 'config firewall schedule group', 'edit "vide"');
    const auSet = sh.execute('set member "jamais-declare"');
    const auNext = sh.execute('next');

    expect(`${auSet}\n${auNext}`).toMatch(/Command fail|Invalid|value parse error/i);
    run(sh, 'abort');
  });
});

describe('config system ntp', () => {
  it('la configuration est acceptee et `show` la reproduit', async () => {
    const { sh } = await laboratoire();

    run(sh, 'config system ntp',
      'set ntpsync enable', 'set type custom', 'set syncinterval 60',
      'config ntpserver', 'edit 1', 'set server "203.0.113.53"', 'next', 'end',
      'end');

    const rendu = sh.execute('show system ntp');
    expect(rendu).toMatch(/set ntpsync enable/);
    expect(rendu).toMatch(/set syncinterval 60/);
    expect(rendu).toMatch(/set server "203\.0\.113\.53"/);
  });

  it('le serveur declare atteint vraiment l`agent NTP', async () => {
    const { fw, sh } = await laboratoire();

    run(sh, 'config system ntp',
      'set ntpsync enable', 'set type custom',
      'config ntpserver', 'edit 1', 'set server "203.0.113.53"', 'next', 'end',
      'end');

    const agent = fw.getNtpAgent();
    expect(agent.getConfig().enabled).toBe(true);
    expect([...agent.getConfig().associations.keys()]).toContain('203.0.113.53');
  });

  it('`set ntpsync disable` arrete vraiment l`agent', async () => {
    const { fw, sh } = await laboratoire();
    run(sh, 'config system ntp', 'set ntpsync enable', 'set type custom',
      'config ntpserver', 'edit 1', 'set server "203.0.113.53"', 'next', 'end', 'end');
    expect(fw.getNtpAgent().getConfig().enabled).toBe(true);

    run(sh, 'config system ntp', 'set ntpsync disable', 'end');

    expect(fw.getNtpAgent().getConfig().enabled).toBe(false);
  });
});
