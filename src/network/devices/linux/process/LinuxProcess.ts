/**
 * LinuxProcess — Linux-flavoured {@link OSProcess}.
 *
 * Linux-specific behaviour: `-bash` login-shell comm matching for
 * `ps -C`, ProcessInfo structural compatibility for the existing
 * managers/tests, and a snapshot that returns ProcessInfo (not the
 * full OS-agnostic field set, to keep existing consumers stable).
 *
 * State transitions stay in {@link LinuxProcessManager} (aggregate
 * root + event publisher).
 */

import { OSProcess } from '../../os/OSProcess';
import type { ProcessInfo, ProcessState } from '../LinuxProcessManager';

export class LinuxProcess extends OSProcess implements ProcessInfo {
  // Re-declare for ProcessInfo structural compatibility (state type is
  // imported from the manager rather than from OSProcess).
  declare state: ProcessState;

  constructor(init: ProcessInfo) {
    super({
      pid: init.pid, ppid: init.ppid, pgid: init.pgid, sid: init.sid,
      uid: init.uid, gid: init.gid, user: init.user,
      command: init.command, comm: init.comm, args: init.args, exe: init.exe,
      state: init.state, startTime: init.startTime,
      cwd: init.cwd, tty: init.tty, nice: init.nice,
      vsize: init.vsize, rss: init.rss,
      serviceName: init.serviceName,
      schedPolicy: init.schedPolicy, rtPriority: init.rtPriority,
      ioClass: init.ioClass, ioClassData: init.ioClassData,
      cpuAffinity: init.cpuAffinity,
    });
    // Caller may pass cpuTime or priority overrides; honour them.
    this.cpuTime = init.cpuTime;
    if (typeof init.priority === 'number') this.priority = init.priority;
  }

  /** True when the process is in the given state. */
  is(state: ProcessState): boolean { return this.state === state; }

  /** Match `ps -C` semantics (login shells expose comm as `-bash`). */
  matchesComm(name: string): boolean {
    return this.comm === name || this.comm.replace(/^-/, '') === name;
  }

  /**
   * Owned-by check that accepts either a username (Linux ergonomic) or
   * a numeric uid (OSProcess base signature). Overrides the base to
   * keep `p.ownedBy('root')` calls in existing code working.
   */
  ownedBy(who: string | number): boolean {
    return typeof who === 'string' ? this.user === who : this.uid === who;
  }

  /**
   * Plain-object snapshot — all enumerable instance fields, no methods.
   * Wider than the ProcessInfo interface (it carries every OSProcess
   * attribute too); consumers that need exactly ProcessInfo can pick
   * fields off the result, but most just want a JSON-safe copy.
   */
  snapshot(): ProcessInfo {
    return { ...this } as ProcessInfo;
  }
}
