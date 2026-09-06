/**
 * Lot T2 du `docs/PRD-Geographie-Et-Temps-Local.md` : cette table n'est
 * plus une SECONDE ecriture du decalage, seulement la porte des
 * ABREVIATIONS.
 *
 * Elle rangeait un `offsetMin` FIXE par zone, et l'assumait en tete de
 * fichier : « `Europe/Paris` vaut ici UTC+1 toute l'annee ». Ce
 * raisonnement etait juste quand il a ete ecrit — rien ne portait les
 * regles d'heure d'ete. Il ne l'est plus depuis que
 * `core/time/TimeZoneRegistry` les calcule, et le garder faisait dire
 * a une machine Linux une heure differente de celle du pare-feu, au
 * meme instant et pour le meme fuseau.
 *
 * Le decalage vient donc du registre, ou il est une FONCTION de
 * l'instant. Ce qui RESTE ici est ce que le registre ne sait pas
 * produire : l'abreviation. Mesure : `Intl` rend `GMT+1`/`GMT+2` pour
 * `Europe/Paris`, jamais `CET`/`CEST` ; seules quelques zones
 * americaines rendent `EST`/`EDT`. Les abreviations tabulees ci-dessous
 * sont relevees sur le nom long qu'`Intl` rend, lui, correctement
 * (« Central European Summer Time » -> `CEST`), et non devinees : un
 * acronyme automatique donnerait `CUT` pour UTC et `MST` pour Moscou.
 *
 * Une zone ABSENTE de cette table reste acceptee si tzdata la connait,
 * avec la forme numerique que tzdata emploie lui-meme faute
 * d'abreviation propre (`+01`, `-05`) — c'est ce que `timedatectl`
 * affiche pour `Africa/Casablanca`.
 */
import { TimeZone } from '../../../core/time/TimeZone';
import {
  formatOffsetCompact, isDaylightSavingAt, offsetMinutesAt,
} from '../../../core/time/TimeZoneRegistry';

export interface Timezone {
  /** Le nom de zone, tel que `set-timezone` l'attend. */
  readonly nom: string;
  /** L'abreviation hors heure d'ete : `WAT`, `CET`, `EST`. */
  readonly abbr: string;
  /** Celle d'heure d'ete, quand la zone en a une : `CEST`, `EDT`. */
  readonly abbrDst?: string;
}

const Z = (nom: string, abbr: string, abbrDst?: string): Timezone =>
  abbrDst === undefined ? { nom, abbr } : { nom, abbr, abbrDst };

export const TIMEZONES: readonly Timezone[] = [
  Z('Etc/UTC', 'UTC'),
  Z('UTC', 'UTC'),
  Z('Africa/Abidjan', 'GMT'),
  Z('Africa/Accra', 'GMT'),
  Z('Africa/Algiers', 'CET'),
  Z('Africa/Bangui', 'WAT'),
  Z('Africa/Brazzaville', 'WAT'),
  Z('Africa/Cairo', 'EET', 'EEST'),
  Z('Africa/Casablanca', '+01'),
  Z('Africa/Dakar', 'GMT'),
  Z('Africa/Dar_es_Salaam', 'EAT'),
  Z('Africa/Douala', 'WAT'),
  Z('Africa/Johannesburg', 'SAST'),
  Z('Africa/Kampala', 'EAT'),
  Z('Africa/Kinshasa', 'WAT'),
  Z('Africa/Lagos', 'WAT'),
  Z('Africa/Libreville', 'WAT'),
  Z('Africa/Lubumbashi', 'CAT'),
  Z('Africa/Nairobi', 'EAT'),
  Z('Africa/Ndjamena', 'WAT'),
  Z('Africa/Tunis', 'CET'),
  Z('Europe/Berlin', 'CET', 'CEST'),
  Z('Europe/Brussels', 'CET', 'CEST'),
  Z('Europe/Lisbon', 'WET', 'WEST'),
  Z('Europe/London', 'GMT', 'BST'),
  Z('Europe/Madrid', 'CET', 'CEST'),
  Z('Europe/Moscow', 'MSK'),
  Z('Europe/Paris', 'CET', 'CEST'),
  Z('Europe/Rome', 'CET', 'CEST'),
  Z('America/Bogota', '-05'),
  Z('America/Chicago', 'CST', 'CDT'),
  Z('America/Denver', 'MST', 'MDT'),
  Z('America/Los_Angeles', 'PST', 'PDT'),
  Z('America/Mexico_City', 'CST'),
  Z('America/New_York', 'EST', 'EDT'),
  Z('America/Sao_Paulo', '-03'),
  Z('America/Toronto', 'EST', 'EDT'),
  Z('Asia/Dubai', '+04'),
  Z('Asia/Hong_Kong', 'HKT'),
  Z('Asia/Jerusalem', 'IST', 'IDT'),
  Z('Asia/Kolkata', 'IST'),
  Z('Asia/Riyadh', '+03'),
  Z('Asia/Seoul', 'KST'),
  Z('Asia/Shanghai', 'CST'),
  Z('Asia/Singapore', '+08'),
  Z('Asia/Tokyo', 'JST'),
  Z('Australia/Melbourne', 'AEST', 'AEDT'),
  Z('Australia/Sydney', 'AEST', 'AEDT'),
  Z('Pacific/Auckland', 'NZST', 'NZDT'),
];

const PAR_NOM = new Map(TIMEZONES.map((z) => [z.nom.toLowerCase(), z]));

function numericAbbreviation(zone: TimeZone, atMs: number): string {
  const minutes = offsetMinutesAt(zone, atMs);
  const signe = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  const heures = String(Math.floor(abs / 60)).padStart(2, '0');
  return abs % 60 === 0
    ? `${signe}${heures}`
    : `${signe}${heures}:${String(abs % 60).padStart(2, '0')}`;
}

/** La zone portant ce nom, si tzdata la connait. La casse est la sienne. */
export function trouverTimezone(nom: string): Timezone | undefined {
  const zone = TimeZone.parse(nom);
  if (!zone) return undefined;

  const tabulee = PAR_NOM.get(zone.name.toLowerCase())
    ?? PAR_NOM.get(nom.trim().toLowerCase());
  if (tabulee) return tabulee;

  return { nom: zone.name, abbr: numericAbbreviation(zone, Date.now()) };
}

/** Les noms, tries — ce que `timedatectl list-timezones` imprime. */
export function listerTimezones(): string[] {
  return TIMEZONES.map((z) => z.nom).sort();
}

/** Le decalage de cette zone A CET INSTANT, heure d'ete comprise. */
export function decalageA(nom: string, atMs: number): number {
  const zone = TimeZone.parse(nom);
  return zone ? offsetMinutesAt(zone, atMs) : 0;
}

/** L'abreviation A CET INSTANT : `CET` en janvier, `CEST` en juillet. */
export function abreviationA(nom: string, atMs: number): string {
  const zone = TimeZone.parse(nom);
  if (!zone) return 'UTC';

  const tabulee = PAR_NOM.get(zone.name.toLowerCase());
  if (!tabulee) return numericAbbreviation(zone, atMs);
  if (tabulee.abbrDst && isDaylightSavingAt(zone, atMs)) return tabulee.abbrDst;
  return tabulee.abbr;
}

export { formatOffsetCompact as formatOffset };
