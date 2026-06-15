import type { StorageRow } from '../../engine/storage/BaseStorage';

interface HistoryEntry {
  scn: number;
  timeMs: number;
  rows: StorageRow[];
}

const MAX_ENTRIES_PER_TABLE = 64;

export class TableHistory {
  private entries = new Map<string, HistoryEntry[]>();

  private key(schema: string, table: string): string {
    return `${schema.toUpperCase()}.${table.toUpperCase()}`;
  }

  capture(schema: string, table: string, scn: number, rows: readonly StorageRow[]): void {
    const k = this.key(schema, table);
    let list = this.entries.get(k);
    if (!list) { list = []; this.entries.set(k, list); }
    list.push({ scn, timeMs: Date.now(), rows: rows.map(r => [...r]) });
    if (list.length > MAX_ENTRIES_PER_TABLE) list.shift();
  }

  stateAtScn(schema: string, table: string, scn: number): StorageRow[] | null {
    const list = this.entries.get(this.key(schema, table)) ?? [];
    const hit = list.find(e => e.scn >= scn);
    return hit ? hit.rows.map(r => [...r]) : null;
  }

  stateAtTime(schema: string, table: string, timeMs: number): StorageRow[] | null {
    const list = this.entries.get(this.key(schema, table)) ?? [];
    const hit = list.find(e => e.timeMs > timeMs);
    return hit ? hit.rows.map(r => [...r]) : null;
  }

  drop(schema: string, table: string): void {
    this.entries.delete(this.key(schema, table));
  }
}
