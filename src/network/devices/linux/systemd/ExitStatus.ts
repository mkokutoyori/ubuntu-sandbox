/**
 * The names systemd gives the exit statuses it defines itself
 * (src/basic/exit-status.c), and which `systemctl status` and the journal
 * both print after the number.
 *
 * The name is the whole diagnosis: `203/EXEC` says the child could never be
 * executed — a missing or unexecutable binary — as opposed to a daemon that
 * ran and refused. Anything outside systemd's own table keeps the generic
 * SUCCESS/FAILURE, which is what the status and journal lines printed for
 * every code before this table existed.
 *
 * It lives here rather than beside either caller because `systemctl status`
 * and `journalctl -u` describe the same exit and must not be able to name it
 * differently.
 */
const SYSTEMD_EXIT_NAMES: Record<number, string> = {
  0: 'SUCCESS',
  1: 'FAILURE',
  2: 'INVALIDARGUMENT',
  200: 'CHDIR',
  202: 'FDS',
  203: 'EXEC',
  204: 'MEMORY',
  208: 'STDIN',
  209: 'STDOUT',
  216: 'GROUP',
  217: 'USER',
};

/** `SUCCESS`, `FAILURE`, `EXEC`, … — what follows the `status=<n>/` slash. */
export function exitStatusLabel(code: number): string {
  return SYSTEMD_EXIT_NAMES[code] ?? (code === 0 ? 'SUCCESS' : 'FAILURE');
}

/** systemd's exit status for "could not execute the binary at all". */
export const EXIT_EXEC = 203;
