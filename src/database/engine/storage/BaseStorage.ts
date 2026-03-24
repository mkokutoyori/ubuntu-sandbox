/**
 * BaseStorage — Abstract in-memory storage layer for a SQL database.
 *
 * Manages tables, rows, indexes, and sequences in memory.
 * Subclasses add dialect-specific storage features (tablespaces, segments).
 */

import type { ColumnDataType } from '../catalog/DataType';

// ── Row representation ──────────────────────────────────────────────

/** Values are stored as JS primitives. NULL is represented as null. */
export type CellValue = string | number | boolean | null | Date;

/** A row is an array of cell values, ordered by column index. */
export type StorageRow = CellValue[];

// ── Table metadata ──────────────────────────────────────────────────

export interface ColumnMeta {
  name: string;
  dataType: ColumnDataType;
  ordinalPosition: number;
  defaultValue?: CellValue;
}

export interface ConstraintMeta {
  name: string;
  type: 'PRIMARY_KEY' | 'UNIQUE' | 'FOREIGN_KEY' | 'CHECK' | 'NOT_NULL';
  columns: string[];
  refTable?: string;
  refColumns?: string[];
  checkExpression?: string;
  onDelete?: 'CASCADE' | 'SET_NULL';
}

export interface IndexMeta {
  name: string;
  tableName: string;
  columns: string[];
  unique: boolean;
  bitmap?: boolean;
  expressions?: (string | null)[];
}

export interface SequenceMeta {
  name: string;
  currentValue: number;
  incrementBy: number;
  minValue: number;
  maxValue: number;
  cache: number;
  cycle: boolean;
}

export interface TableMeta {
  schema: string;
  name: string;
  columns: ColumnMeta[];
  constraints: ConstraintMeta[];
  tablespace?: string;
  temporary?: boolean;
  rowCount: number;
}

export interface TriggerMeta {
  schema: string;
  name: string;
  timing: 'BEFORE' | 'AFTER' | 'INSTEAD OF';
  events: Array<'INSERT' | 'UPDATE' | 'DELETE'>;
  tableName: string;
  tableSchema: string;
  forEachRow: boolean;
  whenCondition?: string;
  body: string;
  enabled: boolean;
}

export interface ViewMeta {
  schema: string;
  name: string;
  columns?: string[];
  queryText: string;
  queryAST?: any;
  withCheckOption?: boolean;
  withReadOnly?: boolean;
}

export interface SynonymMeta {
  owner: string;
  name: string;
  tableOwner: string;
  tableName: string;
  dbLink?: string;
  isPublic: boolean;
}

// ── Abstract Storage ────────────────────────────────────────────────

export abstract class BaseStorage {
  /** Schema → Table name → Table data */
  protected tables: Map<string, Map<string, { meta: TableMeta; rows: StorageRow[] }>> = new Map();
  /** Schema → Sequence name → Sequence state */
  protected sequences: Map<string, Map<string, SequenceMeta>> = new Map();
  /** Schema → Index name → Index meta */
  protected indexes: Map<string, Map<string, IndexMeta>> = new Map();
  /** Schema → View name → View meta */
  protected views: Map<string, Map<string, ViewMeta>> = new Map();
  /** Schema → Trigger name → Trigger meta */
  protected triggers: Map<string, Map<string, TriggerMeta>> = new Map();
  /** Synonyms (public + private) */
  protected synonyms: Map<string, SynonymMeta> = new Map();

  // ── Schema management ────────────────────────────────────────────

  ensureSchema(schema: string): void {
    const s = schema.toUpperCase();
    if (!this.tables.has(s)) this.tables.set(s, new Map());
    if (!this.sequences.has(s)) this.sequences.set(s, new Map());
    if (!this.indexes.has(s)) this.indexes.set(s, new Map());
    if (!this.views.has(s)) this.views.set(s, new Map());
    if (!this.triggers.has(s)) this.triggers.set(s, new Map());
  }

  getSchemas(): string[] {
    return Array.from(this.tables.keys());
  }

  // ── Table operations ─────────────────────────────────────────────

  createTable(meta: TableMeta): void {
    const schema = meta.schema.toUpperCase();
    const name = meta.name.toUpperCase();
    this.ensureSchema(schema);
    const schemaTables = this.tables.get(schema)!;
    if (schemaTables.has(name)) {
      throw new Error(`Table ${schema}.${name} already exists`);
    }
    schemaTables.set(name, { meta: { ...meta, schema, name }, rows: [] });
  }

  dropTable(schema: string, name: string): void {
    const s = schema.toUpperCase();
    const n = name.toUpperCase();
    const schemaTables = this.tables.get(s);
    if (!schemaTables?.has(n)) throw new Error(`Table ${s}.${n} does not exist`);
    schemaTables.delete(n);
    // Drop associated indexes
    const schemaIndexes = this.indexes.get(s);
    if (schemaIndexes) {
      for (const [idxName, idx] of schemaIndexes) {
        if (idx.tableName === n) schemaIndexes.delete(idxName);
      }
    }
  }

