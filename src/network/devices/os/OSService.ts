/**
 * OSService — OS-agnostic rich service / daemon record.
 *
 * Linux systemd units and Windows services both extend this class. It
 * carries every attribute either OS would expose, even ones unused
 * today (cgroups, conditions, trigger start, recovery actions, watch-
 * dog), so feature growth doesn't break call sites.
 *
 * Behavior on the base is limited to state queries, property overrides,
 * and failure bookkeeping. Adapters add OS-specific quirks (systemctl
 * show output, sc config flags).
 */

export type ServiceState = 'inactive' | 'activating' | 'active' | 'deactivating' | 'failed';
export type EnabledState = 'enabled' | 'disabled' | 'static' | 'masked' | 'alias' | 'indirect';
export type StartType = 'automatic' | 'manual' | 'disabled' | 'delayed-auto' | 'triggered';
export type RestartPolicy = 'no' | 'always' | 'on-success' | 'on-failure' | 'on-abnormal' | 'on-watchdog' | 'on-abort';
export type ServiceType = 'simple' | 'forking' | 'oneshot' | 'notify' | 'idle' | 'dbus';

/** Failure-recovery action: what to do on the Nth failure. */
export interface RecoveryAction {
  /** "restart-service" / "run-command" / "reboot". */
  action: 'restart-service' | 'run-command' | 'reboot' | 'none';
  /** Delay before action (ms). */
  delayMs: number;
  /** Command for "run-command". */
  command?: string;
}

export interface OSServiceInit {
  name: string;
  execStart: string;
  user: string;
  // Optional with sensible defaults:
  displayName?: string;
  description?: string;
  execStop?: string;
  execReload?: string;
  execStartPre?: string[];
  execStartPost?: string[];
  execStopPost?: string[];
  group?: string;
  type?: ServiceType;
  state?: ServiceState;
  enabled?: EnabledState;
  startType?: StartType;
  restart?: RestartPolicy;
  loadedFrom?: string;
  wantedBy?: string[];
  after?: string[];
  before?: string[];
  requires?: string[];
  requisite?: string[];
  bindsTo?: string[];
  partOf?: string[];
  conflicts?: string[];
  dependsOn?: string[];
  configFiles?: string[];
  logFiles?: string[];
  listenPorts?: number[];
  environment?: Record<string, string>;
  environmentFiles?: string[];
  workingDirectory?: string;
  /** Service-aware default property overrides. */
  props?: Record<string, string>;
}

const AUTO_RESTART: ReadonlySet<RestartPolicy> = new Set<RestartPolicy>([
  'always', 'on-failure', 'on-abnormal', 'on-watchdog', 'on-abort',
]);

export class OSService {
  // ─── identity & metadata ───────────────────────────────────────────
  name: string;
  displayName: string;
  description: string;
  type: ServiceType;

  // ─── exec ──────────────────────────────────────────────────────────
  execStart: string;
  execStop?: string;
  execReload?: string;
  execStartPre: string[];
  execStartPost: string[];
  execStopPost: string[];

  // ─── identity & privileges ─────────────────────────────────────────
  user: string;
  group: string;
  supplementaryGroups: string[] = [];
  ambientCapabilities: string[] = [];
  capabilityBoundingSet: string[] = [];
  requiredPrivileges: string[] = [];

  // ─── lifecycle state ───────────────────────────────────────────────
  state: ServiceState;
  enabled: EnabledState;
  startType: StartType;
  restart: RestartPolicy;
  mainPid?: number;
  controlPid?: number;
  activeSince?: Date;
  inactiveSince?: Date;
  /** systemd nRestarts counter — bumped by orchestrator on auto-restart. */
  nRestarts = 0;
  failureCount = 0;
  lastFailureReason?: string;
  lastFailureExitCode?: number;
  lastFailureAt?: Date;

  // ─── dependency graph ──────────────────────────────────────────────
  wantedBy: string[];
  requiredBy: string[] = [];
  after: string[];
  before: string[];
  requires: string[];
  requisite: string[];
  bindsTo: string[];
  partOf: string[];
  conflicts: string[];
  /** Flat dependency list (OS-agnostic shorthand for after+requires). */
  dependsOn: string[];

  // ─── files / sockets / network ─────────────────────────────────────
  loadedFrom: string;
  configFiles: string[];
  logFiles: string[];
  listenPorts: number[];
  workingDirectory: string;

  // ─── env ───────────────────────────────────────────────────────────
  environment: Record<string, string>;
  environmentFiles: string[];

  // ─── conditions / assertions (systemd) ─────────────────────────────
  conditionPathExists: string[] = [];
  conditionFileNotEmpty: string[] = [];
  conditionACPower: boolean | null = null;
  assertPathExists: string[] = [];

  // ─── resource control (cgroup v2 / job objects) ────────────────────
  cpuQuota?: string;
  memoryMax?: string;
  memoryHigh?: string;
  memoryLow?: string;
  tasksMax?: string;
  ioWeight?: number;

  // ─── recovery / watchdog ───────────────────────────────────────────
  watchdogSec?: number;
  watchdogTimestamp?: Date;
  recoveryActions: RecoveryAction[] = [
    { action: 'restart-service', delayMs: 0 },
    { action: 'restart-service', delayMs: 60_000 },
    { action: 'none', delayMs: 0 },
  ];

