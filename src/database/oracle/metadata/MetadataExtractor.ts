/**
 * MetadataExtractor — Re-render the CREATE statement for any object
 * the catalog knows about.
 *
 * This is the engine behind `DBMS_METADATA.GET_DDL` on a real Oracle
 * database. `GET_DDL` is the canonical object-management tool: DBAs
 * use it to script tables, indexes, views and procedures out of one
 * environment and into another. The simulator's executor mutates the
 * catalog as DDL runs; this extractor walks back from the catalog and
 * reconstructs the SQL text.
 *
 * Returns the rendered DDL or `null` if the object is not found.
 * `null` mirrors the `ORA-31603` Oracle would raise for an unknown
 * object — the caller decides whether to surface the error.
 */

import type { OracleStorage } from '../OracleStorage';
import type { OracleCatalog } from '../OracleCatalog';
import type { ColumnDataType } from '../../engine/catalog/DataType';
import type { ColumnMeta, ConstraintMeta, TableMeta, ViewMeta, IndexMeta,
              SequenceMeta, SynonymMeta, TriggerMeta } from '../../engine/storage/BaseStorage';

export type MetadataObjectType =
  | 'TABLE' | 'VIEW' | 'INDEX' | 'SEQUENCE' | 'SYNONYM'
  | 'TRIGGER' | 'USER' | 'ROLE' | 'PROCEDURE' | 'FUNCTION' | 'PACKAGE';

export class MetadataExtractor {
  constructor(
    private readonly storage: OracleStorage,
    private readonly catalog: OracleCatalog,
  ) {}

  /**
   * Reproduce the CREATE statement for `owner.name`. The `objectType`
   * argument matches the way `DBMS_METADATA.GET_DDL('TABLE', 'EMP',
   * 'SCOTT')` is called on real Oracle. Returns `null` when the object
   * does not exist (caller raises ORA-31603).
   */
  getDdl(objectType: MetadataObjectType, name: string, owner: string = 'SYS'): string | null {
    const o = owner.toUpperCase();
    const n = name.toUpperCase();
    switch (objectType) {
      case 'TABLE':     return this.tableDdl(o, n);
      case 'VIEW':      return this.viewDdl(o, n);
      case 'INDEX':     return this.indexDdl(o, n);
      case 'SEQUENCE':  return this.sequenceDdl(o, n);
      case 'SYNONYM':   return this.synonymDdl(o, n);
      case 'TRIGGER':   return this.triggerDdl(o, n);
      case 'USER':      return this.userDdl(n);
      case 'ROLE':      return this.roleDdl(n);
      case 'PROCEDURE':
      case 'FUNCTION':
      case 'PACKAGE':   return this.storedUnitDdl(objectType, o, n);
      default:          return null;
    }
  }

  // ── Per-object renderers ──────────────────────────────────────────

  private tableDdl(owner: string, name: string): string | null {
    const t = this.storage.getTableMeta(owner, name);
    if (!t) return null;
    const lines: string[] = [];
    lines.push(`  CREATE TABLE "${owner}"."${t.name}"`);
    lines.push('   (' + t.columns.map(c => this.columnClause(c, t)).join(',\n    '));
    const constraintClauses = this.constraintClauses(t);
    for (const c of constraintClauses) lines.push('    ,' + c);
    lines.push('   )');
    if (t.tablespace) lines.push(`  TABLESPACE "${t.tablespace}"`);
    if (t.compression?.enabled) {
      lines.push(`  COMPRESS${t.compression.for ? ` FOR ${t.compression.for}` : ''}`);
    }
    if (t.partitioning) {
      lines.push(`  PARTITION BY ${t.partitioning.type} (${t.partitioning.columns.join(', ')})`);
      lines.push('  (' + t.partitioning.partitions.map(p =>
        `PARTITION "${p.name}"${p.highValue ? ` VALUES LESS THAN (${p.highValue})` : ''}`).join(',\n   ') + ')');
    }
    return lines.join('\n') + ';';
  }

