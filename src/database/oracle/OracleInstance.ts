/**
 * OracleInstance — Simulates an Oracle database instance.
 *
 * Manages instance state (SHUTDOWN → NOMOUNT → MOUNT → OPEN),
 * background processes, SGA/PGA parameters, and redo log groups.
 */

import type { OracleDatabaseConfig } from '../engine/types/DatabaseConfig';
import { defaultOracleConfig } from '../engine/types/DatabaseConfig';
import { ORACLE_CONFIG, ORACLE_ERRORS, TNS_ERRORS } from '../../terminal/commands/OracleConfig';
import { getDefaultEventBus, type IEventBus } from '@/events/EventBus';
import {
  OracleSignalStore,
  makeReadonlyOracleObservables,
  type OracleObservables,
} from './observables';
import { OracleSignalRefreshActor } from './actors/OracleSignalRefreshActor';
import { OracleRuntimeState } from './views/OracleRuntimeState';
import { OracleRuntimeStateActor } from './actors/OracleRuntimeStateActor';
import { AsmManager } from './asm/AsmManager';
import { AuditJournal } from './security/audit/AuditJournal';
import { SecurityAuditActor } from './security/audit/SecurityAuditActor';
import { NetworkAclManager } from './security/NetworkAclManager';
import { DataRedactionManager } from './security/DataRedactionManager';
import { IndexUsageMonitor } from './metadata/IndexUsageMonitor';
import { TypeRegistry } from './metadata/TypeRegistry';
import { ExternalTableRegistry } from './metadata/ExternalTableRegistry';
import { UserActivityTracker } from './security/audit/UserActivityTracker';
import { SystemTriggerRegistry } from './triggers/SystemTriggerRegistry';
import { SystemTriggerExecutor } from './triggers/SystemTriggerExecutor';
import { WaitEventEngine } from './wait/WaitEventEngine';
import { ResourceManager } from './resource/ResourceManager';
import { AwrSnapshotManager } from './awr/AwrSnapshotManager';
import type { OracleStorage } from './OracleStorage';

export type InstanceState = 'SHUTDOWN' | 'NOMOUNT' | 'MOUNT' | 'OPEN';

export interface BackgroundProcess {
  name: string;
  pid: number;
  description: string;
}

export interface RedoLogGroup {
  group: number;
  status: 'CURRENT' | 'ACTIVE' | 'INACTIVE' | 'UNUSED';
  members: string[];
  sizeBytes: number;
  sequence: number;
}

export interface SGAInfo {
  totalSize: string;
  sharedPool: string;
  bufferCache: string;
  redoLogBuffer: string;
  javaPool: string;
  largePool: string;
}

export class OracleInstance {
  readonly config: OracleDatabaseConfig;
  private _state: InstanceState = 'SHUTDOWN';
  private _startupTime: Date | null = null;
  private _backgroundProcesses: BackgroundProcess[] = [];
  private _redoLogGroups: RedoLogGroup[] = [];
  private _currentRedoGroup: number = 1;
  private _redoSequence: number = 1;
  private _alertLog: string[] = [];
  private _parameters: Map<string, string> = new Map();
  private _archiveLogMode: boolean;
  private _pidCounter: number = 1000;