  tableExists(schema: string, name: string): boolean {
    return this.tables.get(schema.toUpperCase())?.has(name.toUpperCase()) ?? false;
  }

  getTableMeta(schema: string, name: string): TableMeta | undefined {
    return this.tables.get(schema.toUpperCase())?.get(name.toUpperCase())?.meta;
  }

  getTableNames(schema: string): string[] {
    return Array.from(this.tables.get(schema.toUpperCase())?.keys() ?? []);
  }

  getAllTables(): TableMeta[] {
    const result: TableMeta[] = [];
    for (const schemaTables of this.tables.values()) {
      for (const { meta } of schemaTables.values()) result.push(meta);
    }
    return result;
  }

  // ── Row operations ───────────────────────────────────────────────

  insertRow(schema: string, tableName: string, row: StorageRow): void {
    const table = this.getTableData(schema, tableName);
    table.rows.push(row);
    table.meta.rowCount = table.rows.length;
  }

  insertRows(schema: string, tableName: string, rows: StorageRow[]): number {
    const table = this.getTableData(schema, tableName);
    table.rows.push(...rows);
    table.meta.rowCount = table.rows.length;
    return rows.length;
  }

  getRows(schema: string, tableName: string): StorageRow[] {
    return this.getTableData(schema, tableName).rows;
  }

  deleteRows(schema: string, tableName: string, predicate: (row: StorageRow) => boolean): number {
    const table = this.getTableData(schema, tableName);
    const before = table.rows.length;
    table.rows = table.rows.filter(row => !predicate(row));
    table.meta.rowCount = table.rows.length;
    return before - table.rows.length;
  }

  updateRows(schema: string, tableName: string, predicate: (row: StorageRow) => boolean, updater: (row: StorageRow) => StorageRow): number {
    const table = this.getTableData(schema, tableName);
    let count = 0;
    for (let i = 0; i < table.rows.length; i++) {
      if (predicate(table.rows[i])) {
        table.rows[i] = updater(table.rows[i]);
        count++;
      }
    }
    return count;
  }

  truncateTable(schema: string, tableName: string): void {
    const table = this.getTableData(schema, tableName);
    table.rows = [];
    table.meta.rowCount = 0;
  }

  // ── Sequence operations ──────────────────────────────────────────

  createSequence(schema: string, seq: SequenceMeta): void {
    const s = schema.toUpperCase();
    this.ensureSchema(s);
    this.sequences.get(s)!.set(seq.name.toUpperCase(), seq);
  }

  nextVal(schema: string, seqName: string): number {
    const seq = this.sequences.get(schema.toUpperCase())?.get(seqName.toUpperCase());
    if (!seq) throw new Error(`Sequence ${schema}.${seqName} does not exist`);
    seq.currentValue += seq.incrementBy;
    if (seq.currentValue > seq.maxValue) {
      if (seq.cycle) seq.currentValue = seq.minValue;
      else throw new Error(`Sequence ${seqName} exceeded MAXVALUE`);
    }
    return seq.currentValue;
  }

  currVal(schema: string, seqName: string): number {
    const seq = this.sequences.get(schema.toUpperCase())?.get(seqName.toUpperCase());
    if (!seq) throw new Error(`Sequence ${schema}.${seqName} does not exist`);
    return seq.currentValue;
  }

  dropSequence(schema: string, seqName: string): void {
    this.sequences.get(schema.toUpperCase())?.delete(seqName.toUpperCase());
  }

  sequenceExists(schema: string, name: string): boolean {
    return this.sequences.get(schema.toUpperCase())?.has(name.toUpperCase()) ?? false;
  }

  getSequence(schema: string, name: string): SequenceMeta | undefined {
    return this.sequences.get(schema.toUpperCase())?.get(name.toUpperCase());
  }

  // ── Index operations ─────────────────────────────────────────────

  createIndex(schema: string, idx: IndexMeta): void {
    const s = schema.toUpperCase();
    this.ensureSchema(s);
    this.indexes.get(s)!.set(idx.name.toUpperCase(), { ...idx, tableName: idx.tableName.toUpperCase() });
  }

  dropIndex(schema: string, name: string): void {
    this.indexes.get(schema.toUpperCase())?.delete(name.toUpperCase());
  }

  getIndexes(schema: string, tableName?: string): IndexMeta[] {
    const schemaIndexes = this.indexes.get(schema.toUpperCase());
    if (!schemaIndexes) return [];
    const all = Array.from(schemaIndexes.values());
    if (tableName) return all.filter(i => i.tableName === tableName.toUpperCase());
    return all;
  }

  // ── Column alteration ────────────────────────────────────────────

