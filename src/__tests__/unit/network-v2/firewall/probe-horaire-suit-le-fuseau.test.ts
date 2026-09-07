/**
 * Lot T6 du `docs/PRD-Geographie-Et-Temps-Local.md` : un horaire de
 * politique cesse de suivre le fuseau du NAVIGATEUR (invariant I-T5).
 *
 * Mesure d'ouverture, prise sur un FortiGate regle sur `Europe/Paris`,
 * avec la politique 1 liee a l'horaire et un ping qui la traverse :
 *
 *     horaire recurrent « 08:00-18:00 lundi »
 *     lundi 19:30 a Paris   AVANT: PASSE     APRES: BLOQUE
 *     lundi 08:30 a Paris   AVANT: BLOQUE    APRES: PASSE
 *
 *     horaire recurrent « 00:00-06:00 lundi »
 *     lundi 01:30 a Paris   AVANT: BLOQUE    APRES: PASSE
 *     (il est encore dimanche 23:30 a UTC : le jour lui-meme etait faux)
 *
 *     horaire ponctuel « 08:00 -> 18:00 le 07/09 »
 *     19:30 a Paris         AVANT: PASSE     APRES: BLOQUE
 *     08:30 a Paris         AVANT: BLOQUE    APRES: PASSE
 *
 * Le pare-feu repondait `current time is: 19:30:00` a `execute time`
 * pendant que son moteur d'horaires lisait 17:30 : deux vues de LA MEME
 * horloge, sur la meme machine, au meme instant, qui se contredisaient
 * de deux heures (`CLAUDE.md` §3, invariant I-T6).
 *
 * **Le sens de l'erreur compte.** Deux des cas ci-dessus laissent passer
 * un trafic que la configuration de l'operateur interdit : l'horaire ne
 * rendait pas seulement la mauvaise reponse, il la rendait OUVERTE. Un
 * TP « acces autorise aux heures de bureau » verifie a 19:30 laissait
 * donc passer, et l'eleve n'avait aucun moyen de voir pourquoi.
 *
 * **Origine.** `scheduleActiveAt` lisait `new Date(at).getDay()` et
 * `.getHours()` — les accesseurs locaux d'un `Date`, c'est-a-dire le
 * fuseau du moteur JavaScript qui execute la simulation. Le meme
 * laboratoire donnait donc un resultat different selon le fuseau du
 * poste de l'eleve. Il lit maintenant `partsAt(zone, at)` du socle T1,
 * ou `zone` est celle que `config system global set timezone` a posee.
 *
 * **Le ponctuel change de nature, et c'est voulu.** `set start 08:00
 * 2026/09/07` est une heure MURALE sur un vrai FortiGate, pas un instant
 * absolu : changer le fuseau de l'equipement deplace la fenetre. Les
 * bornes restent donc rangees telles qu'ecrites et c'est l'INSTANT
 * courant qui est ramene en heure locale au moment de decider — l'ordre
 * inverse figerait la fenetre au fuseau qui avait cours a la saisie.
 *
 * L'autorite est la documentation de Fortinet : `config system global`
 * / `set timezone <index>` regle l'heure de l'equipement, et « for many
 * features to work, including scheduling, the FortiOS system time must
 * be accurate » (Setting the system time, FortiOS 7.6 / 8.0).
 *
 * ── Discrimination ──────────────────────────────────────────────────
 *
 * Mesure, et non prediction : `git stash push -- src/network` fait
 * tomber **6 des 8 cas**. Les 2 qui passent des deux cotes sont nommes :
 *
 *   - « le pare-feu est bien a Paris, et le dit » est le TEMOIN, et il
 *     est indispensable : sans lui, un laboratoire casse et un horaire
 *     faux seraient indiscernables. Il tient de ce que le lot T1 a
 *     ferme — `execute time` lisait deja l'heure locale, et c'est
 *     precisement l'ecart entre cette vue-la et celle du moteur
 *     d'horaires que ce lot supprime ;
 *   - « un horaire toujours actif reste insensible au fuseau » est le
 *     cas de NON-REGRESSION : `always` court-circuite avant toute
 *     lecture d'horloge, et devait continuer a le faire — un lot qui
 *     rendrait le fuseau obligatoire pour decider d'`always` aurait
 *     casse la politique par defaut de tout equipement.
 */
import { describe, it, expect } from 'vitest';
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

