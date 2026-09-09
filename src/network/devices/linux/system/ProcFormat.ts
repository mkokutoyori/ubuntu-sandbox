/**
 * ProcFormat — shared process-metrics formatting utilities.
 *
 * `ps` and `top` previously each carried their own copies of the
 * clock / CPU-time / memory-percentage formatters. Centralising them
 * here removes the duplication (DRY) and guarantees both commands
 * render identical values for the same process.
 */

const TOTAL_MEM_KB = 4_000_000;

function two(n: number): string {
  return String(n).padStart(2, '0');
}

/** Wall-clock HH:MM used for the STIME / START columns. */
export function formatClock(d: Date): string {
  return `${two(d.getHours())}:${two(d.getMinutes())}`;
}

/**
 * Accumulated CPU time as HH:MM:SS — la colonne `time` de `ps`, celle
 * que `ps -ef` et `ps -o time` rendent. Elle sortait en `MM:SS`, le
 * format de l'AUTRE colonne.
 */
export function formatCpuTime(ms: number): string {
  const total = Math.floor(ms / 1000);
  return `${two(Math.floor(total / 3600))}:${two(Math.floor(total / 60) % 60)}:${two(total % 60)}`;
}

/**
 * Accumulated CPU time as M:SS — la colonne `bsdtime`, celle que
 * `ps aux` rend sous l'en-tete `TIME`. Les minutes ne sont pas
 * completees a deux chiffres.
 */
export function formatBsdCpuTime(ms: number): string {
  const total = Math.floor(ms / 1000);
  return `${Math.floor(total / 60)}:${two(total % 60)}`;
}

export type TaskBucket = 'running' | 'sleeping' | 'stopped' | 'zombie';

/**
 * Le compartiment dans lequel `top` range un etat de processus. Les
 * fils noyau au repos (`I`) et l'attente disque non interruptible (`D`)
 * comptent comme DORMANTS : sans cela la ligne `Tasks` ne s'additionne
 * pas, ce qu'une vraie machine ne fait jamais.
 */
export function taskBucketOf(state: string): TaskBucket {
  switch (state[0]) {
    case 'R': return 'running';
    case 'T': case 't': return 'stopped';
    case 'Z': return 'zombie';
    default: return 'sleeping';
  }
}

/** Largeur de la colonne COMMAND de `top`, au-dela de laquelle il tronque. */
const TOP_COMMAND_WIDTH = 9;

/**
 * Le nom qu'affiche `top` : le `comm` sans les crochets dont `ps`
 * entoure un fil noyau, tronque a la largeur de colonne avec un `+`.
 */
export function topCommand(comm: string): string {
  const nu = comm.replace(/^\[(.*)\]$/, '$1');
  return nu.length > TOP_COMMAND_WIDTH
    ? `${nu.slice(0, TOP_COMMAND_WIDTH)}+`
    : nu;
}

/** RSS as a percentage of (simulated) total memory, one decimal. */
export function memPercent(rssKb: number): string {
  return ((rssKb / TOTAL_MEM_KB) * 100).toFixed(1);
}

/** KB → integer MiB (top VIRT/RES columns). */
export function kbToMiB(kb: number): number {
  return Math.floor(kb / 1024);
}

/**
 * La memoire PARTAGEE d'un processus, colonne `SHR` de `top`. Ce
 * simulateur ne modelise aucune projection partagee : il en compte donc
 * zero, comme il compte zero pour tout ce qu'il ne mesure pas. La
 * valeur precedente — `4M` pour TOUS les processus, fils noyau
 * compris — annoncait de la memoire partagee a des taches qui n'ont ni
 * espace virtuel ni resident.
 */
export function sharedKib(_process: { rss: number }): number {
  return 0;
}
