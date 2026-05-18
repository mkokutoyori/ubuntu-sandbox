/**
 * HostCommandRunner — pluggable host-shell executor for SQL*Plus.
 *
 * SQL*Plus' `HOST <cmd>` (also `! <cmd>`) drops to the OS shell. The
 * session itself stays decoupled from any concrete device: the
 * sub-shell that owns the session wires a runner that delegates to the
 * underlying machine. When no runner is wired, the session falls back
 * to the historical "not available" message.
 */
export interface HostCommandRunner {
  /** Execute a host shell command. Returns one entry per output line. */
  execute(command: string): string[];
}
