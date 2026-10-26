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
  rewriteRows(schema: string, tableName: string, apply: (rows: StorageRow[]) => void): void;
  setUndoSink(sink: UndoSink | null): UndoSink | null;
}

/** One attributed row change; `seq` is a global order across sessions. */
export type UndoRecord =
  | { seq: number; schema: string; table: string; kind: 'insert'; row: StorageRow }
  | { seq: number; schema: string; table: string; kind: 'delete'; row: StorageRow }
  | { seq: number; schema: string; table: string; kind: 'update'; before: StorageRow; after: StorageRow };

/** Global mutation order, shared by every session of every instance. */
let undoSeqSource = 1;

function rowSignature(row: StorageRow): string {
  let key = '';
  for (const cell of row) {
    if (cell === null || cell === undefined) key += 'N;';
    else if (cell instanceof Date) key += `d${cell.getTime()};`;
    else if (typeof cell === 'string') key += `s${cell.length}:${cell};`;
    else key += `${typeof cell === 'number' ? 'n' : 'b'}${cell};`;
  }
  return `${row.length}|${key}`;
}

class RowRestorer {
  private readonly bySignature = new Map<string, StorageRow[]>();
  private readonly removed = new Set<StorageRow>();
  private readonly indexedCount: number;
  private indexed = 0;
  private applied = 0;

  constructor(
    private readonly rows: StorageRow[],
    private readonly newestFirst: readonly UndoRecord[],
  ) {
    this.indexedCount = rows.length;
  }

  private index(row: StorageRow): void {
    const key = rowSignature(row);
    const bucket = this.bySignature.get(key);
    if (bucket) bucket.push(row); else this.bySignature.set(key, [row]);
  }

  private take(row: StorageRow): StorageRow | undefined {
    return this.bySignature.get(rowSignature(row))?.pop();
  }

  advance(stop: () => boolean): boolean {
    const { rows, newestFirst } = this;
    while (this.indexed < this.indexedCount) {
      if ((this.indexed & 255) === 255 && stop()) return false;
      this.index(rows[this.indexed++]);
    }
    while (this.applied < newestFirst.length) {
      if ((this.applied & 255) === 255 && stop()) return false;
      const rec = newestFirst[this.applied++];
      if (rec.kind === 'insert') {
        const found = this.take(rec.row);
        if (found) this.removed.add(found);
      } else if (rec.kind === 'delete') {
        const restored = [...rec.row];
        rows.push(restored);
        this.index(restored);
      } else {
        const found = this.take(rec.after);
        if (!found) continue;
        found.length = 0;
        for (const cell of rec.before) found.push(cell);
        this.index(found);
      }
    }
    if (this.removed.size === 0) return true;
    let kept = 0;
    for (const row of rows) if (!this.removed.has(row)) rows[kept++] = row;
    rows.length = kept;
    return true;
  }
}

export function restoreRows(rows: StorageRow[], newestFirst: readonly UndoRecord[]): void {
  new RowRestorer(rows, newestFirst).advance(() => false);
}

export interface UndoApplication {
  advance(stop: () => boolean): boolean;
}

export interface RollbackJob extends UndoApplication {
  finish(): boolean;
}

const NOTHING_TO_UNDO: UndoApplication = { advance: () => true };

/** Lifecycle notifications, used by the executor to publish oracle.transaction.* events. */
export interface TransactionObserver {
  onBegin(txId: number): void;
  onCommit(txId: number, durationMs: number, changes: readonly UndoRecord[]): void;
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
    const changes = this.undoLog;
    this.undoLog = [];
    this.savepoints.clear();
    this.active = false;
    this.coordinator?.unregisterWriter(this);
    if (wasActive) this.observer.onCommit(this.txId, performance.now() - startedAt, changes);
    return wasActive;
  }

  /** End the transaction reverting only this session's changes. */
  rollback(): boolean {
    const job = this.beginRollback();
    job.advance(() => false);
    return job.finish();
  }

  beginRollback(): RollbackJob {
    const undo = this.beginUndo(0);
    return {
      advance: (stop) => undo.advance(stop),
      finish: () => {
        const wasActive = this.active;
        this.undoLog = [];
        this.savepoints.clear();
        this.active = false;
        this.coordinator?.unregisterWriter(this);
        if (wasActive) this.observer.onRollback(this.txId);
        return wasActive;
      },
    };
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
    this.beginUndo(downTo).advance(() => false);
  }

  private beginUndo(downTo: number): UndoApplication {
    if (this.undoLog.length <= downTo) return NOTHING_TO_UNDO;
    const perTable = new Map<string, UndoRecord[]>();
    for (let i = this.undoLog.length - 1; i >= downTo; i--) {
      const rec = this.undoLog[i];
      if (!this.storage.tableExists(rec.schema, rec.table)) continue;
      const key = `${rec.schema}\u0000${rec.table}`;
      const list = perTable.get(key);
      if (list) list.push(rec); else perTable.set(key, [rec]);
    }
    const tables = [...perTable.values()];
    let current = 0;
    let restorer: RowRestorer | null = null;
    let restoring: StorageRow[] | null = null;
    return {
      advance: (stop) => {
        this.applyingUndo = true;
        const prevSink = this.storage.setUndoSink(null);
        try {
          while (current < tables.length) {
            const records = tables[current];
            const { schema, table } = records[0];
            const rows = this.storage.getRows(schema, table);
            if (restorer !== null && restoring !== rows) {
              throw new OracleError(8177, "can't serialize access for this transaction");
            }
            restorer ??= new RowRestorer(rows, records);
            restoring = rows;
            if (!restorer.advance(stop)) return false;
            this.storage.rewriteRows(schema, table, () => undefined);
            restorer = null;
            current++;
          }
          return true;
        } finally {
          this.storage.setUndoSink(prevSink);
          this.applyingUndo = false;
        }
      },
    };
  }
}
