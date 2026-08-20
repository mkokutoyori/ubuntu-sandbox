import type { IEventBus, Unsubscribe } from '@/events/EventBus';
import type { VirtualFileSystem } from '../VirtualFileSystem';
import type { LinuxServiceManager } from '../LinuxServiceManager';
import type { ServiceLifecyclePayload, ProcessSignalledPayload } from '../events';
import type { LinuxAuditLog } from './LinuxAuditLog';
import type { LinuxAuditRules } from './LinuxAuditRules';

export type AuditdState = 'running' | 'stopped' | 'suspended';

export interface AuditdConfig {
  logFile: string;
  logFormat: string;
  flush: string;
  spaceLeft: number;
  spaceLeftAction: string;
  adminSpaceLeft: number;
  adminSpaceLeftAction: string;
  diskFullAction: string;
  maxLogFile: number;
  numLogs: number;
}

const SUSPENDING_ACTIONS = new Set(['SUSPEND', 'SINGLE', 'HALT']);

const DEFAULT_CONFIG: AuditdConfig = {
  logFile: '/var/log/audit/audit.log',
  logFormat: 'RAW',
  flush: 'INCREMENTAL_ASYNC',
  spaceLeft: 75,
  spaceLeftAction: 'SYSLOG',
  adminSpaceLeft: 50,
  adminSpaceLeftAction: 'SUSPEND',
  diskFullAction: 'SUSPEND',
  maxLogFile: 8,
  numLogs: 5,
};

export interface AuditdDeps {
  auditLog: LinuxAuditLog;
  rules: LinuxAuditRules;
  vfs: VirtualFileSystem;
  serviceMgr: LinuxServiceManager;
  freeSpaceMb: () => number;
  kernelRelease: () => string;
}

export class LinuxAuditDaemon {
  private state: AuditdState = 'stopped';
  private config: AuditdConfig = { ...DEFAULT_CONFIG };
  private readonly subs: Unsubscribe[] = [];

  constructor(
    private readonly bus: IEventBus,
    private readonly deviceId: string,
    private readonly deps: AuditdDeps,
  ) {
    this.subs.push(
      bus.subscribe('linux.service.started', (e) => this.onLifecycle(e.payload, 'start')),
      bus.subscribe('linux.service.stopped', (e) => this.onLifecycle(e.payload, 'stop')),
      bus.subscribe('linux.process.signalled', (e) => this.onSignal(e.payload)),
    );
    if (deps.serviceMgr.isActive('auditd')) this.runStart();
  }

  dispose(): void {
    for (const off of this.subs) off();
    this.subs.length = 0;
  }

  get running(): boolean {
    return this.state !== 'stopped';
  }

  get suspended(): boolean {
    return this.state === 'suspended';
  }

  get currentState(): AuditdState {
    return this.state;
  }

  get spaceLeftAction(): string {
    return this.config.spaceLeftAction;
  }

  private onLifecycle(p: ServiceLifecyclePayload, kind: 'start' | 'stop'): void {
    if (p.deviceId !== this.deviceId || p.name !== 'auditd') return;
    if (kind === 'start') this.runStart();
    else this.runStop();
  }

  private onSignal(p: ProcessSignalledPayload): void {
    if (p.deviceId !== this.deviceId || !p.delivered) return;
    const mainPid = this.deps.serviceMgr.status('auditd')?.mainPid;
    if (p.comm !== 'auditd' && p.pid !== mainPid) return;
    if (p.signal === 'SIGHUP') this.runReload();
    else if (p.signal === 'SIGTERM' || p.signal === 'SIGKILL') this.runStop();
    else if (p.signal === 'SIGUSR1') this.deps.auditLog.record('DAEMON_ROTATE', { op: 'rotate', uid: 0, res: 'success' });
  }

  private runStart(): void {
    this.loadConfig();
    this.loadRules();
    this.evaluateDiskSpace();
    this.deps.auditLog.record('DAEMON_START', {
      op: 'start',
      ver: '3.0',
      format: this.config.logFormat.toLowerCase(),
      kernel: this.deps.kernelRelease(),
      auid: 0,
      pid: this.deps.serviceMgr.status('auditd')?.mainPid ?? 1,
      uid: 0,
      res: 'success',
    });
  }

  private runStop(): void {
    if (this.state === 'stopped') return;
    this.state = 'stopped';
    this.deps.auditLog.record('DAEMON_END', {
      op: 'terminate',
      auid: 0,
      pid: this.deps.serviceMgr.status('auditd')?.mainPid ?? 1,
      uid: 0,
      res: 'success',
    });
  }

  private runReload(): void {
    this.loadConfig();
    this.loadRules();
    this.evaluateDiskSpace();
    this.deps.auditLog.record('DAEMON_CONFIG', {
      op: 'reconfigure',
      auid: 0,
      pid: this.deps.serviceMgr.status('auditd')?.mainPid ?? 1,
      uid: 0,
      res: 'success',
    });
  }

  private evaluateDiskSpace(): void {
    const free = this.deps.freeSpaceMb();
    if (free < this.config.adminSpaceLeft && SUSPENDING_ACTIONS.has(this.config.adminSpaceLeftAction)) {
      this.state = 'suspended';
      return;
    }
    if (free < this.config.spaceLeft && SUSPENDING_ACTIONS.has(this.config.spaceLeftAction)) {
      this.state = 'suspended';
      return;
    }
    this.state = 'running';
  }

  private loadRules(): void {
    this.deps.rules.loadFromDisk();
    const rulesD = '/etc/audit/rules.d';
    const entries = this.deps.vfs.listDirectory(rulesD) ?? [];
    for (const entry of entries) {
      if (entry.inode.type !== 'file' || !entry.name.endsWith('.rules')) continue;
      const content = this.deps.vfs.readFile(`${rulesD}/${entry.name}`);
      if (content !== null) this.deps.rules.loadRulesText(content);
    }
  }

  private loadConfig(): void {
    const content = this.deps.vfs.readFile('/etc/audit/auditd.conf');
    if (content === null) return;
    const cfg: AuditdConfig = { ...DEFAULT_CONFIG };
    for (const raw of content.split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq === -1) continue;
      const key = line.slice(0, eq).trim();
      const value = line.slice(eq + 1).trim();
      switch (key) {
        case 'log_file': cfg.logFile = value; break;
        case 'log_format': cfg.logFormat = value; break;
        case 'flush': cfg.flush = value; break;
        case 'space_left': cfg.spaceLeft = parseInt(value, 10) || 0; break;
        case 'space_left_action': cfg.spaceLeftAction = value.toUpperCase(); break;
        case 'admin_space_left': cfg.adminSpaceLeft = parseInt(value, 10) || 0; break;
        case 'admin_space_left_action': cfg.adminSpaceLeftAction = value.toUpperCase(); break;
        case 'disk_full_action': cfg.diskFullAction = value.toUpperCase(); break;
        case 'max_log_file': cfg.maxLogFile = parseInt(value, 10) || 0; break;
        case 'num_logs': cfg.numLogs = parseInt(value, 10) || 0; break;
      }
    }
    this.config = cfg;
  }
}
