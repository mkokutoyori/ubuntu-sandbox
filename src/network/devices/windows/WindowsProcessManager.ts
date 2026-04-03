/**
 * Windows Process Manager — simulates the Windows process table.
 *
 * Models realistic process behavior:
 *   - Dynamic process table with PIDs, memory, CPU, parent-child relationships
 *   - Process ownership (SYSTEM, NetworkService, LocalService, current user)
 *   - Session tracking (0=Services, 1=Console)
 *   - Critical process protection (csrss, lsass, smss, etc.)
 *   - Service-to-process linking (svchost.exe hosts multiple services)
 *   - Process creation/termination with child cascade (/T tree kill)
 */

import type { WindowsServiceManager } from './WindowsServiceManager';

export type ProcessSession = 'Services' | 'Console';

export interface WindowsProcess {
  pid: number;
  name: string;
  ppid: number;
  session: ProcessSession;
  sessionId: number;
  owner: string;
  /** Handles count */
  handles: number;
  /** Non-paged memory (KB) */
  npmK: number;
  /** Paged memory (KB) */
  pmK: number;
  /** Working set (KB) */
  wsK: number;
  /** CPU time (seconds) */
  cpuSec: number;
  /** Status: Running, Not Responding */
  status: 'Running' | 'Not Responding';
  /** Window title (for /V verbose) */
  windowTitle: string;
  /** If true, cannot be killed even with /F */
  critical: boolean;
  /** If true, only admin can kill */
  systemOwned: boolean;
  /** Service names hosted by this process (for svchost instances) */
  hostedServices: string[];
}

const CRITICAL_PROCESSES = new Set([
  'system', 'smss.exe', 'csrss.exe', 'wininit.exe',
  'winlogon.exe', 'services.exe', 'lsass.exe',
]);

export class WindowsProcessManager {
  private processes: Map<number, WindowsProcess> = new Map();
  private nextPid = 100;

  constructor() {
    this.initDefaults();
  }

  private initDefaults(): void {
    // Kernel / boot chain
    this.addSystem(0, 'System Idle Process', 0, 0, 8, 0, 0, 0);
    this.addSystem(4, 'System', 0, 0, 144, 100, 0.5, 0);
    this.addSystem(108, 'Registry', 4, 0, 4096, 48, 0, 0);
    this.addSystem(340, 'smss.exe', 4, 0, 1024, 56, 0, 0);

    // Session 0 system processes
    this.addSystem(472, 'csrss.exe', 340, 0, 4608, 590, 2.1, 0);
    this.addSystem(548, 'wininit.exe', 340, 0, 3584, 152, 0, 0);
    this.addSystem(560, 'csrss.exe', 548, 1, 5120, 468, 1.2, 1); // Session 1 csrss
    this.addSystem(596, 'winlogon.exe', 548, 1, 6656, 256, 0.1, 1);
    this.addSystem(620, 'services.exe', 548, 0, 7168, 680, 1.5, 0);
    this.addSystem(636, 'lsass.exe', 548, 0, 10240, 820, 3.2, 0);

    // svchost.exe instances — each hosts a group of services
    this.addSvchost(784, [0, 'NT AUTHORITY\\SYSTEM'], ['RpcSs', 'RpcEptMapper']);
    this.addSvchost(836, [0, 'NT AUTHORITY\\NetworkService'], ['Dnscache', 'NetBT']);
    this.addSvchost(912, [0, 'NT AUTHORITY\\LocalService'], ['EventLog', 'W32Time']);
    this.addSvchost(964, [0, 'NT AUTHORITY\\SYSTEM'], ['Schedule', 'Themes', 'Winmgmt']);
    this.addSvchost(1048, [0, 'NT AUTHORITY\\LocalService'], ['Dhcp', 'AudioSrv']);
    this.addSvchost(1100, [0, 'NT AUTHORITY\\SYSTEM'], ['SamSs', 'CryptSvc']);
    this.addSvchost(1168, [0, 'NT AUTHORITY\\LocalService'], ['mpssvc']);

    // Desktop Window Manager
    this.addProcess(1024, 'dwm.exe', 560, 'Console', 1,
      'Window Manager\\DWM-1', 980, 18, 45056, 132000, 8.4, 'Running', 'DWM', true, true);

    // User-mode system processes
    this.addProcess(1400, 'taskhostw.exe', 964, 'Console', 1,
      'NT AUTHORITY\\SYSTEM', 210, 8, 5120, 12800, 0.2, 'Running', 'Task Host Window', false, true);
    this.addProcess(1560, 'RuntimeBroker.exe', 784, 'Console', 1,
      'NT AUTHORITY\\SYSTEM', 340, 14, 12288, 28000, 0.8, 'Running', '', false, true);

    // User processes
    this.addProcess(2848, 'explorer.exe', 596, 'Console', 1,
      '{USER}', 2100, 65, 65536, 145000, 12.3, 'Running', 'Windows Explorer', false, false);
    this.addProcess(5120, 'cmd.exe', 2848, 'Console', 1,
      '{USER}', 48, 3, 3072, 5200, 0.1, 'Running', 'Command Prompt', false, false);
    this.addProcess(5132, 'conhost.exe', 5120, 'Console', 1,
      '{USER}', 180, 10, 10240, 18400, 0.3, 'Running', 'Console Window Host', false, false);

    // Service-specific processes (non-svchost)
    this.addProcess(1800, 'spoolsv.exe', 620, 'Services', 0,
      'NT AUTHORITY\\SYSTEM', 420, 12, 8192, 18000, 0.5, 'Running', '', false, true,
      ['Spooler']);
    this.addProcess(2200, 'LanmanServer.exe', 620, 'Services', 0,
      'NT AUTHORITY\\SYSTEM', 320, 10, 6144, 14000, 0.3, 'Running', '', false, true,
      ['LanmanServer']);
    this.addProcess(2400, 'LanmanWorkstation.exe', 620, 'Services', 0,
      'NT AUTHORITY\\NetworkService', 280, 8, 4096, 10000, 0.2, 'Running', '', false, true,
      ['LanmanWorkstation']);
  }

