/**
 * LinuxProfile - Declarative configuration of a simulated Linux machine.
 *
 * A profile is the only thing that distinguishes a `LinuxPC` from a
 * `LinuxServer` (or any future Linux-flavored device). All behavior is
 * implemented once in `LinuxMachine`; the profile drives construction-time
 * choices.
 *
 * See `linux_gap.md` §6 for the rationale.
 */

export interface LinuxProfile {
  /** Number of Ethernet interfaces to create by default. */
  readonly portCount: number;

  /** Prefix used when naming ports: "eth" → eth0, eth1, ... */
  readonly portPrefix: string;

  /**
   * Whether the machine runs as a server profile (root session, no default
   * `user` account). Passed through to `LinuxCommandExecutor`.
   */
  readonly isServer: boolean;

  /** Hostname displayed in the shell and in `sudo -l` output. */
  readonly hostname: string;

  /**
   * Expose `registerProcess`/`clearSystemProcesses` on the device so that
   * external subsystems (e.g. Oracle DBMS background processes) can surface
   * their processes in `ps` / `top`.
   */
  readonly exposeSystemProcessApi?: boolean;
}

/** Default profile for a desktop / workstation Linux machine. */
export const LINUX_PC_PROFILE: LinuxProfile = {
  portCount: 4,
  portPrefix: 'eth',
  isServer: false,
  hostname: 'linux-pc',
};

/** Default profile for a Linux server. */
export const LINUX_SERVER_PROFILE: LinuxProfile = {
  portCount: 4,
  portPrefix: 'eth',
  isServer: true,
  hostname: 'linux-server',
  exposeSystemProcessApi: true,
};
