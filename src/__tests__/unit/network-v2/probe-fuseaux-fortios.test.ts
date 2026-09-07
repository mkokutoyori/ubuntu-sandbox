/**
 * Lot T5 du `docs/PRD-Geographie-Et-Temps-Local.md` : un index de fuseau
 * que le simulateur n'implante pas cesse de valoir UTC en silence
 * (invariant I-T4).
 *
 * ── Ce qui a ete mesure avant correctif ──────────────────────────────
 *
 *     set timezone 55        accepte
 *     get system global      timezone: 55
 *     execute time           l'heure d'UTC
 *
 * `resolveFortiTimezone` fabriquait `{ index: 55, name: 'UTC',
 * label: '(GMT) time zone 55' }` pour TOUT index de 0 a 86 absent de sa
 * table de huit lignes. Le pare-feu annoncait donc un fuseau dans sa
 * configuration pendant que son horloge, ses journaux et ses horaires de
 * politique restaient a UTC — un fait affiche que rien ne soutient.
 *
 * La porte de refus existait deja (`acceptsValue` dans le schema), et
 * elle ne servait a rien puisque la resolution ne rendait jamais `null`
 * pour un index dans la plage. Le correctif tient en une ligne : le
 * repli fabrique disparait.
 *
 * ── Le lot ne remplit PAS les 79 index manquants, et c'est un choix ──
 *
 * Il faudrait la correspondance index -> fuseau. `docs.fortinet.com` et
 * `registry.terraform.io` sont bloques par le proxy de sortie, et
 * `official_docs/forti-cli-ref-60.txt` (l. 33538) donne la PLAGE
 * (« from 00 to 86 ») en renvoyant a `set timezone ?` pour la liste,
 * qu'il ne reproduit pas.
 *
 * Un resume de recherche a rendu une liste, et elle est ecartee plutot
 * qu'utilisee : elle est DECALEE D'UN CRAN par rapport aux huit lignes
 * deja presentes (Midway/Samoa a l'index 01 la ou la table le met a 0),
 * et elle melange des versions dont certaines montent a 89. Ecrire 87
 * lignes depuis la injecterait 87 faits non verifies. `CLAUDE.md` §8 :
 * quand la source est injoignable, on le dit et on n'implante pas.
 *
 * Refuser est donc PLUS DUR qu'un vrai FortiGate, qui accepte ces index.
 * C'est assume : le §6 tranche que le silence permissif est le pire des
 * trois etats, et le refus NOMME les index implantes. Surtout, aucun
 * fuseau ne devient inatteignable — `set timezone Europe/Paris` passe
 * par le chemin IANA, que la table ne borne pas. C'est ce que verifie le
 * temoin.
 *
 * ── Le dernier cas garde les lignes FUTURES ─────────────────────────
 *
 * Le jour ou la table sera remplie, rien ne dira qu'une ligne a ete mal
 * recopiee. Or chaque ligne porte sa propre verification : son libelle
 * ANNONCE un decalage (`(GMT+1:00)`), et son nom IANA en A un, que
 * tzdata connait et que le socle du lot T1 sait lire. Les deux doivent
 * coincider. Ce cas vaut donc pour les huit lignes d'aujourd'hui comme
 * pour les quatre-vingt-sept de demain.
 *
 * ── Discrimination ──────────────────────────────────────────────────
 *
 * Mesure : `git stash push -- src/network` fait tomber **3 des 6 cas**.
 * Les 3 qui passent des deux cotes sont nommes, et aucun ne prouve le
 * mecanisme :
 *
 *   - « un index implante reste accepte et pose SON fuseau » est la
 *     NON-REGRESSION. Les huit lignes tabulees marchaient deja ; le
 *     correctif ne devait pas les emporter avec le repli fabrique.
 *   - « TEMOIN — aucun fuseau n'est devenu inatteignable » est le cas
 *     qui rend le compromis acceptable. Le refus est PLUS DUR qu'un vrai
 *     FortiGate ; il ne serait pas defendable si le chemin IANA tombait
 *     avec lui. Il passait avant parce que ce chemin existait deja, et
 *     il doit continuer de passer pour la meme raison.
 *   - « le nom IANA porte le decalage que le libelle annonce » regarde
 *     vers l'AVANT, pas vers l'arriere : il ne mesure aucun defaut
 *     ferme ici, il garde les 79 lignes que quelqu'un ajoutera le jour
 *     ou la table sera lisible. Les huit lignes actuelles le passaient
 *     deja, ce qui est en soi une information — elles sont
 *     mutuellement coherentes, et le decalage d'un cran vu dans la
 *     source ecartee ne vient donc pas d'elles.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import {
  FORTIOS_TIMEZONES, resolveFortiTimezone,
} from '@/network/devices/firewall/vendors/fortios/schema/timezones';
import { TimeZone } from '@/network/core/time/TimeZone';
import { standardOffsetMinutes } from '@/network/core/time/TimeZoneRegistry';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

async function pareFeu(): Promise<FortiGate> {
  return new FortiGate('firewall-fortinet', 'FGT', 0, 0);
}

async function poser(fw: FortiGate, valeur: string): Promise<string> {
  await fw.executeCommand('config system global');
  const reponse = await fw.executeCommand(`set timezone ${valeur}`);
  await fw.executeCommand('end');
  return reponse;
}

const JANVIER = Date.UTC(2026, 0, 15, 12, 0, 0);

describe('un index de fuseau que le simulateur n_implante pas', () => {
  it('est refuse au lieu de valoir UTC en silence', async () => {
    const fw = await pareFeu();

    const reponse = await poser(fw, '55');

    expect(reponse).not.toBe('');
    expect(fw.getTimezone()).toBe('Europe/Paris');
  }, 30000);

  it('le refus NOMME les index qui existent', async () => {
    const fw = await pareFeu();

    const reponse = await poser(fw, '55');

    expect(reponse).toContain('12');
    expect(reponse).toContain('26');
  }, 30000);

  it('la resolution elle-meme ne fabrique plus rien', () => {
    expect(resolveFortiTimezone('55')).toBeNull();
    expect(resolveFortiTimezone('86')).toBeNull();
    expect(resolveFortiTimezone('999')).toBeNull();
  });

  it('un index implante reste accepte et pose SON fuseau', async () => {
    const fw = await pareFeu();

    expect(await poser(fw, '12')).toBe('');
    expect(fw.getTimezone()).toBe('America/New_York');
  }, 30000);

  it('TEMOIN — aucun fuseau n_est devenu inatteignable', async () => {
    const fw = await pareFeu();

    expect(await poser(fw, 'Asia/Tokyo')).toBe('');
    expect(fw.getTimezone()).toBe('Asia/Tokyo');
  }, 30000);
});

describe('chaque ligne de la table se verifie elle-meme', () => {
  it('le nom IANA porte le decalage que le libelle annonce', () => {
    const ecarts: string[] = [];

    for (const zone of FORTIOS_TIMEZONES) {
      const annonce = /\(GMT([+-]\d{1,2}):?(\d{2})?\)/.exec(zone.label);
      const attendu = annonce === null ? 0
        : Number.parseInt(annonce[1], 10) * 60
          + (annonce[2] === undefined ? 0 : Number.parseInt(annonce[2], 10))
            * (annonce[1].startsWith('-') ? -1 : 1);
      const reel = standardOffsetMinutes(TimeZone.of(zone.name), JANVIER);
      if (reel !== attendu) {
        ecarts.push(`index ${zone.index} ${zone.name} : libelle=${attendu} tzdata=${reel}`);
      }
    }

    expect(ecarts).toEqual([]);
  });
});
