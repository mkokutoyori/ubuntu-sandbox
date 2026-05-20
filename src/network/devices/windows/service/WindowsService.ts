/**
 * WindowsService — Windows-flavoured {@link OSService}.
 *
 * Promotes the flat `WindowsService` record (binaryPath, account,
 * dependencies, processName, critical) into the cross-OS hierarchy
 * without breaking on-the-wire shape. SC.exe / Get-Service / net start
 * formatters keep working because all original fields stay enumerable.
 *
 * Inherits OSService's richer surface (conditions, recovery actions,
 * watchdog, resource control) so future Phase F gates and feature
 * growth plug in directly.
 */

import { OSService } from '../../os/OSService';
import type {
  WindowsService as WindowsServiceRecord,
  ServiceState as WinServiceState,
  ServiceStartType as WinStartType,
  ServiceType as WinServiceType,
} from '../WindowsServiceManager';

function winStateToOs(s: WinServiceState): 'inactive' | 'activating' | 'active' | 'deactivating' | 'failed' {
  switch (s) {
    case 'Running':         return 'active';
    case 'StartPending':    return 'activating';
    case 'StopPending':
    case 'PausePending':
    case 'ContinuePending': return 'deactivating';
    case 'Paused':          return 'active'; // paused still "alive"
    case 'Stopped':
    default:                return 'inactive';
  }
}

function winStartTypeToOs(s: WinStartType): 'automatic' | 'manual' | 'disabled' | 'delayed-auto' | 'triggered' {
  switch (s) {
    case 'Automatic':              return 'automatic';
    case 'AutomaticDelayedStart':  return 'delayed-auto';
    case 'Manual':                 return 'manual';
    case 'Disabled':               return 'disabled';
    case 'Boot':
    case 'System':                 return 'automatic';
  }
}

export class WindowsService extends OSService implements WindowsServiceRecord {
  // ─── Windows-flavoured SCM surface ──────────────────────────────────
  declare displayName: string;
  declare description: string;
  startType: WinStartType;
  serviceType: WinServiceType;
  binaryPath: string;
  account: string;
  dependencies: string[];
  declare canPauseAndContinue: boolean;
  acceptsShutdown: boolean;
  processName: string;
  builtIn: boolean;
  critical?: boolean;
  /** Windows-specific state (Running / Stopped / Paused / pending). */
  declare state: WinServiceState;

  // ─── richer attributes a real Windows OS exposes ────────────────────
  /** Registry path under HKLM\SYSTEM\CurrentControlSet\Services. */
  registryPath: string;
  /** Error-control level: 0=Ignore, 1=Normal, 2=Severe, 3=Critical. */
  errorControl: 0 | 1 | 2 | 3 = 1;
  /** Failure-recovery cmdline run after the configured restarts. */
  failureCommand?: string;
  /** Optional service SID type: None | Unrestricted | Restricted. */
  declare sidType?: string;

  constructor(init: WindowsServiceRecord) {
    super({
      name: init.name,
      displayName: init.displayName,
      description: init.description,
      execStart: init.binaryPath,
      user: init.account,
      group: init.account,
      state: winStateToOs(init.state),
      startType: winStartTypeToOs(init.startType),
      dependsOn: [...init.dependencies],
      configFiles: [`HKLM\\SYSTEM\\CurrentControlSet\\Services\\${init.name}`],
    });
    this.state = init.state;
    this.startType = init.startType;
    this.serviceType = init.serviceType;
    this.binaryPath = init.binaryPath;
    this.account = init.account;
    this.dependencies = [...init.dependencies];
    this.canPauseAndContinue = init.canPauseAndContinue;
    this.acceptsShutdown = init.acceptsShutdown;
    this.processName = init.processName;
    this.builtIn = init.builtIn;
    this.critical = init.critical;
    this.serviceTypeWin = init.serviceType;
    this.registryPath = `HKLM\\SYSTEM\\CurrentControlSet\\Services\\${init.name}`;
  }

  // ─── queries ────────────────────────────────────────────────────────

  isRunning(): boolean { return this.state === 'Running'; }
  isStopped(): boolean { return this.state === 'Stopped'; }
  isPaused(): boolean { return this.state === 'Paused'; }
  isPending(): boolean {
    return this.state === 'StartPending' || this.state === 'StopPending'
        || this.state === 'PausePending' || this.state === 'ContinuePending';
  }
  isBuiltIn(): boolean { return this.builtIn; }
  isCritical(): boolean { return this.critical === true; }
  canBeStopped(): boolean { return !this.isCritical() && this.acceptsShutdown; }
  hasDependency(name: string): boolean {
    return this.dependencies.some(d => d.toLowerCase() === name.toLowerCase());
  }

  // ─── mutations ──────────────────────────────────────────────────────

  transitionTo(state: WinServiceState): void {
    this.state = state;
  }
  changeStartType(t: WinStartType): void {
    this.startType = t;
  }

  // Override the base queries to read the Windows-flavoured state field
  // (we override the `state` slot itself via the `declare` redeclaration).
  override isActive(): boolean {
    return this.state === 'Running' || this.state === 'Paused';
  }
  override isInactive(): boolean { return this.state === 'Stopped'; }
  override isFailed(): boolean { return false; }
  override canStart(): boolean { return this.startType !== 'Disabled'; }

  /** Flat WindowsServiceRecord-shape snapshot for sc.exe / Get-Service. */
  snapshot(): WindowsServiceRecord {
    return {
      name: this.name, displayName: this.displayName, description: this.description,
      state: this.state, startType: this.startType, serviceType: this.serviceType,
      binaryPath: this.binaryPath, account: this.account,
      dependencies: [...this.dependencies],
      canPauseAndContinue: this.canPauseAndContinue,
      acceptsShutdown: this.acceptsShutdown,
      processName: this.processName, builtIn: this.builtIn, critical: this.critical,
    };
  }
}
