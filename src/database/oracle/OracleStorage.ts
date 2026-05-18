/**
 * OracleStorage — Oracle-specific in-memory storage.
 *
 * Adds tablespace management, DUAL table, and Oracle data file tracking.
 */

import { BaseStorage, type TableMeta, type ColumnMeta } from '../engine/storage/BaseStorage';
import { oracleVarchar2 } from '../engine/catalog/DataType';
import { ORACLE_CONFIG } from '../../terminal/commands/OracleConfig';

export interface TablespaceMeta {
  name: string;
  type: 'PERMANENT' | 'TEMPORARY' | 'UNDO';
  status: 'ONLINE' | 'OFFLINE' | 'READ ONLY';
  datafiles: { path: string; size: string; autoextend: boolean }[];
  blockSize: number;
}

export class OracleStorage extends BaseStorage {
  private tablespaces: Map<string, TablespaceMeta> = new Map();

  constructor() {
    super();
    this.initDefaultTablespaces();
    this.initDual();
  }

  private initDefaultTablespaces(): void {
    const oradata = ORACLE_CONFIG.ORADATA;
    const defaults: TablespaceMeta[] = [
      { name: 'SYSTEM', type: 'PERMANENT', status: 'ONLINE', datafiles: [{ path: `${oradata}/system01.dbf`, size: '800M', autoextend: true }], blockSize: 8192 },
      { name: 'SYSAUX', type: 'PERMANENT', status: 'ONLINE', datafiles: [{ path: `${oradata}/sysaux01.dbf`, size: '550M', autoextend: true }], blockSize: 8192 },
      { name: 'UNDOTBS1', type: 'UNDO', status: 'ONLINE', datafiles: [{ path: `${oradata}/undotbs01.dbf`, size: '200M', autoextend: true }], blockSize: 8192 },
      { name: 'USERS', type: 'PERMANENT', status: 'ONLINE', datafiles: [{ path: `${oradata}/users01.dbf`, size: '100M', autoextend: true }], blockSize: 8192 },
      { name: 'TEMP', type: 'TEMPORARY', status: 'ONLINE', datafiles: [{ path: `${oradata}/temp01.dbf`, size: '100M', autoextend: true }], blockSize: 8192 },
    ];
    for (const ts of defaults) this.tablespaces.set(ts.name, ts);
  }

  private initDual(): void {
    const dualCol: ColumnMeta = { name: 'DUMMY', dataType: oracleVarchar2(1), ordinalPosition: 0 };
    const dualMeta: TableMeta = { schema: 'SYS', name: 'DUAL', columns: [dualCol], constraints: [], tablespace: 'SYSTEM', rowCount: 1 };
    this.ensureSchema('SYS');
    this.tables.get('SYS')!.set('DUAL', { meta: dualMeta, rows: [['X']] });
  }

  // ── Tablespace management ────────────────────────────────────────

  createTablespace(ts: TablespaceMeta): void {
    if (this.tablespaces.has(ts.name.toUpperCase())) {
      throw new Error(`Tablespace ${ts.name} already exists`);
    }
    this.tablespaces.set(ts.name.toUpperCase(), ts);
  }

  dropTablespace(name: string): void {
    if (!this.tablespaces.has(name.toUpperCase())) {
      throw new Error(`Tablespace ${name} does not exist`);
    }
    this.tablespaces.delete(name.toUpperCase());
  }

  getTablespace(name: string): TablespaceMeta | undefined {
    return this.tablespaces.get(name.toUpperCase());
  }

  getAllTablespaces(): TablespaceMeta[] {
    return Array.from(this.tablespaces.values());
  }

  tablespaceExists(name: string): boolean {
    return this.tablespaces.has(name.toUpperCase());
  }

  /** Append a datafile to an existing tablespace. */
  addDatafileToTablespace(
    tablespaceName: string,
    datafile: { path: string; size: string; autoextend: boolean },
  ): TablespaceMeta | null {
    const ts = this.tablespaces.get(tablespaceName.toUpperCase());
    if (!ts) return null;
    ts.datafiles.push(datafile);
    return ts;
  }

  /** Update a tablespace status (ONLINE / OFFLINE / READ ONLY). */
  setTablespaceStatus(name: string, status: TablespaceMeta['status']): TablespaceMeta | null {
    const ts = this.tablespaces.get(name.toUpperCase());
    if (!ts) return null;
    ts.status = status;
    return ts;
  }

  /** Rename a tablespace (keys + meta name). */
  renameTablespace(oldName: string, newName: string): TablespaceMeta | null {
    const key = oldName.toUpperCase();
    const ts = this.tablespaces.get(key);
    if (!ts) return null;
    const newKey = newName.toUpperCase();
    if (this.tablespaces.has(newKey)) {
      throw new Error(`Tablespace ${newName} already exists`);
    }
    ts.name = newKey;
    this.tablespaces.delete(key);
    this.tablespaces.set(newKey, ts);
    return ts;
  }

  /**
   * Resize a datafile (no validation of MAXSIZE / autoextend bounds —
   * the simulator doesn't allocate real bytes).
   * @returns the owning tablespace name, or `null` if no datafile matched.
   */
  resizeDatafile(path: string, size: string): string | null {
    for (const ts of this.tablespaces.values()) {
      const df = ts.datafiles.find(d => d.path === path);
      if (df) { df.size = size; return ts.name; }
    }
    return null;
  }

  /** Flip the AUTOEXTEND flag on a datafile. */
  setDatafileAutoextend(path: string, on: boolean): string | null {
    for (const ts of this.tablespaces.values()) {
      const df = ts.datafiles.find(d => d.path === path);
      if (df) { df.autoextend = on; return ts.name; }
    }
    return null;
  }

  /**
   * Rename a datafile path inside whichever tablespace owns it.
   * @returns the tablespace name if the rename happened, `null` otherwise.
   */
  renameDatafile(oldPath: string, newPath: string): string | null {
    for (const ts of this.tablespaces.values()) {
      const df = ts.datafiles.find(d => d.path === oldPath);
      if (df) {
        df.path = newPath;
        return ts.name;
      }
    }
    return null;
  }
}
