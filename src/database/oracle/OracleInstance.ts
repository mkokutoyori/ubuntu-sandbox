/**
 * OracleInstance — Simulates an Oracle database instance.
 *
 * Manages instance state (SHUTDOWN → NOMOUNT → MOUNT → OPEN),
 * background processes, SGA/PGA parameters, and redo log groups.
 */

import type { OracleDatabaseConfig } from '../engine/types/DatabaseConfig';
import { defaultOracleConfig } from '../engine/types/DatabaseConfig';
import { ORACLE_CONFIG, ORACLE_ERRORS, TNS_ERRORS } from './OracleConfig';
import { parseSize } from './views/_fileSize';
import { OracleError } from '../engine/types/DatabaseError';
import { ListenerControl } from './listener/ListenerControl';
import { getDefaultEventBus, type IEventBus } from '@/events/EventBus';
import {
  OracleSignalStore,
  makeReadonlyOracleObservables,
  type OracleObservables,
} from './observables';
import { OracleSignalRefreshActor } from './actors/OracleSignalRefreshActor';
import { OracleRuntimeState } from './views/OracleRuntimeState';
import { OracleRuntimeStateActor } from './actors/OracleRuntimeStateActor';
import { SchedulerSweepActor } from './actors/SchedulerSweepActor';
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
import { PlanCache } from './plan/PlanCache';
import { StatisticsManager } from './statistics/StatisticsManager';
import { MultitenantManager } from './multitenant/PluggableDatabase';
import { DataGuardConfiguration } from './dataguard/DataGuardConfiguration';
import { ReplicationManager } from './replication/Replication';
import { FlashbackArchiveManager } from './flashback/FlashbackArchive';
import { ResultCacheManager } from './resultcache/ResultCache';
import { InMemoryManager } from './resultcache/InMemoryManager';
import { LockManager } from './lock/LockManager';
import { LockActor } from './lock/LockActor';
import type { OracleStorage } from './OracleStorage';

export type InstanceState = 'SHUTDOWN' | 'NOMOUNT' | 'MOUNT' | 'OPEN';

export interface BackgroundProcess {
  name: string;
  pid: number;
  description: string;
}

export interface ServerProcess {
  pid: number;
  sessionSid: number;
  serial: number;
  username: string;
  osUser: string;
  local: boolean;
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

  // ── Database identity & SCN ──────────────────────────────────────
  /** DBID — computed once per database like CREATE DATABASE does (lazy
   *  so the deviceId injected after construction participates, giving
   *  every device a distinct, stable identifier). */
  private _dbid: number | null = null;
  /** System Change Number — one monotonic stream per database. Every
   *  commit advances it; checkpoints stamp the current value into the
   *  datafile headers (V$DATAFILE / V$DATAFILE_HEADER agree by design). */
  private _currentScn = 1_000_000;
  private _checkpointScn = 1_000_000;
  private _checkpointTime = new Date();

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
   *  Surfaces forensic data through the DBA_* security views. Shares the
   *  instance SCN stream so DDL/DML history SCNs are coherent with
   *  V$DATABASE.CURRENT_SCN instead of running a private counter. */
  private readonly _auditJournal = new AuditJournal(undefined, () => this.advanceScn());
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
  /** SQL plan cache — feeds V$SQL_PLAN. Populated by the executor.
   *  Sized generously so a fresh database with demo schemas does not
   *  evict every plan before user activity starts. */
  readonly planCache = new PlanCache(2000);
  readonly multitenant = new MultitenantManager();
  readonly dataGuard = new DataGuardConfiguration();
  readonly replication = new ReplicationManager();
  readonly flashbackArchive = new FlashbackArchiveManager();
  readonly resultCache = new ResultCacheManager();
  readonly inMemory = new InMemoryManager();
  readonly lockManager = new LockManager();
  private _lockActor: LockActor | null = null;
  statistics: StatisticsManager | null = null;
  scheduler: import('./scheduler/SchedulerManager').SchedulerManager | null = null;
  private _schedulerSweepActor: SchedulerSweepActor | null = null;
  attachScheduler(s: import('./scheduler/SchedulerManager').SchedulerManager): void {
    this.scheduler = s;
    this._schedulerSweepActor?.stop();
    this._schedulerSweepActor = null;
    if (this._state === 'OPEN') this.ensureSchedulerSweep();
  }
  attachStatistics(storage: OracleStorage): StatisticsManager {
    if (!this.statistics) this.statistics = new StatisticsManager(storage);
    return this.statistics;
  }
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
    containerId: number;
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