  addColumn(schema: string, tableName: string, col: ColumnMeta): void {
    const table = this.getTableData(schema, tableName);
    table.meta.columns.push(col);
    // Add null values to all existing rows
    for (const row of table.rows) {
      row.push(col.defaultValue ?? null);
    }
  }

  dropColumn(schema: string, tableName: string, columnName: string): void {
    const table = this.getTableData(schema, tableName);
    const colIdx = table.meta.columns.findIndex(c => c.name.toUpperCase() === columnName.toUpperCase());
    if (colIdx < 0) throw new Error(`Column ${columnName} not found in ${tableName}`);
    table.meta.columns.splice(colIdx, 1);
    for (const row of table.rows) row.splice(colIdx, 1);
    // Re-index ordinal positions
    table.meta.columns.forEach((c, i) => c.ordinalPosition = i);
  }

  // ── View operations ─────────────────────────────────────────────

  createView(meta: ViewMeta): void {
    const schema = meta.schema.toUpperCase();
    const name = meta.name.toUpperCase();
    this.ensureSchema(schema);
    this.views.get(schema)!.set(name, { ...meta, schema, name });
  }

  dropView(schema: string, name: string): void {
    const s = schema.toUpperCase();
    const n = name.toUpperCase();
    const schemaViews = this.views.get(s);
    if (!schemaViews?.has(n)) throw new Error(`View ${s}.${n} does not exist`);
    schemaViews.delete(n);
  }

  viewExists(schema: string, name: string): boolean {
    return this.views.get(schema.toUpperCase())?.has(name.toUpperCase()) ?? false;
  }

  getViewMeta(schema: string, name: string): ViewMeta | undefined {
    return this.views.get(schema.toUpperCase())?.get(name.toUpperCase());
  }

  getAllViews(): ViewMeta[] {
    const result: ViewMeta[] = [];
    for (const schemaViews of this.views.values()) {
      for (const view of schemaViews.values()) result.push(view);
    }
    return result;
  }

  // ── Trigger operations ──────────────────────────────────────────

  createTrigger(meta: TriggerMeta): void {
    const schema = meta.schema.toUpperCase();
    const name = meta.name.toUpperCase();
    this.ensureSchema(schema);
    this.triggers.get(schema)!.set(name, { ...meta, schema, name });
  }

  dropTrigger(schema: string, name: string): void {
    const s = schema.toUpperCase();
    const n = name.toUpperCase();
    const schemaTriggers = this.triggers.get(s);
    if (!schemaTriggers?.has(n)) throw new Error(`Trigger ${s}.${n} does not exist`);
    schemaTriggers.delete(n);
  }

  getTriggersForTable(schema: string, tableName: string): TriggerMeta[] {
    const s = schema.toUpperCase();
    const t = tableName.toUpperCase();
    const result: TriggerMeta[] = [];
    const schemaTriggers = this.triggers.get(s);
    if (schemaTriggers) {
      for (const trigger of schemaTriggers.values()) {
        if (trigger.tableSchema.toUpperCase() === s && trigger.tableName.toUpperCase() === t && trigger.enabled) {
          result.push(trigger);
        }
      }
    }
    return result;
  }

  getAllTriggers(): TriggerMeta[] {
    const result: TriggerMeta[] = [];
    for (const schemaTriggers of this.triggers.values()) {
      for (const trigger of schemaTriggers.values()) result.push(trigger);
    }
    return result;
  }

  // ── Synonym operations ──────────────────────────────────────────

  createSynonym(meta: SynonymMeta): void {
    const key = `${meta.owner.toUpperCase()}.${meta.name.toUpperCase()}`;
    this.synonyms.set(key, { ...meta, owner: meta.owner.toUpperCase(), name: meta.name.toUpperCase(), tableOwner: meta.tableOwner.toUpperCase(), tableName: meta.tableName.toUpperCase() });
  }

  dropSynonym(owner: string, name: string): void {
    const key = `${owner.toUpperCase()}.${name.toUpperCase()}`;
    if (!this.synonyms.has(key)) throw new Error(`Synonym ${owner}.${name} does not exist`);
    this.synonyms.delete(key);
  }

  getSynonym(owner: string, name: string): SynonymMeta | undefined {
    return this.synonyms.get(`${owner.toUpperCase()}.${name.toUpperCase()}`);
  }

  getAllSynonyms(): SynonymMeta[] {
    return Array.from(this.synonyms.values());
  }

  // ── Internals ────────────────────────────────────────────────────

  protected getTableData(schema: string, tableName: string): { meta: TableMeta; rows: StorageRow[] } {
    const s = schema.toUpperCase();
    const n = tableName.toUpperCase();
    const table = this.tables.get(s)?.get(n);
    if (!table) throw new Error(`Table ${s}.${n} does not exist`);
    return table;
  }
}
