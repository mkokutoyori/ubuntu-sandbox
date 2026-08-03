/**
 * `systemd-analyze calendar` et `systemd-analyze timespan` — les deux
 * sous-commandes qui répondent à la question qu'on se pose devant un
 * `OnCalendar=` : « et ça tombe quand, au juste ? »
 *
 * L'analyseur calendaire existe depuis la phase 2 des tâches planifiées
 * (`systemd/CalendarSpec.ts`) et a été vérifié expression par expression
 * contre le vrai `systemd-analyze`. Ce qui manquait n'était pas le calcul
 * mais la porte : aucune commande ne le donnait à l'opérateur.
 *
 * Transcription relevée sur le vrai (systemd d'Ubuntu), au caractère
 * d'indentation près :
 *
 *       Original form: daily
 *     Normalized form: *-*-* 00:00:00
 *         Next elapse: Mon 2026-08-03 00:00:00 UTC
 *            From now: 2h 23min left
 *
 * Trois choses non évidentes, toutes mesurées :
 *   - « Original form » n'apparaît **que** si l'entrée diffère de la forme
 *     normalisée. `Mon *-*-* 06:00:00` n'en a pas.
 *   - une date fixe déjà passée donne `Next elapse: never`, et **aucune**
 *     ligne « From now » derrière.
 *   - une base postérieure à l'échéance donne `… ago`, pas `… left`.
 */

import type { LinuxCommand } from '../LinuxCommand';
import {
  parseCalendar, nextCalendarElapse, normalizeCalendar,
} from '../../systemd/CalendarSpec';

const JOURS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const deux = (n: number): string => String(n).padStart(2, '0');

/** `Mon 2026-08-03 00:00:00 UTC` — la forme qu'imprime `Next elapse`. */
function formatElapse(d: Date): string {
  return `${JOURS[d.getDay()]} ${d.getFullYear()}-${deux(d.getMonth() + 1)}-${deux(d.getDate())}`
    + ` ${deux(d.getHours())}:${deux(d.getMinutes())}:${deux(d.getSeconds())} UTC`;
}

/**
 * La durée telle que systemd la dit : les deux unités les plus grandes,
 * jamais plus. `2h 23min`, `1 week 0 days`, `23min`, `5h 23min`.
 *
 * Les semaines et les jours s'écrivent en toutes lettres et gardent le
 * zéro (`1 week 0 days`) ; en dessous, les unités sont abrégées et une
 * unité nulle disparaît (`5h` et non `5h 0min`). C'est le relevé, pas
 * une règle inventée.
 */
export function formatTimespan(ms: number): string {
  const s = Math.floor(ms / 1000);
  const semaines = Math.floor(s / 604_800);
  const jours = Math.floor((s % 604_800) / 86_400);
  const heures = Math.floor((s % 86_400) / 3_600);
  const minutes = Math.floor((s % 3_600) / 60);
  const secondes = s % 60;

  if (semaines > 0) {
    return `${semaines} ${semaines === 1 ? 'week' : 'weeks'} ${jours} ${jours === 1 ? 'day' : 'days'}`;
  }
  if (jours > 0) {
    const reste = heures > 0 ? ` ${heures}h` : '';
    return `${jours} ${jours === 1 ? 'day' : 'days'}${reste}`;
  }
  if (heures > 0) return minutes > 0 ? `${heures}h ${minutes}min` : `${heures}h`;
  if (minutes > 0) return secondes > 0 ? `${minutes}min ${secondes}s` : `${minutes}min`;
  return `${secondes}s`;
}

/** Le bloc de quatre lignes que rend une expression calendaire. */
function analyseCalendar(expression: string, base: Date, iterations: number): string[] {
  const spec = parseCalendar(expression);
  if (spec === null) {
    return [`Failed to parse calendar specification '${expression}': Invalid argument`];
  }
  const normalisee = normalizeCalendar(expression) ?? expression;
  const lignes: string[] = [];
  if (normalisee !== expression.trim()) lignes.push(`  Original form: ${expression.trim()}`);
  lignes.push(`Normalized form: ${normalisee}`);

  let curseur = base;
  for (let i = 0; i < Math.max(1, iterations); i++) {
    const next = nextCalendarElapse(spec, curseur);
    if (next === null) {
      // « never » clôt le bloc : le vrai n'écrit pas de « From now »
      // derrière une échéance qui n'arrivera pas.
      if (i === 0) lignes.push('    Next elapse: never');
      break;
    }
    lignes.push(i === 0
      ? `    Next elapse: ${formatElapse(next)}`
      : `   Iteration #${i + 1}: ${formatElapse(next)}`);
    const delta = next.getTime() - base.getTime();
    lignes.push(`       From now: ${formatTimespan(Math.abs(delta))} ${delta >= 0 ? 'left' : 'ago'}`);
    curseur = next;
  }
  return lignes;
}