  // ── Reactive (Phase 7) ───────────────────────────────────────────
  /** Bus override; defaults to the global singleton at publish time. */
  private _bus: IEventBus | null = null;
  /** deviceId scoping the events emitted by this instance. */
  private _deviceId: string = 'default';
  /** Reactive signal store + read-only view exposed to UI consumers. */
  private readonly _signalStore = new OracleSignalStore();
  readonly observables: OracleObservables = makeReadonlyOracleObservables(this._signalStore);
  /** Refresh actor bridging oracle.* events → signal store. (Re-)attached
   *  whenever the bus or deviceId changes. */
  private _refreshActor: OracleSignalRefreshActor | null = null;
  /** Runtime state feeding the dynamic V$/GV$ views, maintained by an
   *  event-driven actor. Exposed via `getRuntimeState()` so the catalog
   *  can hand it to view files at query time. */
  private readonly _runtimeState = new OracleRuntimeState();
  private _runtimeStateActor: OracleRuntimeStateActor | null = null;
  /** Real ASM machinery — empty by default; CREATE DISKGROUP populates it. */
  readonly asm: AsmManager = new AsmManager();
  /** Security audit journal — fed by the SecurityAuditActor on bus events.
   *  Surfaces forensic data through the DBA_* security views. */
  private readonly _auditJournal = new AuditJournal();
  private _securityAuditActor: SecurityAuditActor | null = null;
  private _userActivity: UserActivityTracker | null = null;
  /** Database-level event-trigger catalogue + executor. */
  readonly systemTriggers = new SystemTriggerRegistry();
  private _systemTriggerExecutor: SystemTriggerExecutor | null = null;
  /** Wait-event engine — feeds V$SESSION_EVENT / V$SYSTEM_EVENT / V$EVENT_HISTOGRAM. */
  private _waitEngine: WaitEventEngine | null = null;
  /** Resource Manager — plans, consumer groups, mappings, directives. */
  readonly resourceManager = new ResourceManager();
  /** AWR snapshot manager — DBA_HIST_SNAPSHOT and friends. */
  readonly awrManager = new AwrSnapshotManager(this);
  /** Network ACL administration (DBMS_NETWORK_ACL_ADMIN). */
  readonly networkAcls = new NetworkAclManager();
  /** Data Redaction policies (DBMS_REDACT). */
  readonly redaction = new DataRedactionManager();
  /** Oracle object-type catalogue (DBA_TYPES / DBA_TYPE_ATTRS / DBA_COLL_TYPES). */
  readonly types = new TypeRegistry();
  /** External-table catalogue (DBA_EXTERNAL_TABLES / DBA_EXTERNAL_LOCATIONS). */
  readonly externalTables = new ExternalTableRegistry();
  /** Index usage monitor (ALTER INDEX … MONITORING USAGE) — attached
   *  to storage by OracleDatabase once it's available. The reference
   *  to storage is captured so we can rebuild the monitor whenever
   *  the bus or deviceId changes. */
  private _indexUsage: IndexUsageMonitor | null = null;
  private _indexUsageStorage: OracleStorage | null = null;
  attachIndexUsageMonitor(storage: OracleStorage): IndexUsageMonitor {
    this._indexUsageStorage = storage;
    if (this._indexUsage) this._indexUsage.stop();
    this._indexUsage = new IndexUsageMonitor(this.getBus(), this._deviceId, storage);
    this._indexUsage.start();
    return this._indexUsage;
  }
  getIndexUsageMonitor(): IndexUsageMonitor | null { return this._indexUsage; }

  constructor(config?: Partial<OracleDatabaseConfig>) {
    this.config = { ...defaultOracleConfig(), ...config };
    this._archiveLogMode = this.config.archiveLogMode;
    this.initParameters();
    this.initRedoLogs();
    // Attach the signal refresh actor immediately so observables work
    // even when no explicit setEventBus/setDeviceId is called.
    this.reattachRefreshActor();
  }

  /** Inject (or replace) the bus this instance publishes to. */
  setEventBus(bus: IEventBus | null): void {
    this._bus = bus;
    this.reattachRefreshActor();
  }

  /**
   * Provider returning every currently-open OracleSession. Set by
   * OracleDatabase so views (V$SESSION_CONTEXT) can read live
   * per-session state without OracleInstance importing OracleSession.
   */
  private _liveSessionProvider: (() => Array<{
    sid: number; serial: number; username: string;
    listContextEntries(): Array<{ namespace: string; attribute: string; value: string }>;
    module: string | null; action: string | null;
    clientInfo: string | null; clientIdentifier: string | null;
  }>) | null = null;
  setLiveSessionProvider(fn: NonNullable<typeof this._liveSessionProvider>): void {
    this._liveSessionProvider = fn;
  }
  getLiveSessions(): ReturnType<NonNullable<typeof this._liveSessionProvider>> {
    return this._liveSessionProvider?.() ?? [];
  }
  /** Set the deviceId scoping all `oracle.*` events from this instance. */
  setDeviceId(deviceId: string): void {
    this._deviceId = deviceId;
    this.reattachRefreshActor();
  }

