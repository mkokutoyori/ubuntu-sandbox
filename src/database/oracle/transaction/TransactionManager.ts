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
 * Undo is modelled as a row-level undo log: the executor registers this
 * manager as the storage's UndoSink around each statement it runs, so
 * every mutation is attributed to the transaction that made it. ROLLBACK
 * reverse-applies only this session's records — concurrent writers on
 * the same table keep their uncommitted rows (the old full-table
 * snapshot restore silently destroyed them). Reader visibility (READ
 * COMMITTED) is served by the TransactionCoordinator, which starts from
 * physical rows and reverse-applies every *other* active writer's log.
 */

import type { StorageRow, UndoSink } from '../../engine/storage/BaseStorage';
import { OracleError } from '../../engine/types/DatabaseError';
import type { TransactionCoordinator } from './TransactionCoordinator';

/** The slice of the storage layer needed to record and apply row undo. */
export interface SnapshotableStorage {
  getRows(schema: string, tableName: string): StorageRow[];
  tableExists(schema: string, name: string): boolean;
  insertRow(schema: string, tableName: string, row: StorageRow): void;
  deleteRows(schema: string, tableName: string, predicate: (row: StorageRow) => boolean): number;
  updateRows(schema: string, tableName: string, predicate: (row: StorageRow) => boolean, updater: (row: StorageRow) => StorageRow): number;
  setUndoSink(sink: UndoSink | null): UndoSink | null;
}

/** One attributed row change; `seq` is a global order across sessions. */
export type UndoRecord =
  | { seq: number; schema: string; table: string; kind: 'insert'; row: StorageRow }
  | { seq: number; schema: string; table: string; kind: 'delete'; row: StorageRow }
  | { seq: number; schema: string; table: string; kind: 'update'; before: StorageRow; after: StorageRow };

/** Global mutation order, shared by every session of every instance. */
let undoSeqSource = 1;

export function rowEquals(a: StorageRow, b: StorageRow): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const va = a[i], vb = b[i];
    if (va instanceof Date || vb instanceof Date) {
      const ta = va instanceof Date ? va.getTime() : va;
      const tb = vb instanceof Date ? vb.getTime() : vb;
      if (ta !== tb) return false;
    } else if (va !== vb) return false;
  }
  return true;
}

/** Reverse-apply one undo record on an in-memory row set (for readers). */
export function reverseApplyInMemory(rows: StorageRow[], rec: UndoRecord): void {
  if (rec.kind === 'insert') {
    const idx = rows.findIndex(r => rowEquals(r, rec.row));
    if (idx >= 0) rows.splice(idx, 1);
  } else if (rec.kind === 'delete') {
    rows.push([...rec.row]);
  } else {
    const idx = rows.findIndex(r => rowEquals(r, rec.after));
    if (idx >= 0) rows[idx] = [...rec.before];
  }
}

/** Lifecycle notifications, used by the executor to publish oracle.transaction.* events. */
export interface TransactionObserver {
  onBegin(txId: number): void;
  onCommit(txId: number, durationMs: number): void;
  onRollback(txId: number): void;
}

export class TransactionManager implements UndoSink {
  private undoLog: UndoRecord[] = [];
  /** Savepoint name → undo-log length at creation time. */
  private savepoints: Map<string, number> = new Map();
  private active = false;
  /** True while this manager is reverse-applying its own log. */
  private applyingUndo = false;
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

  // ── UndoSink — row changes attributed to this session ─────────────

  recordInsert(schema: string, tableName: string, row: StorageRow): void {
    if (!this.active || this.applyingUndo) return;
    this.undoLog.push({
      seq: undoSeqSource++, schema: schema.toUpperCase(), table: tableName.toUpperCase(),
      kind: 'insert', row: [...row],
    });
  }

  recordDelete(schema: string, tableName: string, row: StorageRow): void {
    if (!this.active || this.applyingUndo) return;
    this.undoLog.push({
      seq: undoSeqSource++, schema: schema.toUpperCase(), table: tableName.toUpperCase(),
      kind: 'delete', row: [...row],
    });
  }

