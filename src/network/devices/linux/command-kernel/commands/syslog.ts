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

export const FACILITY_NAMES: Record<string, number> = {
  kern: 0, user: 1, mail: 2, daemon: 3,
  auth: 4, syslog: 5, lpr: 6, news: 7,
  cron: 8, authpriv: 10, ftp: 11,
  local0: 16, local1: 17, local2: 18,
  local3: 19, local4: 20, local5: 21, local6: 22, local7: 23,
};

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Horodatage syslog court (`journalctl -o short`) : `Jun 14 12:34:56`. */
export function formatSyslogTimestamp(d: Date): string {
  const mon = MONTHS[d.getMonth()];
  const day = String(d.getDate()).padStart(2, ' ');
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${mon} ${day} ${hh}:${mm}:${ss}`;
}

/** Horodatage ISO (`journalctl -o short-iso`) : `2026-06-14T12:34:56+0000`. */
export function formatIsoTimestamp(d: Date): string {
  const yyyy = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${yyyy}-${mo}-${dd}T${hh}:${mm}:${ss}+0000`;
}

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