  /** (Re-)bind the refresh actor whenever bus / deviceId is updated. */
  private reattachRefreshActor(): void {
    if (this._refreshActor) {
      this._refreshActor.stop();
      this._refreshActor = null;
    }
    if (this._runtimeStateActor) {
      this._runtimeStateActor.stop();
      this._runtimeStateActor = null;
    }
    if (this._securityAuditActor) {
      this._securityAuditActor.stop();
      this._securityAuditActor = null;
    }
    if (this._userActivity) {
      this._userActivity.stop();
      this._userActivity = null;
    }
    if (this._systemTriggerExecutor) {
      this._systemTriggerExecutor.stop();
      this._systemTriggerExecutor = null;
    }
    if (this._waitEngine) {
      this._waitEngine.stop();
      this._waitEngine = null;
    }
    this._refreshActor = new OracleSignalRefreshActor(this.getBus(), this._deviceId, this._signalStore);
    this._refreshActor.start();
    this._runtimeStateActor = new OracleRuntimeStateActor(this.getBus(), this._deviceId, this._runtimeState);
    this._runtimeStateActor.start();
    this._securityAuditActor = new SecurityAuditActor(this.getBus(), this._deviceId, this._auditJournal);
    this._securityAuditActor.start();
    this._userActivity = new UserActivityTracker(this.getBus(), this._deviceId, this._auditJournal);
    this._userActivity.start();
    this._systemTriggerExecutor = new SystemTriggerExecutor(
      this.getBus(), this._deviceId, this.systemTriggers, this);
    this._systemTriggerExecutor.start();
    this._waitEngine = new WaitEventEngine(this.getBus(), this._deviceId);
    this._waitEngine.start();
    // Reattach the index usage monitor with the current bus/deviceId so
    // its subscription tracks the same scoping the other actors use.
    if (this._indexUsageStorage) {
      if (this._indexUsage) this._indexUsage.stop();
      this._indexUsage = new IndexUsageMonitor(this.getBus(), this._deviceId, this._indexUsageStorage);
      this._indexUsage.start();
    }
  }

  /** Read-only handle to the security audit journal. */
  getAuditJournal(): AuditJournal { return this._auditJournal; }
  /** The actor wires bus → journal; exposed so external evaluators reuse it. */
  getSecurityAuditActor(): SecurityAuditActor | null { return this._securityAuditActor; }
  /** Per-user activity ledger (reactive). */
  getUserActivityTracker(): UserActivityTracker | null { return this._userActivity; }
  /** Database-level trigger executor (reactive). */
  getSystemTriggerExecutor(): SystemTriggerExecutor | null { return this._systemTriggerExecutor; }
  /** Wait-event engine (reactive). */
  getWaitEngine(): WaitEventEngine | null { return this._waitEngine; }

  /** Snapshot of the event-fed runtime state used by the V$/GV$ views. */
  getRuntimeState(): OracleRuntimeState { return this._runtimeState; }

  /** Public bus accessor — used by OracleExecutor / SQLPlusSession to
   *  reuse the same bus binding as the instance. */
  getBus(): IEventBus { return this._bus ?? getDefaultEventBus(); }
  /** Public deviceId accessor. */
  getDeviceId(): string { return this._deviceId; }
  private ref() { return { deviceId: this._deviceId, sid: this.config.sid }; }

  /** Centralised state transition — emits oracle.instance.state-changed. */
  private transitionTo(newState: InstanceState): void {
    const oldState = this._state;
    if (oldState === newState) return;
    this._state = newState;
    this.getBus().publish({
      topic: 'oracle.instance.state-changed',
      payload: { ...this.ref(), oldState, newState },
    });
  }

  // ── State management ─────────────────────────────────────────────

  get state(): InstanceState { return this._state; }
  get startupTime(): Date | null { return this._startupTime; }
  /** RESTRICTED SESSION mode (ALTER SYSTEM ENABLE RESTRICTED SESSION). */
  private _restrictedSession = false;
  get restrictedSession(): boolean { return this._restrictedSession; }
  setRestrictedSession(on: boolean): void { this._restrictedSession = on; }
  /** Monotonic counter feeding SYS_C00<n> auto-constraint / auto-index names. */
  private _sysConstraintCounter = 0;
  nextSysConstraintId(): number { return this._sysConstraintCounter++; }
  /** Whether a SHUTDOWN is in progress (no new logins). */
  private _shutdownPending = false;
  get shutdownPending(): boolean { return this._shutdownPending; }
  setShutdownPending(on: boolean): void { this._shutdownPending = on; }
  get isOpen(): boolean { return this._state === 'OPEN'; }