/** `systemd-analyze timespan 2h 30min` — la durée en microsecondes et en clair. */
function analyseTimespan(expression: string): string[] {
  const unites: Record<string, number> = {
    us: 1e-3, ms: 1, s: 1000, sec: 1000, second: 1000, seconds: 1000,
    m: 60_000, min: 60_000, minute: 60_000, minutes: 60_000,
    h: 3_600_000, hr: 3_600_000, hour: 3_600_000, hours: 3_600_000,
    d: 86_400_000, day: 86_400_000, days: 86_400_000,
    w: 604_800_000, week: 604_800_000, weeks: 604_800_000,
  };
  let total = 0;
  let vu = false;
  for (const morceau of expression.trim().matchAll(/(\d+(?:\.\d+)?)\s*([a-z]*)/gi)) {
    const n = Number(morceau[1]);
    const u = morceau[2].toLowerCase();
    const facteur = u === '' ? 1000 : unites[u];
    if (facteur === undefined) {
      return [`Failed to parse time span '${expression}': Invalid argument`];
    }
    total += n * facteur;
    vu = true;
  }
  if (!vu) return [`Failed to parse time span '${expression}': Invalid argument`];
  return [
    `Original: ${expression.trim()}`,
    `      μs: ${Math.round(total * 1000)}`,
    `   Human: ${formatTimespan(total)}`,
  ];
}

export const systemdAnalyzeCommand: LinuxCommand = {
  name: 'systemd-analyze',
  needsNetworkContext: true,
  usage: 'systemd-analyze calendar [--iterations=N] [--base-time=TIME] EXPRESSION...',
  manSection: 1,
  help: 'Shows when a calendar expression elapses next, and converts time spans.',
  runWithStatusSync: (ctx, args) => {
    const sousCommande = args.find((a) => !a.startsWith('-'));
    const options = args.filter((a) => a.startsWith('-'));
    const reste = args.filter((a) => !a.startsWith('-') && a !== sousCommande);

    if (sousCommande === 'timespan') {
      if (reste.length === 0) {
        return { output: 'Too few arguments.', exitCode: 1 };
      }
      // `2h 30min` arrive en deux mots : le vrai les recolle.
      const bloc = analyseTimespan(reste.join(' '));
      return { output: bloc.join('\n'), exitCode: bloc[0].startsWith('Failed') ? 1 : 0 };
    }

    if (sousCommande !== 'calendar') {
      return {
        output: `Unknown verb ${sousCommande ?? ''}.\nOnly 'calendar' and 'timespan' are simulated.`,
        exitCode: 1,
      };
    }
    if (reste.length === 0) return { output: 'Too few arguments.', exitCode: 1 };

    const opt = (nom: string): string | null => {
      const trouve = options.find((o) => o.startsWith(`--${nom}=`));
      return trouve ? trouve.slice(nom.length + 3) : null;
    };
    const iterations = Number(opt('iterations') ?? '1') || 1;
    const baseTexte = opt('base-time');
    const base = baseTexte ? new Date(baseTexte.replace(' ', 'T')) : ctx.executor.simulatedDate();
    if (Number.isNaN(base.getTime())) {
      return { output: `Failed to parse time specification '${baseTexte}': Invalid argument`, exitCode: 1 };
    }

    const blocs: string[][] = [];
    let echec = false;
    for (const expression of reste) {
      const bloc = analyseCalendar(expression, base, iterations);
      if (bloc[0].startsWith('Failed')) echec = true;
      blocs.push(bloc);
    }
    // Plusieurs expressions sont séparées par une ligne vide.
    return { output: blocs.map((b) => b.join('\n')).join('\n\n'), exitCode: echec ? 1 : 0 };
  },
  run: (ctx, args) => (systemdAnalyzeCommand.runWithStatusSync!(ctx, args)).output,
};
