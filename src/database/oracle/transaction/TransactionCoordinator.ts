/**
 * TransactionCoordinator — READ COMMITTED visibility across sessions.
 *
 * Every session with an open transaction registers as a writer. A
 * reader's view of a table is computed by taking the physical rows and
 * reverse-applying (newest first, in global mutation order) the undo
 * records of every *other* active writer — which yields the last
 * committed state plus the reader's own uncommitted changes. This
 * replaces the old single-provider model, which arbitrarily served the
 * first other writer's begin-snapshot and broke down as soon as two
 * writers were active on the same table.
 */

import type { StorageRow } from '../../engine/storage/BaseStorage';
import { reverseApplyInMemory, type UndoRecord } from './TransactionManager';

export interface UndoRecordsProvider {
  undoRecordsFor(schema: string, tableName: string): readonly UndoRecord[];
}

export class TransactionCoordinator {
  private readonly writers = new Set<UndoRecordsProvider>();

  registerWriter(w: UndoRecordsProvider): void { this.writers.add(w); }
  unregisterWriter(w: UndoRecordsProvider): void { this.writers.delete(w); }

  /**
   * The table image `reader` should see, or null when no other writer
   * has uncommitted changes on it (caller then reads physical rows,
   * which include the reader's own changes).
   */
  committedImageFor(
    reader: UndoRecordsProvider, schema: string, tableName: string,
    physicalRows: () => StorageRow[],
  ): StorageRow[] | null {
    let records: UndoRecord[] | null = null;
    for (const w of this.writers) {
      if (w === reader) continue;
      const recs = w.undoRecordsFor(schema, tableName);
      if (recs.length === 0) continue;
      records = records ? records.concat(recs) : [...recs];
    }
    if (!records) return null;
    records.sort((a, b) => a.seq - b.seq);
    const rows = physicalRows().map(r => [...r]);
    for (let i = records.length - 1; i >= 0; i--) {
      reverseApplyInMemory(rows, records[i]);
    }
    return rows;
  }
}