  private addSystem(
    pid: number, name: string, ppid: number, sessionId: number,
    wsK: number, handles: number, cpuSec: number, si: number
  ): void {
    this.addProcess(pid, name, ppid, sessionId === 0 ? 'Services' : 'Console', sessionId,
      'NT AUTHORITY\\SYSTEM', handles, 4, wsK, wsK * 2, cpuSec, 'Running', '', true, true);
    if (pid >= this.nextPid) this.nextPid = pid + 4;
  }

  private addSvchost(pid: number, [sessionId, owner]: [number, string], services: string[]): void {
    const wsK = 8192 + services.length * 2048;
    this.addProcess(pid, 'svchost.exe', 620, sessionId === 0 ? 'Services' : 'Console', sessionId,
      owner, 300 + services.length * 50, 8 + services.length * 2, wsK, wsK * 1.5,
      services.length * 0.3, 'Running', '', false, true, services);
    if (pid >= this.nextPid) this.nextPid = pid + 4;
  }

  private addProcess(
    pid: number, name: string, ppid: number,
    session: ProcessSession, sessionId: number,
    owner: string, handles: number, npmK: number,
    pmK: number, wsK: number, cpuSec: number,
    status: 'Running' | 'Not Responding', windowTitle: string,
    critical: boolean, systemOwned: boolean,
    hostedServices: string[] = []
  ): void {
    this.processes.set(pid, {
      pid, name, ppid, session, sessionId, owner,
      handles, npmK, pmK, wsK, cpuSec, status, windowTitle,
      critical, systemOwned, hostedServices,
    });
    if (pid >= this.nextPid) this.nextPid = pid + 4;
  }

  // ─── Queries ─────────────────────────────────────────────────────

  getProcess(pid: number): WindowsProcess | undefined {
    return this.processes.get(pid);
  }

  getProcessesByName(name: string): WindowsProcess[] {
    const lower = name.toLowerCase().replace(/\.exe$/, '');
    return [...this.processes.values()].filter(p =>
      p.name.toLowerCase().replace(/\.exe$/, '') === lower
    );
  }

  getAllProcesses(): WindowsProcess[] {
    return [...this.processes.values()].sort((a, b) => a.pid - b.pid);
  }

  getChildren(pid: number): WindowsProcess[] {
    return [...this.processes.values()].filter(p => p.ppid === pid);
  }

  /** Recursively collect all descendants */
  getDescendants(pid: number): WindowsProcess[] {
    const result: WindowsProcess[] = [];
    const children = this.getChildren(pid);
    for (const child of children) {
      result.push(child);
      result.push(...this.getDescendants(child.pid));
    }
    return result;
  }

