/**
 * LinuxServiceManager — systemd-style service supervisor for the sandbox.
 *
 * Loads unit files from /lib/systemd/system and /etc/systemd/system in the
 * VFS, tracks service state, spawns/kills processes via LinuxProcessManager,
 * and persists enable/disable state through symlinks under
 * /etc/systemd/system/multi-user.target.wants/.
 *
 * The implementation is intentionally faithful to systemd semantics where
 * it matters for the simulator (ordering of override paths, drop-in dirs,
 * Wants vs Active state) so users can drop new .service files in /etc and
 * have them recognized after `systemctl daemon-reload`.
 */

import type { VirtualFileSystem } from './VirtualFileSystem';
import type { LinuxProcessManager } from './LinuxProcessManager';
import type { IEventBus } from '@/events/EventBus';
import { LinuxService } from './service/LinuxService';
import { DependencyGraph, fullUnitName, unitSuffix, type UnitNode } from './systemd/DependencyGraph';
import { SystemdJobEngine } from './systemd/SystemdJobEngine';
import { TimerScheduler, type TimerEntry } from './systemd/TimerScheduler';
import { parseTimeSpan } from './systemd/TimeSpan';
import type { DynamicUserTable } from './nss/DynamicUserTable';
import type { PortSpec } from '../../core/ports/PortNumber';

/** systemd-equivalent activation state for a unit. */
export type ServiceState =
  | 'active'
  | 'inactive'
  | 'failed'
  | 'activating'
  | 'deactivating';

/** Whether the unit is enabled at boot via Wants symlinks. */
export type EnabledState = 'enabled' | 'disabled' | 'static' | 'masked';

/** systemd Type= directive: how the supervisor tracks the main process. */
export type ServiceType = 'simple' | 'forking' | 'oneshot' | 'notify' | 'idle' | 'dbus';

/** Restart= directive: when to restart the service automatically. */
export type RestartPolicy = 'no' | 'on-failure' | 'on-success' | 'always' | 'on-abnormal';

/** A loaded systemd unit file with parsed directives and runtime state. */
export interface ServiceUnit {
  name: string;
  description: string;
  type: ServiceType;
  execStart: string;
  execStop?: string;
  execReload?: string;
  user: string;
  group: string;
  dynamicUser?: boolean;
  wantedBy: string[];
  wants: string[];
  after: string[];
  before: string[];
  requires: string[];
  bindsTo: string[];
  partOf: string[];
  conflicts: string[];
  allowIsolate?: boolean;
  restart: RestartPolicy;
  restartSec?: number;
  startLimitBurst?: number;
  startLimitIntervalSec?: number;
  listenStream?: number;
  onActiveSec?: number;
  onBootSec?: number;
  onUnitActiveSec?: number;
  onCalendar?: string;
  activates?: string;
  /** Source file the unit was loaded from. */
  loadedFrom: string;
  // ── Runtime state (mutated by start/stop/etc.) ────────────────
  state: ServiceState;
  enabled: EnabledState;
  mainPid?: number;
  activeSince?: Date;
  lastExit?: { code?: number; signal?: string };
  failedReason?: string;
  startLimitHit?: boolean;
  autoRestartPending?: boolean;
  restartEpochs?: number[];
  /** Runtime resource-control overrides set via `systemctl set-property`. */
  props?: Record<string, string>;
  readinessDelayMs?: number;
  portOverride?: { port: number; source: 'cli' | 'env' | 'config-reload'; cliArg?: string };
}

export interface ServiceManagerOptions {
  isServer: boolean;
}

export interface OperationResult {
  ok: boolean;
  error?: string;
}

export interface ListFilter {
  state?: ServiceState;
  enabled?: EnabledState;
}

/** Directory where the system stores vendor-shipped unit files.
 *  Canonical path; /lib/systemd/system is a symlink that some VFS layers
 *  do not resolve transparently, so we always read/write through /usr/lib. */
const SYSTEM_UNIT_DIR = '/usr/lib/systemd/system';
/** Directory where local administrator overrides live (highest precedence). */
const ETC_UNIT_DIR = '/etc/systemd/system';
/** multi-user.target.wants — Wants symlinks for the default boot target. */
const WANTS_DIR = '/etc/systemd/system/multi-user.target.wants';

interface DefaultTarget {
  name: string;
  description: string;
  unitLines?: string[];
}

const DEFAULT_TARGETS: readonly DefaultTarget[] = [
  { name: 'graphical.target', description: 'Graphical Interface', unitLines: ['Requires=multi-user.target', 'After=multi-user.target', 'AllowIsolate=yes'] },
  { name: 'multi-user.target', description: 'Multi-User System', unitLines: ['Requires=basic.target', 'After=basic.target', 'AllowIsolate=yes'] },
  { name: 'basic.target', description: 'Basic System', unitLines: ['Requires=sysinit.target', 'After=sysinit.target'] },
  { name: 'sysinit.target', description: 'System Initialization', unitLines: ['Requires=local-fs.target', 'After=local-fs.target'] },
  { name: 'local-fs.target', description: 'Local File Systems' },
  { name: 'remote-fs.target', description: 'Remote File Systems' },
  { name: 'network-pre.target', description: 'Preparation for Network' },
  { name: 'network.target', description: 'Network', unitLines: ['After=network-pre.target'] },
];

// ─── Default unit definitions ─────────────────────────────────────────

/** A default unit to be installed at first boot. */
interface DefaultUnit {
  name: string;
  description: string;
  type: ServiceType;
  execStart: string;
  execReload?: string;
  user?: string;
  after?: string[];
  enabledByDefault: boolean;
  /** Whether the service should be active right after boot. */
  startByDefault: boolean;
}

