/**
 * Windows Service Manager — simulates Windows service lifecycle.
 *
 * Models realistic Windows services with:
 *   - Service states: Running, Stopped, Paused, StartPending, StopPending,
 *     PausePending, ContinuePending
 *   - Start types: Automatic, Manual, Disabled, AutomaticDelayedStart
 *   - Service dependencies (prevents stopping services with running dependents)
 *   - Service accounts: LocalSystem, LocalService, NetworkService
 *   - Pause/Resume support (only for services that declare it)
 *   - Built-in services matching real Windows defaults
 *   - Service creation/deletion with protection on built-in services
 */

import type { PortSpec } from '../../core/ports/PortNumber';
import type { IEventBus } from '@/events/EventBus';

export type ServiceState =
  | 'Running' | 'Stopped' | 'Paused'
  | 'StartPending' | 'StopPending'
  | 'PausePending' | 'ContinuePending';

export type ServiceStartType =
  | 'Automatic' | 'AutomaticDelayedStart' | 'Manual' | 'Disabled'
  | 'Boot' | 'System';

export type ServiceType = 'WIN32_OWN_PROCESS' | 'WIN32_SHARE_PROCESS' | 'KERNEL_DRIVER';

/** One tier of `sc failure`'s `actions=` list. */
export type RecoveryActionType = 'restart' | 'run' | 'reboot' | 'none';

export interface RecoveryAction {
  type: RecoveryActionType;
  delayMs: number;
}

/** `sc failure <name> reset= <sec> actions= <tiers> command= <cmd>` state. */
export interface FailureActionsConfig {
  resetPeriodSec: number;
  /** actions[0] = 1st failure, actions[1] = 2nd, actions[n>=length] clamp to the last tier. */
  actions: RecoveryAction[];
  /** Command line for `run` tiers (`sc failure ... command= "..."`). */
  command?: string;
}

/** A callback invoked whenever a watched service's state changes — the
 *  primitive `Register-WmiEvent`'s `__InstanceModificationEvent` polling
 *  simulates on top of. */
export type ServiceInstanceWatcher = (evt: {
  previousState: ServiceState;
  newState: ServiceState;
  timestamp: Date;
}) => void;

export interface WindowsService {
  name: string;
  displayName: string;
  description: string;
  state: ServiceState;
  startType: ServiceStartType;
  serviceType: ServiceType;
  binaryPath: string;
  account: string;
  dependencies: string[];
  canPauseAndContinue: boolean;
  acceptsShutdown: boolean;
  /** Process name spawned when service runs (for process manager link) */
  processName: string;
  builtIn: boolean;
  /** Critical OS services that cannot be stopped */
  critical?: boolean;
}

/**
 * The listening sockets a Windows service opens once running. Drives the
 * socket-table coherence: `sc start`/`net start` binds them, `sc stop`
 * releases them — exactly as the service controller does on real Windows.
 */
export interface WindowsServiceListenerSpec {
  /** Process the kernel attributes the socket to (`netstat -b`/`-o`). */
  processName: string;
  /** PID shown by `netstat -o`. */
  pid: number;
  sockets: PortSpec[];
}

/** Default Windows service → listening-port mapping (keyed lower-case). */
export const WINDOWS_SERVICE_LISTENERS: Readonly<Record<string, WindowsServiceListenerSpec>> = {
  lanmanserver: {
    processName: 'System',
    pid: 4,
    sockets: [{ port: 445, protocol: 'tcp' }, { port: 139, protocol: 'tcp' }],
  },
  termservice: {
    processName: 'svchost.exe',
    pid: 1096,
    sockets: [{ port: 3389, protocol: 'tcp' }],
  },
  sshd: {
    processName: 'sshd.exe',
    pid: 1088,
    sockets: [{ port: 22, protocol: 'tcp' }],
  },
};

/** State codes for sc query output */
const STATE_CODES: Record<ServiceState, number> = {
  Stopped: 1, StartPending: 2, StopPending: 3,
  Running: 4, ContinuePending: 5, PausePending: 6, Paused: 7,
};

