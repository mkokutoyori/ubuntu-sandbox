/**
 * ExternalTableRegistry — native external-table catalogue
 * (CREATE TABLE … ORGANIZATION EXTERNAL …).
 *
 * Backs DBA_EXTERNAL_TABLES and DBA_EXTERNAL_LOCATIONS exactly the
 * way the real dictionary does: one row per external table for the
 * first view, one row per (table, location) pair for the second.
 *
 * The registry is built up reactively — when the executor parses an
 * `ORGANIZATION EXTERNAL` clause it asks us to register the table.
 * Until that happens both views are empty, exactly like a fresh DB.
 */

export type ExternalTableType = 'ORACLE_LOADER' | 'ORACLE_DATAPUMP' | 'ORACLE_HIVE' | 'ORACLE_HDFS' | 'ORACLE_BIGDATA';

export interface ExternalTable {
  readonly owner: string;
  readonly tableName: string;
  readonly typeOwner: string;
  readonly typeName: ExternalTableType;
  readonly defaultDirectoryOwner: string;
  readonly defaultDirectoryName: string;
  readonly rejectLimit: string;
  readonly accessType: 'CLOB';
  readonly accessParameters: string;
  readonly propertyClause: string;
}

export interface ExternalTableLocation {
  readonly owner: string;
  readonly tableName: string;
  readonly location: string;
  readonly directoryOwner: string;
  readonly directoryName: string;
}

export class ExternalTableRegistry {
  private tables: ExternalTable[] = [];
  private locations: ExternalTableLocation[] = [];

  /** Register a new ORGANIZATION EXTERNAL table. */
  registerTable(t: Partial<ExternalTable> & Pick<ExternalTable, 'owner' | 'tableName' | 'defaultDirectoryName'>): ExternalTable {
    const row: ExternalTable = {
      owner: t.owner.toUpperCase(),
      tableName: t.tableName.toUpperCase(),
      typeOwner: (t.typeOwner ?? 'SYS').toUpperCase(),
      typeName: t.typeName ?? 'ORACLE_LOADER',
      defaultDirectoryOwner: (t.defaultDirectoryOwner ?? 'SYS').toUpperCase(),
      defaultDirectoryName: t.defaultDirectoryName.toUpperCase(),
      rejectLimit: t.rejectLimit ?? '0',
      accessType: 'CLOB',
      accessParameters: t.accessParameters ?? '',
      propertyClause: t.propertyClause ?? 'ALL',
    };
    this.tables = this.tables.filter(x => !(x.owner === row.owner && x.tableName === row.tableName));
    this.tables.push(row);
    return row;
  }

  /** Add one LOCATION clause entry for an existing external table. */
  addLocation(owner: string, tableName: string, location: string, directoryName?: string, directoryOwner?: string): void {
    const o = owner.toUpperCase(), t = tableName.toUpperCase();
    const tbl = this.tables.find(x => x.owner === o && x.tableName === t);
    if (!tbl) throw new Error(`ORA-30657: external table ${o}.${t} does not exist`);
    this.locations.push({
      owner: o, tableName: t, location: location,
      directoryName: (directoryName ?? tbl.defaultDirectoryName).toUpperCase(),
      directoryOwner: (directoryOwner ?? tbl.defaultDirectoryOwner).toUpperCase(),
    });
  }

  /** Drop an external table and its locations. */
  drop(owner: string, tableName: string): boolean {
    const o = owner.toUpperCase(), t = tableName.toUpperCase();
    const before = this.tables.length;
    this.tables = this.tables.filter(x => !(x.owner === o && x.tableName === t));
    this.locations = this.locations.filter(x => !(x.owner === o && x.tableName === t));
    return this.tables.length < before;
  }

  getTables(): readonly ExternalTable[] { return this.tables; }
  getLocations(): readonly ExternalTableLocation[] { return this.locations; }
  isExternal(owner: string, tableName: string): boolean {
    const o = owner.toUpperCase(), t = tableName.toUpperCase();
    return this.tables.some(x => x.owner === o && x.tableName === t);
  }
}