  startup(mode?: 'NOMOUNT' | 'MOUNT' | 'RESTRICT' | 'FORCE'): string[] {
    const output: string[] = [];
    const now = new Date();

    if (mode === 'FORCE' && this._state !== 'SHUTDOWN') {
      output.push(...this.shutdown('ABORT'));
    }

    if (this._state !== 'SHUTDOWN') {
      return [ORACLE_ERRORS.ORA_01081];
    }

    this._startupTime = now;
    this.logAlert(`Starting ORACLE instance (normal)`);
    output.push(`ORACLE instance started.`);
    output.push('');

    // NOMOUNT
    this.transitionTo('NOMOUNT');
    this.startBackgroundProcesses();
    output.push(`Total System Global Area  ${this.config.sgaTarget} bytes`);
    output.push(`Fixed Size                  2.0M bytes`);
    output.push(`Variable Size             256.0M bytes`);
    output.push(`Database Buffers          128.0M bytes`);
    output.push(`Redo Buffers               16.0M bytes`);

    if (mode === 'NOMOUNT') {
      this.logAlert('Instance started in NOMOUNT mode');
      return output;
    }

    // MOUNT
    this.transitionTo('MOUNT');
    output.push(`Database mounted.`);
    this.logAlert('Database mounted');

    if (mode === 'MOUNT') return output;

    // OPEN
    this.transitionTo('OPEN');
    this._redoLogGroups[0].status = 'CURRENT';
    output.push(`Database opened.`);
    this.logAlert('Database opened');
    this.getBus().publish({
      topic: 'oracle.service.event',
      payload: { ...this.ref(), name: this.config.sid, kind: 'started' },
    });
    this.getBus().publish({
      topic: 'oracle.service.event',
      payload: { ...this.ref(), name: 'SYS$USERS', kind: 'started' },
    });
    this.getBus().publish({
      topic: 'oracle.service.event',
      payload: { ...this.ref(), name: 'SYS$BACKGROUND', kind: 'started' },
    });

    if (mode === 'RESTRICT') {
      output.push('Database opened in restricted mode.');
      this.logAlert('Database opened in restricted mode');
    }

    return output;
  }

  shutdown(mode?: 'NORMAL' | 'IMMEDIATE' | 'TRANSACTIONAL' | 'ABORT'): string[] {
    const output: string[] = [];

    if (this._state === 'SHUTDOWN') {
      return [ORACLE_ERRORS.ORA_01034];
    }

    const effectiveMode = mode ?? 'NORMAL';
    this.logAlert(`Shutting down instance (${effectiveMode.toLowerCase()})`);

    if (this._state === 'OPEN') {
      output.push('Database closed.');
      this.logAlert('Database closed');
    }
    if (this._state === 'OPEN' || this._state === 'MOUNT') {
      output.push('Database dismounted.');
      this.logAlert('Database dismounted');
    }

    output.push('ORACLE instance shut down.');
    this.logAlert('Instance shut down');

    // Emit background-process-stopped for each running process BEFORE we
    // tear them down, so subscribers can clean up the device process table.
    for (const p of this._backgroundProcesses) {
      this.getBus().publish({
        topic: 'oracle.instance.background-process-stopped',
        payload: { ...this.ref(), name: p.name, pid: p.pid },
      });
    }
    this.transitionTo('SHUTDOWN');
    this._startupTime = null;
    this._backgroundProcesses = [];
    for (const rg of this._redoLogGroups) rg.status = 'UNUSED';

    return output;
  }

  // ── Background processes ──────────────────────────────────────────

  private startBackgroundProcesses(): void {
    const procs: [string, string][] = [
      ['PMON', 'Process Monitor'],
      ['SMON', 'System Monitor'],
      ['DBW0', 'Database Writer 0'],
      ['LGWR', 'Log Writer'],
      ['CKPT', 'Checkpoint'],
      ['RECO', 'Recovery'],
      ['MMON', 'Manageability Monitor'],
      ['MMNL', 'Manageability Monitor Light'],
    ];
    if (this._archiveLogMode) {
      procs.push(['ARC0', 'Archiver 0']);
    }
    this._backgroundProcesses = procs.map(([name, description]) => ({
      name, pid: this._pidCounter++, description,
    }));
    for (const p of this._backgroundProcesses) {
      this.getBus().publish({
        topic: 'oracle.instance.background-process-started',
        payload: { ...this.ref(), name: p.name, pid: p.pid, description: p.description },
      });
    }
  }

  getBackgroundProcesses(): BackgroundProcess[] {
    return [...this._backgroundProcesses];
  }

  // ── Redo logs ────────────────────────────────────────────────────

  private initRedoLogs(): void {
    const oradata = `${ORACLE_CONFIG.BASE}/oradata/${this.config.sid}`;
    this._redoLogGroups = [
      { group: 1, status: 'UNUSED', members: [`${oradata}/redo01.log`], sizeBytes: 52428800, sequence: 0 },
      { group: 2, status: 'UNUSED', members: [`${oradata}/redo02.log`], sizeBytes: 52428800, sequence: 0 },
      { group: 3, status: 'UNUSED', members: [`${oradata}/redo03.log`], sizeBytes: 52428800, sequence: 0 },
    ];
  }