async function laboratoire(instant: string) {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();

  const horloge = { valeur: Date.parse(instant) };
  const fw = new FortiGate('firewall-fortinet', 'FGT', 0, 0, { now: () => horloge.valeur });
  const sh = new FortiShell(fw);
  const poste = new LinuxPC('linux-pc', 'PC', -150, 0);
  const cible = new LinuxPC('linux-pc', 'CIBLE', 150, 0);

  new Cable('a').connect(poste.getPort('eth0')!, fw.getPort('port1')!);
  new Cable('b').connect(cible.getPort('eth0')!, fw.getPort('port2')!);

  run(sh,
    'config system global', 'set timezone 4', 'end',
    'config system interface',
    'edit "port1"', 'set mode static',
    'set ip 192.168.1.1 255.255.255.0', 'set allowaccess ping', 'next',
    'edit "port2"', 'set mode static',
    'set ip 203.0.113.1 255.255.255.0', 'set allowaccess ping', 'next', 'end');

  await runOn(poste, ['ip link set eth0 up', 'ip addr add 192.168.1.10/24 dev eth0',
    'ip route add default via 192.168.1.1']);
  await runOn(cible, ['ip link set eth0 up', 'ip addr add 203.0.113.10/24 dev eth0',
    'ip route add default via 203.0.113.1']);

  return { fw, sh, poste };
}

function politique(sh: FortiShell, horaire: string): void {
  run(sh, 'config firewall policy', 'edit 1',
    'set srcintf "port1"', 'set dstintf "port2"',
    'set srcaddr "all"', 'set dstaddr "all"',
    'set action accept', `set schedule "${horaire}"`, 'set service "ALL"',
    'next', 'end');
}

const traverse = async (poste: LinuxPC): Promise<boolean> =>
  (await pingOnSimulatedClock(poste, 'ping -c 1 203.0.113.10')).includes(', 0% packet loss');

describe('un horaire de politique suit le fuseau du pare-feu', () => {
  it('le pare-feu est bien a Paris, et le dit', async () => {
    const { fw } = await laboratoire('2026-09-07T17:30:00Z');

    expect(fw.getTimezone()).toBe('Europe/Paris');
    expect(await fw.executeCommand('execute time')).toContain('19:30:00');
  }, 30000);

  it('hors des heures de bureau LOCALES, le trafic est bloque', async () => {
    const { sh, poste } = await laboratoire('2026-09-07T17:30:00Z');

    run(sh, 'config firewall schedule recurring', 'edit "bureau"',
      'set day monday', 'set start 08:00', 'set end 18:00', 'next', 'end');
    politique(sh, 'bureau');

    expect(await traverse(poste)).toBe(false);
  }, 30000);

  it('pendant les heures de bureau LOCALES, le trafic passe', async () => {
    const { sh, poste } = await laboratoire('2026-09-07T06:30:00Z');

    run(sh, 'config firewall schedule recurring', 'edit "bureau"',
      'set day monday', 'set start 08:00', 'set end 18:00', 'next', 'end');
    politique(sh, 'bureau');

    expect(await traverse(poste)).toBe(true);
  }, 30000);

  it('le JOUR de la semaine est lui aussi celui de la machine', async () => {
    const { sh, poste } = await laboratoire('2026-09-06T23:30:00Z');

    run(sh, 'config firewall schedule recurring', 'edit "nuit"',
      'set day monday', 'set start 00:00', 'set end 06:00', 'next', 'end');
    politique(sh, 'nuit');

    expect(await traverse(poste)).toBe(true);
  }, 30000);

  it('une fenetre ponctuelle est murale, pas absolue', async () => {
    const dedans = await laboratoire('2026-09-07T06:30:00Z');
    run(dedans.sh, 'config firewall schedule onetime', 'edit "maintenance"',
      'set start 08:00 2026/09/07', 'set end 18:00 2026/09/07', 'next', 'end');
    politique(dedans.sh, 'maintenance');

    expect(await traverse(dedans.poste)).toBe(true);
  }, 30000);

  it('et se referme a l_heure locale, pas a l_heure UTC', async () => {
    const dehors = await laboratoire('2026-09-07T17:30:00Z');
    run(dehors.sh, 'config firewall schedule onetime', 'edit "maintenance"',
      'set start 08:00 2026/09/07', 'set end 18:00 2026/09/07', 'next', 'end');
    politique(dehors.sh, 'maintenance');

    expect(await traverse(dehors.poste)).toBe(false);
  }, 30000);

  it('changer le fuseau DEPLACE la fenetre deja saisie', async () => {
    const { fw, sh } = await laboratoire('2026-09-07T17:30:00Z');
    run(sh, 'config firewall schedule onetime', 'edit "maintenance"',
      'set start 08:00 2026/09/07', 'set end 18:00 2026/09/07', 'next', 'end');

    const aParis = fw.getScheduleStore().activeAt('maintenance', fw.now());
    run(sh, 'config system global', 'set timezone 12', 'end');
    const aNewYork = fw.getScheduleStore().activeAt('maintenance', fw.now());

    expect(fw.getTimezone()).toBe('America/New_York');
    expect(aParis).toBe(false);
    expect(aNewYork).toBe(true);
  }, 30000);

  it('un horaire toujours actif reste insensible au fuseau', async () => {
    const { sh, poste } = await laboratoire('2026-09-07T17:30:00Z');
    politique(sh, 'always');

    expect(await traverse(poste)).toBe(true);
  }, 30000);
});