/** Vendor unit set installed in /lib/systemd/system on every machine. */
const BASE_UNITS: DefaultUnit[] = [
  {
    name: 'ssh',
    description: 'OpenBSD Secure Shell server',
    type: 'notify',
    execStart: '/usr/sbin/sshd -D',
    execReload: '/bin/kill -HUP $MAINPID',
    after: ['network.target', 'auditd.service'],
    enabledByDefault: true,
    startByDefault: true,
  },
  {
    name: 'cron',
    description: 'Regular background program processing daemon',
    type: 'forking',
    execStart: '/usr/sbin/cron -f',
    after: ['network.target'],
    enabledByDefault: true,
    startByDefault: true,
  },
  {
    name: 'rsyslog',
    description: 'System Logging Service',
    type: 'notify',
    execStart: '/usr/sbin/rsyslogd -n -iNONE',
    after: ['network.target'],
    enabledByDefault: true,
    startByDefault: true,
  },
  {
    name: 'auditd',
    description: 'Security Auditing Service',
    type: 'forking',
    execStart: '/sbin/auditd',
    execReload: '/sbin/auditctl -R /etc/audit/audit.rules',
    after: ['local-fs.target'],
    enabledByDefault: true,
    startByDefault: true,
  },
  {
    name: 'atd',
    description: 'Deferred execution scheduler',
    type: 'forking',
    execStart: '/usr/sbin/atd -f',
    after: ['network.target'],
    enabledByDefault: true,
    startByDefault: true,
  },
  {
    name: 'systemd-resolved',
    description: 'Network Name Resolution',
    type: 'notify',
    execStart: '/lib/systemd/systemd-resolved',
    user: 'systemd-resolve',
    enabledByDefault: true,
    startByDefault: true,
  },
  {
    name: 'systemd-journald',
    description: 'Journal Service',
    type: 'notify',
    execStart: '/lib/systemd/systemd-journald',
    enabledByDefault: true,
    startByDefault: true,
  },
  {
    name: 'systemd-logind',
    description: 'User Login Management',
    type: 'dbus',
    execStart: '/lib/systemd/systemd-logind',
    enabledByDefault: true,
    startByDefault: true,
  },
  {
    name: 'dbus',
    description: 'D-Bus System Message Bus',
    type: 'dbus',
    execStart: '/usr/bin/dbus-daemon --system --address=systemd: --nofork --nopidfile --systemd-activation --syslog-only',
    user: 'messagebus',
    enabledByDefault: true,
    startByDefault: true,
  },
  {
    name: 'named',
    description: 'BIND Domain Name Server',
    type: 'forking',
    execStart: '/usr/sbin/named -u bind',
    execReload: '/usr/sbin/rndc reload',
    user: 'bind',
    after: ['network.target'],
    enabledByDefault: false,
    startByDefault: false,
  },
  {
    name: 'networking',
    description: 'Raise network interfaces',
    type: 'oneshot',
    execStart: '/sbin/ifup -a --read-environment',
    after: ['network-pre.target'],
    enabledByDefault: true,
    startByDefault: true,
  },
  {
    name: 'ufw',
    description: 'Uncomplicated firewall',
    type: 'oneshot',
    execStart: '/lib/ufw/ufw-init start quiet',
    after: ['local-fs.target'],
    enabledByDefault: true,
    startByDefault: true,
  },
  {
    name: 'apparmor',
    description: 'Load AppArmor profiles',
    type: 'oneshot',
    execStart: '/lib/apparmor/apparmor.systemd reload',
    enabledByDefault: true,
    startByDefault: true,
  },
];

/** Extra units only installed on machines flagged as servers. */
const SERVER_UNITS: DefaultUnit[] = [
  {
    name: 'apache2',
    description: 'The Apache HTTP Server',
    type: 'forking',
    execStart: '/usr/sbin/apachectl start',
    execReload: '/usr/sbin/apachectl graceful',
    user: 'www-data',
    after: ['network.target', 'remote-fs.target'],
    enabledByDefault: false,
    startByDefault: false,
  },
  {
    name: 'nginx',
    description: 'A high performance web server and a reverse proxy server',
    type: 'forking',
    execStart: '/usr/sbin/nginx -g "daemon on; master_process on;"',
    execReload: '/usr/sbin/nginx -s reload',
    user: 'www-data',
    after: ['network.target', 'remote-fs.target'],
    enabledByDefault: false,
    startByDefault: false,
  },
  {
    name: 'mysql',
    description: 'MySQL Community Server',
    type: 'notify',
    execStart: '/usr/sbin/mysqld',
    user: 'mysql',
    after: ['network.target'],
    enabledByDefault: false,
    startByDefault: false,
  },
  {
    name: 'postgresql',
    description: 'PostgreSQL RDBMS',
    type: 'oneshot',
    execStart: '/bin/true',
    user: 'postgres',
    after: ['network.target'],
    enabledByDefault: false,
    startByDefault: false,
  },
  {
    name: 'oracle-ohasd',
    description: 'Oracle High Availability Services',
    type: 'simple',
    execStart: '/etc/init.d/init.ohasd run',
    user: 'oracle',
    enabledByDefault: true,
    startByDefault: true,
  },
];

/**
 * The listening sockets a daemon opens once active — the well-known
 * daemon→port mapping a real host carries. `processName` is the argv[0]
 * basename `netstat -p` / `ss -p` shows (it differs from the unit name for
 * several daemons, e.g. the `mysql` unit runs `mysqld`).
 */
export interface ServiceListenerSpec {
  processName: string;
  sockets: PortSpec[];
  /**
   * Long-running process the unit leaves behind, when it differs from
   * ExecStart — e.g. `lsnrctl start` is a launcher that exits while the
   * daemon it forks is `tnslsnr LISTENER -inherit`. `ps` shows the
   * daemon, not the launcher.
   */
  daemonCommand?: string;
}

/**
 * Default daemon→listener mapping. The reactive {@link ServicePortProjection}
 * consults this so a `systemctl start <unit>` genuinely opens the port and
 * `systemctl stop` closes it — port/service/process coherence.
 */
export const SERVICE_LISTENERS: Readonly<Record<string, ServiceListenerSpec>> = {
  ssh: { processName: 'sshd', sockets: [{ port: 22, protocol: 'tcp' }] },
  'systemd-resolved': {
    processName: 'systemd-resolved',
    sockets: [
      { port: 53, protocol: 'udp', address: '127.0.0.53' },
      { port: 53, protocol: 'tcp', address: '127.0.0.53' },
    ],
  },
  apache2: {
    processName: 'apache2',
    sockets: [{ port: 80, protocol: 'tcp' }, { port: 443, protocol: 'tcp' }],
  },
  nginx: {
    processName: 'nginx',
    sockets: [{ port: 80, protocol: 'tcp' }, { port: 443, protocol: 'tcp' }],
  },
  mysql: { processName: 'mysqld', sockets: [{ port: 3306, protocol: 'tcp' }] },
  postgresql: { processName: 'postgres', sockets: [{ port: 5432, protocol: 'tcp' }] },
  'oracle-ohasd': { processName: 'tnslsnr', sockets: [{ port: 1521, protocol: 'tcp' }] },
};