  switchLogfile(): string {
    if (this._state !== 'OPEN') return ORACLE_ERRORS.ORA_01034;
    const currentGroup = this._redoLogGroups.find(g => g.status === 'CURRENT');
    if (currentGroup) {
      currentGroup.status = 'ACTIVE';
      currentGroup.sequence = this._redoSequence;
    }
    this._redoSequence++;
    const oldGroupNum = this._currentRedoGroup;
    this._currentRedoGroup = (this._currentRedoGroup % this._redoLogGroups.length) + 1;
    const nextGroup = this._redoLogGroups[this._currentRedoGroup - 1];
    nextGroup.status = 'CURRENT';
    nextGroup.sequence = this._redoSequence;
    this.logAlert(`Thread 1 advanced to log sequence ${this._redoSequence}`);
    this.getBus().publish({
      topic: 'oracle.instance.redo-log-switched',
      payload: {
        ...this.ref(),
        oldGroup: oldGroupNum,
        newGroup: this._currentRedoGroup,
        sequence: this._redoSequence,
      },
    });
    if (this._archiveLogMode) {
      const archivePath = `${ORACLE_CONFIG.BASE}/archivelog/1_${this._redoSequence - 1}_arc.arc`;
      this.getBus().publish({
        topic: 'oracle.archive-log.created',
        payload: { ...this.ref(), sequence: this._redoSequence - 1, path: archivePath },
      });
    }
    return `System altered.`;
  }

  getRedoLogGroups(): RedoLogGroup[] {
    return [...this._redoLogGroups];
  }

  // ── Parameters ───────────────────────────────────────────────────

  /** Tracks which parameters were explicitly changed via ALTER SYSTEM */
  private _modifiedParams: Set<string> = new Set();
  /** Tracks spfile-specific parameter overrides */
  private _spfileParams: Map<string, string> = new Map();

  private initParameters(): void {
    const p = this._parameters;
    const oradata = `${ORACLE_CONFIG.BASE}/oradata/${this.config.sid}`;

    // Core database identity
    p.set('db_name', this.config.sid);
    p.set('db_domain', 'localdomain');
    p.set('db_unique_name', this.config.sid);
    p.set('instance_name', this.config.sid);
    p.set('service_names', this.config.serviceName);

    // Memory
    p.set('db_block_size', String(this.config.dbBlockSize));
    p.set('db_cache_size', '128M');
    p.set('shared_pool_size', '256M');
    p.set('sga_target', this.config.sgaTarget);
    p.set('sga_max_size', '1G');
    p.set('pga_aggregate_target', this.config.pgaAggregateTarget);
    p.set('java_pool_size', '64M');
    p.set('large_pool_size', '32M');
    p.set('streams_pool_size', '0');
    p.set('memory_target', '0');
    p.set('memory_max_target', '0');

    // Processes & sessions
    p.set('processes', String(this.config.processes));
    p.set('sessions', String(this.config.maxSessions));
    p.set('open_cursors', String(this.config.openCursors));

    // Undo
    p.set('undo_management', this.config.undoManagement);
    p.set('undo_tablespace', this.config.undoTablespace);
    p.set('undo_retention', '900');

    // Redo & archiving
    p.set('log_archive_dest_1', `LOCATION=${ORACLE_CONFIG.BASE}/archivelog`);
    p.set('log_archive_format', 'arch_%t_%s_%r.arc');
    p.set('archive_log_mode', this._archiveLogMode ? 'ENABLED' : 'DISABLED');

    // Recovery
    p.set('db_recovery_file_dest', `${ORACLE_CONFIG.BASE}/fast_recovery_area`);
    p.set('db_recovery_file_dest_size', '4G');

    // Control files
    p.set('control_files', `${oradata}/control01.ctl, ${oradata}/control02.ctl`);

    // Audit
    p.set('audit_file_dest', `${ORACLE_CONFIG.BASE}/admin/${this.config.sid}/adump`);
    p.set('audit_trail', this.config.auditTrail);

    // Diagnostics
    p.set('diagnostic_dest', ORACLE_CONFIG.BASE);

    // Compatibility
    p.set('compatible', this.config.compatibleVersion);
    p.set('remote_login_passwordfile', 'EXCLUSIVE');

    // NLS
    p.set('nls_language', 'AMERICAN');
    p.set('nls_territory', 'AMERICA');
    p.set('nls_date_format', 'DD-MON-RR');
    p.set('nls_characterset', 'AL32UTF8');
    p.set('nls_nchar_characterset', 'AL16UTF16');

    // Optimizer
    p.set('optimizer_mode', 'ALL_ROWS');
    p.set('optimizer_index_cost_adj', '100');
    p.set('optimizer_index_caching', '0');
    p.set('cursor_sharing', 'EXACT');
    p.set('result_cache_max_size', '0');

    // Security
    p.set('sec_case_sensitive_logon', 'TRUE');
    p.set('os_authent_prefix', 'ops$');

    // Networking & dispatchers
    p.set('local_listener', `(ADDRESS=(PROTOCOL=TCP)(HOST=localhost)(PORT=${ORACLE_CONFIG.PORT}))`);
    p.set('dispatchers', '(PROTOCOL=TCP) (SERVICE=ORCLXDB)');

    // Misc
    p.set('db_files', '200');
    p.set('recyclebin', 'ON');
    p.set('deferred_segment_creation', 'TRUE');
    p.set('filesystemio_options', 'setall');
    p.set('resource_limit', 'TRUE');
    p.set('parallel_max_servers', '40');
    p.set('parallel_min_servers', '0');

    // Environment (stored for SHOW PARAMETER lookups)
    p.set('oracle_home', ORACLE_CONFIG.HOME);
    p.set('oracle_sid', this.config.sid);
    p.set('oracle_base', ORACLE_CONFIG.BASE);

    // Copy initial params as spfile baseline
    for (const [k, v] of p) {
      this._spfileParams.set(k, v);
    }
  }

