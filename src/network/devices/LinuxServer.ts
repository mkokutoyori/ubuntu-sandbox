/**
 * LinuxServer - Linux server (root profile + Oracle process API).
 *
 * Phase 3: all logic now lives in `LinuxMachine`. `LinuxServer` is a
 * thin shell that provides the server profile to the parent constructor
 * and exposes the two Oracle-specific pass-throughs (`registerProcess`,
 * `clearSystemProcesses`).
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

  /** Clear all externally registered processes. */
  clearSystemProcesses(): void {
    this.executor.clearSystemProcesses();
  }
}
