/**
 * Lot T3 du `docs/PRD-Geographie-Et-Temps-Local.md` : deux vues d'une
 * meme machine cessent de se contredire (invariant I-T6).
 *
 * Le lot T2 a mis d'accord DEUX MACHINES sur le meme fuseau. Restait la
 * contradiction INTERNE, celle qu'un operateur voit sans quitter son
 * terminal :
 *
 *     AVANT   timedatectl  ->  Local time: ... 19:56:15 CEST
 *             date         ->  Sun Sep 06 17:56:15 UTC 2026
 *
 *     APRES   timedatectl  ->  Local time: ... 19:56:38 CEST
 *             date         ->  Sun Sep 06 19:56:38 CEST 2026
 *
 * Deux heures d'ecart entre deux commandes du meme systeme
 * d'exploitation, au meme instant, sur la meme machine. `cmdDate`
 * ignorait le fuseau de bout en bout : tout le rendu passait par les
 * accesseurs `getUTC*` d'un `Date`, `%Z` valait `'UTC'` en dur et `%z`
 * valait `'+0000'`.
 *
 * **Le defaut etait connu et ecrit.** L'en-tete de `SystemInfo.ts`
 * disait « The debug transcript showed `date -u` identical to `date` » —
 * constate, note, et jamais referme. La ligne qui l'expliquait le disait
 * aussi : « -u / --utc are no-ops here (sandbox TZ is already UTC) ».
 * C'etait vrai tant qu'aucune machine n'avait de fuseau ; ca ne l'est
 * plus depuis que `timedatectl set-timezone` en pose un.
 *
 * **Ce qui NE doit pas se decaler, et qui est le piege de ce lot.** Un
 * horodatage local se rend en decalant, mais trois specificateurs
 * doivent rester adosses a l'instant REEL : `%s` (secondes depuis
 * l'epoque) et `%N` (nanosecondes) sont des instants absolus — les
 * decaler ferait mentir tout script qui les compare — et `%Z`/`%z`
 * doivent decrire la zone, pas la subir. Le rendu passe donc un objet
 * qui porte a la fois l'instant reel, le decalage et l'abreviation,
 * plutot qu'un `Date` deja decale dont on aurait perdu l'origine.
 *
 * **La vue voisine avait le meme defaut, et CLAUDE.md §3 impose de la
 * traiter.** `date /t` et `time /t` de cmd Windows lisaient `getDay()`
 * et `getHours()`, c'est-a-dire le fuseau du MOTEUR JavaScript et non
 * celui de la machine : `Set-TimeZone` ne les deplacait pas d'une
 * minute. Une machine Windows a UNE heure, que `time /t` et
 * `Get-TimeZone` decrivent chacun a leur facon.
 *
 * ── Discrimination ──────────────────────────────────────────────────
 *
 * `git stash push -u -- src/network src/powershell` fait tomber **7 des
 * 10 cas**. Les 3 qui passent des deux cotes sont nommes :
 *
 *   - « date repond une date complete » est le TEMOIN : sans lui, une
 *     commande cassee et un fuseau ignore seraient indiscernables ;
 *   - « date -u rend bien UTC » est le cas de NON-REGRESSION — c'etait
 *     la SEULE reponse juste avant le lot, puisque tout etait en UTC, et
 *     elle devait le rester. Son jumeau, « date -u differe de date »,
 *     est celui qui mord ;
 *   - « l_epoque n_est pas decalee » est la garde du piege decrit
 *     ci-dessus : `%s` valait deja l'instant reel, et le lot ne devait
 *     pas le lui prendre en decalant le `Date` rendu.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

async function posteA(zone: string): Promise<LinuxPC> {
  const pc = new LinuxPC('linux-pc', 'PC', 0, 0);
  pc.powerOn();
  await pc.executeCommand(`timedatectl set-timezone ${zone}`);
  return pc;
}

async function taper(pc: LinuxPC, commande: string): Promise<string> {
  return (await pc.executeCommand(commande)).trim();
}

function minutesDe(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

describe('date suit le fuseau de sa machine', () => {
  it('date repond une date complete', async () => {
    const pc = await posteA('Europe/Paris');

    expect(await taper(pc, 'date')).toMatch(/^\w{3} \w{3} \d{2} \d{2}:\d{2}:\d{2} \w+ \d{4}$/);
  }, 20000);

  it('date et timedatectl s_accordent sur la meme machine', async () => {
    const pc = await posteA('Europe/Paris');

    const heureDate = await taper(pc, 'date "+%H"');
    const vueTimedatectl = await taper(pc, 'timedatectl');
    const heureTimedatectl = /Local time: \w{3} [\d-]+ (\d{2}):/.exec(vueTimedatectl)?.[1];

    expect(heureTimedatectl).toBe(heureDate);
  }, 20000);

  it('date porte l_abreviation de la zone, pas UTC', async () => {
    const pc = await posteA('Europe/Paris');

    expect(await taper(pc, 'date')).toContain('CEST');
  }, 20000);

  it('date -u differe de date quand la zone n_est pas UTC', async () => {
    const pc = await posteA('Europe/Paris');

    const local = minutesDe(await taper(pc, 'date "+%H:%M"'));
    const utc = minutesDe(await taper(pc, 'date -u "+%H:%M"'));

    expect((local - utc + 1440) % 1440).toBe(120);
  }, 20000);

  it('date -u rend bien UTC', async () => {
    const pc = await posteA('Europe/Paris');

    expect(await taper(pc, 'date -u "+%Z %z"')).toBe('UTC +0000');
  }, 20000);

  it('les specificateurs de zone disent la zone', async () => {
    const pc = await posteA('Europe/Paris');

    expect(await taper(pc, 'date "+%Z %z"')).toBe('CEST +0200');
  }, 20000);

  it('l_epoque n_est pas decalee', async () => {
    const pc = await posteA('Europe/Paris');

    const epoqueLocale = Number(await taper(pc, 'date "+%s"'));
    const epoqueUtc = Number(await taper(pc, 'date -u "+%s"'));

    expect(Math.abs(epoqueLocale - epoqueUtc)).toBeLessThan(5);
  }, 20000);

  it('une zone sans heure d_ete porte son abreviation propre', async () => {
    const pc = await posteA('Africa/Douala');

    expect(await taper(pc, 'date "+%Z %z"')).toBe('WAT +0100');
  }, 20000);

  it('une date donnee en argument se rend dans la zone locale', async () => {
    const pc = await posteA('Europe/Paris');

    expect(await taper(pc, 'date -d @1788717600 "+%H:%M %Z"')).toBe('20:00 CEST');
  }, 20000);

  it('cmd Windows suit le fuseau de sa machine', async () => {
    const pc = new WindowsPC('windows-pc', 'W', 0, 0);
    pc.powerOn();

    await pc.executeCommand('powershell -c "Set-TimeZone -Id \'UTC\'"');
    const aUtc = (await pc.executeCommand('time /t')).trim();
    await pc.executeCommand(
      'powershell -c "Set-TimeZone -Id \'Romance Standard Time\'"');
    const aParis = (await pc.executeCommand('time /t')).trim();

    expect(aParis).not.toBe(aUtc);
  }, 20000);
});