  getParameter(name: string): string | undefined {
    return this._parameters.get(name.toLowerCase());
  }

  setParameter(name: string, value: string, scope?: 'MEMORY' | 'SPFILE' | 'BOTH'): void {
    const key = name.toLowerCase();
    const effectiveScope = scope ?? 'BOTH';
    const oldValue = this._parameters.get(key);
    if (effectiveScope === 'MEMORY' || effectiveScope === 'BOTH') {
      this._parameters.set(key, value);
    }
    if (effectiveScope === 'SPFILE' || effectiveScope === 'BOTH') {
      this._spfileParams.set(key, value);
    }
    this._modifiedParams.add(key);
    this.getBus().publish({
      topic: 'oracle.instance.parameter-changed',
      payload: { ...this.ref(), key, oldValue, newValue: value, scope: effectiveScope },
    });
  }

  getAllParameters(): Map<string, string> {
    return new Map(this._parameters);
  }

  getSpfileParameters(): Map<string, string> {
    return new Map(this._spfileParams);
  }

  isParameterModified(name: string): boolean {
    return this._modifiedParams.has(name.toLowerCase());
  }

  // ── SGA Info ─────────────────────────────────────────────────────

  getSGAInfo(): SGAInfo {
    return {
      totalSize: this.config.sgaTarget,
      sharedPool: '256M',
      bufferCache: '128M',
      redoLogBuffer: '16M',
      javaPool: '64M',
      largePool: '32M',
    };
  }

  // ── Alert log ────────────────────────────────────────────────────

  private logAlert(message: string): void {
    const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
    const line = `${ts}: ${message}`;
    this._alertLog.push(line);
    this.getBus().publish({
      topic: 'oracle.instance.alert-log-entry-added',
      payload: { ...this.ref(), line },
    });
  }

  /**
   * Publicly-callable wrapper around `logAlert`. Used by audit hooks
   * (logon/logoff/error) to surface user activity in the alert log,
   * matching the way a real Oracle instance writes to `alert.log`.
   */
  logAlertEvent(message: string): void {
    this.logAlert(message);
  }

  getAlertLog(): string[] {
    return [...this._alertLog];
  }

  // ── Archive log mode ─────────────────────────────────────────────

  /** Supplemental-log toggles, mutated by ALTER DATABASE / TABLE … SUPPLEMENTAL LOG. */
  private _supplementalLog = { min: 'NO' as 'NO' | 'YES' | 'IMPLICIT', pk: false, ui: false, fk: false, all: false };
  /** FORCE LOGGING toggle, mutated by ALTER DATABASE FORCE LOGGING. */
  private _forceLogging = false;
  /** FLASHBACK ON toggle. */
  private _flashbackOn = false;

  get archiveLogMode(): boolean { return this._archiveLogMode; }
  get supplementalLog(): { min: 'NO' | 'YES' | 'IMPLICIT'; pk: boolean; ui: boolean; fk: boolean; all: boolean } {
    return { ...this._supplementalLog };
  }
  get forceLogging(): boolean { return this._forceLogging; }
  get flashbackOn(): boolean { return this._flashbackOn; }

