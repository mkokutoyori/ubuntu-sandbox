/**
 * `cal` — le calendrier.
 *
 * Aucun état machine n'est en jeu : c'est du calcul pur, mais c'est
 * précisément pour ça que son absence se remarquait — un `cal` qui répond
 * `command not found` sur une machine par ailleurs complète est un trou
 * gratuit, et c'est la commande qu'on tape pour lire une date de crontab
 * ou vérifier un jour de la semaine.
 *
 * Relevé sur le binaire de la machine de référence (Ubuntu 24.04) :
 *
 *         August 2026␣␣␣␣␣␣␣
 *     Su Mo Tu We Th Fr Sa␣␣
 *                        1␣␣
 *      2  3  4  5  6  7  8␣␣
 *
 * Chaque ligne fait 22 colonnes — sept colonnes de trois moins l'espace de
 * tête, plus deux espaces de queue — et l'en-tête du mois est **centré**
 * sur ces 20 caractères utiles. Les espaces de fin sont ceux du vrai
 * binaire, pas une négligence ; les enlever ferait échouer une
 * comparaison colonne à colonne.
 *
 * `-3` et une année seule passent par le même moteur : trois mois par
 * bande, deux espaces entre les grilles, et l'année seule centrée
 * au-dessus.
 *
 * Ce qui n'est PAS modélisé : le basculement julien → grégorien de
 * septembre 1752, que `cal 9 1752` montre sur un vrai système. Le
 * simulateur ne modélise aucune date antérieure au démarrage de la
 * machine et une grille amputée pour cette seule combinaison serait un
 * détail sans usage pédagogique ici.
 */

import type { LinuxCommand, LinuxCommandOption } from '../LinuxCommand';
import type { LinuxCommandContext } from '../LinuxCommandContext';

const CAL_OPTIONS: readonly LinuxCommandOption[] = [
  { flag: '-1', dest: 'one', description: 'Display single month output (default)' },
  { flag: '-3', dest: 'three', description: 'Display previous, current and next month' },
  { flag: '-y', dest: 'year', description: 'Display a calendar for the whole year' },
  { flag: '-j', dest: 'julian', description: 'Display day-of-year (Julian) dates' },
  { flag: '-m', dest: 'month', takesArg: true, argName: 'month', description: 'Display the specified month' },
];

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'] as const;

const DAY_HEADER = 'Su Mo Tu We Th Fr Sa';

/** Largeur d'une grille : sept colonnes de trois, moins l'espace de tête. */
const GRID_WIDTH = 20;
const JULIAN_GRID_WIDTH = 27;
/** Nombre de semaines qu'un corps de mois occupe toujours — mesuré. */
const WEEK_ROWS = 6;

