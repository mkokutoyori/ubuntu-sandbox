import type { OracleDatabase } from '../OracleDatabase';
import type { TableMeta, StorageRow, CellValue } from '../../engine/storage/BaseStorage';

/** Serialized cell — Dates need an explicit envelope to survive JSON. */
type DumpCell = string | number | boolean | null | { $date: string };

export interface DumpTableEntry {
  schema: string;
  name: string;
  columns: TableMeta['columns'];
  constraints: TableMeta['constraints'];
  tablespace?: string;
  rows: DumpCell[][];
}

/** On-disk dump file payload (JSON inside the .dmp file). */
export interface DataPumpDump {
  format: 'ORACLE-SIM-DATAPUMP';
  version: 1;
  mode: 'FULL' | 'SCHEMA' | 'TABLE';
  exportedAt: string;
  tables: DumpTableEntry[];
}

export interface ExportOptions {
  schemas?: string[];
  /** TABLES= entries, possibly schema-qualified. */
  tables?: string[];
  full?: boolean;
}

export type TableExistsAction = 'SKIP' | 'APPEND' | 'TRUNCATE' | 'REPLACE';

export interface ImportOptions {
  remapSchema?: { from: string; to: string };
  tableExistsAction: TableExistsAction;
}

export interface TransferReport {
  /** Per-table CLI lines (". . exported …" / ORA- diagnostics). */
  lines: string[];
  tables: number;
  rows: number;
}

/** Schemas that never travel in a dump — Oracle excludes the dictionary. */
const EXCLUDED_SCHEMAS = new Set(['SYS', 'SYSTEM', 'OUTLN', 'DBSNMP', 'AUDSYS', 'CTXSYS', 'XDB']);

/**
 * Data Pump engine: real export/import against the simulated database.
 * expdp serializes table metadata and rows; impdp recreates them with
 * Oracle's TABLE_EXISTS_ACTION and REMAP_SCHEMA semantics — the dump
 * file is a faithful transport, not a cosmetic artifact.
 */
export class DataPumpEngine {
  constructor(private readonly db: OracleDatabase) {}

  export(opts: ExportOptions): { dump: DataPumpDump; report: TransferReport } {
    const storage = this.db.storage;
    const mode: DataPumpDump['mode'] = opts.full ? 'FULL' : opts.tables ? 'TABLE' : 'SCHEMA';
    const schemas = opts.full
      ? storage.getSchemas().filter(s => !EXCLUDED_SCHEMAS.has(s.toUpperCase()))
      : (opts.schemas ?? []).map(s => s.toUpperCase());
    const tableFilter = opts.tables?.map(t => t.toUpperCase());

    const entries: DumpTableEntry[] = [];
    const lines: string[] = [];
    let rowTotal = 0;

    for (const schema of schemas) {
      for (const name of storage.getTableNames(schema)) {
        if (tableFilter && !tableFilter.some(t => t === name || t === `${schema}.${name}`)) continue;
        const meta = storage.getTableMeta(schema, name)!;
        const rows = storage.getRows(schema, name);
        entries.push({
          schema, name,
          columns: meta.columns,
          constraints: meta.constraints,
          tablespace: meta.tablespace,
          rows: rows.map(r => r.map(encodeCell)),
        });
        rowTotal += rows.length;
        lines.push(`. . exported "${schema}"."${name}"${' '.repeat(Math.max(1, 40 - schema.length - name.length))}${rows.length} rows`);
      }
    }

    return {
      dump: {
        format: 'ORACLE-SIM-DATAPUMP',
        version: 1,
        mode,
        exportedAt: new Date().toISOString(),
        tables: entries,
      },
      report: { lines, tables: entries.length, rows: rowTotal },
    };
  }

  /** Parse a dump file's content; null when it is not a valid dump. */
  static parse(content: string): DataPumpDump | null {
    try {
      const parsed = JSON.parse(content) as DataPumpDump;
      if (parsed && parsed.format === 'ORACLE-SIM-DATAPUMP' && Array.isArray(parsed.tables)) return parsed;
      return null;
    } catch {
      return null;
    }
  }

  import(dump: DataPumpDump, opts: ImportOptions): TransferReport {
    const storage = this.db.storage;
    const lines: string[] = [];
    let tables = 0;
    let rowTotal = 0;

    for (const entry of dump.tables) {
      const targetSchema = opts.remapSchema && entry.schema === opts.remapSchema.from.toUpperCase()
        ? opts.remapSchema.to.toUpperCase()
        : entry.schema;

      // Real impdp cannot conjure the target user (outside FULL mode):
      // ORA-01918 per affected object.
      if (!this.db.catalog.userExists(targetSchema)) {
        lines.push(`ORA-39083: Object type TABLE:"${targetSchema}"."${entry.name}" failed to create with error:`);
        lines.push(`ORA-01918: user '${targetSchema}' does not exist`);
        continue;
      }

      const rows: StorageRow[] = entry.rows.map(r => r.map(decodeCell));
      const exists = storage.tableExists(targetSchema, entry.name);

      if (exists) {
        switch (opts.tableExistsAction) {
          case 'SKIP':
            lines.push(`ORA-31684: Object type TABLE:"${targetSchema}"."${entry.name}" already exists`);
            continue;
          case 'APPEND':
            storage.insertRows(targetSchema, entry.name, rows);
            break;
          case 'TRUNCATE':
            storage.truncateTable(targetSchema, entry.name);
            storage.insertRows(targetSchema, entry.name, rows);
            break;
          case 'REPLACE':
            storage.dropTable(targetSchema, entry.name);
            this.createFromEntry(targetSchema, entry, rows);
            break;
        }
      } else {
        this.createFromEntry(targetSchema, entry, rows);
      }

      tables++;
      rowTotal += rows.length;
      lines.push(`. . imported "${targetSchema}"."${entry.name}"${' '.repeat(Math.max(1, 40 - targetSchema.length - entry.name.length))}${rows.length} rows`);
    }

    return { lines, tables, rows: rowTotal };
  }

  private createFromEntry(schema: string, entry: DumpTableEntry, rows: StorageRow[]): void {
    this.db.storage.createTable({
      schema,
      name: entry.name,
      columns: entry.columns,
      constraints: entry.constraints,
      tablespace: entry.tablespace,
      rowCount: 0,
    });
    this.db.storage.insertRows(schema, entry.name, rows);
  }
}

function encodeCell(v: CellValue): DumpCell {
  if (v instanceof Date) return { $date: v.toISOString() };
  return v as DumpCell;
}

function decodeCell(v: DumpCell): CellValue {
  if (v !== null && typeof v === 'object' && '$date' in v) return new Date(v.$date);
  return v as CellValue;
}
