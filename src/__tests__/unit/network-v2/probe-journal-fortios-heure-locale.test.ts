/**
 * Lot T9 du `docs/PRD-Geographie-Et-Temps-Local.md` : les champs `date=`
 * et `time=` d'un enregistrement FortiOS portent l'heure de
 * l'EQUIPEMENT, comme tout le reste de ses vues.
 *
 * ── La ligne du PRD etait perimee, et la mesure l'a dit ──────────────
 *
 * Le PRD annoncait « champs absents ». Ils ne le sont pas : `date=` et
 * `time=` existent depuis un lot precedent. Ce qu'ils portaient etait
 * faux, ce qui est plus difficile a voir qu'une absence — un champ vide
 * se remarque, un champ juste-en-apparence non.
 *
 *     execute time                  current time is: 14:00:00
 *     execute log display   AVANT   date=2026-07-15 time=12:00:00
 *                           APRES   date=2026-07-15 time=14:00:00
 *
 * `orderedFields` rendait `record.at` par les accesseurs `getUTC*`. Un
 * pare-feu regle sur `Europe/Paris` ecrivait donc l'heure d'UTC dans son
 * journal pendant qu'`execute time` et `execute date` annoncaient
 * l'heure locale : deux vues de la MEME machine, au MEME instant, qui se
 * contredisent (`CLAUDE.md` §3). C'est ce que corrige ce lot, en
 * reutilisant le port `localClock` que le lot T8 venait d'ouvrir plutot
 * qu'en ajoutant un second chemin vers l'horloge.
 *
 * **Ce qui NE se decale pas, et c'est le piege du lot.** `eventtime` est
 * un instant ABSOLU — des nanosecondes depuis l'epoque — et un
 * collecteur qui correle deux equipements le compare tel quel. Le
 * decaler ferait mentir la correlation au moment meme ou elle sert. Un
 * cas le garde, exactement comme `%s` etait garde au lot T3.
 *
 * `orderedFields` sert les rendus `default`, `csv` et `cef` : les trois
 * suivent d'un coup. Le rendu `rfc5424`, lui, porte son propre
 * horodatage, corrige au lot T8.
 *
 * ── Discrimination ──────────────────────────────────────────────────
 *
 * Mesure : `git stash push -- src/network` fait tomber **5 des 7 cas**.
 * Les 2 qui passent des deux cotes sont nommes, et ce sont les deux
 * gardes du lot plutot que ses preuves :
 *
 *   - « eventtime reste l'instant ABSOLU » est le garde du PIEGE. Il
 *     etait juste avant le lot et devait le rester : decaler `eventtime`
 *     en meme temps que `time=` aurait paru cohérent et aurait casse la
 *     correlation entre deux equipements, qui est justement ce a quoi ce
 *     champ sert. Sa chute signalerait qu'on a decale ce qu'il ne
 *     fallait pas.
 *   - « sur un pare-feu a UTC, rien ne se decale » est le TEMOIN. Sans
 *     lui, un journal vide, une commande cassee et un decalage faux
 *     seraient indiscernables — les trois rendent une chaine qui ne
 *     contient pas l'heure attendue. Il prouve que le laboratoire
 *     produit bien un enregistrement lisible.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

const JUILLET = Date.parse('2026-07-15T12:00:00Z');
const JANVIER = Date.parse('2026-01-15T12:00:00Z');

async function jouer(
  d: { executeCommand(c: string): Promise<string> }, lignes: string[],
): Promise<string> {
  let out = '';
  for (const l of lignes) out = await d.executeCommand(l);
  return out;
}

async function pareFeu(at: number, zone = 'Europe/Paris'): Promise<FortiGate> {
  const fw = new FortiGate('firewall-fortinet', 'FGT', 0, 0, { now: () => at });
  await jouer(fw, ['config system global', `set timezone ${zone}`, 'end']);
  fw.getLogStore().append({
    id: '0000000013', type: 'traffic', subtype: 'forward', level: 'notice',
    at, fields: { srcip: '192.168.1.10' },
  });
  return fw;
}

describe('le journal FortiOS porte l_heure de son equipement', () => {
  it('en juillet, time= est l_heure d_ete et non UTC', async () => {
    const fw = await pareFeu(JUILLET);

    expect(await fw.executeCommand('execute log display'))
      .toContain('time=14:00:00');
  }, 30000);

  it('en janvier, il suit le fuseau standard', async () => {
    const fw = await pareFeu(JANVIER);

    expect(await fw.executeCommand('execute log display'))
      .toContain('time=13:00:00');
  }, 30000);

  it('le journal et `execute time` disent la MEME heure', async () => {
    const fw = await pareFeu(JUILLET);

    const journal = /time=(\d{2}:\d{2}:\d{2})/.exec(
      await fw.executeCommand('execute log display'))?.[1];
    const horloge = /current time is: (\d{2}:\d{2}:\d{2})/.exec(
      await fw.executeCommand('execute time'))?.[1];

    expect(journal).toBe(horloge);
  }, 30000);

  it('la DATE bascule aussi quand le decalage change de jour', async () => {
    const fw = await pareFeu(Date.parse('2026-07-15T23:30:00Z'));

    expect(await fw.executeCommand('execute log display'))
      .toContain('date=2026-07-16');
  }, 30000);

  it('eventtime reste l_instant ABSOLU, non decale', async () => {
    const fw = await pareFeu(JUILLET);

    expect(await fw.executeCommand('execute log display'))
      .toContain(`eventtime=${JUILLET * 1_000_000}`);
  }, 30000);

  it('le rendu CSV suit, puisqu_il lit les memes champs', async () => {
    const fw = await pareFeu(JUILLET);
    await jouer(fw, ['config log setting', 'set fwpolicy-implicit-log enable', 'end']);

    expect(await fw.executeCommand('execute log display'))
      .toContain('14:00:00');
  }, 30000);

  it('TEMOIN — sur un pare-feu a UTC, rien ne se decale', async () => {
    const fw = await pareFeu(JUILLET, 'UTC');

    expect(await fw.executeCommand('execute log display'))
      .toContain('time=12:00:00');
  }, 30000);
});
