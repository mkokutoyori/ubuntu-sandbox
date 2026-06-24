/**
 * TransactionManager — owns the implicit-transaction lifecycle of one session.
 *
 * Oracle semantics implemented here:
 *  - A transaction starts implicitly with the first DML statement
 *    (`begin()` is idempotent while a transaction is active).
 *  - COMMIT / ROLLBACK end the transaction; DDL issues an implicit COMMIT
 *    (the executor calls `commit()` before DDL).
 *  - Reusing a SAVEPOINT name erases the earlier savepoint and moves it to
 *    the new position (Oracle SQL Language Reference, SAVEPOINT).
 *  - ROLLBACK TO SAVEPOINT keeps the transaction active, erases savepoints
 *    created after the named one, and raises ORA-01086 when the name was
 *    never established in this session.
 *
 * Undo is modelled as full row snapshots per table — sufficient for the
 * simulator's single-session-at-a-time write model.
 */

import type { StorageRow } from '../../engine/storage/BaseStorage';
import { OracleError } from '../../engine/types/DatabaseError';

/** The slice of the storage layer needed to capture/restore row snapshots. */
export interface SnapshotableStorage {
  getSchemas(): string[];
  getTableNames(schema: string): string[];
  getRows(schema: string, tableName: string): StorageRow[];
  tableExists(schema: string, name: string): boolean;
  truncateTable(schema: string, tableName: string): void;
  insertRow(schema: string, tableName: string, row: StorageRow): void;
}

/** Snapshot of table rows for transaction undo: schema -> table -> rows copy. */
interface TransactionSnapshot {
  tables: Map<string, Map<string, StorageRow[]>>;
}

/** Shallow row-set comparison (cell-by-cell) used to detect autonomous writes. */
function rowsEqual(a: StorageRow[], b: StorageRow[] | undefined): boolean {
  if (!b) return a.length === 0;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const ra = a[i], rb = b[i];
    if (ra.length !== rb.length) return false;
    for (let j = 0; j < ra.length; j++) if (ra[j] !== rb[j]) return false;
  }
  return true;
}

/** Lifecycle notifications, used by the executor to publish oracle.transaction.* events. */
export interface TransactionObserver {
  onBegin(txId: number): void;
  onCommit(txId: number, durationMs: number): void;
  onRollback(txId: number): void;
}

export class TransactionManager {
  private snapshot: TransactionSnapshot | null = null;
  private savepoints: Map<string, TransactionSnapshot> = new Map();
  private active = false;
  /** Monotonic per session; bumped on each implicit BEGIN. */
  private txIdCounter = 0;
  private txId = 0;
  private startedAt = 0;

  constructor(
    private readonly storage: SnapshotableStorage,
    private readonly observer: TransactionObserver,
  ) {}

  get isActive(): boolean { return this.active; }

  /** Valid while `isActive`; keeps the last id afterwards (matches event payloads). */
  get activeTxId(): number { return this.txId; }

  /** Begin an implicit transaction on first DML; no-op when already active. */
  begin(): void {
    if (this.active) return;
    this.snapshot = this.captureSnapshot();
    this.active = true;
    this.txId = ++this.txIdCounter;
    this.startedAt = performance.now();
    this.observer.onBegin(this.txId);
  }

  /** End the transaction keeping all changes. Returns whether one was open. */
  commit(): boolean {
    const wasActive = this.active;
    const startedAt = this.startedAt;
    this.snapshot = null;
    this.savepoints.clear();
    this.active = false;
    if (wasActive) this.observer.onCommit(this.txId, performance.now() - startedAt);
    return wasActive;
  }

  /** End the transaction restoring the pre-transaction row state. */
  rollback(): boolean {
    if (this.snapshot) this.restoreSnapshot(this.snapshot);
    const wasActive = this.active;
    this.snapshot = null;
    this.savepoints.clear();
    this.active = false;
    if (wasActive) this.observer.onRollback(this.txId);
    return wasActive;
  }

  /**
   * Roll back to a named savepoint. The transaction stays active and
   * savepoints created after the named one are erased.
   * @throws OracleError ORA-01086 when the savepoint was never established.
   */
  rollbackToSavepoint(name: string): void {
    const key = name.toUpperCase();
    const snap = this.savepoints.get(key);
    if (!snap) {
      throw new OracleError(1086, `savepoint '${key}' never established in this session or is invalid`);
    }
    this.restoreSnapshot(snap);
    const names = Array.from(this.savepoints.keys());
    for (let i = names.indexOf(key) + 1; i < names.length; i++) {
      this.savepoints.delete(names[i]);
    }
  }

