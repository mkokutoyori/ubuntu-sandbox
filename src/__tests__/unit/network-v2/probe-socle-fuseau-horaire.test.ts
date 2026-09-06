/**
 * Lot T1 du `docs/PRD-Geographie-Et-Temps-Local.md` : le socle
 * temporel, et le defaut qu'il referme au passage.
 *
 * Le PRD part d'une mesure : le meme instant, le meme fuseau demande
 * (`Europe/Paris`), trois equipements du meme laboratoire, et TROIS
 * reponses — le pare-feu a 17:33, le Linux a 16:33, et `date` sur cette
 * meme machine Linux a 15:33. Quatre ecritures d'un seul fait
 * cohabitaient ; ce lot en installe UNE, dont les autres deviendront des
 * vues.
 *
 * **Le decalage est une FONCTION de l'instant, jamais une constante**
 * (invariant I-T3). C'est ce qui separe le socle des trois autres
 * ecritures : un champ `offsetMin` ne peut pas dire que `Europe/Paris`
 * vaut +01:00 en janvier et +02:00 en juillet, et une table qui le
 * range dit forcement faux six mois sur douze. La signature est donc
 * `offsetMinutesAt(zone, instant)` — deux arguments, pas un.
 *
 * **`TimeZone` est un TYPE, pas une chaine** (`CLAUDE.md` §5), et ce
 * n'etait pas cosmetique. Mesure avant correctif, sur un FortiGate neuf :
 *
 *     fw.setTimezone('Zorglub/Ville')
 *     fw.getTimezone()   -> "Zorglub/Ville"        (accepte, range tel quel)
 *     fw.localTimeOf(t)  -> LEVE "Invalid time zone specified"
 *
 * Un nom de fuseau que personne n'avait valide mettait donc le pare-feu
 * dans un etat ou TOUTE lecture de l'heure locale plante — un journal,
 * un `execute date`, un horaire de politique. La validation se fait
 * maintenant a la frontiere, une fois, et ce qui circule en aval est
 * connu bon.
 *
 * **La canonicalisation est ce qui rend l'egalite fiable.** `Intl`
 * accepte `EUROPE/PARIS` et `etc/utc` aussi bien que leurs formes
 * propres ; sans canonicalisation, deux equipements configures avec la
 * meme zone ecrite differemment porteraient deux zones differentes, et
 * une comparaison par nom mentirait. `TimeZone.parse` rend la forme
 * canonique ET la MEME instance, donc `===` est vrai.
 *
 * **Mesure de performance, prise avant d'ecrire le cache.** L'ancien
 * `core/Timezone.ts` construisait un `Intl.DateTimeFormat` neuf a chaque
 * appel : 0,097 ms contre 0,0065 ms avec un formateur reutilise, soit
 * QUINZE fois plus cher — sur un chemin que le pare-feu emprunte a
 * chaque ligne de journal. Le registre garde un formateur par zone.
 *
 * **Ce qu'`Intl` ne sait PAS faire, et qui change la suite.** Mesure :
 * `timeZoneName: 'short'` rend `GMT+1`/`GMT+2` pour `Europe/Paris`, pas
 * `CET`/`CEST` ; seules les zones americaines rendent `EST`/`EDT`.
 * L'abreviation que `timedatectl` affiche ne peut donc PAS venir d'ici
 * et restera tabulee au lot T2 — la table y perd son decalage, qui
 * devient une fonction, et garde son abreviation. Le dire ici evite de
 * le redecouvrir en croyant a une regression.
 *
 * ── Discrimination : ce que cette sonde prouve, et ce qu'elle ne
 * prouve pas ────────────────────────────────────────────────────────
 *
 * Mesure, et non prediction : `git stash push -- src/network/` fait
 * tomber **2 des 14 cas**. J'en avais annonce onze avant de mesurer ;
 * la mesure tranche, et voici pourquoi elle a raison.
 *
 * Ce lot est de l'INFRASTRUCTURE. Douze de ces cas decrivent le contrat
 * d'un module qui n'existe pas avant le correctif — il n'y a donc rien
 * a contredire, et les faire passer pour des defauts fermes serait
 * flatteur. La seule porte pre-existante est le pare-feu, seul lecteur
 * de l'ancien `core/Timezone.ts`, et c'est exactement la que les deux
 * cas discriminants mordent :
 *
 *   - « une zone invalide ne peut plus casser l_horloge du pare-feu » :
 *     avant, `localTimeOf` LEVAIT ;
 *   - « le pare-feu canonicalise le fuseau qu_on lui donne » : avant,
 *     `EUROPE/PARIS` etait range tel quel.
 *
 * Une variante de la discrimination est ecartee ici plutot que laissee
 * a decouvrir : `git stash push -u` retire aussi les fichiers non
 * suivis, la sonde ne se charge alors PAS DU TOUT (« 0 test »), et
 * « le module n'existe pas » ne prouve rien de plus que « le module est
 * neuf ». C'est la variante sans `-u` qui mesure quelque chose.
 *
 * Les 2 cas qui passent des deux cotes ET qui comptent sont nommes :
 *
 *   - « le pare-feu avance sur UTC en septembre » est le TEMOIN, et il
 *     est indispensable : sans lui, un socle casse et un laboratoire
 *     casse seraient indiscernables ;
 *   - « janvier et juillet ne donnent pas le meme decalage » est le cas
 *     de NON-REGRESSION : le pare-feu etait deja la seule couche a
 *     honorer I-T3, et ce lot ne devait pas le lui reprendre.
 *
 * Les dix autres sont le CONTRAT que les lots T2 a T10 devront
 * respecter en s'y branchant — c'est la leur utilite, et elle est a
 * venir, pas acquise.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { TimeZone, TimeZoneError } from '@/network/core/time/TimeZone';
import {
  isDaylightSavingAt, localMsAt, observesDaylightSaving, offsetMinutesAt,
  partsAt, standardOffsetMinutes, utcMsForLocal,
} from '@/network/core/time/TimeZoneRegistry';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

const JANVIER = Date.UTC(2026, 0, 15, 12, 0, 0);
const JUILLET = Date.UTC(2026, 6, 15, 12, 0, 0);
const SEPTEMBRE = Date.UTC(2026, 8, 5, 12, 0, 0);

const PARIS = () => TimeZone.of('Europe/Paris');

function pareFeu(): FortiGate {
  return new FortiGate('firewall-fortinet', 'FGT', 0, 0);
}

describe('le socle des fuseaux horaires', () => {
  it('le pare-feu avance sur UTC en septembre', () => {
    const fw = pareFeu();

    expect(fw.localTimeOf(SEPTEMBRE)).toBeGreaterThan(SEPTEMBRE);
  });

  it('janvier et juillet ne donnent pas le meme decalage', () => {
    const fw = pareFeu();

    const hiver = fw.localTimeOf(JANVIER) - JANVIER;
    const ete = fw.localTimeOf(JUILLET) - JUILLET;

    expect(ete - hiver).toBe(60 * 60_000);
  });

  it('un nom de fuseau inconnu est refuse a la frontiere', () => {
    expect(TimeZone.parse('Zorglub/Ville')).toBeNull();
    expect(TimeZone.parse('')).toBeNull();
    expect(() => TimeZone.of('Zorglub/Ville')).toThrow(TimeZoneError);
  });

  it('un nom valide est canonicalise', () => {
    expect(TimeZone.of('EUROPE/PARIS').name).toBe('Europe/Paris');
    expect(TimeZone.of('  Europe/Paris  ').name).toBe('Europe/Paris');
  });

  it('deux graphies d_une meme zone donnent la MEME instance', () => {
    expect(TimeZone.of('EUROPE/PARIS')).toBe(TimeZone.of('Europe/Paris'));
    expect(TimeZone.of('Europe/Paris').equals(TimeZone.of('EUROPE/PARIS'))).toBe(true);
  });

  it('le decalage est une fonction de l_instant', () => {
    expect(offsetMinutesAt(PARIS(), JANVIER)).toBe(60);
    expect(offsetMinutesAt(PARIS(), JUILLET)).toBe(120);
  });

  it('l_heure locale se lit sans passer par le fuseau du moteur JavaScript', () => {
    const parts = partsAt(PARIS(), JANVIER);

    expect(parts.year).toBe(2026);
    expect(parts.month).toBe(1);
    expect(parts.day).toBe(15);
    expect(parts.hour).toBe(13);
    expect(parts.weekday).toBe(4);
  });

  it('l_heure d_ete est reconnue au nord', () => {
    expect(isDaylightSavingAt(PARIS(), JUILLET)).toBe(true);
    expect(isDaylightSavingAt(PARIS(), JANVIER)).toBe(false);
  });

  it('l_heure d_ete est reconnue au sud, ou les saisons sont inversees', () => {
    const sydney = TimeZone.of('Australia/Sydney');

    expect(isDaylightSavingAt(sydney, JANVIER)).toBe(true);
    expect(isDaylightSavingAt(sydney, JUILLET)).toBe(false);
  });

  it('une zone sans heure d_ete n_en prend jamais', () => {
    const douala = TimeZone.of('Africa/Douala');

    expect(observesDaylightSaving(douala, JANVIER)).toBe(false);
    expect(isDaylightSavingAt(douala, JUILLET)).toBe(false);
    expect(offsetMinutesAt(douala, JANVIER)).toBe(offsetMinutesAt(douala, JUILLET));
  });

  it('le decalage normal est celui d_hiver, ete compris', () => {
    expect(standardOffsetMinutes(PARIS(), JANVIER)).toBe(60);
    expect(standardOffsetMinutes(PARIS(), JUILLET)).toBe(60);
  });

  it('le passage en heure locale et son inverse se referment', () => {
    const local = localMsAt(PARIS(), JUILLET);

    expect(local - JUILLET).toBe(120 * 60_000);
    expect(utcMsForLocal(PARIS(), local)).toBe(JUILLET);
  });

  it('une zone invalide ne peut plus casser l_horloge du pare-feu', () => {
    const fw = pareFeu();

    fw.setTimezone('Zorglub/Ville');

    expect(fw.getTimezone()).toBe('Europe/Paris');
    expect(() => fw.localTimeOf(SEPTEMBRE)).not.toThrow();
  });

  it('le pare-feu canonicalise le fuseau qu_on lui donne', () => {
    const fw = pareFeu();

    fw.setTimezone('EUROPE/PARIS');

    expect(fw.getTimezone()).toBe('Europe/Paris');
  });
});