  // ─── Process Lifecycle ──────────────────────────────────────────

  allocatePid(): number {
    const pid = this.nextPid;
    this.nextPid += 4; // Windows PIDs are multiples of 4
    return pid;
  }

  /** Spawn a new process (used by service start, etc.) */
  spawnProcess(name: string, ppid: number, owner: string, opts: {
    session?: ProcessSession; sessionId?: number; hostedServices?: string[];
    systemOwned?: boolean;
  } = {}): WindowsProcess {
    const pid = this.allocatePid();
    const proc: WindowsProcess = {
      pid, name, ppid,
      session: opts.session ?? 'Services',
      sessionId: opts.sessionId ?? 0,
      owner,
      handles: 50 + Math.floor(Math.random() * 200),
      npmK: 4 + Math.floor(Math.random() * 10),
      pmK: 2048 + Math.floor(Math.random() * 8192),
      wsK: 4096 + Math.floor(Math.random() * 16384),
      cpuSec: 0,
      status: 'Running',
      windowTitle: '',
      critical: false,
      systemOwned: opts.systemOwned ?? false,
      hostedServices: opts.hostedServices ?? [],
    };
    this.processes.set(pid, proc);
    return proc;
  }

  /**
   * Kill a process.
   * Returns error string or '' on success.
   */
  killProcess(pid: number, force: boolean, isAdmin: boolean): string {
    const proc = this.processes.get(pid);
    if (!proc) return `ERROR: The process with PID ${pid} was not found.`;
    if (proc.systemOwned && !isAdmin) return `ERROR: Access is denied.`;
    if (proc.critical) return `ERROR: The process "${proc.name}" with PID ${pid} is critical and cannot be terminated.`;

    this.processes.delete(pid);
    return '';
  }

  /**
   * Kill by image name.
   * Returns error string or success message.
   */
  killByName(name: string, force: boolean, isAdmin: boolean, treeKill: boolean): string {
    const procs = this.getProcessesByName(name);
    if (procs.length === 0) return `ERROR: The process "${name}" was not found.`;

    const results: string[] = [];
    for (const proc of procs) {
      if (treeKill) {
        // Kill descendants first
        const descendants = this.getDescendants(proc.pid);
        for (const child of descendants.reverse()) {
          const err = this.killProcess(child.pid, force, isAdmin);
          if (!err) results.push(`SUCCESS: The process "${child.name}" with PID ${child.pid} has been terminated.`);
        }
      }
      const err = this.killProcess(proc.pid, force, isAdmin);
      if (err) {
        results.push(err);
      } else {
        results.push(`SUCCESS: The process "${proc.name}" with PID ${proc.pid} has been terminated.`);
      }
    }
    return results.join('\n');
  }

  /**
   * Remove processes tied to a service when the service stops.
   */
  onServiceStopped(serviceName: string): void {
    for (const proc of [...this.processes.values()]) {
      if (proc.hostedServices.length === 0) continue;
      const idx = proc.hostedServices.findIndex(s => s.toLowerCase() === serviceName.toLowerCase());
      if (idx === -1) continue;

      // If this process hosts only this service, kill it
      if (proc.hostedServices.length === 1) {
        // Only remove non-svchost processes; svchost stays alive even if one service stops
        if (proc.name !== 'svchost.exe') {
          this.processes.delete(proc.pid);
        } else {
          proc.hostedServices.splice(idx, 1);
        }
      } else {
        proc.hostedServices.splice(idx, 1);
      }
    }
  }

  /**
   * Spawn a process when a service starts (for dedicated-process services).
   */
  onServiceStarted(serviceName: string, processName: string): void {
    // Check if a process already hosts this service
    for (const proc of this.processes.values()) {
      if (proc.hostedServices.some(s => s.toLowerCase() === serviceName.toLowerCase())) return;
    }
    // If it's a svchost service, add to an existing svchost or don't spawn
    if (processName === 'svchost.exe') return;

    this.spawnProcess(processName, 620, 'NT AUTHORITY\\SYSTEM', {
      hostedServices: [serviceName], systemOwned: true,
    });
  }

  /**
   * Resolve {USER} placeholder in owner field.
   */
  resolveOwner(proc: WindowsProcess, currentUser: string): string {
    return proc.owner === '{USER}' ? `${currentUser}` : proc.owner;
  }
}