/** State names matching real sc.exe output */
const STATE_NAMES: Record<ServiceState, string> = {
  Stopped: 'STOPPED', StartPending: 'START_PENDING', StopPending: 'STOP_PENDING',
  Running: 'RUNNING', ContinuePending: 'CONTINUE_PENDING',
  PausePending: 'PAUSE_PENDING', Paused: 'PAUSED',
};

/** Type codes matching real sc.exe output */
const TYPE_CODES: Record<ServiceType, number> = {
  KERNEL_DRIVER: 1,
  WIN32_OWN_PROCESS: 10,
  WIN32_SHARE_PROCESS: 20,
};

/** Start type codes matching real sc.exe output */
export const START_TYPE_CODES: Record<ServiceStartType, number> = {
  Boot: 0, System: 1, Automatic: 2, AutomaticDelayedStart: 2,
  Manual: 3, Disabled: 4,
};

/** Start type names for sc qc output */
const START_TYPE_NAMES: Record<ServiceStartType, string> = {
  Boot: 'BOOT_START', System: 'SYSTEM_START',
  Automatic: 'AUTO_START', AutomaticDelayedStart: 'AUTO_START (DELAYED)',
  Manual: 'DEMAND_START', Disabled: 'DISABLED',
};

export class WindowsServiceManager {
  private services: Map<string, WindowsService> = new Map();
  /** Reactive sink — null until the device attaches its bus. */
  private bus: IEventBus | null = null;
  private deviceId = '';

  private failureConfigs: Map<string, FailureActionsConfig> = new Map();
  private failureState: Map<string, { count: number; lastFailureAtMs: number }> = new Map();
  private pendingRecoveries: Array<{
    serviceName: string; dueAtMs: number; rank: number; action: RecoveryAction; command?: string;
  }> = [];

  private instanceWatchers: Map<string, { serviceName: string; cb: ServiceInstanceWatcher }> = new Map();
  private watcherSeq = 0;

  constructor() {
    this.initDefaults();
  }

  /**
   * Attach the device event bus so service lifecycle changes are published.
   * Reactive consumers — the System event-log projection and the socket-table
   * port projection — subscribe and keep their derived views coherent.
   */
  attachBus(bus: IEventBus, deviceId: string): void {
    this.bus = bus;
    this.deviceId = deviceId;
    bus.subscribe('device.power-on', (e) => {
      if (e.payload.id === deviceId) this.applyBootStartupPolicy();
    });
  }

  /** Start types the SCM brings up unattended on boot, before any user logs on. */
  private static readonly AUTO_START_TYPES: ReadonlySet<ServiceStartType> = new Set([
    'Automatic', 'AutomaticDelayedStart', 'Boot', 'System',
  ]);

  /**
   * Real Windows boot: every service comes up from Stopped, then the SCM
   * starts whichever ones are configured Automatic/Boot/System. Manual and
   * Disabled services stay stopped until explicitly started — this is what
   * makes `Set-Service -StartupType Disabled` survive a reboot.
   */
  private applyBootStartupPolicy(): void {
    for (const svc of this.services.values()) {
      svc.state = WindowsServiceManager.AUTO_START_TYPES.has(svc.startType) ? 'Running' : 'Stopped';
    }
  }

  /** Publish a service-lifecycle event on the central bus. */
  private publishServiceState(svc: WindowsService, running: boolean): void {
    this.bus?.publish({
      topic: running ? 'windows.service.started' : 'windows.service.stopped',
      payload: {
        deviceId: this.deviceId,
        serviceName: svc.name,
        displayName: svc.displayName,
        running,
      },
    });
  }

