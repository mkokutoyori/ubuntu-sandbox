/**
 * OracleRuntimeState — event-fed collections that back the dynamic
 * V$/GV$/DBA_HIST_ views.
 *
 * The runtime state is intentionally *passive*: it owns the data
 * structures (sessions, waits, locks, sql cache, latches, …) but never
 * decides when they change. Mutations are driven by actors subscribed to
 * the same `oracle.*` event bus the instance publishes to — see
 * `actors/OracleRuntimeStateActor.ts`.
 *
 * View files read snapshots from this object. They never reach back into
 * the storage or instance to invent rows; if a view has no event source
 * yet, it returns its static schema-only empty set.
 */

export interface RuntimeSessionRecord {
  sessionId: string;
  sid: number;
  serial: number;
  username: string;
  schema: string;
  role?: string;
  program: string;
  type: 'USER' | 'BACKGROUND';
  status: 'ACTIVE' | 'INACTIVE';
  logonTime: number;
  inTransaction: boolean;
  /** Last SQL run by this session. */
  lastSqlId?: string;
  lastSqlText?: string;
}

export interface RuntimeWaitRecord {
  sid: number;
  event: string;
  waitClass: string;
  seq: number;
  waitTimeMicros: number;
  timestamp: number;
}

export interface RuntimeSqlRecord {
  sqlId: string;
  text: string;
  parsingSchema: string;
  executions: number;
  elapsedMicros: number;
  cpuMicros: number;
  bufferGets: number;
  diskReads: number;
  rowsProcessed: number;
  firstLoadTime: number;
  lastLoadTime: number;
}

export interface RuntimeTransactionRecord {
  txId: number;
  sessionId: string;
  startedAt: number;
  status: 'ACTIVE' | 'COMMITTED' | 'ROLLED_BACK';
  usedUblk: number;
  usedUrec: number;
}

export interface RuntimeLockRecord {
  sid: number;
  sessionId: string;
  type: string;
  id1: number;
  id2: number;
  lmode: number;
  request: number;
  block: number;
  schema: string;
  table: string;
}

export interface RuntimeArchivedLogRecord {
  recid: number;
  name: string;
  sequence: number;
  firstTime: number;
  nextTime: number;
}

export interface RuntimeAlertRecord {
  ts: number;
  line: string;
}

export interface RuntimeLatchRecord {
  sid: number;
  latch: string;
  level: number;
  kind: 'acquired' | 'released' | 'sleep';
  spinCount: number;
  ts: number;
}

export interface RuntimeBackupRecord {
  setId: number;
  pieceId: number;
  type: string;
  handle: string;
  bytes: number;
  startedAt: number;
  completedAt: number;
  status: string;
}

export interface RuntimeServiceRecord {
  name: string;
  startedAt: number;
  active: boolean;
}

export interface RuntimeLongopsRecord {
  sessionId: string;
  sid: number;
  opname: string;
  target: string;
  sofar: number;
  totalwork: number;
  units: string;
  ts: number;
}

export interface RuntimeSessionMetricRecord {
  sid: number;
  metric: string;
  value: number;
  ts: number;
}

export interface RuntimeFlashbackRecord {
  ts: number;
  kind: string;
  bytes: number;
  scn: number;
}

export class OracleRuntimeState {
  readonly sessions = new Map<string, RuntimeSessionRecord>();
  readonly waitHistory: RuntimeWaitRecord[] = [];
  readonly sqlCache = new Map<string, RuntimeSqlRecord>();
  readonly transactions = new Map<number, RuntimeTransactionRecord>();
  readonly locks: RuntimeLockRecord[] = [];
  readonly archivedLogs: RuntimeArchivedLogRecord[] = [];
  readonly alertEntries: RuntimeAlertRecord[] = [];
  readonly latches: RuntimeLatchRecord[] = [];
  readonly backups: RuntimeBackupRecord[] = [];
  readonly services = new Map<string, RuntimeServiceRecord>();
  readonly longops: RuntimeLongopsRecord[] = [];
  readonly sessionMetrics: RuntimeSessionMetricRecord[] = [];
  readonly flashbackHistory: RuntimeFlashbackRecord[] = [];
  /** Listener state mirrored from oracle.listener.event. */
  listenerState: 'running' | 'stopped' = 'stopped';
  listenerEndpoint = '';

  /** Aggregated counters maintained by the actor. */
  readonly counters = {
    commits: 0,
    rollbacks: 0,
    dml: 0,
    ddl: 0,
    errors: 0,
    redoSwitches: 0,
    archiveLogs: 0,
    logonsCumulative: 0,
    parseTotal: 0,
    parseHard: 0,
    executions: 0,
  };

  /** Time the actor first subscribed — used as a baseline for histories. */
  startedAt: number = Date.now();
}

/**
 * Memory budget per collection. Picked to keep a long-lived simulator
 * stable: a session that submits ≈100 queries/s will accumulate at most
 * a few MB of runtime state, then plateau.
 *
 * `maxEntriesByCollection` caps array lengths and `sqlCacheMaxEntries`
 * caps the SQL cache (LRU eviction). `historyTtlMs` is consulted by the
 * actor's drain loop to evict anything older than the window.
 */
export interface RuntimeStateBudget {
  readonly waitHistory: number;
  readonly alertEntries: number;
  readonly latches: number;
  readonly backups: number;
  readonly longops: number;
  readonly sessionMetrics: number;
  readonly flashbackHistory: number;
  readonly archivedLogs: number;
  readonly sqlCacheMaxEntries: number;
  /** Drop anything older than this from time-stamped histories. */
  readonly historyTtlMs: number;
}

export const DEFAULT_RUNTIME_BUDGET: RuntimeStateBudget = Object.freeze({
  waitHistory: 1000,
  alertEntries: 500,
  latches: 500,
  backups: 200,
  longops: 200,
  sessionMetrics: 1000,
  flashbackHistory: 200,
  archivedLogs: 500,
  sqlCacheMaxEntries: 500,
  historyTtlMs: 60 * 60 * 1000, // 1 hour
});