  recordUpdate(schema: string, tableName: string, before: StorageRow, after: StorageRow): void {
    if (!this.active || this.applyingUndo) return;
    this.undoLog.push({
      seq: undoSeqSource++, schema: schema.toUpperCase(), table: tableName.toUpperCase(),
      kind: 'update', before: [...before], after: [...after],
    });
  }

  /** This session's uncommitted changes for one table (for the coordinator). */
  undoRecordsFor(schema: string, tableName: string): readonly UndoRecord[] {
    if (!this.active || this.undoLog.length === 0) return [];
    const s = schema.toUpperCase(), t = tableName.toUpperCase();
    return this.undoLog.filter(r => r.schema === s && r.table === t);
  }

  /**
   * The rows this session should see for a table, or null to read the
   * physical rows directly (no other writer has uncommitted changes).
   */
  visibleRows(schema: string, tableName: string): StorageRow[] | null {
    return this.coordinator?.committedImageFor(
      this, schema, tableName,
      () => this.storage.getRows(schema, tableName),
    ) ?? null;
  }

  /** Begin an implicit transaction on first DML; no-op when already active. */
  begin(): void {
    if (this.active) return;
    this.undoLog = [];
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
    this.undoLog = [];
    this.savepoints.clear();
    this.active = false;
    this.coordinator?.unregisterWriter(this);
    if (wasActive) this.observer.onCommit(this.txId, performance.now() - startedAt);
    return wasActive;
  }

  /** End the transaction reverting only this session's changes. */
  rollback(): boolean {
    this.applyUndo(0);
    const wasActive = this.active;
    this.undoLog = [];
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
    const pos = this.savepoints.get(key);
    if (pos === undefined) {
      throw new OracleError(1086, `savepoint '${key}' never established in this session or is invalid`);
    }
    this.applyUndo(pos);
    this.undoLog.length = pos;
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
    this.savepoints.set(key, this.undoLog.length);
  }

  private autonomousStack: {
    undoLog: UndoRecord[];
    savepoints: Map<string, number>;
    active: boolean;
    txId: number;
    startedAt: number;
  }[] = [];

  enterAutonomous(): void {
    this.autonomousStack.push({
      undoLog: this.undoLog,
      savepoints: this.savepoints,
      active: this.active,
      txId: this.txId,
      startedAt: this.startedAt,
    });
    if (this.active) this.coordinator?.unregisterWriter(this);
    this.undoLog = [];
    this.savepoints = new Map();
    this.active = false;
  }

  exitAutonomous(): void {
    const saved = this.autonomousStack.pop();
    if (!saved) return;
    if (this.active) this.rollback();
    this.undoLog = saved.undoLog;
    this.savepoints = saved.savepoints;
    this.active = saved.active;
    this.txId = saved.txId;
    this.startedAt = saved.startedAt;
    if (this.active) this.coordinator?.registerWriter(this);
  }

  /**
   * Reverse-apply this session's undo records down to (excluding) log
   * position `downTo`, newest first. The undo sink is suspended so the
   * reverting mutations are never themselves recorded — neither in this
   * log nor in another session's (a rollback can run while another
   * session's statement scope holds the sink, e.g. ALTER SYSTEM KILL
   * SESSION).
   */
  private applyUndo(downTo: number): void {
    if (this.undoLog.length <= downTo) return;
    this.applyingUndo = true;
    const prevSink = this.storage.setUndoSink(null);
    try {
      for (let i = this.undoLog.length - 1; i >= downTo; i--) {
        const rec = this.undoLog[i];
        if (!this.storage.tableExists(rec.schema, rec.table)) continue;
        if (rec.kind === 'insert') {
          let removed = false;
          this.storage.deleteRows(rec.schema, rec.table, r => {
            if (removed || !rowEquals(r, rec.row)) return false;
            removed = true;
            return true;
          });
        } else if (rec.kind === 'delete') {
          this.storage.insertRow(rec.schema, rec.table, [...rec.row]);
        } else {
          let restored = false;
          this.storage.updateRows(rec.schema, rec.table,
            r => {
              if (restored || !rowEquals(r, rec.after)) return false;
              restored = true;
              return true;
            },
            () => [...rec.before]);
        }
      }
    } finally {
      this.storage.setUndoSink(prevSink);
      this.applyingUndo = false;
    }
  }
}
