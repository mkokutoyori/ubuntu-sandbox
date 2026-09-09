/**
 * Lot T7 du `docs/PRD-Geographie-Et-Temps-Local.md` : cron cesse de
 * suivre le fuseau du NAVIGATEUR (invariant I-T5), et `CRON_TZ` cesse
 * d'etre un mot range que personne ne lit (`CLAUDE.md` §6).
 *
 * Mesure d'ouverture, sur une machine posee a `Europe/Paris` par
 * `timedatectl set-timezone`, avec `30 8 * * *` au crontab :
 *
 *     tour a 06:30 UTC (08:30 a Paris)   AVANT: rien     APRES: part
 *     tour a 08:30 UTC (10:30 a Paris)   AVANT: part     APRES: rien
 *
 *     `30 1 * * mon`, tour a dimanche 23:30 UTC (lundi 01:30 a Paris)
 *                                        AVANT: rien     APRES: part
 *
 * La tache de 08:30 partait donc a 10:30, et celle du lundi ne partait
 * pas le lundi. `CronSchedule.isDue` lisait `at.getHours()` et
 * `at.getDay()` — les accesseurs locaux d'un `Date`, c'est-a-dire le
 * fuseau du moteur JavaScript. Elle recoit desormais des `LocalParts`
 * que l'appelant construit dans le fuseau de SA machine.
 *
 * **`CRON_TZ` etait deja analyse, range, et rendu par `crontab -l`.**
 * `parseCrontab` le voit comme une affectation d'environnement depuis
 * toujours et le recopie dans l'environnement de chaque tache ; rien ne
 * le LISAIT. C'est le defaut « un critere stocke et jamais evalue »,
 * dans sa forme la plus trompeuse : la ligne s'affiche, donc l'eleve
 * croit qu'elle agit. Vixie cron et cronie l'honorent — une ligne
 * `CRON_TZ=Area/City` placee au-dessus d'une tache la fait suivre CE
 * fuseau plutot que celui du systeme — et c'est ce qui est fait ici.
 *
 * **Deux defauts trouves en cablant, et fermes ici.**
 *
 * 1. `CronEngine` se souvenait de la derniere minute traitee sous forme
 *    d'heure MURALE (`annee-mois-jour-heure-minute`). Une heure murale
 *    se REPETE au retour a l'heure d'hiver : la tache de la seconde
 *    03:00 etait alors prise pour un doublon et supprimee, alors que le
 *    vrai cron la fait partir deux fois. La cle est desormais la minute
 *    de l'instant, qui ne se repete pas. Le meme defaut se trouvait
 *    dans le declencheur `event timer cron` d'EEM, et y est referme.
 * 2. `LinuxCronManager` gardait `dueJobs`/`rebootJobs`/`allJobs`, une
 *    SECONDE selection des taches dues a cote de celle de `SystemCron`.
 *    Le moteur ne les lisait plus depuis que le double d'execution a ete
 *    referme — l'en-tete de `LinuxMachine` le dit — et il aurait fallu
 *    lui cabler un fuseau de plus. La moitie morte est retiree ; le
 *    magasin garde ce que `crontab -l` lui demande.
 *
 * **Cote Cisco, EEM lit maintenant l'horloge de son routeur.** Son
 * declencheur cron lisait lui aussi le fuseau du navigateur ; il lit le
 * decalage de `clock timezone`. La reserve d'honnetete : `clock
 * summer-time` n'est pas encore honore par ce chemin — c'est le lot T4,
 * qui donnera au routeur une vraie horloge.
 *
 * ── Le piege que le balayage complet a leve, et sa mesure ────────────
 *
 * Ces tours etaient d'abord dates du JOUR MEME (2026-09-07). Le cas
 * `CRON_TZ` tombait a 12:30 UTC, et le balayage complet — une heure de
 * machine — est passe par cette minute-la : le cas est devenu rouge,
 * puis vert au balayage suivant.
 *
 * Mesure du mecanisme, prise au banc :
 *
 *     tour dont la minute simulee tombe sur la minute REELLE -> rien
 *     tour loin de la minute reelle                          -> part
 *
 * `startCronTicker()` lance un `cronTick()` IMMEDIAT a l'allumage. Ce
 * tour demarrait le moteur et marquait sa minute avec `new Date()` —
 * l'horloge du navigateur sur une machine dont tout le reste du temps
 * est simule. Un tour pilote tombant dans cette meme minute etait alors
 * pris pour un doublon et avale.
 *
 * Deux corrections, et elles ne se remplacent pas. Le fond : la machine
 * lit desormais SA propre horloge (`executor.simulatedDate()`) pour son
 * tour d'allumage, son moteur et le courrier de cron — c'est l'invariant
 * I-T5, et le melange des deux horloges etait le defaut. La forme : ces
 * tours sont dates de 2027, parce qu'une sonde qui choisit l'instant du
 * jour mesure le calendrier autant que le code. `probe-cron-01` avait
 * appris la meme lecon et l'avait ecrite ; il fallait la relire.
 *
 * ── Discrimination ──────────────────────────────────────────────────
 *
 * Mesure, et non prediction : `git stash push -- src/network` fait
 * tomber **5 des 9 cas**. Les 4 qui passent des deux cotes sont nommes,
 * avec leur raison :
 *
 *   - « la machine est bien a Paris, et date le dit » est le TEMOIN :
 *     sans lui, un `timedatectl` casse et un cron sourd seraient
 *     indiscernables. Il est acquis depuis les lots T2 et T3, et c'est
 *     l'ecart entre cette vue-la et celle de cron que ce lot supprime ;
 *   - « une machine restee a UTC part bien a l_heure UTC » est le cas de
 *     NON-REGRESSION. C'etait la SEULE reponse juste avant le lot,
 *     puisque tout se decidait dans le fuseau du moteur, et elle devait
 *     le rester ;
 *   - « une tache de chaque minute part a chaque tour » garde le tour de
 *     cron lui-meme : `* * * * *` ne consulte ni heure ni jour, donc il
 *     part des deux cotes, et sa chute signalerait que le lot a casse le
 *     moteur plutot que le fuseau ;
 *   - « et l_ecarte de l_heure qu_elle aurait eue sans lui » ne mord pas
 *     SEUL : a 06:30 UTC la tache ne part ni avant (il est 06:30 pour le
 *     moteur, pas 08:30) ni apres (il est 02:30 a New York). Les deux
 *     refus ont des raisons opposees, et c'est son jumeau — « CRON_TZ
 *     deplace la tache dans SON fuseau » — qui tranche. Le garder isole
 *     la moitie negative du couple, sans quoi un `CRON_TZ` qui ferait
 *     partir la tache DEUX fois passerait inapercu.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

beforeEach(() => { EquipmentRegistry.resetInstance(); });

function laboratoire(): { pc: LinuxPC; tour: (iso: string) => void } {
  const pc = new LinuxPC('linux-pc', 'pc1', 0, 0);
  pc.powerOn();
  const machine = pc as unknown as {
    cronTick(at?: Date): void;
    cronTimer: symbol | null;
    hostTimers: { clear(id: symbol): void };
  };
  if (machine.cronTimer) { machine.hostTimers.clear(machine.cronTimer); machine.cronTimer = null; }
  return { pc, tour: (iso) => machine.cronTick(new Date(Date.parse(iso))) };
}

async function poseA(zone: string, crontab: string[]): Promise<ReturnType<typeof laboratoire>> {
  const lab = laboratoire();
  await lab.pc.executeCommand(`timedatectl set-timezone ${zone}`);
  await lab.pc.executeCommand(
    `printf '%s\\n' ${crontab.map((l) => `"${l}"`).join(' ')} | crontab -`);
  return lab;
}

const TACHE = '30 8 * * * echo tick >> /home/user/t.txt';

async function partie(pc: LinuxPC): Promise<boolean> {
  return (await pc.executeCommand('cat /home/user/t.txt')).trim() === 'tick';
}

describe('cron suit le fuseau de sa machine', () => {
  it('la machine est bien a Paris, et date le dit', async () => {
    const { pc } = await poseA('Europe/Paris', [TACHE]);

    expect(await pc.executeCommand('cat /etc/timezone')).toContain('Europe/Paris');
    expect(await pc.executeCommand('date "+%Z"')).toContain('CEST');
  }, 30000);

  it('la tache de 08:30 part a 08:30 LOCALES', async () => {
    const { pc, tour } = await poseA('Europe/Paris', [TACHE]);

    tour('2027-09-06T06:30:00Z');

    expect(await partie(pc)).toBe(true);
  }, 30000);

  it('et ne part pas a 08:30 UTC, qui est 10:30 chez elle', async () => {
    const { pc, tour } = await poseA('Europe/Paris', [TACHE]);

    tour('2027-09-06T08:30:00Z');

    expect(await partie(pc)).toBe(false);
  }, 30000);

  it('le JOUR de la semaine est celui de la machine', async () => {
    const { pc, tour } = await poseA('Europe/Paris',
      ['30 1 * * mon echo tick >> /home/user/t.txt']);

    tour('2027-09-05T23:30:00Z');

    expect(await partie(pc)).toBe(true);
  }, 30000);

  it('CRON_TZ deplace la tache dans SON fuseau', async () => {
    const { pc, tour } = await poseA('Europe/Paris', ['CRON_TZ=America/New_York', TACHE]);

    tour('2027-09-06T12:30:00Z');

    expect(await partie(pc)).toBe(true);
  }, 30000);

  it('et l_ecarte de l_heure qu_elle aurait eue sans lui', async () => {
    const { pc, tour } = await poseA('Europe/Paris', ['CRON_TZ=America/New_York', TACHE]);

    tour('2027-09-06T06:30:00Z');

    expect(await partie(pc)).toBe(false);
  }, 30000);

  it('un CRON_TZ que tzdata ignore laisse le fuseau de la machine', async () => {
    const { pc, tour } = await poseA('Europe/Paris', ['CRON_TZ=Zorglub/Ville', TACHE]);

    tour('2027-09-06T06:30:00Z');

    expect(await partie(pc)).toBe(true);
  }, 30000);

  it('une machine restee a UTC part bien a l_heure UTC', async () => {
    const { pc, tour } = await poseA('Etc/UTC', [TACHE]);

    tour('2027-09-06T08:30:00Z');

    expect(await partie(pc)).toBe(true);
  }, 30000);

  it('une tache de chaque minute part a chaque tour', async () => {
    const { pc, tour } = await poseA('Europe/Paris',
      ['* * * * * echo tick >> /home/user/t.txt']);

    tour('2027-09-06T06:30:00Z');

    expect(await partie(pc)).toBe(true);
  }, 30000);
});