  /**
   * Create (or move) a named savepoint. Reusing a name erases the earlier
   * savepoint, so its position in the rollback order is the new one.
   */
  createSavepoint(name: string): void {
    this.begin();
    const key = name.toUpperCase();
    this.savepoints.delete(key);
    this.savepoints.set(key, this.captureSnapshot());
  }

  // ── Autonomous transactions ──────────────────────────────────────
  //
  // PRAGMA AUTONOMOUS_TRANSACTION suspends the caller's transaction, runs the
  // unit in a fresh one, then resumes the caller. The autonomous unit's
  // committed changes must survive a later rollback of the parent, so on exit
  // we re-baseline the parent's undo snapshots for every table the autonomous
  // unit changed (between enter and exit).

  private autonomousStack: {
    snapshot: TransactionSnapshot | null;
    savepoints: Map<string, TransactionSnapshot>;
    active: boolean;
    txId: number;
    startedAt: number;
    /** Storage state captured at enter — the autonomous diff baseline. */
    entry: TransactionSnapshot;
  }[] = [];

  /** Suspend the current transaction and start a fresh, empty one. */
  enterAutonomous(): void {
    this.autonomousStack.push({
      snapshot: this.snapshot,
      savepoints: this.savepoints,
      active: this.active,
      txId: this.txId,
      startedAt: this.startedAt,
      entry: this.captureSnapshot(),
    });
    this.snapshot = null;
    this.savepoints = new Map();
    this.active = false;
  }

  /** Restore the suspended caller transaction, preserving autonomous commits. */
  exitAutonomous(): void {
    const saved = this.autonomousStack.pop();
    if (!saved) return;
    // Any work the autonomous unit left uncommitted is discarded.
    if (this.active) this.rollback();
    // Re-baseline the caller's undo snapshots so a later parent ROLLBACK does
    // not undo what the autonomous unit committed.
    if (saved.snapshot) this.rebaseSnapshot(saved.snapshot, saved.entry);
    for (const sp of saved.savepoints.values()) this.rebaseSnapshot(sp, saved.entry);
    this.snapshot = saved.snapshot;
    this.savepoints = saved.savepoints;
    this.active = saved.active;
    this.txId = saved.txId;
    this.startedAt = saved.startedAt;
  }

  /**
   * For every table whose current rows differ from `entry`, replace its
   * baseline in `target` with the current rows — so restoring `target` keeps
   * those (autonomously-committed) changes.
   */
  private rebaseSnapshot(target: TransactionSnapshot, entry: TransactionSnapshot): void {
    for (const schema of this.storage.getSchemas()) {
      for (const tableName of this.storage.getTableNames(schema)) {
        const current = this.storage.getRows(schema, tableName);
        const before = entry.tables.get(schema)?.get(tableName);
        if (rowsEqual(current, before)) continue;
        let tableMap = target.tables.get(schema);
        if (!tableMap) { tableMap = new Map(); target.tables.set(schema, tableMap); }
        tableMap.set(tableName, current.map(r => [...r]));
      }
    }
  }

  /** Deep-copy current row state of all tables for undo. */
  private captureSnapshot(): TransactionSnapshot {
    const snap: TransactionSnapshot = { tables: new Map() };
    for (const schema of this.storage.getSchemas()) {
      const tableMap = new Map<string, StorageRow[]>();
      for (const tableName of this.storage.getTableNames(schema)) {
        const rows = this.storage.getRows(schema, tableName);
        tableMap.set(tableName, rows.map(r => [...r]));
      }
      snap.tables.set(schema, tableMap);
    }
    return snap;
  }

  /** Restore row state from a snapshot. Tables created after the snapshot keep their rows. */
  private restoreSnapshot(snap: TransactionSnapshot): void {
    for (const [schema, tableMap] of snap.tables) {
      for (const [tableName, rows] of tableMap) {
        if (this.storage.tableExists(schema, tableName)) {
          this.storage.truncateTable(schema, tableName);
          for (const row of rows) {
            this.storage.insertRow(schema, tableName, [...row]);
          }
        }
      }
    }
  }
}
