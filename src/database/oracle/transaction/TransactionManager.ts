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
import type { TransactionCoordinator, CommittedImageProvider } from './TransactionCoordinator';

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

export class TransactionManager implements CommittedImageProvider {
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
    private readonly coordinator?: TransactionCoordinator,
  ) {}

  get isActive(): boolean { return this.active; }

  /** Valid while `isActive`; keeps the last id afterwards (matches event payloads). */
  get activeTxId(): number { return this.txId; }

  committedImage(schema: string, tableName: string): StorageRow[] | null {
    if (!this.active || !this.snapshot) return null;
    const rows = this.snapshot.tables.get(schema)?.get(tableName);
    return rows ? rows.map(r => [...r]) : null;
  }

  visibleRows(schema: string, tableName: string): StorageRow[] | null {
    return this.coordinator?.committedImageFor(this, schema, tableName) ?? null;
  }

  /** Begin an implicit transaction on first DML; no-op when already active. */
  begin(): void {
    if (this.active) return;
    this.snapshot = this.captureSnapshot();
    this.active = true;
    this.txId = ++this.txIdCounter;
    this.startedAt = performance.now();
    this.coordinator?.registerWriter(this);
    this.observer.onBegin(this.txId);
  }

  /** End the transaction keeping all changes. Returns whether one was open. */
  commit(): boolean {
    const wasActive = this.active;
    const startedAt = this.startedAt;
    this.snapshot = null;
    this.savepoints.clear();
    this.active = false;
    this.coordinator?.unregisterWriter(this);
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
    this.coordinator?.unregisterWriter(this);
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

  private autonomousStack: {
    snapshot: TransactionSnapshot | null;
    savepoints: Map<string, TransactionSnapshot>;
    active: boolean;
    txId: number;
    startedAt: number;
    entry: TransactionSnapshot;
  }[] = [];

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

  exitAutonomous(): void {
    const saved = this.autonomousStack.pop();
    if (!saved) return;
    if (this.active) this.rollback();
    if (saved.snapshot) this.rebaseSnapshot(saved.snapshot, saved.entry);
    for (const sp of saved.savepoints.values()) this.rebaseSnapshot(sp, saved.entry);
    this.snapshot = saved.snapshot;
    this.savepoints = saved.savepoints;
    this.active = saved.active;
    this.txId = saved.txId;
    this.startedAt = saved.startedAt;
    if (this.active) this.coordinator?.registerWriter(this);
  }

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
