/**
 * WindowsProcess — Windows-flavoured {@link OSProcess}.
 *
 * Brings the existing flat `WindowsProcess` record (used everywhere
 * Get-Process / tasklist / Task Manager output is produced) into the
 * cross-OS class hierarchy without changing its on-the-wire shape:
 *
 *   - all original fields (handles, npmK, pmK, wsK, sessionId, owner,
 *     hostedServices, critical, systemOwned, …) remain enumerable
 *   - behaviour (isCritical, hostsService, applyNice, snapshot) lives
 *     on the prototype so JSON / spread / structural comparisons keep
 *     working
 *   - inherits everything OSProcess offers (file descriptors, rlimits,
 *     namespaces, scheduling…) for future feature growth
 */

import { OSProcess } from '../../os/OSProcess';
import type { ProcessSession, WindowsProcess as WindowsProcessRecord } from '../WindowsProcessManager';

export class WindowsProcess extends OSProcess implements WindowsProcessRecord {
  // ─── Windows-flavoured Task Manager surface ─────────────────────────
  name: string;
  session: ProcessSession;
  sessionIdNum: number;            // renamed to avoid clash with OSProcess.sessionId
  owner: string;
  handles: number;
  npmK: number;
  pmK: number;
  wsK: number;
  cpuSec: number;
  status: 'Running' | 'Not Responding';
  windowTitle: string;
  critical: boolean;
  systemOwned: boolean;
  hostedServices: string[];

  // ─── extra attributes a real Windows OS exposes (Phase E surplus) ───
  /** Integrity level: System / High / Medium / Low / AppContainer. */
  integrityLevel: 'System' | 'High' | 'Medium' | 'Low' | 'AppContainer' = 'Medium';
  /** Whether the process is running as a protected process (PPL/PP). */
  protectedProcess: boolean = false;
  /** Loaded DLL / module paths. */
  modules: string[] = [];
  /** Number of OS threads — mirrors numThreads from the base. */
  threadCount: number = 1;
  /** Job object the process belongs to (Win32 Job, akin to cgroup). */
  jobObject?: string;

  constructor(init: WindowsProcessRecord) {
    super({
      pid: init.pid,
      ppid: init.ppid,
      uid: 0,
      gid: 0,
      user: init.owner,
      command: init.name,
      comm: init.name,
      args: [],
      exe: `C:\\Windows\\System32\\${init.name}`,
      state: init.status === 'Running' ? 'R' : 'S',
      numThreads: 1,
      vsize: init.pmK,
      rss: init.wsK,
      tty: 'console',
    });
    this.name = init.name;
    this.session = init.session;
    this.sessionIdNum = init.sessionId;
    this.owner = init.owner;
    this.handles = init.handles;
    this.npmK = init.npmK;
    this.pmK = init.pmK;
    this.wsK = init.wsK;
    this.cpuSec = init.cpuSec;
    this.status = init.status;
    this.windowTitle = init.windowTitle;
    this.critical = init.critical;
    this.systemOwned = init.systemOwned;
    this.hostedServices = [...init.hostedServices];
    this.threadCount = this.numThreads;
    if (init.critical || init.systemOwned) this.integrityLevel = 'System';
  }

  /** ProcessInfo declares `sessionId: number` — alias to the renamed field. */
  get sessionId(): string { return String(this.sessionIdNum); }
  set sessionId(v: string | number) { this.sessionIdNum = Number(v); }

  // ─── queries ───────────────────────────────────────────────────────

  isCritical(): boolean { return this.critical; }
  isSystemOwned(): boolean { return this.systemOwned; }
  hostsService(svcName: string): boolean {
    const needle = svcName.toLowerCase();
    return this.hostedServices.some(s => s.toLowerCase() === needle);
  }
  isResponding(): boolean { return this.status === 'Running'; }

  // ─── mutations ─────────────────────────────────────────────────────

  hostService(svcName: string): void {
    if (!this.hostsService(svcName)) this.hostedServices.push(svcName);
  }
  unhostService(svcName: string): void {
    const needle = svcName.toLowerCase();
    this.hostedServices = this.hostedServices.filter(s => s.toLowerCase() !== needle);
  }

  /**
   * Plain-object snapshot — keeps the original WindowsProcessRecord
   * shape for telemetry consumers / sc.exe rendering / test deep-equals.
   */
  snapshot(): WindowsProcessRecord {
    return {
      pid: this.pid, name: this.name, ppid: this.ppid,
      session: this.session, sessionId: this.sessionIdNum, owner: this.owner,
      handles: this.handles, npmK: this.npmK, pmK: this.pmK, wsK: this.wsK,
      cpuSec: this.cpuSec, status: this.status, windowTitle: this.windowTitle,
      critical: this.critical, systemOwned: this.systemOwned,
      hostedServices: [...this.hostedServices],
    };
  }
}