/** A service plus the runtime data the port projection needs to bind it. */
export interface ServicePortBinding {
  name: string;
  mainPid?: number;
  processName: string;
  sockets: PortSpec[];
}

export type ServiceLifecycleEvent = 'start' | 'stop' | 'restart' | 'reload';
export type ServiceLifecycleListener = (
  event: ServiceLifecycleEvent,
  serviceName: string,
) => void;

export class LinuxServiceManager {
  /** Loaded units indexed by short name (without .service suffix). */
  private units = new Map<string, LinuxService>();
  /** Lifecycle listeners (BRD SSH-07-R6: sshd reloads its config on restart). */
  private listeners: ServiceLifecycleListener[] = [];
  /**
   * Per-service configuration pre-checks, run before a `reload` is applied —
   * the simulator's analogue of systemd's `ExecReload=/usr/sbin/sshd -t`.
   * A failing check aborts the reload and surfaces the error to the caller.
   */
  private configChecks = new Map<string, () => OperationResult>();
  /**
   * Listener specs registered at runtime for units that are not part of
   * the static {@link SERVICE_LISTENERS} table — units with dynamic
   * names, e.g. `oracle-listener-<SID>` installed by OracleSystemdSync.
   * Consulted with priority over the static table.
   */
  private dynamicListeners = new Map<string, ServiceListenerSpec>();
  /** Reactive sink — null until a device attaches its bus. */
  private bus: IEventBus | null = null;
  private deviceId = '';

  constructor(
    private readonly vfs: VirtualFileSystem,
    private readonly processMgr: LinuxProcessManager,
    private readonly opts: ServiceManagerOptions,
    private readonly dynamicUsers?: DynamicUserTable,
  ) {
    this.bootstrapDefaultUnits();
    this.daemonReload();
    this.startEnabledServices();
  }

  /**
   * Attach the owning device's bus so service transitions become
   * observable by supervisors / UI / telemetry (Dependency Inversion).
   */
  attachBus(bus: IEventBus, deviceId: string): void {
    this.bus = bus;
    this.deviceId = deviceId;
  }

  /**
   * Register a configuration pre-check for a service. Invoked before every
   * `reload` so an invalid on-disk config is rejected exactly as `sshd -t`
   * would reject it, instead of being silently applied.
   */
  registerConfigCheck(name: string, check: () => OperationResult): void {
    this.configChecks.set(name.replace(/\.service$/, ''), check);
  }

  /** Subscribe to service lifecycle changes. Returns an unsubscribe handle. */
  onLifecycle(listener: ServiceLifecycleListener): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  private static readonly LIFECYCLE_TOPIC = {
    start: 'linux.service.started',
    stop: 'linux.service.stopped',
    restart: 'linux.service.restarted',
    reload: 'linux.service.reloaded',
  } as const;

  private emitLifecycle(event: ServiceLifecycleEvent, name: string): void {
    for (const l of this.listeners) l(event, name);
    const u = this.units.get(name);
    this.bus?.publish({
      topic: LinuxServiceManager.LIFECYCLE_TOPIC[event],
      payload: {
        deviceId: this.deviceId,
        name,
        state: u?.state ?? 'inactive',
        mainPid: u?.mainPid,
        type: u?.type ?? 'simple',
      },
    });
  }

  private emitEnablement(
    topic: 'linux.service.enabled' | 'linux.service.disabled'
      | 'linux.service.masked' | 'linux.service.unmasked',
    name: string,
    enabled: EnabledState,
  ): void {
    this.bus?.publish({ topic, payload: { deviceId: this.deviceId, name, enabled } });
  }

  private emitStateChanged(name: string, from: ServiceState, to: ServiceState): void {
    if (from === to) return;
    this.bus?.publish({
      topic: 'linux.service.state-changed',
      payload: { deviceId: this.deviceId, name, from, to },
    });
  }

  // ─── Public API ───────────────────────────────────────────────────

  /**
   * Start a service and its dependencies. Resolves the Requires/Wants/
   * BindsTo activation closure, orders it by After/Before, and activates
   * each unit in turn (systemd's job transaction). A unit with no
   * dependencies yields a single-job transaction — same result as before.
   */
  start(name: string): OperationResult {
    const unit = this.requireUnit(name);
    if (!unit.ok) return unit;
    return this.jobEngine().start(unit.unit.name);
  }

  private jobEngine(): SystemdJobEngine {
    return new SystemdJobEngine({
      graph: () => this.dependencyGraph(),
      isActive: (n) => this.isActive(n),
      exists: (n) => this.units.has(n),
      activate: (n) => this.startOne(n),
      deactivate: (n) => this.stopOne(n),
    });
  }

  dependencyGraph(): DependencyGraph {
    return new DependencyGraph(this.list().map((u) => this.graphNode(u)));
  }

  private graphNode(u: LinuxService): UnitNode {
    if (!u.name.endsWith('.target')) return u;
    const dir = `${ETC_UNIT_DIR}/${u.name}.wants`;
    const entries = this.vfs.exists(dir) ? this.vfs.listDirectory(dir) ?? [] : [];
    const linked = entries
      .filter((e) => e.name.endsWith('.service'))
      .map((e) => e.name.replace(/\.service$/, ''));
    const wants = [...new Set([...u.wants, ...linked])];
    return {
      name: u.name,
      requires: u.requires,
      wants,
      bindsTo: u.bindsTo,
      partOf: u.partOf,
      conflicts: u.conflicts,
      after: [...new Set([...u.after, ...u.requires, ...wants, ...u.bindsTo])],
      before: u.before,
    };
  }

  isolate(name: string): OperationResult {
    const unit = this.requireUnit(name);
    if (!unit.ok) return unit;
    if (!unit.unit.allowIsolate) {
      return {
        ok: false,
        error: `Operation refused, unit ${fullUnitName(unit.unit.name)} may be requested by dependency only (it is configured to refuse manual start/stop).`,
      };
    }
    return this.jobEngine().isolate(unit.unit.name);
  }

  private readonly timerScheduler = new TimerScheduler();

  timerTick(now: Date = new Date()): void {
    for (const service of this.timerScheduler.due(now)) this.start(service);
  }

