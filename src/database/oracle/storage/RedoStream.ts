import type { StorageRow } from '../../engine/storage/BaseStorage';
import type { UndoRecord } from '../transaction/TransactionManager';
import type { TablespacePayload, SerializedTable } from '../OracleStorage';

export type RedoRecord = UndoRecord & { readonly scn: number };

const PAYLOAD_MARKER = 'ORACLE-REDO-STREAM';

export function renderRedoStream(records: readonly RedoRecord[]): string {
  return records.length === 0 ? '' : `${PAYLOAD_MARKER} ${JSON.stringify(records)}\n`;
}

export function parseRedoStream(text: string | null): RedoRecord[] {
  if (!text) return [];
  const line = text.split('\n').find((l) => l.startsWith(`${PAYLOAD_MARKER} `));
  if (!line) return [];
  try {
    const parsed: unknown = JSON.parse(line.slice(PAYLOAD_MARKER.length + 1));
    return Array.isArray(parsed) ? (parsed as RedoRecord[]) : [];
  } catch {
    return [];
  }
}

function sameRow(a: StorageRow, b: StorageRow): boolean {
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

function tableOf(payload: TablespacePayload, rec: RedoRecord): SerializedTable | null {
  return payload.tables.find(t =>
    t.schema.toUpperCase() === rec.schema.toUpperCase()
    && t.table.toUpperCase() === rec.table.toUpperCase()) ?? null;
}

export function applyRedoToTablespace(
  payload: TablespacePayload,
  rec: RedoRecord,
): TablespacePayload {
  const target = tableOf(payload, rec);
  if (!target) return payload;
  const rows = target.rows.map(r => [...r]) as StorageRow[];
  if (rec.kind === 'insert') {
    rows.push([...rec.row]);
  } else if (rec.kind === 'delete') {
    const idx = rows.findIndex(r => sameRow(r, rec.row));
    if (idx >= 0) rows.splice(idx, 1);
  } else {
    const idx = rows.findIndex(r => sameRow(r, rec.before));
    if (idx >= 0) rows[idx] = [...rec.after];
  }
  return {
    tablespace: payload.tablespace,
    tables: payload.tables.map(t => t === target ? { ...t, rows } : t),
  };
}
