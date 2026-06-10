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