  timerEntries(): TimerEntry[] {
    return this.timerScheduler.entries();
  }

  socketEntries(): Array<{ unit: string; port: number; service: string }> {
    return this.list()
      .filter((u) => unitSuffix(u.name) === 'socket' && u.state === 'active' && u.listenStream !== undefined)
      .map((u) => ({ unit: u.name, port: u.listenStream!, service: this.activatedUnit(u) }));
  }

  triggerSocket(name: string): OperationResult {
    const unit = this.units.get(name);
    if (!unit || unit.state !== 'active') {
      return { ok: false, error: `Socket unit ${fullUnitName(name)} is not listening.` };
    }
    return this.start(this.activatedUnit(unit));
  }

  private activatedUnit(u: LinuxService): string {
    const raw = u.activates ?? u.name.replace(/\.(socket|timer)$/, '');
    return raw.replace(/\.service$/, '');
  }

  private startOne(name: string): OperationResult {
    const unit = this.requireUnit(name);
    if (!unit.ok) return unit;
    const u = unit.unit;
    if (u.state === 'active') return { ok: true };
    if (u.startLimitHit) {
      return { ok: false, error: `Unit ${u.name}.service has a start-limit-hit.` };
    }
    const check = this.configChecks.get(u.name);
    if (check) {
      const verdict = check();
      if (!verdict.ok) {
        this.markFailed(u.name, verdict.error ?? 'configuration check failed');
        return verdict;
      }
    }
    if (u.readinessDelayMs && u.readinessDelayMs > 0) {
      const r = this.beginActivation(u);
      if (!r.ok) return r;
      const pending = { name: u.name, complete: () => this.completeDelayedActivation(u.name) };
      this.pendingReadiness.set(u.name, pending);
      const timer = setTimeout(() => {
        if (this.pendingReadiness.get(u.name) === pending) pending.complete();
      }, u.readinessDelayMs);
      if (typeof (timer as unknown as { unref?: () => void }).unref === 'function') {
        (timer as unknown as { unref: () => void }).unref();
      }
      return { ok: true };
    }
    const r = this.activate(u);
    if (r.ok) {
      this.emitLifecycle('start', u.name);
      this.logPortSource(u);
    }
    return r;
  }

  private logPortSource(u: LinuxService): void {
    const binding = this.getPortBinding(u.name);
    if (!binding || binding.sockets.length === 0) return;
    const port = binding.sockets[0].port;
    const source = u.portOverride ? u.portOverride.source : 'config';
    const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
    const line = `${now} systemd[1]: ${u.name}.service: bound port ${port} (source: ${source})\n`;
    const path = '/var/log/messages';
    if (!this.vfs.exists('/var/log')) this.vfs.mkdirp('/var/log', 0o755, 0, 0);
    const existing = this.vfs.readFile(path) ?? '';
    this.vfs.writeFile(path, existing + line, 0, 0, 0o022);
  }

  setReadinessDelay(name: string, delayMs: number): OperationResult {
    const unit = this.requireUnit(name);
    if (!unit.ok) return unit;
    unit.unit.readinessDelayMs = delayMs;
    return { ok: true };
  }

  setPortOverride(
    name: string,
    port: number,
    source: 'cli' | 'env' | 'config-reload',
    cliArg?: string,
  ): OperationResult {
    const unit = this.requireUnit(name);
    if (!unit.ok) return unit;
    const u = unit.unit;
    u.portOverride = { port, source, cliArg };
    return { ok: true };
  }

  getPortOverride(name: string): { port: number; source: string; cliArg?: string } | undefined {
    return this.units.get(name)?.portOverride;
  }

  flushReadiness(name?: string): void {
    if (name) {
      const p = this.pendingReadiness.get(name);
      if (p) p.complete();
      return;
    }
    for (const p of Array.from(this.pendingReadiness.values())) p.complete();
  }

  private readonly pendingReadiness = new Map<string, { name: string; complete: () => void }>();

  private beginActivation(u: LinuxService): OperationResult {
    const prev = u.state;
    u.state = 'activating';
    const userEntry = u.user || 'root';
    let uid = userEntry === 'root' ? 0 : 1;
    let gid = userEntry === 'root' ? 0 : 1;
    if (u.dynamicUser && this.dynamicUsers) {
      const allocated = this.dynamicUsers.allocate(userEntry);
      uid = allocated.uid;
      gid = allocated.gid;
    }
    const daemon = this.listenerSpecFor(u.name)?.daemonCommand;
    let expanded = (daemon ?? u.execStart).replace(/\$MAINPID/g, '');
    if (u.portOverride?.cliArg) expanded = `${expanded} ${u.portOverride.cliArg}`;
    const profile = serviceMemoryProfile(u.name);
    const proc = this.processMgr.spawn({
      command: expanded,
      user: userEntry,
      uid,
      gid,
      serviceName: u.name,
      vsize: profile.vsize,
      rss: profile.rss,
    });
    u.mainPid = proc.pid;
    this.emitStateChanged(u.name, prev, 'activating');
    return { ok: true };
  }

  private completeDelayedActivation(name: string): void {
    const u = this.units.get(name);
    if (!u || u.state !== 'activating') { this.pendingReadiness.delete(name); return; }
    u.activeSince = new Date();
    u.state = 'active';
    this.pendingReadiness.delete(name);
    this.emitStateChanged(u.name, 'activating', 'active');
    this.emitLifecycle('start', u.name);
  }

  /**
   * Stop a service and the units that depend on it. Propagates through
   * the reverse Requires/BindsTo/PartOf edges (systemd's stop job),
   * deactivating dependents before the target. A unit nothing depends on
   * yields a single-job transaction — same result as before.
   */
  stop(name: string): OperationResult {
    const unit = this.requireUnit(name);
    if (!unit.ok) return unit;
    return this.jobEngine().stop(unit.unit.name);
  }

  private stopOne(name: string): OperationResult {
    const unit = this.requireUnit(name);
    if (!unit.ok) return unit;
    const u = unit.unit;
    if (u.state !== 'active' && u.state !== 'activating') {
      return { ok: true };
    }
    const r = this.deactivate(u);
    if (r.ok) this.emitLifecycle('stop', u.name);
    return r;
  }

