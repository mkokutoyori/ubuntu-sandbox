/**
 * LinuxProcess — the process **entity**.
 *
 * Part of the reactive refonte: the process table no longer stores
 * anonymous records but real objects that own their invariants and
 * behaviour (priority derives from nice, comm matching, snapshotting).
 * State *transitions* stay in {@link LinuxProcessManager} because that
 * is the aggregate root that also publishes the domain events — the
 * entity must never emit on its own (single source of truth).
 *
 * It structurally implements {@link ProcessInfo}, so every existing
 * consumer (ps engine, pgrep, top, tests) keeps working unchanged:
 * prototype methods are non-enumerable, hence invisible to
 * `toEqual` / `{...spread}` / `JSON.stringify`.
 */

import type { ProcessInfo, ProcessState } from '../LinuxProcessManager';

export class LinuxProcess implements ProcessInfo {
  pid!: number;
  ppid!: number;
  pgid!: number;
  sid!: number;
  uid!: number;
  gid!: number;
  user!: string;
  command!: string;
  comm!: string;
  args!: string[];
  state!: ProcessState;
  startTime!: Date;
  cpuTime!: number;
  vsize!: number;
  rss!: number;
  tty!: string;
  nice!: number;
  priority!: number;
  cwd!: string;
  exe!: string;
  serviceName?: string;

  constructor(init: ProcessInfo) {
    Object.assign(this, init);
  }

  /** True when the process is in the given state. */
  is(state: ProcessState): boolean {
    return this.state === state;
  }

  /** Match `ps -C` semantics (login shells expose comm as `-bash`). */
  matchesComm(name: string): boolean {
    return this.comm === name || this.comm.replace(/^-/, '') === name;
  }

  /** True when owned by `user`. */
  ownedBy(user: string): boolean {
    return this.user === user;
  }

  /** True when this is a daemon's main process. */
  isServiceProcess(): boolean {
    return this.serviceName !== undefined;
  }

  /** Apply a nice value, keeping the derived priority consistent. */
  applyNice(nice: number): void {
    this.nice = nice;
    this.priority = 20 + nice;
  }

  /** Plain serialisable copy (telemetry / UI projections). */
  snapshot(): ProcessInfo {
    return { ...this };
  }
}