  private initDefaults(): void {
    const svc = (
      name: string, displayName: string, desc: string,
      opts: Partial<Pick<WindowsService, 'startType' | 'dependencies' | 'canPauseAndContinue'
        | 'acceptsShutdown' | 'processName' | 'account' | 'serviceType' | 'state' | 'critical'>> = {}
    ) => {
      this.services.set(name.toLowerCase(), {
        name, displayName, description: desc,
        state: opts.state ?? 'Running',
        startType: opts.startType ?? 'Automatic',
        serviceType: opts.serviceType ?? 'WIN32_SHARE_PROCESS',
        binaryPath: `C:\\Windows\\System32\\svchost.exe -k ${name.toLowerCase()}`,
        account: opts.account ?? 'NT AUTHORITY\\LocalService',
        dependencies: opts.dependencies ?? [],
        canPauseAndContinue: opts.canPauseAndContinue ?? false,
        acceptsShutdown: opts.acceptsShutdown ?? true,
        processName: opts.processName ?? 'svchost.exe',
        builtIn: true,
        critical: opts.critical ?? false,
      });
    };

    // Core networking
    svc('Tcpip', 'TCP/IP Protocol Driver', 'TCP/IP Protocol Driver',
      { serviceType: 'KERNEL_DRIVER', startType: 'Boot', account: '', processName: 'System', acceptsShutdown: false });
    svc('Afd', 'Ancillary Function Driver for Winsock', 'Winsock helper',
      { serviceType: 'KERNEL_DRIVER', startType: 'System', account: '', processName: 'System', acceptsShutdown: false });
    svc('Dhcp', 'DHCP Client', 'Registers and updates IP addresses and DNS records',
      { dependencies: ['Afd', 'Tcpip'], account: 'NT Authority\\LocalService' });
    svc('Dnscache', 'DNS Client', 'Caches DNS names and registers the full computer name',
      { dependencies: ['Tcpip'], account: 'NT AUTHORITY\\NetworkService' });
    svc('NetBT', 'NetBT', 'NetBIOS over TCP/IP',
      { serviceType: 'KERNEL_DRIVER', startType: 'System', dependencies: ['Tcpip'], account: '', processName: 'System', acceptsShutdown: false });

    // RPC (many services depend on this)
    svc('RpcSs', 'Remote Procedure Call (RPC)', 'The RPCSS service is the Service Control Manager for COM and DCOM servers',
      { account: 'NT AUTHORITY\\NetworkService' });
    svc('RpcEptMapper', 'RPC Endpoint Mapper', 'Resolves RPC interfaces identifiers to transport endpoints',
      { account: 'NT AUTHORITY\\NetworkService' });

    // Security
    svc('SamSs', 'Security Accounts Manager', 'Stores security information for local user accounts',
      { dependencies: ['RpcSs'], account: 'NT AUTHORITY\\SYSTEM' });

    // Network sharing
    svc('LanmanServer', 'Server', 'Supports file, print, and named-pipe sharing over the network',
      { dependencies: ['SamSs'], canPauseAndContinue: true, account: 'NT AUTHORITY\\SYSTEM' });
    svc('LanmanWorkstation', 'Workstation', 'Creates and maintains client network connections to remote servers',
      { account: 'NT AUTHORITY\\NetworkService' });

    // Firewall
    svc('mpssvc', 'Windows Defender Firewall', 'Helps protect your computer by preventing unauthorized users from gaining access',
      { dependencies: ['RpcSs'], account: 'NT AUTHORITY\\LocalService' });

    // Event log
    svc('EventLog', 'Windows Event Log', 'Manages events and event logs',
      { account: 'NT AUTHORITY\\LocalService' });

    // Time
    svc('W32Time', 'Windows Time', 'Maintains date and time synchronization on all clients and servers',
      { account: 'NT AUTHORITY\\LocalService' });

    // Cryptography
    svc('CryptSvc', 'Cryptographic Services', 'Provides cryptographic key management services',
      { dependencies: ['RpcSs'], account: 'NT AUTHORITY\\NetworkService' });

    // Management
    svc('Winmgmt', 'Windows Management Instrumentation', 'Provides a common interface and object model for WMI',
      { dependencies: ['RpcSs'], account: 'NT AUTHORITY\\SYSTEM' });
    svc('WinRM', 'Windows Remote Management (WS-Management)',
      'Windows Remote Management (WinRM) service',
      { dependencies: ['RpcSs'], startType: 'Manual', state: 'Stopped', account: 'NT AUTHORITY\\NetworkService' });

    // Bluetooth
    svc('bthserv', 'Bluetooth Support Service', 'Supports Bluetooth HID devices and Audio',
      { startType: 'Manual', state: 'Stopped', account: 'NT AUTHORITY\\LocalService' });

    // Windows Logon (critical — cannot be stopped)
    svc('winlogon', 'Windows Logon Application', 'Manages user logon and logoff',
      { account: 'NT AUTHORITY\\SYSTEM', critical: true } as any);

    // Print
    svc('Spooler', 'Print Spooler', 'Loads files to memory for later printing',
      { dependencies: ['RpcSs'], canPauseAndContinue: true,
        processName: 'spoolsv.exe', binaryPath: 'C:\\Windows\\System32\\spoolsv.exe',
        account: 'NT AUTHORITY\\SYSTEM', serviceType: 'WIN32_OWN_PROCESS' } as any);

    // Task scheduler
    svc('Schedule', 'Task Scheduler', 'Enables a user to configure and schedule automated tasks',
      { dependencies: ['RpcSs'], account: 'NT AUTHORITY\\SYSTEM' });

    // OpenSSH SSH Server — inbound `ssh` / SFTP transport on port 22.
    svc('sshd', 'OpenSSH SSH Server',
      'SSH protocol based service to provide secure encrypted communications between two untrusted hosts over an insecure network.',
      {
        dependencies: ['RpcSs'], processName: 'sshd.exe',
        binaryPath: 'C:\\Windows\\System32\\OpenSSH\\sshd.exe',
        account: 'NT AUTHORITY\\SYSTEM', serviceType: 'WIN32_OWN_PROCESS',
      } as any);

    // Audio
    svc('AudioSrv', 'Windows Audio', 'Manages audio for Windows-based programs',
      { dependencies: ['RpcSs'], account: 'NT AUTHORITY\\LocalService' });

    // Themes
    svc('Themes', 'Themes', 'Provides user experience theme management',
      { account: 'NT AUTHORITY\\SYSTEM' });

    // Update Spooler binaryPath (overriding svchost default)
    const spooler = this.services.get('spooler');
    if (spooler) spooler.binaryPath = 'C:\\Windows\\System32\\spoolsv.exe';
  }