function isLeap(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

function daysInMonth(m: number, y: number): number {
  return [31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m];
}

/** Jour de l'année du 1er du mois — la base de la numérotation `-j`. */
function dayOfYearOfFirst(m: number, y: number): number {
  let n = 1;
  for (let i = 0; i < m; i++) n += daysInMonth(i, y);
  return n;
}

/** Centre `text` sur `width`, en complétant à droite jusqu'à `width`. */
function centre(text: string, width: number): string {
  const left = Math.max(0, Math.floor((width - text.length) / 2));
  return `${' '.repeat(left)}${text}`.padEnd(width, ' ');
}

/**
 * Une grille mensuelle, en-tête compris : `[titre, jours, …semaines]`.
 * Chaque ligne est complétée à la largeur de la grille pour que la mise
 * en bande de `-3` / `-y` reste alignée.
 */
export function monthGrid(month: number, year: number, julian = false, withYear = true): string[] {
  const width = julian ? JULIAN_GRID_WIDTH : GRID_WIDTH;
  const cell = julian ? 3 : 2;
  const title = withYear ? `${MONTHS[month]} ${year}` : MONTHS[month];
  const header = julian
    ? DAY_HEADER.split(' ').map((d) => d.padStart(3)).join(' ')
    : DAY_HEADER;
  const lines = [centre(title, width), header.padEnd(width, ' ')];

  const firstWeekday = new Date(Date.UTC(year, month, 1)).getUTCDay();
  const total = daysInMonth(month, year);
  const base = julian ? dayOfYearOfFirst(month, year) - 1 : 0;

  let week: string[] = Array.from({ length: firstWeekday }, () => ' '.repeat(cell));
  for (let day = 1; day <= total; day++) {
    week.push(String(base + day).padStart(cell));
    if (week.length === 7) {
      lines.push(week.join(' ').padEnd(width, ' '));
      week = [];
    }
  }
  if (week.length > 0) lines.push(week.join(' ').padEnd(width, ' '));
  // Mesuré : le corps fait TOUJOURS six semaines, complétées par des
  // lignes blanches (`cal 2 2026` en rend quatre pleines puis deux
  // vides). C'est ce qui garde les bandes de `-3` et d'une année
  // alignées entre elles sans que rien n'ait à les recadrer après coup.
  while (lines.length < WEEK_ROWS + 2) lines.push(' '.repeat(width));
  return lines;
}

/** Met des grilles côte à côte, trois par bande, séparées de deux espaces. */
function band(grids: string[][]): string[] {
  const height = Math.max(...grids.map((g) => g.length));
  const width = grids[0][0].length;
  const out: string[] = [];
  for (let row = 0; row < height; row++) {
    out.push(grids.map((g) => (g[row] ?? '').padEnd(width, ' ')).join('  ') + '  ');
  }
  return out;
}

function renderYear(year: number, julian: boolean): string[] {
  const perBand = julian ? 2 : 3;
  const gridWidth = julian ? JULIAN_GRID_WIDTH : GRID_WIDTH;
  // Mesuré : le vrai binaire centre l'année sur la somme des grilles
  // SEULES, séparateurs exclus — 28 espaces avant `2026` sur trois
  // grilles de 20, pas 30. Compter les séparateurs décale de deux.
  const totalWidth = perBand * gridWidth;
  const lines = [centre(String(year), totalWidth).trimEnd(), ''];
  for (let m = 0; m < 12; m += perBand) {
    const grids = [];
    for (let k = 0; k < perBand; k++) grids.push(monthGrid(m + k, year, julian, false));
    lines.push(...band(grids));
    if (m + perBand < 12) lines.push('');
  }
  return lines;
}

export function runCal(now: Date, args: string[]): { output: string; exitCode: number } {
  let three = false;
  let whole = false;
  let julian = false;
  let monthFlag: number | undefined;
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-3') { three = true; continue; }
    if (a === '-1') { three = false; continue; }
    if (a === '-y') { whole = true; continue; }
    if (a === '-j') { julian = true; continue; }
    if (a === '-m') {
      const n = parseInt(args[++i] ?? '', 10);
      if (Number.isNaN(n) || n < 1 || n > 12) {
        return { output: `cal: ${args[i]} is neither a month number (1..12) nor a name`, exitCode: 64 };
      }
      monthFlag = n;
      continue;
    }
    if (a.startsWith('-')) return { output: usageText(), exitCode: 64 };
    positional.push(a);
  }

  let month = now.getMonth();
  let year = now.getFullYear();

  if (monthFlag !== undefined) {
    month = monthFlag - 1;
    if (positional.length >= 1) {
      const y = parseInt(positional[0], 10);
      if (Number.isNaN(y)) return { output: `cal: illegal year value: ${positional[0]}`, exitCode: 64 };
      year = y;
    }
  } else if (positional.length === 1) {
    // Un seul argument est une ANNÉE (`cal 2026`), pas un mois — c'est la
    // règle de cal, et s'en écarter afficherait août quand on demande 2026.
    const y = parseInt(positional[0], 10);
    if (Number.isNaN(y)) return { output: `cal: illegal year value: ${positional[0]}`, exitCode: 64 };
    year = y;
    whole = true;
  } else if (positional.length >= 2) {
    const m = parseInt(positional[0], 10);
    if (Number.isNaN(m) || m < 1 || m > 12) {
      return { output: `cal: ${positional[0]} is neither a month number (1..12) nor a name`, exitCode: 64 };
    }
    const y = parseInt(positional[1], 10);
    if (Number.isNaN(y)) return { output: `cal: illegal year value: ${positional[1]}`, exitCode: 64 };
    month = m - 1;
    year = y;
  }

  if (whole) return { output: renderYear(year, julian).join('\n'), exitCode: 0 };

  if (three) {
    const grids = [-1, 0, 1].map((d) => {
      const t = new Date(Date.UTC(year, month + d, 1));
      return monthGrid(t.getUTCMonth(), t.getUTCFullYear(), julian, false);
    });
    const spanYear = new Date(Date.UTC(year, month, 1)).getUTCFullYear();
    const gridWidth = julian ? JULIAN_GRID_WIDTH : GRID_WIDTH;
    const head = centre(String(spanYear), 3 * gridWidth).trimEnd();
    return { output: [head, ...band(grids)].join('\n'), exitCode: 0 };
  }

  return { output: monthGrid(month, year, julian).map((l) => `${l}  `).join('\n'), exitCode: 0 };
}

function usageText(): string {
  return [
    'Usage: cal [general options] [-jy] [[month] year]',
    '       cal [general options] [-j] [-m month] [year]',
  ].join('\n');
}

export const calCommand: LinuxCommand = {
  name: 'cal',
  needsNetworkContext: true,
  usage: 'cal [-13jy] [-m month] [[month] year]',
  manSection: 1,
  options: CAL_OPTIONS,
  help: 'Display a calendar.',
  run(ctx: LinuxCommandContext, args) {
    return runCal(ctx.executor.simulatedDate(), args).output;
  },
  runWithStatusSync(ctx: LinuxCommandContext, args) {
    return runCal(ctx.executor.simulatedDate(), args);
  },
};