  setSupplementalLog(patch: Partial<{ min: 'NO' | 'YES' | 'IMPLICIT'; pk: boolean; ui: boolean; fk: boolean; all: boolean }>): void {
    this._supplementalLog = { ...this._supplementalLog, ...patch };
  }
  setForceLogging(on: boolean): void { this._forceLogging = on; }
  setFlashbackOn(on: boolean): void { this._flashbackOn = on; }

  setArchiveLogMode(enabled: boolean): string {
    if (this._state !== 'MOUNT') {
      return ORACLE_ERRORS.ORA_01126;
    }
    this._archiveLogMode = enabled;
    this._parameters.set('archive_log_mode', enabled ? 'ENABLED' : 'DISABLED');
    this.logAlert(`Archive log mode ${enabled ? 'enabled' : 'disabled'}`);
    return 'Database altered.';
  }

  // ── Version ──────────────────────────────────────────────────────

  getVersionBanner(): string[] {
    return [
      'Oracle Database 19c Enterprise Edition Release 19.0.0.0.0 - Production',
      'Version 19.3.0.0.0',
    ];
  }

  // ── Listener ────────────────────────────────────────────────────

  private _listenerState: 'running' | 'stopped' = 'stopped';

  get listenerStatus(): 'running' | 'stopped' { return this._listenerState; }

  startListener(): string {
    if (this._listenerState === 'running') {
      return TNS_ERRORS.TNS_01106;
    }
    this._listenerState = 'running';
    this.logAlert('Listener LISTENER started successfully');
    const endpoint = `(ADDRESS=(PROTOCOL=tcp)(HOST=0.0.0.0)(PORT=${ORACLE_CONFIG.PORT}))`;
    this.getBus().publish({
      topic: 'oracle.listener.event',
      payload: { ...this.ref(), state: 'running', endpoint },
    });
    this.getBus().publish({
      topic: 'oracle.service.event',
      payload: { ...this.ref(), name: this.config.sid, kind: 'started' },
    });
    const ver = `${ORACLE_CONFIG.VERSION}.0.0.0`;
    const port = ORACLE_CONFIG.PORT;
    const sid = this.config.sid;
    return [
      `LSNRCTL for Linux: Version ${ver} - Production`,
      `Starting ${ORACLE_CONFIG.HOME}/bin/tnslsnr: please wait...`,
      '',
      `TNSLSNR for Linux: Version ${ver} - Production`,
      `System parameter file is ${ORACLE_CONFIG.HOME}/network/admin/listener.ora`,
      `Log messages written to ${ORACLE_CONFIG.BASE}/diag/tnslsnr/${sid.toLowerCase()}/listener/alert/log.xml`,
      `Listening on: (DESCRIPTION=(ADDRESS=(PROTOCOL=tcp)(HOST=0.0.0.0)(PORT=${port})))`,
      '',
      `Connecting to (DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=0.0.0.0)(PORT=${port})))`,
      `STATUS of the LISTENER`,
      `------------------------`,
      `Alias                     LISTENER`,
      `Version                   TNSLSNR for Linux: Version ${ver}`,
      `Start Date                ${new Date().toISOString().slice(0, 19).replace('T', ' ')}`,
      `Uptime                    0 days 0 hr. 0 min. 0 sec`,
      `Trace Level               off`,
      `Security                  ON: Local OS Authentication`,
      `SNMP                      OFF`,
      `Listener Parameter File   ${ORACLE_CONFIG.HOME}/network/admin/listener.ora`,
      `Listener Log File         ${ORACLE_CONFIG.BASE}/diag/tnslsnr/${sid.toLowerCase()}/listener/alert/log.xml`,
      `Listening Endpoints Summary...`,
      `  (DESCRIPTION=(ADDRESS=(PROTOCOL=tcp)(HOST=0.0.0.0)(PORT=${port})))`,
      `Services Summary...`,
      `Service "${sid}" has 1 instance(s).`,
      `  Instance "${sid}", status READY, has 1 handler(s) for this service...`,
      `The command completed successfully`,
      '',
      'Listener started successfully.',
    ].join('\n');
  }

  stopListener(): string {
    if (this._listenerState === 'stopped') {
      return TNS_ERRORS.TNS_12541;
    }
    this._listenerState = 'stopped';
    this.logAlert('Listener LISTENER stopped');
    this.getBus().publish({
      topic: 'oracle.listener.event',
      payload: { ...this.ref(), state: 'stopped', endpoint: '' },
    });
    this.getBus().publish({
      topic: 'oracle.service.event',
      payload: { ...this.ref(), name: this.config.sid, kind: 'stopped' },
    });
    const ver = `${ORACLE_CONFIG.VERSION}.0.0.0`;
    const port = ORACLE_CONFIG.PORT;
    return [
      `LSNRCTL for Linux: Version ${ver} - Production`,
      `Connecting to (DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=0.0.0.0)(PORT=${port})))`,
      `The command completed successfully`,
      '',
      'Listener stopped.',
    ].join('\n');
  }

