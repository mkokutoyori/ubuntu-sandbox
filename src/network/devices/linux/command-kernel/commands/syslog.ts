/**
 * Tables de noms syslog (priorités/niveaux) et formatage de date humaine —
 * utilitaires propres à la couche command-kernel, partagés par
 * `dmesg`/`journalctl`. Constantes POSIX stables, pas de logique de
 * commande héritée.
 */
export const PRIORITY_NAMES: Record<string, number> = {
  emerg: 0, emergency: 0, panic: 0, alert: 1, crit: 2, err: 3, error: 3,
  warning: 4, warn: 4, notice: 5, info: 6, debug: 7,
};

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Format de date « ctime » utilisé par `dmesg -T` : `Wed Jun 14 12:34:56 2026`. */
export function formatHumanDate(d: Date): string {
  const day = DAYS[d.getDay()];
  const mon = MONTHS[d.getMonth()];
  const dd = String(d.getDate()).padStart(2, ' ');
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${day} ${mon} ${dd} ${hh}:${mm}:${ss} ${d.getFullYear()}`;
}