  private columnClause(c: ColumnMeta, t: TableMeta): string {
    const isNotNull = t.constraints.some(k =>
      k.type === 'NOT_NULL' && k.columns.length === 1 && k.columns[0] === c.name);
    const def = c.defaultValue !== undefined && c.defaultValue !== null
      ? ` DEFAULT ${this.renderLiteral(c.defaultValue as string | number | Date)}`
      : '';
    return `"${c.name}" ${this.renderType(c.dataType)}${def}${isNotNull ? ' NOT NULL' : ''}`;
  }

  private constraintClauses(t: TableMeta): string[] {
    const out: string[] = [];
    for (const k of t.constraints) {
      switch (k.type) {
        case 'PRIMARY_KEY':
          out.push(`CONSTRAINT "${k.name}" PRIMARY KEY (${k.columns.map(c => `"${c}"`).join(', ')})`);
          break;
        case 'UNIQUE':
          out.push(`CONSTRAINT "${k.name}" UNIQUE (${k.columns.map(c => `"${c}"`).join(', ')})`);
          break;
        case 'FOREIGN_KEY':
          out.push(`CONSTRAINT "${k.name}" FOREIGN KEY (${k.columns.map(c => `"${c}"`).join(', ')}) `
            + `REFERENCES "${t.schema}"."${k.refTable}" (${(k.refColumns ?? []).map(c => `"${c}"`).join(', ')})`
            + (k.onDelete ? ` ON DELETE ${k.onDelete.replace('_', ' ')}` : ''));
          break;
        case 'CHECK':
          out.push(`CONSTRAINT "${k.name}" CHECK (${k.checkExpression ?? ''})`);
          break;
      }
    }
    return out;
  }

  private viewDdl(owner: string, name: string): string | null {
    const v: ViewMeta | undefined = this.storage.getViewMeta(owner, name);
    if (!v) return null;
    const cols = v.columns && v.columns.length > 0 ? ` (${v.columns.map(c => `"${c}"`).join(', ')})` : '';
    const opt = v.withCheckOption ? '\n  WITH CHECK OPTION' : v.withReadOnly ? '\n  WITH READ ONLY' : '';
    return `  CREATE OR REPLACE FORCE EDITIONABLE VIEW "${owner}"."${v.name}"${cols} AS\n  ${v.queryText}${opt};`;
  }

  private indexDdl(owner: string, name: string): string | null {
    for (const idx of this.storage.getIndexes(owner)) {
      if (idx.name.toUpperCase() === name) return this.renderIndex(owner, idx);
    }
    return null;
  }

  private renderIndex(owner: string, idx: IndexMeta): string {
    const unique = idx.unique ? 'UNIQUE ' : '';
    const bitmap = idx.bitmap ? 'BITMAP ' : '';
    const cols = idx.columns.map(c => `"${c}"`).join(', ');
    const ts = idx.tablespace ? `\n  TABLESPACE "${idx.tablespace}"` : '';
    return `  CREATE ${bitmap}${unique}INDEX "${owner}"."${idx.name}"\n  ON "${owner}"."${idx.tableName}" (${cols})${ts};`;
  }

  private sequenceDdl(owner: string, name: string): string | null {
    const s: SequenceMeta | undefined = this.storage.getSequence(owner, name);
    if (!s) return null;
    const cache = s.cache > 1 ? ` CACHE ${s.cache}` : ' NOCACHE';
    const cycle = s.cycle ? ' CYCLE' : ' NOCYCLE';
    return `  CREATE SEQUENCE "${owner}"."${s.name}" MINVALUE ${s.minValue} MAXVALUE ${s.maxValue}`
      + ` INCREMENT BY ${s.incrementBy} START WITH ${s.currentValue}${cache}${cycle};`;
  }