  getListenerStatus(): string {
    const ver = `${ORACLE_CONFIG.VERSION}.0.0.0`;
    const port = ORACLE_CONFIG.PORT;
    const sid = this.config.sid;

    if (this._listenerState === 'stopped') {
      return [
        `LSNRCTL for Linux: Version ${ver} - Production`,
        `Connecting to (DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=0.0.0.0)(PORT=${port})))`,
        TNS_ERRORS.TNS_12541,
        ` ${TNS_ERRORS.TNS_12560}`,
        `  ${TNS_ERRORS.TNS_00511}`,
      ].join('\n');
    }
    return [
      `LSNRCTL for Linux: Version ${ver} - Production`,
      `Connecting to (DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=0.0.0.0)(PORT=${port})))`,
      `STATUS of the LISTENER`,
      `------------------------`,
      `Alias                     LISTENER`,
      `Version                   TNSLSNR for Linux: Version ${ver}`,
      `Start Date                ${(this._startupTime || new Date()).toISOString().slice(0, 19).replace('T', ' ')}`,
      `Uptime                    0 days 0 hr. 5 min. 0 sec`,
      `Trace Level               off`,
      `Security                  ON: Local OS Authentication`,
      `SNMP                      OFF`,
      `Listener Parameter File   ${ORACLE_CONFIG.HOME}/network/admin/listener.ora`,
      `Listening Endpoints Summary...`,
      `  (DESCRIPTION=(ADDRESS=(PROTOCOL=tcp)(HOST=0.0.0.0)(PORT=${port})))`,
      `Services Summary...`,
      `Service "${sid}" has 1 instance(s).`,
      `  Instance "${sid}", status READY, has 1 handler(s) for this service...`,
      `The command completed successfully`,
    ].join('\n');
  }

  // ── Configuration file content ─────────────────────────────────

  getInitOraContent(): string {
    const params = [
      `db_name                  = ${this.config.sid}`,
      `db_domain                = localdomain`,
      `db_block_size            = ${this.config.dbBlockSize}`,
      `sga_target               = ${this.config.sgaTarget}`,
      `sga_max_size             = ${this.config.sgaTarget}`,
      `pga_aggregate_target     = 128M`,
      `processes                = ${this.config.processes}`,
      `sessions                 = ${this.config.maxSessions}`,
      `open_cursors             = ${this.config.openCursors}`,
      `undo_management          = AUTO`,
      `undo_tablespace          = UNDOTBS1`,
      `undo_retention           = 900`,
      `compatible               = 19.0.0`,
      `remote_login_passwordfile = EXCLUSIVE`,
      `audit_trail              = DB`,
      `diagnostic_dest          = ${ORACLE_CONFIG.BASE}`,
      `control_files            = ('${ORACLE_CONFIG.BASE}/oradata/${this.config.sid}/control01.ctl',`,
      `                            '${ORACLE_CONFIG.BASE}/oradata/${this.config.sid}/control02.ctl')`,
    ];
    return params.join('\n');
  }

  getTnsNamesContent(): string {
    return [
      `${this.config.sid} =`,
      `  (DESCRIPTION =`,
      `    (ADDRESS = (PROTOCOL = TCP)(HOST = localhost)(PORT = ${ORACLE_CONFIG.PORT}))`,
      `    (CONNECT_DATA =`,
      `      (SERVER = DEDICATED)`,
      `      (SERVICE_NAME = ${this.config.sid})`,
      `    )`,
      `  )`,
    ].join('\n');
  }

  getListenerOraContent(): string {
    return [
      `LISTENER =`,
      `  (DESCRIPTION_LIST =`,
      `    (DESCRIPTION =`,
      `      (ADDRESS = (PROTOCOL = TCP)(HOST = 0.0.0.0)(PORT = 1521))`,
      `    )`,
      `  )`,
      ``,
      `SID_LIST_LISTENER =`,
      `  (SID_LIST =`,
      `    (SID_DESC =`,
      `      (GLOBAL_DBNAME = ${this.config.sid})`,
      `      (ORACLE_HOME = /u01/app/oracle/product/19c/dbhome_1)`,
      `      (SID_NAME = ${this.config.sid})`,
      `    )`,
      `  )`,
      ``,
      `ADR_BASE_LISTENER = /u01/app/oracle`,
    ].join('\n');
  }
}
