/**
 * PRD-NTP-Tutoriel.md §4 / lot N3 — la base des fuseaux, et pourquoi
 * elle existe.
 *
 * `timedatectl set-timezone Africa/Douala` etait ACCEPTE et ne changeait
 * rien : l'heure restait UTC, `timedatectl` continuait d'ecrire
 * `Time zone: Etc/UTC (UTC, +0000)`, et `timedatectl list-timezones` ne
 * rendait rien. Il n'y avait aucune notion de fuseau sur la machine —
 * seulement une chaine rangee dans l'identite systeme, que la vue
 * reimprimait avec un decalage ECRIT EN DUR a `+0000` quel qu'il soit.
 *
 * Ce fichier est ce qui manquait : un nom de zone porte un decalage et
 * une abreviation, donc `set-timezone` peut agir et `list-timezones`
 * peut repondre.
 *
 * ── Ce qui est delibrement absent, et dit plutot que tu ─────────────
 *
 * La vraie base tzdata compte plus de six cents zones et decrit leurs
 * regles d'heure d'ete sur plus d'un siecle. Celle-ci en porte une
 * cinquantaine, choisies pour couvrir les continents et les cas du
 * tutoriel (Afrique centrale et de l'Ouest), avec un decalage FIXE.
 * Les zones a heure d'ete y figurent avec leur heure normale : une
 * bascule saisonniere demanderait les regles de tzdata, que ce
 * simulateur n'a pas — et inventer une date de bascule serait pire que
 * de ne pas en avoir, puisque personne ne pourrait la verifier.
 *
 * Consequence assumee : `Europe/Paris` vaut ici UTC+1 toute l'annee.
 */

export interface Timezone {
  /** Le nom de zone, tel que `set-timezone` l'attend. */
  readonly nom: string;
  /** L'abreviation que `timedatectl` affiche : `WAT`, `CET`, `EST`. */
  readonly abbr: string;
  /** Le decalage sur UTC, en minutes. */
  readonly offsetMin: number;
}

const Z = (nom: string, abbr: string, offsetMin: number): Timezone => ({ nom, abbr, offsetMin });

/**
 * Les zones connues. `Etc/UTC` est la premiere parce que c'est le
 * defaut d'une image Debian nue, celui que la machine porte au demarrage.
 */
export const TIMEZONES: readonly Timezone[] = [
  Z('Etc/UTC', 'UTC', 0),
  Z('UTC', 'UTC', 0),
  // Afrique — les fuseaux du tutoriel.
  Z('Africa/Abidjan', 'GMT', 0),
  Z('Africa/Accra', 'GMT', 0),
  Z('Africa/Algiers', 'CET', 60),
  Z('Africa/Bangui', 'WAT', 60),
  Z('Africa/Brazzaville', 'WAT', 60),
  Z('Africa/Cairo', 'EET', 120),
  Z('Africa/Casablanca', 'WEST', 60),
  Z('Africa/Dakar', 'GMT', 0),
  Z('Africa/Dar_es_Salaam', 'EAT', 180),
  Z('Africa/Douala', 'WAT', 60),
  Z('Africa/Johannesburg', 'SAST', 120),
  Z('Africa/Kampala', 'EAT', 180),
  Z('Africa/Kinshasa', 'WAT', 60),
  Z('Africa/Lagos', 'WAT', 60),
  Z('Africa/Libreville', 'WAT', 60),
  Z('Africa/Lubumbashi', 'CAT', 120),
  Z('Africa/Nairobi', 'EAT', 180),
  Z('Africa/Ndjamena', 'WAT', 60),
  Z('Africa/Tunis', 'CET', 60),
  Z('Africa/Yaounde', 'WAT', 60),
  // Europe.
  Z('Europe/Berlin', 'CET', 60),
  Z('Europe/Brussels', 'CET', 60),
  Z('Europe/Lisbon', 'WET', 0),
  Z('Europe/London', 'GMT', 0),
  Z('Europe/Madrid', 'CET', 60),
  Z('Europe/Moscow', 'MSK', 180),
  Z('Europe/Paris', 'CET', 60),
  Z('Europe/Rome', 'CET', 60),
  // Ameriques.
  Z('America/Bogota', '-05', -300),
  Z('America/Chicago', 'CST', -360),
  Z('America/Denver', 'MST', -420),
  Z('America/Los_Angeles', 'PST', -480),
  Z('America/Mexico_City', 'CST', -360),
  Z('America/New_York', 'EST', -300),
  Z('America/Sao_Paulo', '-03', -180),
  Z('America/Toronto', 'EST', -300),
  // Asie et Oceanie.
  Z('Asia/Dubai', '+04', 240),
  Z('Asia/Hong_Kong', 'HKT', 480),
  Z('Asia/Jerusalem', 'IST', 120),
  Z('Asia/Kolkata', 'IST', 330),
  Z('Asia/Riyadh', '+03', 180),
  Z('Asia/Seoul', 'KST', 540),
  Z('Asia/Shanghai', 'CST', 480),
  Z('Asia/Singapore', '+08', 480),
  Z('Asia/Tokyo', 'JST', 540),
  Z('Australia/Melbourne', 'AEST', 600),
  Z('Australia/Sydney', 'AEST', 600),
  Z('Pacific/Auckland', 'NZST', 720),
];

const PAR_NOM = new Map(TIMEZONES.map((z) => [z.nom.toLowerCase(), z]));

/** La zone portant ce nom, si elle existe. La casse est celle de tzdata. */
export function trouverTimezone(nom: string): Timezone | undefined {
  return PAR_NOM.get(nom.trim().toLowerCase());
}

/** Les noms, tries — ce que `timedatectl list-timezones` imprime. */
export function listerTimezones(): string[] {
  return TIMEZONES.map((z) => z.nom).sort();
}

/** `+0100`, `-0500` — la forme que `timedatectl` met entre parentheses. */
export function formatOffset(offsetMin: number): string {
  const signe = offsetMin < 0 ? '-' : '+';
  const abs = Math.abs(offsetMin);
  return `${signe}${String(Math.floor(abs / 60)).padStart(2, '0')}${String(abs % 60).padStart(2, '0')}`;
}