  /**
   * Host-filesystem reader injected by the layer that owns the device
   * (terminal wiring). Lets SQL like CREATE SPFILE FROM PFILE read
   * init.ora files from the device VFS without the database layer
   * importing network/Equipment (dependency inversion).
   */
  private _deviceFileReader: ((path: string) => string | null) | null = null;
  setDeviceFileReader(fn: (path: string) => string | null): void {
    this._deviceFileReader = fn;
  }
  /** Read a file from the host device VFS, or null when unavailable. */
  readDeviceFile(path: string): string | null {
    return this._deviceFileReader?.(path) ?? null;
  }
  hasDeviceFilesystem(): boolean {
    return this._deviceFileReader !== null;
  }

  /**
   * Host-filesystem writer / remover, injected by the same wiring as the
   * reader. They let UTL_FILE (and any future server-side file producer)
   * materialise files on the device VFS so the OS shell sees exactly what
   * PL/SQL wrote — without the database layer importing network/Equipment.
   */
  private _deviceFileWriter: ((path: string, content: string) => boolean) | null = null;
  setDeviceFileWriter(fn: (path: string, content: string) => boolean): void {
    this._deviceFileWriter = fn;
  }
  /** Write (create/overwrite) a file on the host device VFS. */
  writeDeviceFile(path: string, content: string): boolean {
    return this._deviceFileWriter?.(path, content) ?? false;
  }

  private _deviceFileRemover: ((path: string) => boolean) | null = null;
  setDeviceFileRemover(fn: (path: string) => boolean): void {
    this._deviceFileRemover = fn;
  }
  /** Remove a file from the host device VFS. */
  removeDeviceFile(path: string): boolean {
    return this._deviceFileRemover?.(path) ?? false;
  }

  private _osCommandRunner: ((cmd: string) => { output: string; exitCode: number } | null) | null = null;
  setOsCommandRunner(fn: (cmd: string) => { output: string; exitCode: number } | null): void {
    this._osCommandRunner = fn;
  }
  /** Run an OS command on the host (DBMS_SCHEDULER EXECUTABLE jobs). */
  runOsCommand(cmd: string): { output: string; exitCode: number } | null {
    return this._osCommandRunner?.(cmd) ?? null;
  }

  /**
   * Datafile enumeration injected by OracleDatabase (the instance does
   * not own the storage layer). Combined with the existence probe, it
   * lets the open-time header check verify each datafile still exists
   * on the host filesystem — like DBWR identifying/locking the files
   * when the database opens.
   */
  private _datafileLister: (() => { fileNo: number; path: string }[]) | null = null;
  setDatafileLister(fn: () => { fileNo: number; path: string }[]): void {
    this._datafileLister = fn;
  }

  private _hostFileProbe: ((path: string) => boolean | null) | null = null;
  setHostFileProbe(fn: (path: string) => boolean | null): void {
    this._hostFileProbe = fn;
  }

  /**
   * Datafiles missing from the host filesystem. A file deleted while
   * the instance is up does NOT affect a running database (the OS
   * keeps the open inode, as on a real host); the check only runs at
   * OPEN time.
   */
  private missingDatafiles(): { fileNo: number; path: string }[] {
    if (!this._datafileLister || !this._hostFileProbe) return [];
    const missing: { fileNo: number; path: string }[] = [];
    for (const df of this._datafileLister()) {
      const exists = this._hostFileProbe(df.path);
      if (exists === null) return []; // no host filesystem — nothing to check
      if (!exists) missing.push(df);
    }
    return missing;
  }