  // ─── Queries ─────────────────────────────────────────────────────

  getService(name: string): WindowsService | undefined {
    return this.services.get(name.toLowerCase());
  }

  getAllServices(): WindowsService[] {
    return [...this.services.values()];
  }

  getRunningServices(): WindowsService[] {
    return this.getAllServices().filter(s => s.state === 'Running');
  }

  /** Get services that depend on the given service */
  getDependents(serviceName: string): WindowsService[] {
    const lower = serviceName.toLowerCase();
    return this.getAllServices().filter(s =>
      s.dependencies.some(d => d.toLowerCase() === lower)
    );
  }

  /** Get running dependents (blocks stop) */
  getRunningDependents(serviceName: string): WindowsService[] {
    return this.getDependents(serviceName).filter(s => s.state !== 'Stopped');
  }

  /**
   * Full transitive closure of services that depend on the given service,
   * directly or through another dependent — what `services.msc`'s
   * "Dependencies" tab and `sc enumdepend` show, and what `DependentServices`
   * on a real `Get-Service` result reports.
   */
  getAllDependents(serviceName: string): WindowsService[] {
    const seen = new Set<string>();
    const out: WindowsService[] = [];
    const queue = [serviceName];
    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const dep of this.getDependents(current)) {
        const key = dep.name.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(dep);
        queue.push(dep.name);
      }
    }
    return out;
  }

  /** Get all hosted service names for a given process name */
  getServicesForProcess(processName: string): string[] {
    const lower = processName.toLowerCase();
    return this.getAllServices()
      .filter(s => s.processName.toLowerCase() === lower && s.state === 'Running')
      .map(s => s.name);
  }

  // ─── State Transitions ──────────────────────────────────────────

  startService(name: string, isAdmin: boolean): string {
    if (!isAdmin) return 'Access is denied.';
    const svc = this.services.get(name.toLowerCase());
    if (!svc) return `The specified service does not exist. [SC] OpenService FAILED 1060.`;
    if (svc.state === 'Running') return `An instance of the service is already running.`;
    if (svc.startType === 'Disabled') return `The service cannot be started because it is disabled.`;
    const prev = svc.state;
    svc.state = 'Running';
    this.publishServiceState(svc, true);
    this.notifyWatchers(svc, prev);
    return '';
  }

  stopService(name: string, isAdmin: boolean): string {
    if (!isAdmin) return 'Access is denied.';
    const svc = this.services.get(name.toLowerCase());
    if (!svc) return `The specified service does not exist. [SC] OpenService FAILED 1060.`;
    if (svc.critical) return `Cannot stop ${svc.name}: This is a critical system service.`;
    if (svc.state === 'Stopped') return `The service has not been started.`;

    // Check running dependents
    const deps = this.getRunningDependents(svc.name);
    if (deps.length > 0) {
      const depNames = deps.map(d => d.displayName).join(', ');
      return `Cannot stop ${svc.displayName} because dependent services are running: ${depNames}.`;
    }

    const prev = svc.state;
    svc.state = 'Stopped';
    this.publishServiceState(svc, false);
    this.notifyWatchers(svc, prev);
    return '';
  }

  /**
   * `Stop-Service -Force` / `Restart-Service -Force` semantics: stop every
   * running dependent first (deepest dependents before their prerequisites),
   * then the target itself — the exact reverse of Windows' start order.
   * `onStopped` lets the caller keep a co-owned view (process table, ports)
   * coherent with each individual stop as it happens, in order.
   */
  stopServiceCascade(name: string, isAdmin: boolean, onStopped?: (svc: WindowsService) => void): string {
    if (!isAdmin) return 'Access is denied.';
    const svc = this.services.get(name.toLowerCase());
    if (!svc) return `The specified service does not exist. [SC] OpenService FAILED 1060.`;
    for (const dep of this.getRunningDependents(svc.name)) {
      this.stopServiceCascade(dep.name, isAdmin, onStopped);
    }
    const msg = this.stopService(name, isAdmin);
    if (!msg) onStopped?.(svc);
    return msg;
  }

  // ─── Recovery actions (`sc failure` / crash detection) ───────────

  setFailureConfig(name: string, config: FailureActionsConfig, isAdmin: boolean): string {
    if (!isAdmin) return 'Access is denied.';
    const svc = this.services.get(name.toLowerCase());
    if (!svc) return `The specified service does not exist.`;
    this.failureConfigs.set(name.toLowerCase(), config);
    return '';
  }

  getFailureConfig(name: string): FailureActionsConfig | undefined {
    return this.failureConfigs.get(name.toLowerCase());
  }

  getFailureCount(name: string): number {
    return this.failureState.get(name.toLowerCase())?.count ?? 0;
  }

  /**
   * The service's hosting process died out from under it — a crash, not a
   * graceful `Stop-Service`. Bumps the failure rank (resetting it first if
   * more than `resetPeriodSec` elapsed since the last failure), fires the
   * 7034 "unexpectedly terminated" notification, and schedules whichever
   * recovery tier that rank selects (clamped to the last configured tier).
   */
  recordCrash(name: string, nowMs: number): void {
    const key = name.toLowerCase();
    const svc = this.services.get(key);
    if (!svc) return;
    const prev = svc.state;
    svc.state = 'Stopped';
    this.notifyWatchers(svc, prev);

    const cfg = this.failureConfigs.get(key);
    const resetMs = (cfg?.resetPeriodSec ?? 0) * 1000;
    const prior = this.failureState.get(key);
    const withinWindow = !!prior && resetMs > 0 && (nowMs - prior.lastFailureAtMs) <= resetMs;
    const count = withinWindow ? prior!.count + 1 : 1;
    this.failureState.set(key, { count, lastFailureAtMs: nowMs });

    this.bus?.publish({
      topic: 'windows.service.crashed',
      payload: { deviceId: this.deviceId, serviceName: svc.name, displayName: svc.displayName, failureCount: count },
    });

    if (!cfg || cfg.actions.length === 0) return;
    const action = cfg.actions[Math.min(count - 1, cfg.actions.length - 1)];
    if (!action || action.type === 'none') return;
    this.pendingRecoveries.push({
      serviceName: svc.name, dueAtMs: nowMs + action.delayMs, rank: count, action, command: cfg.command,
    });
  }

  /**
   * Run whichever recovery tiers have come due, per the device's simulated
   * clock. `onRestarted` lets the caller re-spawn the hosting process (the
   * original one is long gone — it's what crashed), keeping Get-Process/
   * `sc queryex` coherent with the newly-running service.
   */
  advanceRecoveryTimers(nowMs: number, onRestarted?: (svc: WindowsService) => void): void {
    const due = this.pendingRecoveries.filter(r => r.dueAtMs <= nowMs);
    if (due.length === 0) return;
    this.pendingRecoveries = this.pendingRecoveries.filter(r => r.dueAtMs > nowMs);
    for (const r of due) {
      const svc = this.services.get(r.serviceName.toLowerCase());
      if (!svc) continue;
      if (r.action.type === 'restart') {
        const prev = svc.state;
        svc.state = 'Running';
        this.publishServiceState(svc, true);
        this.notifyWatchers(svc, prev);
        onRestarted?.(svc);
      } else if (r.action.type === 'run') {
        this.bus?.publish({
          topic: 'windows.service.recovery-run',
          payload: { deviceId: this.deviceId, serviceName: svc.name, command: r.command ?? '', rank: r.rank },
        });
      } else if (r.action.type === 'reboot') {
        this.bus?.publish({
          topic: 'windows.service.recovery-critical',
          payload: { deviceId: this.deviceId, serviceName: svc.name, displayName: svc.displayName, rank: r.rank },
        });
      }
    }
  }

  // ─── WMI instance watchers (`Register-WmiEvent` primitive) ───────

  /** Subscribe to state transitions of one service. Returns a subscription id. */
  registerInstanceWatcher(serviceName: string, cb: ServiceInstanceWatcher): string {
    const id = `wmi-${++this.watcherSeq}`;
    this.instanceWatchers.set(id, { serviceName: serviceName.toLowerCase(), cb });
    return id;
  }

  unregisterInstanceWatcher(id: string): void {
    this.instanceWatchers.delete(id);
  }

  private notifyWatchers(svc: WindowsService, previousState: ServiceState): void {
    if (previousState === svc.state) return;
    for (const w of this.instanceWatchers.values()) {
      if (w.serviceName !== svc.name.toLowerCase()) continue;
      w.cb({ previousState, newState: svc.state, timestamp: new Date() });
    }
  }

  pauseService(name: string, isAdmin: boolean): string {
    if (!isAdmin) return 'Access is denied.';
    const svc = this.services.get(name.toLowerCase());
    if (!svc) return `The specified service does not exist.`;
    if (!svc.canPauseAndContinue) return `Service '${svc.displayName}' cannot be paused.`;
    if (svc.state !== 'Running') return `The service is not running.`;
    svc.state = 'Paused';
    return '';
  }

  resumeService(name: string, isAdmin: boolean): string {
    if (!isAdmin) return 'Access is denied.';
    const svc = this.services.get(name.toLowerCase());
    if (!svc) return `The specified service does not exist.`;
    if (svc.state !== 'Paused') return `The service is not paused.`;
    svc.state = 'Running';
    return '';
  }

  // ─── Configuration ──────────────────────────────────────────────

  setStartType(name: string, startType: ServiceStartType, isAdmin: boolean): string {
    if (!isAdmin) return 'Access is denied.';
    const svc = this.services.get(name.toLowerCase());
    if (!svc) return `The specified service does not exist.`;
    svc.startType = startType;
    return '';
  }

  setDependencies(name: string, dependencies: string[], isAdmin: boolean): string {
    if (!isAdmin) return 'Access is denied.';
    const svc = this.services.get(name.toLowerCase());
    if (!svc) return `The specified service does not exist.`;
    svc.dependencies = dependencies;
    return '';
  }

  setDisplayName(name: string, displayName: string, isAdmin: boolean): string {
    if (!isAdmin) return 'Access is denied.';
    const svc = this.services.get(name.toLowerCase());
    if (!svc) return `The specified service does not exist.`;
    svc.displayName = displayName;
    return '';
  }

  setDescription(name: string, description: string, isAdmin: boolean): string {
    if (!isAdmin) return 'Access is denied.';
    const svc = this.services.get(name.toLowerCase());
    if (!svc) return `The specified service does not exist.`;
    svc.description = description;
    return '';
  }

  /**
   * `sc config <name> obj= "<account>"` — changes the service's logon
   * account. Announces the change (with the previous value and who made it)
   * so the registry-sync projection and the security-audit trail (4657)
   * stay coherent with the live service state.
   */
  setAccount(name: string, account: string, isAdmin: boolean, changedBy: string): string {
    if (!isAdmin) return 'Access is denied.';
    const svc = this.services.get(name.toLowerCase());
    if (!svc) return `The specified service does not exist.`;
    const previousAccount = svc.account;
    svc.account = account;
    this.bus?.publish({
      topic: 'windows.service.account-changed',
      payload: {
        deviceId: this.deviceId, serviceName: svc.name, displayName: svc.displayName,
        previousAccount, newAccount: account, changedBy,
      },
    });
    return '';
  }

  // ─── Create / Delete ────────────────────────────────────────────

  createService(name: string, opts: {
    binaryPath: string; displayName?: string; description?: string;
    startType?: ServiceStartType; account?: string; dependencies?: string[];
  }, isAdmin: boolean): string {
    if (!isAdmin) return 'Access is denied.';
    if (this.services.has(name.toLowerCase())) return `The specified service already exists.`;
    this.services.set(name.toLowerCase(), {
      name,
      displayName: opts.displayName ?? name,
      description: opts.description ?? '',
      state: 'Stopped',
      startType: opts.startType ?? 'Manual',
      serviceType: 'WIN32_OWN_PROCESS',
      binaryPath: opts.binaryPath,
      account: opts.account ?? 'NT AUTHORITY\\SYSTEM',
      dependencies: opts.dependencies ?? [],
      canPauseAndContinue: false,
      acceptsShutdown: false,
      processName: name.toLowerCase() + '.exe',
      builtIn: false,
    });
    return '';
  }

  deleteService(name: string, isAdmin: boolean): string {
    if (!isAdmin) return 'Access is denied.';
    const svc = this.services.get(name.toLowerCase());
    if (!svc) return `The specified service does not exist.`;
    if (svc.builtIn) return `Cannot delete built-in service '${svc.name}'.`;
    if (svc.state === 'Running') return `The service must be stopped before deleting.`;
    this.services.delete(name.toLowerCase());
    return '';
  }

  // ─── Formatting helpers for sc command ──────────────────────────

  /** Build the flags line like (STOPPABLE, NOT_PAUSABLE, ACCEPTS_SHUTDOWN) */
  private formatStateFlags(svc: WindowsService): string {
    const isActive = svc.state === 'Running' || svc.state === 'Paused'
      || svc.state === 'StopPending';

    const stoppable = isActive ? 'STOPPABLE' : 'NOT_STOPPABLE';
    const pausable = (isActive && svc.canPauseAndContinue) ? 'PAUSABLE' : 'NOT_PAUSABLE';
    const shutdown = (isActive && svc.acceptsShutdown) ? 'ACCEPTS_SHUTDOWN' : 'IGNORES_SHUTDOWN';

    return `(${stoppable}, ${pausable}, ${shutdown})`;
  }

  /** Format the service status block shared by query, queryex, start, stop */
  formatServiceStatus(svc: WindowsService, opts?: { waitHint?: number }): string {
    const typeCode = TYPE_CODES[svc.serviceType] ?? 20;
    const stateCode = STATE_CODES[svc.state] ?? 1;
    const stateName = STATE_NAMES[svc.state] ?? svc.state.toUpperCase();
    const flags = this.formatStateFlags(svc);
    const waitHint = opts?.waitHint ?? 0;

    return [
      '',
      `SERVICE_NAME: ${svc.name}`,
      `        TYPE               : ${typeCode}  ${svc.serviceType}`,
      `        STATE              : ${stateCode}  ${stateName}`,
      `                                ${flags}`,
      `        WIN32_EXIT_CODE    : 0  (0x0)`,
      `        SERVICE_EXIT_CODE  : 0  (0x0)`,
      `        CHECKPOINT         : 0x0`,
      `        WAIT_HINT          : 0x${waitHint.toString(16)}`,
    ].join('\n');
  }

  formatScQuery(svc: WindowsService): string {
    return this.formatServiceStatus(svc);
  }

  formatScQueryEx(svc: WindowsService, pid: number): string {
    const base = this.formatServiceStatus(svc);
    return base + '\n' +
      `        PID                : ${pid}\n` +
      `        FLAGS              :`;
  }

  formatScQc(svc: WindowsService): string {
    const startTypeCode = START_TYPE_CODES[svc.startType] ?? 3;
    const startTypeName = START_TYPE_NAMES[svc.startType] ?? svc.startType;

    const lines = [
      `[SC] QueryServiceConfig SUCCESS`,
      '',
      `SERVICE_NAME: ${svc.name}`,
      `        TYPE               : ${TYPE_CODES[svc.serviceType] ?? 20}  ${svc.serviceType}`,
      `        START_TYPE         : ${startTypeCode}   ${startTypeName}`,
      `        ERROR_CONTROL      : 1   NORMAL`,
      `        BINARY_PATH_NAME   : ${svc.binaryPath}`,
      `        LOAD_ORDER_GROUP   :`,
      `        TAG                : 0`,
      `        DISPLAY_NAME       : ${svc.displayName}`,
    ];

    // Dependencies: one per line with aligned colons
    if (svc.dependencies.length === 0) {
      lines.push(`        DEPENDENCIES       :`);
    } else {
      lines.push(`        DEPENDENCIES       : ${svc.dependencies[0]}`);
      for (let i = 1; i < svc.dependencies.length; i++) {
        lines.push(`                           : ${svc.dependencies[i]}`);
      }
    }

    lines.push(`        SERVICE_START_NAME : ${svc.account || 'LocalSystem'}`);

    return lines.join('\n');
  }

  formatScDescription(svc: WindowsService): string {
    return [
      `[SC] QueryServiceConfig2 SUCCESS`,
      '',
      `SERVICE_NAME: ${svc.name}`,
      `DESCRIPTION:  ${svc.description}`,
    ].join('\n');
  }

  formatScQfailure(svc: WindowsService): string {
    const cfg = this.failureConfigs.get(svc.name.toLowerCase());
    const actionLabel = (a: RecoveryAction): string => {
      switch (a.type) {
        case 'restart': return 'RESTART';
        case 'run':     return 'RUN PROCESS';
        case 'reboot':  return 'REBOOT';
        default:        return 'NONE';
      }
    };
    const lines = [
      `[SC] QueryServiceConfig2 SUCCESS`,
      '',
      `SERVICE_NAME: ${svc.name}`,
      '',
      `        RESET_PERIOD (in seconds)    : ${cfg?.resetPeriodSec ?? 0}`,
      `        REBOOT_MESSAGE               :`,
      `        COMMAND_LINE                 : ${cfg?.command ?? ''}`,
    ];
    if (!cfg || cfg.actions.length === 0) {
      lines.push(`        FAILURE_ACTIONS              : NONE`);
    } else {
      lines.push(`        FAILURE_ACTIONS              : ${actionLabel(cfg.actions[0])} -- Delay = ${cfg.actions[0].delayMs} milliseconds.`);
      for (let i = 1; i < cfg.actions.length; i++) {
        lines.push(`                                       ${actionLabel(cfg.actions[i])} -- Delay = ${cfg.actions[i].delayMs} milliseconds.`);
      }
    }
    return lines.join('\n');
  }
}
