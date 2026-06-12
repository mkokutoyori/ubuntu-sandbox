/**
 * OracleStorage — Oracle-specific in-memory storage.
 *
 * Adds tablespace management, DUAL table, and Oracle data file tracking.
 */

import { BaseStorage, type TableMeta, type ColumnMeta } from '../engine/storage/BaseStorage';
import { oracleVarchar2 } from '../engine/catalog/DataType';
import { ORACLE_CONFIG } from './OracleConfig';
import { parseSize } from './views/_fileSize';

export interface TablespaceMeta {
  name: string;
  type: 'PERMANENT' | 'TEMPORARY' | 'UNDO';
  status: 'ONLINE' | 'OFFLINE' | 'READ ONLY';
  datafiles: { path: string; size: string; autoextend: boolean }[];
  blockSize: number;
  /** LOGGING / NOLOGGING — affects whether DML against the tablespace generates redo. */
  logging: boolean;
  /** FORCE LOGGING overrides the per-segment NOLOGGING hint. */
  forceLogging: boolean;
  /** EXTENT MANAGEMENT LOCAL is the only mode the simulator supports. */
  extentManagement: 'LOCAL' | 'DICTIONARY';
  /** SEGMENT SPACE MANAGEMENT AUTO | MANUAL. */
  segmentSpaceManagement: 'AUTO' | 'MANUAL';
  /** Either SYSTEM-allocated extents or UNIFORM SIZE n. */
  allocationType: 'SYSTEM' | 'UNIFORM' | 'USER';
  /** BIGFILE tablespaces map to a single datafile (the simulator does not enforce this). */
  bigfile: boolean;
  /** Whether the tablespace is encrypted (ENCRYPTION USING …). */
  encrypted: boolean;
  /** FLASHBACK ON | OFF — defaults to ON for permanent tablespaces. */
  flashbackOn: boolean;
  /** Initial extent size in bytes (set at CREATE TABLESPACE time). */
  initialExtent: number;
  /** Next extent size in bytes (controls future allocations under DICTIONARY mgmt). */
  nextExtent: number;
  /** Minimum extent length in bytes. */
  minExtentLength: number;
}

/**
 * Fill in the optional storage-attribute defaults for a tablespace.
 * Centralises the "what does Oracle assume when the DDL omits this?"
 * answers so views never have to invent values themselves.
 */
export function normaliseTablespace(
  ts: Partial<TablespaceMeta> & Pick<TablespaceMeta, 'name' | 'type' | 'status' | 'datafiles' | 'blockSize'>,
): TablespaceMeta {
  return {
    name: ts.name.toUpperCase(),
    type: ts.type,
    status: ts.status,
    datafiles: ts.datafiles,
    blockSize: ts.blockSize,
    logging: ts.logging ?? true,
    forceLogging: ts.forceLogging ?? false,
    extentManagement: ts.extentManagement ?? 'LOCAL',
    segmentSpaceManagement: ts.segmentSpaceManagement ?? (ts.type === 'TEMPORARY' ? 'MANUAL' : 'AUTO'),
    allocationType: ts.allocationType ?? 'SYSTEM',
    bigfile: ts.bigfile ?? false,
    encrypted: ts.encrypted ?? false,
    flashbackOn: ts.flashbackOn ?? (ts.type === 'PERMANENT'),
    initialExtent: ts.initialExtent ?? 65536,
    nextExtent: ts.nextExtent ?? 1048576,
    minExtentLength: ts.minExtentLength ?? 65536,
  };
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
    const seed: Array<Omit<TablespaceMeta, 'logging' | 'forceLogging' | 'extentManagement' | 'segmentSpaceManagement' | 'allocationType' | 'bigfile' | 'encrypted' | 'flashbackOn'>> = [
      { name: 'SYSTEM', type: 'PERMANENT', status: 'ONLINE', datafiles: [{ path: `${oradata}/system01.dbf`, size: '800M', autoextend: true }], blockSize: 8192 },
      { name: 'SYSAUX', type: 'PERMANENT', status: 'ONLINE', datafiles: [{ path: `${oradata}/sysaux01.dbf`, size: '550M', autoextend: true }], blockSize: 8192 },
      { name: 'UNDOTBS1', type: 'UNDO', status: 'ONLINE', datafiles: [{ path: `${oradata}/undotbs01.dbf`, size: '200M', autoextend: true }], blockSize: 8192 },
      { name: 'USERS', type: 'PERMANENT', status: 'ONLINE', datafiles: [{ path: `${oradata}/users01.dbf`, size: '100M', autoextend: true }], blockSize: 8192 },
      { name: 'TEMP', type: 'TEMPORARY', status: 'ONLINE', datafiles: [{ path: `${oradata}/temp01.dbf`, size: '100M', autoextend: true }], blockSize: 8192 },
    ];
    for (const ts of seed) this.tablespaces.set(ts.name, normaliseTablespace(ts));
  }

  private initDual(): void {
    const dualCol: ColumnMeta = { name: 'DUMMY', dataType: oracleVarchar2(1), ordinalPosition: 0 };
    const dualMeta: TableMeta = { schema: 'SYS', name: 'DUAL', columns: [dualCol], constraints: [], tablespace: 'SYSTEM', rowCount: 1 };
    this.ensureSchema('SYS');
    this.tables.get('SYS')!.set('DUAL', { meta: dualMeta, rows: [['X']] });
  }

  // ── Tablespace management ────────────────────────────────────────

  createTablespace(ts: Partial<TablespaceMeta> & Pick<TablespaceMeta, 'name' | 'type' | 'status' | 'datafiles' | 'blockSize'>): void {
    if (this.tablespaces.has(ts.name.toUpperCase())) {
      throw new Error(`Tablespace ${ts.name} already exists`);
    }
    this.tablespaces.set(ts.name.toUpperCase(), normaliseTablespace(ts));
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

  /**
   * Canonical datafile enumeration — FILE# assigned sequentially in
   * tablespace order with temp files excluded, exactly like V$DATAFILE.
   * Single source of truth shared by the dictionary views, the RMAN
   * context and the instance's open-time existence checks, so they all
   * agree on file numbers and paths.
   */
  listDatafiles(): { fileNo: number; path: string; sizeBytes: number; tablespace: string }[] {
    const out: { fileNo: number; path: string; sizeBytes: number; tablespace: string }[] = [];
    let fileNo = 1;
    for (const ts of this.getAllTablespaces()) {
      if (ts.type === 'TEMPORARY') continue;
      for (const df of ts.datafiles) {
        out.push({ fileNo: fileNo++, path: df.path, sizeBytes: parseSize(df.size), tablespace: ts.name });
      }
    }
    return out;
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
