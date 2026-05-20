/**
 * LinuxServer - Linux server (root profile + Oracle process API).
 *
 * Phase 3: all logic lives in `LinuxMachine`. `LinuxServer` is a thin
 * shell that provides the server profile to the parent constructor
 * and exposes the Oracle-specific pass-throughs (`registerProcess`,
 * `unregisterProcess`, `clearSystemProcesses`) used by
 * `OracleFilesystemSync` to keep the Linux process table in sync with
 * `STARTUP` / `SHUTDOWN` reactively.
 */

import type { DeviceType } from '../core/types';
import { LinuxMachine } from './LinuxMachine';
import { LINUX_SERVER_PROFILE } from './linux/LinuxProfile';

export class LinuxServer extends LinuxMachine {
  constructor(
    type: DeviceType = 'linux-server',
    name: string = 'Server',
    x: number = 0,
    y: number = 0,
  ) {
    super(type, name, x, y, LINUX_SERVER_PROFILE);
  }

  /** Expose a background process in `ps` output (used by Oracle DBMS). */
  registerProcess(pid: number, user: string, command: string): void {
    this.executor.registerProcess(pid, user, command);
  }

  /** Reactive counterpart of registerProcess — removes one entry. */
  unregisterProcess(pid: number): void {
    this.executor.unregisterProcess(pid);
  }

  /** Clear all externally registered processes. */
  clearSystemProcesses(): void {
    this.executor.clearSystemProcesses();
  }
}