  private synonymDdl(owner: string, name: string): string | null {
    const s: SynonymMeta | undefined = this.storage.getSynonym(owner, name);
    if (!s) return null;
    const pub = s.isPublic ? 'PUBLIC ' : '';
    const link = s.dbLink ? `@"${s.dbLink}"` : '';
    return `  CREATE OR REPLACE ${pub}SYNONYM "${owner}"."${s.name}" FOR "${s.tableOwner}"."${s.tableName}"${link};`;
  }

  private triggerDdl(owner: string, name: string): string | null {
    const trigs = this.storage.getAllTriggers();
    const t: TriggerMeta | undefined = trigs.find(x =>
      x.schema.toUpperCase() === owner && x.name.toUpperCase() === name);
    if (!t) return null;
    const evs = t.events.join(' OR ');
    const each = t.forEachRow ? '\n  FOR EACH ROW' : '';
    const when = t.whenCondition ? `\n  WHEN (${t.whenCondition})` : '';
    const enab = t.enabled ? '' : '\n  DISABLE';
    return `  CREATE OR REPLACE TRIGGER "${owner}"."${t.name}"\n  ${t.timing} ${evs} ON "${t.tableSchema}"."${t.tableName}"${each}${when}${enab}\n  ${t.body};`;
  }

  private userDdl(name: string): string | null {
    const u = this.catalog.getUser(name);
    if (!u) return null;
    const auth = u.authenticationType === 'EXTERNAL' ? 'IDENTIFIED EXTERNALLY'
      : u.authenticationType === 'GLOBAL' ? `IDENTIFIED GLOBALLY AS '${u.externalName ?? ''}'`
      : `IDENTIFIED BY VALUES 'S:HIDDEN'`;
    return `  CREATE USER "${u.username}" ${auth}\n  DEFAULT TABLESPACE "${u.defaultTablespace}"`
      + `\n  TEMPORARY TABLESPACE "${u.temporaryTablespace}"\n  PROFILE "${u.profile}"`
      + (u.accountStatus === 'LOCKED' ? '\n  ACCOUNT LOCK' : '') + ';';
  }

  private roleDdl(name: string): string | null {
    // We don't store role definitions explicitly; if it has any grant, we
    // know it exists.
    const cat = this.catalog as unknown as { roleGrants: { role: string }[] };
    const exists = cat.roleGrants.some(r => r.role === name)
      || ['CONNECT', 'RESOURCE', 'DBA', 'AUDIT_ADMIN', 'PUBLIC'].includes(name);
    if (!exists) return null;
    return `  CREATE ROLE "${name}";`;
  }

  private storedUnitDdl(kind: 'PROCEDURE' | 'FUNCTION' | 'PACKAGE', owner: string, name: string): string | null {
    const u = this.catalog.getStoredUnits().find(x =>
      x.schema.toUpperCase() === owner && x.name.toUpperCase() === name && x.type.toUpperCase().startsWith(kind));
    if (!u) return null;
    return `  CREATE OR REPLACE ${u.type} "${owner}"."${u.name}" AS\n${u.body};`;
  }

  // ── Helpers ────────────────────────────────────────────────────────

  private renderType(t: ColumnDataType): string {
    const n = t.name.toUpperCase();
    if (n === 'NUMBER' && t.precision !== undefined) {
      return t.scale !== undefined && t.scale !== 0
        ? `NUMBER(${t.precision},${t.scale})` : `NUMBER(${t.precision})`;
    }
    if ((n === 'VARCHAR2' || n === 'NVARCHAR2' || n === 'CHAR' || n === 'NCHAR' || n === 'RAW') && t.precision) {
      return `${n}(${t.precision})`;
    }
    return n;
  }

  private renderLiteral(v: string | number | Date): string {
    if (typeof v === 'number') return String(v);
    if (v instanceof Date) return `DATE '${v.toISOString().slice(0, 10)}'`;
    return `'${String(v).replace(/'/g, "''")}'`;
  }
}
