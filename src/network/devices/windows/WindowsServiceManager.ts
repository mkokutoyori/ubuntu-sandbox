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

export type ServiceState =
  | 'Running' | 'Stopped' | 'Paused'
  | 'StartPending' | 'StopPending'
  | 'PausePending' | 'ContinuePending';

export type ServiceStartType =
  | 'Automatic' | 'AutomaticDelayedStart' | 'Manual' | 'Disabled'
  | 'Boot' | 'System';

export type ServiceType = 'WIN32_OWN_PROCESS' | 'WIN32_SHARE_PROCESS' | 'KERNEL_DRIVER';

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
const START_TYPE_CODES: Record<ServiceStartType, number> = {
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

  constructor() {
    this.initDefaults();
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
    svc.state = 'Running';
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

    svc.state = 'Stopped';
    return '';
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

  // ─── Create / Delete ────────────────────────────────────────────

  createService(name: string, opts: {
    binaryPath: string; displayName?: string; description?: string;
    startType?: ServiceStartType; account?: string;
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
      dependencies: [],
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
    return [
      `[SC] QueryServiceConfig2 SUCCESS`,
      '',
      `SERVICE_NAME: ${svc.name}`,
      '',
      `        RESET_PERIOD (in seconds)    : 86400`,
      `        REBOOT_MESSAGE               :`,
      `        COMMAND_LINE                  :`,
      `        FAILURE_ACTIONS              : RESTART -- Delay = 120000 milliseconds.`,
      `                                       RESTART -- Delay = 300000 milliseconds.`,
      `                                       NONE    -- Delay = 0 milliseconds.`,
    ].join('\n');
  }
}