  getControlFilePaths(): string[] {
    return (this.getParameter('control_files') ?? '')
      .split(',')
      .map(s => s.trim().replace(/^['"]|['"]$/g, ''))
      .filter(Boolean);
  }

  private missingControlFiles(): string[] {
    if (!this._hostFileProbe) return [];
    const missing: string[] = [];
    for (const path of this.getControlFilePaths()) {
      const exists = this._hostFileProbe(path);
      if (exists === null) return []; // no host filesystem — nothing to check
      if (!exists) missing.push(path);
    }
    return missing;
  }

  // ── DBID / SCN accessors ──────────────────────────────────────────

  /**
   * Database identifier, as shown by V$DATABASE.DBID and RMAN's
   * `connected to target database: X (DBID=n)`. Real Oracle derives it
   * from the database name and creation timestamp at CREATE DATABASE
   * time; the simulator hashes deviceId+SID so every device gets a
   * distinct but reproducible DBID.
   */
  getDbId(): number {
    if (this._dbid === null) {
      // FNV-1a 32-bit over "deviceId:SID".
      let h = 0x811c9dc5;
      for (const ch of `${this._deviceId}:${this.config.sid}`) {
        h ^= ch.charCodeAt(0);
        h = Math.imul(h, 0x01000193) >>> 0;
      }
      // Map into the 1.0–4.0 billion range typical of real DBIDs.
      this._dbid = 1_000_000_000 + (h % 3_000_000_000);
    }
    return this._dbid;
  }

  /** Current SCN (V$DATABASE.CURRENT_SCN). */
  getCurrentScn(): number { return this._currentScn; }

  /** Advance the SCN (commits, checkpoints) and return the new value. */
  advanceScn(delta: number = 1): number {
    this._currentScn += delta;
    return this._currentScn;
  }

  /** SCN stamped into every datafile header at the last checkpoint. */
  getCheckpointScn(): number { return this._checkpointScn; }
  getCheckpointTime(): Date { return this._checkpointTime; }

  /**
   * Complete a checkpoint: advance the SCN and stamp it (with the wall
   * clock) into the shared header state every datafile view reads.
   * Triggered by ALTER SYSTEM CHECKPOINT, log switches, OPEN and clean
   * shutdowns — the same events as real Oracle.
   */
  performCheckpoint(): void {
    this._checkpointScn = this.advanceScn();
    this._checkpointTime = new Date();
    this.logAlert(`Completed checkpoint up to RBA, SCN: ${this._checkpointScn}`);
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
    if (this._lockActor) {
      this._lockActor.stop();
      this._lockActor = null;
    }
    if (this._schedulerSweepActor) {
      this._schedulerSweepActor.stop();
      this._schedulerSweepActor = null;
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
    this._lockActor = new LockActor(this.getBus(), this._deviceId, this.lockManager);
    this._lockActor.start();
    // Reattach the index usage monitor with the current bus/deviceId so
    // its subscription tracks the same scoping the other actors use.
    if (this._indexUsageStorage) {
      if (this._indexUsage) this._indexUsage.stop();
      this._indexUsage = new IndexUsageMonitor(this.getBus(), this._deviceId, this._indexUsageStorage);
      this._indexUsage.start();
    }
    if (this._state === 'OPEN') this.ensureSchedulerSweep();
  }

  private ensureSchedulerSweep(): void {
    if (!this.scheduler) return;
    if (!this._schedulerSweepActor) {
      this._schedulerSweepActor = new SchedulerSweepActor(this.scheduler);
    }
    this._schedulerSweepActor.start();
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
    // STARTUP RESTRICT opens with RESTRICTED SESSION enabled; any other
    // startup begins unrestricted (ALTER SYSTEM can toggle it later).
    this._restrictedSession = mode === 'RESTRICT';
    this.logAlert(`Starting ORACLE instance (${mode === 'RESTRICT' ? 'restrict' : 'normal'})`);
    output.push(`ORACLE instance started.`);
    output.push('');

    // NOMOUNT
    this.transitionTo('NOMOUNT');
    this.startBackgroundProcesses();
    {
      // Real startup banner prints exact byte counts derived from the
      // live sga_target, not canned figures.
      const sga = this.getSGAInfo();
      const b = (spec: string): number => parseSize(spec);
      const fixed = 2 * 1024 * 1024;
      const variable = b(sga.sharedPool) + b(sga.largePool) + b(sga.javaPool);
      output.push(`Total System Global Area ${String(b(sga.totalSize)).padStart(10)} bytes`);
      output.push(`Fixed Size               ${String(fixed).padStart(10)} bytes`);
      output.push(`Variable Size            ${String(variable).padStart(10)} bytes`);
      output.push(`Database Buffers         ${String(b(sga.bufferCache)).padStart(10)} bytes`);
      output.push(`Redo Buffers             ${String(b(sga.redoLogBuffer)).padStart(10)} bytes`);
    }

    if (mode === 'NOMOUNT') {
      this.logAlert('Instance started in NOMOUNT mode');
      return output;
    }

    const missingCtl = this.missingControlFiles();
    if (missingCtl.length > 0) {
      this.logAlert('ORA-00210: cannot open the specified control file');
      this.logAlert(`ORA-00202: control file: '${missingCtl[0]}'`);
      output.push('ORA-00205: error in identifying control file, check alert log for more info');
      return output;
    }
    this.transitionTo('MOUNT');
    output.push(`Database mounted.`);
    this.logAlert('Database mounted');

    if (mode === 'MOUNT') return output;

    // OPEN — DBWR must identify/lock every datafile first. A file
    // deleted from the host filesystem surfaces here (not while the
    // database was running), exactly like the real ORA-01157 ladder;
    // the instance stays MOUNTed for RESTORE/RECOVER.
    const missing = this.missingDatafiles();
    if (missing.length > 0) {
      const m = missing[0];
      this.logAlert(`Errors in file dbw0 trace: ORA-01157: cannot identify/lock data file ${m.fileNo}`);
      output.push(`ORA-01157: cannot identify/lock data file ${m.fileNo} - see DBWR trace file`);
      output.push(`ORA-01110: data file ${m.fileNo}: '${m.path}'`);
      return output;
    }
    this.markOpen();
    output.push(`Database opened.`);

    if (mode === 'RESTRICT') {
      output.push('Database opened in restricted mode.');
      this.logAlert('Database opened in restricted mode');
    }

    return output;
  }

  /** Shared OPEN transition: redo state, alert log, service events. */
  private markOpen(): void {
    this.transitionTo('OPEN');
    this._redoLogGroups[0].status = 'CURRENT';
    this.performCheckpoint();
    this.logAlert('Database opened');
    this.ensureSchedulerSweep();
    const openPdbServices = this.multitenant.getAll()
      .filter(p => p.name !== 'PDB$SEED' && (p.openMode === 'READ WRITE' || p.openMode === 'READ ONLY'))
      .map(p => p.name);
    for (const name of [this.config.sid, 'SYS$USERS', 'SYS$BACKGROUND', ...openPdbServices]) {
      this.getBus().publish({
        topic: 'oracle.service.event',
        payload: { ...this.ref(), name, kind: 'started' },
      });
    }
  }

  /** Publish a PDB service registration/deregistration (LREG), matching the listener. */
  publishPdbServiceEvent(name: string, kind: 'started' | 'stopped'): void {
    this.getBus().publish({
      topic: 'oracle.service.event',
      payload: { ...this.ref(), name: name.toUpperCase(), kind },
    });
  }

  /** ALTER DATABASE MOUNT — legal only from NOMOUNT (ORA-01100 otherwise). */
  mountDatabase(): void {
    if (this._state === 'MOUNT' || this._state === 'OPEN') {
      throw new OracleError(1100, 'database already mounted');
    }
    if (this._state !== 'NOMOUNT') {
      throw new OracleError(1034, 'ORACLE not available');
    }
    const missingCtl = this.missingControlFiles();
    if (missingCtl.length > 0) {
      this.logAlert('ORA-00210: cannot open the specified control file');
      this.logAlert(`ORA-00202: control file: '${missingCtl[0]}'`);
      throw new OracleError(205, 'error in identifying control file, check alert log for more info');
    }
    this.transitionTo('MOUNT');
    this.logAlert('Database mounted');
  }

  /** ALTER DATABASE OPEN — legal only from MOUNT (ORA-01507 / ORA-01531). */
  openDatabase(): void {
    if (this._state === 'OPEN') {
      throw new OracleError(1531, 'a database already open by the instance');
    }
    if (this._state !== 'MOUNT') {
      throw new OracleError(1507, 'database not mounted');
    }
    const missing = this.missingDatafiles();
    if (missing.length > 0) {
      const m = missing[0];
      this.logAlert(`Errors in file dbw0 trace: ORA-01157: cannot identify/lock data file ${m.fileNo}`);
      throw new OracleError(1157,
        `cannot identify/lock data file ${m.fileNo} - see DBWR trace file\n` +
        `ORA-01110: data file ${m.fileNo}: '${m.path}'`);
    }
    this.markOpen();
  }

  shutdown(mode?: 'NORMAL' | 'IMMEDIATE' | 'TRANSACTIONAL' | 'ABORT'): string[] {
    const output: string[] = [];

    if (this._state === 'SHUTDOWN') {
      return [ORACLE_ERRORS.ORA_01034];
    }

    const effectiveMode = mode ?? 'NORMAL';
    this.logAlert(`Shutting down instance (${effectiveMode.toLowerCase()})`);

    if (this._state === 'OPEN') {
      // Clean shutdowns checkpoint before closing (ABORT skips it, which
      // is what makes the subsequent startup need instance recovery).
      if (effectiveMode !== 'ABORT') this.performCheckpoint();
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
    for (const sp of [...this._serverProcesses.keys()]) {
      this.releaseServerProcess(sp);
    }
    this.transitionTo('SHUTDOWN');
    this._startupTime = null;
    this._restrictedSession = false;
    this._backgroundProcesses = [];
    for (const rg of this._redoLogGroups) rg.status = 'UNUSED';

    if (this._schedulerSweepActor) {
      this._schedulerSweepActor.stop();
      this._schedulerSweepActor = null;
    }

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

  private _serverProcesses = new Map<number, ServerProcess>();

  serverProcessCommand(local: boolean): string {
    return local
      ? `oracle${this.config.sid} (DESCRIPTION=(LOCAL=YES)(ADDRESS=(PROTOCOL=beq)))`
      : `oracle${this.config.sid} (LOCAL=NO)`;
  }

  spawnServerProcess(args: {
    sessionSid: number; serial: number; username: string; osUser: string; local: boolean;
  }): ServerProcess {
    const proc: ServerProcess = { pid: this._pidCounter++, ...args };
    this._serverProcesses.set(args.sessionSid, proc);
    this.getBus().publish({
      topic: 'oracle.instance.server-process-started',
      payload: {
        ...this.ref(), pid: proc.pid, sessionSid: proc.sessionSid,
        username: proc.username, command: this.serverProcessCommand(proc.local),
      },
    });
    return proc;
  }

  releaseServerProcess(sessionSid: number): void {
    const proc = this._serverProcesses.get(sessionSid);
    if (!proc) return;
    this._serverProcesses.delete(sessionSid);
    this.getBus().publish({
      topic: 'oracle.instance.server-process-stopped',
      payload: { ...this.ref(), pid: proc.pid, sessionSid },
    });
  }

  getServerProcesses(): ServerProcess[] {
    return [...this._serverProcesses.values()];
  }

  getServerProcess(sessionSid: number): ServerProcess | undefined {
    return this._serverProcesses.get(sessionSid);
  }

  getServerProcessByPid(pid: number): ServerProcess | undefined {
    for (const p of this._serverProcesses.values()) {
      if (p.pid === pid) return p;
    }
    return undefined;
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
    // A log switch triggers a (media-recovery) checkpoint in real Oracle.
    this.performCheckpoint();
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

  /**
   * SGA component sizes derived from the live `sga_target` parameter —
   * `ALTER SYSTEM SET sga_target=…` immediately reshapes the breakdown,
   * like ASMM on a real instance. Components are granule-rounded
   * (4M granules below 1G of SGA, 16M above, like real Oracle).
   */
  getSGAInfo(): SGAInfo {
    const ONE_MB = 1024 * 1024;
    const total = parseSize(this.getParameter('sga_target') ?? this.config.sgaTarget)
      || parseSize(this.config.sgaTarget);
    const granule = total > 1024 * ONE_MB ? 16 * ONE_MB : 4 * ONE_MB;
    const round = (b: number): number => Math.max(granule, Math.round(b / granule) * granule);
    const asMb = (b: number): string => `${Math.round(b / ONE_MB)}M`;
    // Typical ASMM steady-state split of a 19c instance.
    const bufferCache = round(total * 0.50);
    const sharedPool = round(total * 0.25);
    const largePool = round(total * 0.03);
    const javaPool = round(total * 0.03);
    const redoBuffer = total >= 1024 * ONE_MB ? 16 * ONE_MB : 8 * ONE_MB;
    return {
      totalSize: asMb(total),
      sharedPool: asMb(sharedPool),
      bufferCache: asMb(bufferCache),
      redoLogBuffer: asMb(redoBuffer),
      javaPool: asMb(javaPool),
      largePool: asMb(largePool),
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

  /** Stateful listener: lifecycle, LREG service registration derived
   *  from the live instance state, connection counters, transcripts. */
  private readonly _listener = new ListenerControl({
    sid: () => this.config.sid,
    instanceState: () => this._state,
    pdbServices: () => this.multitenant.getAll()
      .filter(p => p.name !== 'PDB$SEED' && (p.openMode === 'READ WRITE' || p.openMode === 'READ ONLY'))
      .map(p => p.name),
  });

  get listener(): ListenerControl { return this._listener; }

  get listenerStatus(): 'running' | 'stopped' {
    return this._listener.running ? 'running' : 'stopped';
  }

  private readListenerOraPort(): number | null {
    const content = this._deviceFileReader?.(`${ORACLE_CONFIG.HOME}/network/admin/listener.ora`);
    if (!content) return null;
    const m = /LISTENER\s*=[\s\S]*?\(\s*PORT\s*=\s*(\d+)\s*\)/i.exec(content);
    return m ? Number.parseInt(m[1], 10) : null;
  }

  startListener(): string {
    const configuredPort = this.readListenerOraPort();
    if (configuredPort !== null) this._listener.setPort(configuredPort);
    if (!this._listener.start()) {
      return TNS_ERRORS.TNS_01106;
    }
    this.logAlert('Listener LISTENER started successfully');
    const endpoint = `(ADDRESS=(PROTOCOL=tcp)(HOST=0.0.0.0)(PORT=${this._listener.port}))`;
    this.getBus().publish({
      topic: 'oracle.listener.event',
      payload: { ...this.ref(), state: 'running', endpoint, port: this._listener.port },
    });
    this.getBus().publish({
      topic: 'oracle.service.event',
      payload: { ...this.ref(), name: this.config.sid, kind: 'started' },
    });
    const ver = `${ORACLE_CONFIG.VERSION}.0.0.0`;
    const port = this._listener.port;
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
      ...this._listener.statusBody(),
      '',
      'Listener started successfully.',
    ].join('\n');
  }

  stopListener(): string {
    if (!this._listener.stop()) {
      return TNS_ERRORS.TNS_12541;
    }
    this.logAlert('Listener LISTENER stopped');
    this.getBus().publish({
      topic: 'oracle.listener.event',
      payload: { ...this.ref(), state: 'stopped', endpoint: '', port: this._listener.port },
    });
    this.getBus().publish({
      topic: 'oracle.service.event',
      payload: { ...this.ref(), name: this.config.sid, kind: 'stopped' },
    });
    const ver = `${ORACLE_CONFIG.VERSION}.0.0.0`;
    const port = this._listener.port;
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
    const port = this._listener.port;
    const header = [
      `LSNRCTL for Linux: Version ${ver} - Production`,
      `Connecting to (DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=0.0.0.0)(PORT=${port})))`,
    ];
    const body = this._listener.running
      ? this._listener.statusBody()
      : this._listener.notRunningBody();
    return [...header, ...body].join('\n');
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