  /** Stop then start a service in a single operation. */
  restart(name: string): OperationResult {
    const stopRes = this.stop(name);
    if (!stopRes.ok) return stopRes;
    const start = this.start(name);
    if (start.ok) this.emitLifecycle('restart', name);
    return start;
  }

  /** Send SIGHUP (or run ExecReload) to the main process. */
  reload(name: string): OperationResult {
    const unit = this.requireUnit(name);
    if (!unit.ok) return unit;
    const u = unit.unit;
    if (u.state !== 'active' || u.mainPid === undefined) {
      return { ok: false, error: `Job for ${name}.service failed because the unit is not active.` };
    }
    if (!u.execReload) {
      return { ok: false, error: `Job type reload is not applicable for unit ${name}.service.` };
    }
    const check = this.configChecks.get(u.name);
    if (check) {
      const verdict = check();
      if (!verdict.ok) return verdict;
    }
    this.processMgr.deliverSignal(u.mainPid, 'SIGHUP');
    this.emitLifecycle('reload', u.name);
    return { ok: true };
  }

  /** Mark service as enabled and create the Wants symlink. */
  enable(name: string): OperationResult {
    const unit = this.requireUnit(name);
    if (!unit.ok) return unit;
    const u = unit.unit;
    if (u.enabled === 'enabled') return { ok: true };
    this.vfs.mkdirp(WANTS_DIR, 0o755, 0, 0);
    const linkPath = `${WANTS_DIR}/${fullUnitName(u.name)}`;
    if (!this.vfs.existsNoFollow(linkPath)) {
      const target = `${u.loadedFrom}`;
      this.vfs.createSymlink(linkPath, target, 0, 0);
    }
    u.enabled = 'enabled';
    this.emitEnablement('linux.service.enabled', u.name, 'enabled');
    return { ok: true };
  }

  /** Mark service as disabled and remove the Wants symlink. */
  disable(name: string): OperationResult {
    const unit = this.requireUnit(name);
    if (!unit.ok) return unit;
    const u = unit.unit;
    const linkPath = `${WANTS_DIR}/${fullUnitName(u.name)}`;
    if (this.vfs.existsNoFollow(linkPath)) {
      this.vfs.deleteFile(linkPath);
    }
    u.enabled = 'disabled';
    this.emitEnablement('linux.service.disabled', u.name, 'disabled');
    return { ok: true };
  }

  /** Mask a unit (symlink to /dev/null): it cannot be started. */
  mask(name: string): OperationResult {
    const unit = this.requireUnit(name);
    if (!unit.ok) return unit;
    const u = unit.unit;
    u.enabled = 'masked';
    this.emitEnablement('linux.service.masked', u.name, 'masked');
    return { ok: true };
  }

  /** Reverse `mask`, restoring the computed enable state. */
  unmask(name: string): OperationResult {
    const unit = this.requireUnit(name);
    if (!unit.ok) return unit;
    const u = unit.unit;
    u.enabled = this.computeEnabledState(name);
    this.emitEnablement('linux.service.unmasked', u.name, u.enabled);
    return { ok: true };
  }

  /** systemd default boot target (graphical for PC, multi-user for server). */
  defaultTarget(): string {
    return this.opts.isServer ? 'multi-user.target' : 'graphical.target';
  }

  /** Clear the `failed` state so the unit can be started again. */
  resetFailed(name?: string): void {
    const units = name ? [this.units.get(name)].filter(Boolean) as LinuxService[]
      : [...this.units.values()];
    for (const u of units) {
      u.startLimitHit = false;
      u.restartEpochs = [];
      u.failedReason = undefined;
      if (u.state === 'failed') {
        const from = u.state;
        u.state = 'inactive';
        this.emitStateChanged(u.name, from, 'inactive');
      }
    }
  }

  noteMainExited(name: string, exit: { code?: number; signal?: string }): void {
    const u = this.units.get(name);
    if (!u) return;
    u.lastExit = exit;
    u.mainPid = undefined;
    this.bus?.publish({
      topic: 'linux.service.main-exited',
      payload: { deviceId: this.deviceId, name, exitCode: exit.code, signal: exit.signal },
    });
  }

  deactivateAfterExit(name: string): void {
    const u = this.units.get(name);
    if (!u) return;
    const from = u.state;
    u.state = 'inactive';
    u.activeSince = undefined;
    this.emitStateChanged(name, from, 'inactive');
  }

  scheduleAutoRestart(name: string, counter: number, delayMs: number): void {
    const u = this.units.get(name);
    if (!u) return;
    const from = u.state;
    u.state = 'activating';
    u.autoRestartPending = true;
    this.emitStateChanged(name, from, 'activating');
    this.bus?.publish({
      topic: 'linux.service.restart-scheduled',
      payload: { deviceId: this.deviceId, name, counter, delayMs },
    });
  }

  completeAutoRestart(name: string): void {
    const u = this.units.get(name);
    if (!u || !u.autoRestartPending || u.state !== 'activating') return;
    u.autoRestartPending = false;
    u.state = 'inactive';
    const r = this.start(name);
    if (r.ok) this.emitLifecycle('restart', name);
  }

  hitStartLimit(name: string): void {
    const u = this.units.get(name);
    if (!u) return;
    u.startLimitHit = true;
    u.autoRestartPending = false;
    this.bus?.publish({
      topic: 'linux.service.start-limited',
      payload: { deviceId: this.deviceId, name },
    });
    this.markFailed(name, 'start-limit-hit');
  }

  rebootCycle(): void {
    for (const u of [...this.units.values()]) {
      u.autoRestartPending = false;
      u.startLimitHit = false;
      u.restartEpochs = [];
      u.failedReason = undefined;
      u.lastExit = undefined;
      if (u.state === 'active' || u.state === 'activating') {
        this.stopOne(u.name);
      } else if (u.state === 'failed') {
        u.state = 'inactive';
      }
    }
    this.daemonReload();
    this.startEnabledServices();
  }

  /** Return the unit, or null if not loaded. */
  status(name: string): LinuxService | null {
    return this.units.get(name) ?? null;
  }

  /** Find the unit whose main process is `pid` (used by the supervisor). */
  findByMainPid(pid: number): LinuxService | null {
    for (const u of this.units.values()) {
      if (u.mainPid === pid) return u;
    }
    return null;
  }

