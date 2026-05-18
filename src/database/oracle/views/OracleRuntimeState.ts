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

export class OracleRuntimeState {
  readonly sessions = new Map<string, RuntimeSessionRecord>();
  readonly waitHistory: RuntimeWaitRecord[] = [];
  readonly sqlCache = new Map<string, RuntimeSqlRecord>();
  readonly transactions = new Map<number, RuntimeTransactionRecord>();
  readonly locks: RuntimeLockRecord[] = [];
  readonly archivedLogs: RuntimeArchivedLogRecord[] = [];
  readonly alertEntries: RuntimeAlertRecord[] = [];

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