  // ─── windows-specific (carried here for cross-OS parity) ───────────
  /** Win32OwnProcess | Win32ShareProcess | InteractiveProcess. */
  serviceTypeWin?: string;
  /** Service Control Manager: can be paused/stopped/shutdown. */
  canPauseAndContinue = false;
  canStop = true;
  canShutdown = true;
  /** ProcessId on Windows; mirrors mainPid. */
  processId?: number;
  /** sidType: None | Unrestricted | Restricted. */
  sidType?: string;

  // ─── overrides ─────────────────────────────────────────────────────
  props: Record<string, string>;

  constructor(init: OSServiceInit) {
    this.name = init.name;
    this.displayName = init.displayName ?? init.name;
    this.description = init.description ?? init.name;
    this.type = init.type ?? 'simple';
    this.execStart = init.execStart;
    this.execStop = init.execStop;
    this.execReload = init.execReload;
    this.execStartPre = init.execStartPre ?? [];
    this.execStartPost = init.execStartPost ?? [];
    this.execStopPost = init.execStopPost ?? [];
    this.user = init.user;
    this.group = init.group ?? init.user;
    this.state = init.state ?? 'inactive';
    this.enabled = init.enabled ?? 'enabled';
    this.startType = init.startType ?? 'automatic';
    this.restart = init.restart ?? 'on-failure';
    this.loadedFrom = init.loadedFrom ?? `/lib/systemd/system/${init.name}.service`;
    this.wantedBy = init.wantedBy ?? ['multi-user.target'];
    this.after = init.after ?? [];
    this.before = init.before ?? [];
    this.requires = init.requires ?? [];
    this.requisite = init.requisite ?? [];
    this.bindsTo = init.bindsTo ?? [];
    this.partOf = init.partOf ?? [];
    this.conflicts = init.conflicts ?? [];
    this.dependsOn = init.dependsOn ?? [];
    this.configFiles = init.configFiles ?? [];
    this.logFiles = init.logFiles ?? [];
    this.listenPorts = init.listenPorts ?? [];
    this.environment = init.environment ?? {};
    this.environmentFiles = init.environmentFiles ?? [];
    this.workingDirectory = init.workingDirectory ?? '/';
    this.props = { ...(init.props ?? {}) };
  }

  // ─── queries ───────────────────────────────────────────────────────

  isActive(): boolean { return this.state === 'active'; }
  isFailed(): boolean { return this.state === 'failed'; }
  isInactive(): boolean { return this.state === 'inactive'; }
  isEnabled(): boolean { return this.enabled === 'enabled'; }
  isMasked(): boolean { return this.enabled === 'masked'; }
  wantsAutoRestart(): boolean { return AUTO_RESTART.has(this.restart); }

  /** A masked service cannot be started at all. */
  canStart(): boolean { return !this.isMasked() && this.startType !== 'disabled'; }

  /** systemd `Loaded:` parenthetical, e.g. "enabled; preset: enabled". */
  loadStateLabel(): string {
    return `${this.enabled}; preset: enabled`;
  }

  // ─── properties (systemctl show -p KEY) ────────────────────────────

  /** Resolve `systemctl show -p KEY` (override wins over derived). */
  effectiveProp(key: string): string {
    const override = this.props[key];
    if (override !== undefined) return override;
    switch (key) {
      case 'Id':           return `${this.name}.service`;
      case 'Names':        return `${this.name}.service`;
      case 'Description':  return this.description;
      case 'MainPID':      return String(this.mainPid ?? 0);
      case 'ActiveState':  return this.state;
      case 'SubState':     return this.subState();
      case 'LoadState':    return this.isMasked() ? 'masked' : 'loaded';
      case 'UnitFileState': return this.enabled;
      case 'Type':         return this.type;
      case 'User':         return this.user;
      case 'Group':        return this.group;
      case 'ExecStart':    return this.execStart;
      case 'Restart':      return this.restart;
      case 'FragmentPath': return this.loadedFrom;
      case 'WantedBy':     return this.wantedBy.join(' ');
      case 'After':        return this.after.join(' ');
      case 'CPUQuota':     return this.cpuQuota ?? '';
      case 'MemoryMax':    return this.memoryMax ?? 'infinity';
      case 'TasksMax':     return this.tasksMax ?? '4915';
      case 'NRestarts':    return String(this.nRestarts);
      default:             return '';
    }
  }

  setProperty(key: string, value: string): void {
    this.props[key] = value;
    // Mirror well-known keys to first-class fields for type-safe access.
    switch (key) {
      case 'CPUQuota':  this.cpuQuota = value; break;
      case 'MemoryMax': this.memoryMax = value; break;
      case 'TasksMax':  this.tasksMax = value; break;
    }
  }

  private subState(): string {
    if (this.state === 'active') return this.type === 'oneshot' ? 'exited' : 'running';
    if (this.state === 'failed') return 'failed';
    return 'dead';
  }

  // ─── failure bookkeeping ───────────────────────────────────────────

  recordFailure(reason: string, exitCode?: number): void {
    this.failureCount++;
    this.lastFailureReason = reason;
    this.lastFailureExitCode = exitCode;
    this.lastFailureAt = new Date();
    this.state = 'failed';
  }

  resetFailure(): void {
    this.failureCount = 0;
    this.lastFailureReason = undefined;
    this.lastFailureExitCode = undefined;
    this.lastFailureAt = undefined;
    if (this.state === 'failed') this.state = 'inactive';
  }
}