  /** Transition a unit to `failed` and publish the failure event. */
  markFailed(name: string, reason: string): void {
    const u = this.units.get(name);
    if (!u) return;
    const from = u.state;
    u.state = 'failed';
    u.failedReason = reason;
    u.mainPid = undefined;
    u.activeSince = undefined;
    this.emitStateChanged(name, from, 'failed');
    this.bus?.publish({
      topic: 'linux.service.failed',
      payload: { deviceId: this.deviceId, name, reason },
    });
    this.jobEngine().stop(name);
  }

  /** True if the service is currently active. */
  isActive(name: string): boolean {
    return this.units.get(name)?.state === 'active';
  }

  /** True if the service is enabled at boot. */
  isEnabled(name: string): boolean {
    return this.units.get(name)?.enabled === 'enabled';
  }

  /** List units, optionally filtered by state or enabled flag. */
  list(filter: ListFilter = {}): LinuxService[] {
    const out: LinuxService[] = [];
    for (const u of this.units.values()) {
      if (filter.state !== undefined && u.state !== filter.state) continue;
      if (filter.enabled !== undefined && u.enabled !== filter.enabled) continue;
      out.push(u);
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Re-scan unit files from /etc/systemd/system (overrides) and
   * /lib/systemd/system. Preserves runtime state of already-loaded units.
   */
  daemonReload(): void {
    const etcUnits = this.scanDir(ETC_UNIT_DIR);
    const libUnits = this.scanDir(SYSTEM_UNIT_DIR);

    // /etc/systemd/system overrides /lib/systemd/system
    const merged = new Map<string, { path: string; content: string }>();
    for (const u of libUnits) merged.set(u.name, { path: u.path, content: u.content });
    for (const u of etcUnits) merged.set(u.name, { path: u.path, content: u.content });

    for (const [name, src] of merged) {
      const parsed = parseUnitFile(src.content);
      const previous = this.units.get(name);
      const unit = new LinuxService({
        name,
        description: parsed.description ?? name,
        type: parsed.type ?? 'simple',
        execStart: parsed.execStart ?? '/bin/true',
        execStop: parsed.execStop,
        execReload: parsed.execReload,
        user: parsed.user ?? (parsed.dynamicUser ? name : 'root'),
        group: parsed.group ?? (parsed.dynamicUser ? name : 'root'),
        dynamicUser: parsed.dynamicUser ?? false,
        wantedBy: parsed.wantedBy ?? [],
        wants: parsed.wants ?? [],
        after: parsed.after ?? [],
        before: parsed.before ?? [],
        requires: parsed.requires ?? [],
        bindsTo: parsed.bindsTo ?? [],
        partOf: parsed.partOf ?? [],
        conflicts: parsed.conflicts ?? [],
        allowIsolate: parsed.allowIsolate ?? false,
        restart: parsed.restart ?? 'no',
        restartSec: parsed.restartSec,
        startLimitBurst: parsed.startLimitBurst,
        startLimitIntervalSec: parsed.startLimitIntervalSec,
        listenStream: parsed.listenStream,
        onActiveSec: parsed.onActiveSec,
        onBootSec: parsed.onBootSec,
        onUnitActiveSec: parsed.onUnitActiveSec,
        onCalendar: parsed.onCalendar,
        activates: parsed.activates,
        loadedFrom: src.path,
        // Preserve previous runtime state if the unit already existed.
        state: previous?.state ?? 'inactive',
        enabled: this.computeEnabledState(name),
        mainPid: previous?.mainPid,
        activeSince: previous?.activeSince,
      });
      // Stamp the daemon's well-known listening sockets onto the unit so the
      // model carries them and the port projection can keep them coherent.
      unit.listenSockets = (this.listenerSpecFor(name)?.sockets ?? []).map((s) => ({ ...s }));
      this.units.set(name, unit);
    }

    // Drop units that no longer have a backing file (and stop them).
    for (const name of Array.from(this.units.keys())) {
      if (!merged.has(name)) {
        const u = this.units.get(name)!;
        if (u.mainPid !== undefined) this.processMgr.kill(u.mainPid, 'SIGKILL');
        this.timerScheduler.disarm(name);
        this.units.delete(name);
      }
    }
  }

  // ─── Port projection support ──────────────────────────────────────

  /**
   * The listening-port binding for a single unit — its main PID, the
   * `netstat`-visible process name, and the sockets it opens. Returns
   * `undefined` when the unit is unknown or opens no ports.
   */
  /**
   * Declare the listener identity of a dynamically-named unit (which
   * sockets it opens and which daemon process it leaves behind). Must be
   * called before the unit is installed/started so daemon-reload stamps
   * the sockets and the port projection can bind/unbind them.
   */
  registerServiceListener(name: string, spec: ServiceListenerSpec): void {
    this.dynamicListeners.set(name.replace(/\.service$/, ''), {
      ...spec,
      sockets: spec.sockets.map((s) => ({ ...s })),
    });
  }

  /** Listener spec for a unit — runtime registrations win over the static table. */
  private listenerSpecFor(name: string): ServiceListenerSpec | undefined {
    return this.dynamicListeners.get(name) ?? SERVICE_LISTENERS[name];
  }

  getPortBinding(name: string): ServicePortBinding | undefined {
    const unit = this.units.get(name);
    if (unit && unitSuffix(unit.name) === 'socket' && unit.listenStream !== undefined) {
      return {
        name,
        mainPid: 1,
        processName: 'systemd',
        sockets: [{ port: unit.listenStream, protocol: 'tcp' }],
      };
    }
    const listener = this.listenerSpecFor(name);
    if (!unit || !listener || listener.sockets.length === 0) return undefined;
    const override = unit.portOverride;
    const sockets = override
      ? [{ port: override.port, protocol: listener.sockets[0].protocol }]
      : listener.sockets.map((s) => ({ ...s }));
    return {
      name,
      mainPid: unit.mainPid,
      processName: listener.processName,
      sockets,
    };
  }

  /** Port bindings for every unit currently `active` that opens a port. */
  activePortBindings(): ServicePortBinding[] {
    const out: ServicePortBinding[] = [];
    for (const unit of this.units.values()) {
      if (unit.state !== 'active') continue;
      const binding = this.getPortBinding(unit.name);
      if (binding) out.push(binding);
    }
    return out;
  }

  // ─── Private helpers ──────────────────────────────────────────────

  private requireUnit(
    name: string,
  ): { ok: true; unit: LinuxService } | { ok: false; error: string } {
    const short = name.replace(/\.service$/, '');
    const u = this.units.get(short);
    if (!u) {
      return { ok: false, error: `Unit ${fullUnitName(short)} not found.` };
    }
    return { ok: true, unit: u };
  }

  private activate(u: LinuxService): OperationResult {
    const prev = u.state;
    if (unitSuffix(u.name) !== 'service') {
      u.activeSince = new Date();
      u.state = 'active';
      if (unitSuffix(u.name) === 'timer') {
        this.timerScheduler.arm({
          unit: u.name,
          activates: this.activatedUnit(u),
          onActiveSec: u.onActiveSec,
          onBootSec: u.onBootSec,
          onUnitActiveSec: u.onUnitActiveSec,
          onCalendar: u.onCalendar,
        }, u.activeSince);
      }
      this.emitStateChanged(u.name, prev, 'active');
      return { ok: true };
    }
    u.state = 'activating';
    const userEntry = u.user || 'root';
    let uid = userEntry === 'root' ? 0 : 1;
    let gid = userEntry === 'root' ? 0 : 1;
    if (u.dynamicUser && this.dynamicUsers) {
      const allocated = this.dynamicUsers.allocate(userEntry);
      uid = allocated.uid;
      gid = allocated.gid;
    }
    // The process the unit leaves behind: the daemon it forks when the
    // listener spec declares one (lsnrctl start → tnslsnr), else ExecStart.
    const daemon = this.listenerSpecFor(u.name)?.daemonCommand;
    let expanded = (daemon ?? u.execStart).replace(/\$MAINPID/g, '');
    if (u.portOverride?.cliArg) expanded = `${expanded} ${u.portOverride.cliArg}`;
    const profile = serviceMemoryProfile(u.name);
    const proc = this.processMgr.spawn({
      command: expanded,
      user: userEntry,
      uid,
      gid,
      serviceName: u.name,
      vsize: profile.vsize,
      rss: profile.rss,
    });
    u.mainPid = proc.pid;
    u.activeSince = new Date();
    u.state = 'active';
    this.emitStateChanged(u.name, prev, 'active');
    return { ok: true };
  }

  private deactivate(u: LinuxService): OperationResult {
    const prev = u.state;
    u.state = 'deactivating';
    if (unitSuffix(u.name) === 'timer') this.timerScheduler.disarm(u.name);
    if (u.mainPid !== undefined) {
      this.processMgr.kill(u.mainPid, 'SIGTERM');
      u.mainPid = undefined;
    }
    if (u.dynamicUser && this.dynamicUsers) {
      this.dynamicUsers.release(u.user || u.name);
    }
    u.activeSince = undefined;
    u.state = 'inactive';
    this.emitStateChanged(u.name, prev, 'inactive');
    return { ok: true };
  }

  private computeEnabledState(name: string): EnabledState {
    if (name.endsWith('.target')) return 'static';
    return this.vfs.existsNoFollow(`${WANTS_DIR}/${fullUnitName(name)}`) ? 'enabled' : 'disabled';
  }

  private scanDir(dir: string): Array<{ name: string; path: string; content: string }> {
    if (!this.vfs.exists(dir)) return [];
    const entries = this.vfs.listDirectory(dir) ?? [];
    const out: Array<{ name: string; path: string; content: string }> = [];
    for (const entry of entries) {
      if (entry.name === '.' || entry.name === '..') continue;
      if (!/\.(service|target|socket|timer)$/.test(entry.name)) continue;
      const path = `${dir}/${entry.name}`;
      const content = this.vfs.readFile(path);
      if (content === null) continue;
      const name = entry.name.replace(/\.service$/, '');
      out.push({ name, path, content });
    }
    return out;
  }

  /** Install the vendor unit file set in /lib/systemd/system. */
  private bootstrapDefaultUnits(): void {
    this.vfs.mkdirp(SYSTEM_UNIT_DIR, 0o755, 0, 0);
    this.vfs.mkdirp(ETC_UNIT_DIR, 0o755, 0, 0);
    this.vfs.mkdirp(WANTS_DIR, 0o755, 0, 0);

    const units = [...BASE_UNITS, ...(this.opts.isServer ? SERVER_UNITS : [])];
    for (const u of units) {
      const path = `${SYSTEM_UNIT_DIR}/${u.name}.service`;
      if (!this.vfs.exists(path)) {
        this.vfs.writeFile(path, renderUnitFile(u), 0, 0, 0o022);
      }
      if (u.enabledByDefault) {
        const linkPath = `${WANTS_DIR}/${u.name}.service`;
        if (!this.vfs.existsNoFollow(linkPath)) {
          this.vfs.createSymlink(linkPath, path, 0, 0);
        }
      }
    }

    for (const t of DEFAULT_TARGETS) {
      const path = `${SYSTEM_UNIT_DIR}/${t.name}`;
      if (!this.vfs.exists(path)) {
        this.vfs.writeFile(path, renderTargetFile(t), 0, 0, 0o022);
      }
    }
  }

  /** Start every enabled unit — the boot-time multi-user.target job. */
  private startEnabledServices(): void {
    for (const u of [...this.units.values()]) {
      if (u.enabled === 'enabled' && u.state !== 'active') {
        this.startOne(u.name);
      }
    }
    for (const name of this.dependencyGraph().activationClosure(this.defaultTarget())) {
      const u = this.units.get(name);
      if (u && u.name.endsWith('.target') && u.state !== 'active') {
        this.activate(u);
      }
    }
  }
}

// ─── Unit file rendering and parsing ──────────────────────────────────

function renderTargetFile(t: DefaultTarget): string {
  return ['[Unit]', `Description=${t.description}`, ...(t.unitLines ?? []), ''].join('\n');
}

/** Serialize a default unit definition into ini-format unit file content. */
function renderUnitFile(u: DefaultUnit): string {
  const lines: string[] = [];
  lines.push('[Unit]');
  lines.push(`Description=${u.description}`);
  if (u.after && u.after.length) lines.push(`After=${u.after.join(' ')}`);
  lines.push('');
  lines.push('[Service]');
  lines.push(`Type=${u.type}`);
  lines.push(`ExecStart=${u.execStart}`);
  if (u.execReload) lines.push(`ExecReload=${u.execReload}`);
  if (u.user) lines.push(`User=${u.user}`);
  lines.push('Restart=on-failure');
  lines.push('');
  lines.push('[Install]');
  lines.push('WantedBy=multi-user.target');
  lines.push('');
  return lines.join('\n');
}

/** Parsed directives from a unit file (all fields optional). */
interface ParsedUnit {
  description?: string;
  type?: ServiceType;
  execStart?: string;
  execStop?: string;
  execReload?: string;
  user?: string;
  group?: string;
  dynamicUser?: boolean;
  wantedBy?: string[];
  wants?: string[];
  after?: string[];
  before?: string[];
  requires?: string[];
  bindsTo?: string[];
  partOf?: string[];
  conflicts?: string[];
  allowIsolate?: boolean;
  restart?: RestartPolicy;
  restartSec?: number;
  startLimitBurst?: number;
  startLimitIntervalSec?: number;
  listenStream?: number;
  onActiveSec?: number;
  onBootSec?: number;
  onUnitActiveSec?: number;
  onCalendar?: string;
  activates?: string;
}

/** Minimal ini-style parser for systemd unit files. */
export function parseUnitFile(content: string): ParsedUnit {
  const out: ParsedUnit = {};
  const sections = ['Unit', 'Service', 'Install', 'Socket', 'Timer'] as const;
  let section: typeof sections[number] | null = null;
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    if (line.startsWith('[') && line.endsWith(']')) {
      const name = line.slice(1, -1);
      section = (sections as readonly string[]).includes(name) ? name as typeof sections[number] : null;
      continue;
    }
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    const val = line.slice(eq + 1).trim();
    if (section === 'Unit') {
      if (key === 'Description') out.description = val;
      else if (key === 'After') out.after = val.split(/\s+/);
      else if (key === 'Before') out.before = val.split(/\s+/);
      else if (key === 'Requires') out.requires = val.split(/\s+/);
      else if (key === 'Wants') out.wants = val.split(/\s+/);
      else if (key === 'BindsTo') out.bindsTo = val.split(/\s+/);
      else if (key === 'PartOf') out.partOf = val.split(/\s+/);
      else if (key === 'Conflicts') out.conflicts = val.split(/\s+/);
      else if (key === 'AllowIsolate') out.allowIsolate = /^(yes|true|1|on)$/i.test(val);
      else if (key === 'StartLimitBurst') out.startLimitBurst = parseInt(val, 10);
      else if (key === 'StartLimitIntervalSec') out.startLimitIntervalSec = parseFloat(val);
    } else if (section === 'Service') {
      if (key === 'Type') out.type = val as ServiceType;
      else if (key === 'ExecStart') out.execStart = val;
      else if (key === 'ExecStop') out.execStop = val;
      else if (key === 'ExecReload') out.execReload = val;
      else if (key === 'User') out.user = val;
      else if (key === 'Group') out.group = val;
      else if (key === 'DynamicUser') out.dynamicUser = /^(yes|true|1|on)$/i.test(val);
      else if (key === 'Restart') out.restart = val as RestartPolicy;
      else if (key === 'RestartSec') out.restartSec = parseFloat(val);
      else if (key === 'StartLimitBurst') out.startLimitBurst = parseInt(val, 10);
      else if (key === 'StartLimitIntervalSec') out.startLimitIntervalSec = parseFloat(val);
    } else if (section === 'Socket') {
      if (key === 'ListenStream' && /^\d+$/.test(val)) out.listenStream = parseInt(val, 10);
      else if (key === 'Service') out.activates = val;
    } else if (section === 'Timer') {
      if (key === 'OnActiveSec') out.onActiveSec = parseTimeSpan(val);
      else if (key === 'OnBootSec') out.onBootSec = parseTimeSpan(val);
      else if (key === 'OnUnitActiveSec') out.onUnitActiveSec = parseTimeSpan(val);
      else if (key === 'OnCalendar') out.onCalendar = val;
      else if (key === 'Unit') out.activates = val;
    } else if (section === 'Install') {
      if (key === 'WantedBy') out.wantedBy = val.split(/\s+/);
    }
  }
  return out;
}

/** Plausible VSZ/RSS (in KiB) for each well-known systemd unit, with
 *  small ±10% jitter so two daemons of the same family don't look like
 *  pixel-perfect clones in `ps aux` / `top`. Falls back to a generic
 *  middleweight daemon footprint. */
function serviceMemoryProfile(name: string): { vsize: number; rss: number } {
  const table: Record<string, [number, number]> = {
    'systemd':              [169000, 13000],
    'systemd-journald':     [55000,  5400],
    'systemd-logind':       [82000,  3900],
    'systemd-resolved':     [98000,  6800],
    'systemd-timesyncd':    [85000,  3000],
    'systemd-networkd':     [89000,  4900],
    'systemd-udevd':        [25000,  4400],
    'sshd':                 [15000,  6200],
    'cron':                 [10000,  2400],
    'atd':                  [8200,   1600],
    'rsyslog':              [223000, 4700],
    'dbus':                 [9500,   3500],
    'dbus-daemon':          [9500,   3500],
    'auditd':               [82000,  4200],
    'apparmor':             [3500,   200],
    'NetworkManager':       [310000, 11000],
    'polkit':               [185000, 8800],
    'polkitd':              [185000, 8800],
    'getty':                [5400,   1700],
    'agetty':               [5400,   1700],
    'snapd':                [820000, 35000],
    'unattended-upgrade':   [126000, 16000],
    'nginx':                [55000,  4900],
    'apache2':              [220000, 12000],
    'mariadbd':             [1180000, 130000],
    'mysqld':               [1180000, 130000],
    'postgres':             [355000, 26000],
    'redis-server':         [62000,  9700],
    'docker':               [1450000, 70000],
    'containerd':           [1450000, 65000],
  };
  const base = table[name] ?? [48000, 4300];
  // Deterministic jitter so a given service name always renders the
  // same numbers across calls (otherwise `ps` and `top` would disagree).
  let seed = 0;
  for (let i = 0; i < name.length; i++) seed = (seed * 31 + name.charCodeAt(i)) >>> 0;
  const jitter = (((seed % 2000) - 1000) / 10000); // ±10 %
  return {
    vsize: Math.max(1024, Math.round(base[0] * (1 + jitter))),
    rss:   Math.max(256,  Math.round(base[1] * (1 + jitter * 0.7))),
  };
}
