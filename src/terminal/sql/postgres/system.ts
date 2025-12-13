/**
 * PostgreSQL System Catalog
 * Implementation of PostgreSQL system tables and views
 */

import { SQLResultSet } from '../generic/types';
import { SQLEngine } from '../generic/engine';
import {
  PostgresDatabase,
  PostgresRole,
  PostgresSchema,
  PostgresTable,
  PostgresColumn,
  PostgresIndex,
  PostgresView,
  PostgresSequence,
  PgStatActivity,
  PgStatDatabase,
} from './types';

/**
 * PostgreSQL System Catalog
 */
export class PostgresSystemCatalog {
  private engine: SQLEngine;
  private currentUser: string = 'postgres';
  private currentDatabase: string = 'postgres';
  private sessionId: number = Math.floor(Math.random() * 10000) + 1000;

  constructor(engine: SQLEngine) {
    this.engine = engine;
  }

  /**
   * Set current user
   */
  setCurrentUser(user: string): void {
    this.currentUser = user;
  }

  /**
   * Set current database
   */
  setCurrentDatabase(database: string): void {
    this.currentDatabase = database;
  }

  /**
   * Query a system view/table
   */
  queryView(viewName: string, whereClause?: Record<string, any>): SQLResultSet {
    const name = viewName.toLowerCase();

    switch (name) {
      // pg_catalog views
      case 'pg_database':
        return this.getPgDatabase(whereClause);
      case 'pg_roles':
      case 'pg_user':
        return this.getPgRoles(whereClause);
      case 'pg_tables':
        return this.getPgTables(whereClause);
      case 'pg_views':
        return this.getPgViews(whereClause);
      case 'pg_indexes':
        return this.getPgIndexes(whereClause);
      case 'pg_sequences':
        return this.getPgSequences(whereClause);
      case 'pg_namespace':
        return this.getPgNamespace(whereClause);
      case 'pg_class':
        return this.getPgClass(whereClause);
      case 'pg_attribute':
        return this.getPgAttribute(whereClause);
      case 'pg_type':
        return this.getPgType(whereClause);
      case 'pg_constraint':
        return this.getPgConstraint(whereClause);
      case 'pg_stat_activity':
        return this.getPgStatActivity(whereClause);
      case 'pg_stat_database':
        return this.getPgStatDatabase(whereClause);
      case 'pg_stat_user_tables':
        return this.getPgStatUserTables(whereClause);
      case 'pg_settings':
        return this.getPgSettings(whereClause);
      case 'pg_tablespace':
        return this.getPgTablespace(whereClause);

      // information_schema views
      case 'information_schema.tables':
      case 'tables':
        return this.getInformationSchemaTables(whereClause);
      case 'information_schema.columns':
      case 'columns':
        return this.getInformationSchemaColumns(whereClause);
      case 'information_schema.schemata':
      case 'schemata':
        return this.getInformationSchemaSchemata(whereClause);
      case 'information_schema.table_constraints':
      case 'table_constraints':
        return this.getInformationSchemaTableConstraints(whereClause);
      case 'information_schema.routines':
      case 'routines':
        return this.getInformationSchemaRoutines(whereClause);
      case 'information_schema.views':
      case 'views':
        return this.getInformationSchemaViews(whereClause);

      default:
        return {
          columns: [],
          rows: [],
          rowCount: 0,
        };
    }
  }

  /**
   * pg_database - List of databases
   */
  private getPgDatabase(whereClause?: Record<string, any>): SQLResultSet {
    const databases: PostgresDatabase[] = [
      {
        datname: 'postgres',
        datdba: 'postgres',
        encoding: 'UTF8',
        datcollate: 'en_US.UTF-8',
        datctype: 'en_US.UTF-8',
        datistemplate: false,
        datallowconn: true,
        datconnlimit: -1,
        datlastsysoid: 12999,
        datfrozenxid: 722,
        dattablespace: 'pg_default',
        datacl: null,
      },
      {
        datname: 'template0',
        datdba: 'postgres',
        encoding: 'UTF8',
        datcollate: 'en_US.UTF-8',
        datctype: 'en_US.UTF-8',
        datistemplate: true,
        datallowconn: false,
        datconnlimit: -1,
        datlastsysoid: 12999,
        datfrozenxid: 722,
        dattablespace: 'pg_default',
        datacl: null,
      },
      {
        datname: 'template1',
        datdba: 'postgres',
        encoding: 'UTF8',
        datcollate: 'en_US.UTF-8',
        datctype: 'en_US.UTF-8',
        datistemplate: true,
        datallowconn: true,
        datconnlimit: -1,
        datlastsysoid: 12999,
        datfrozenxid: 722,
        dattablespace: 'pg_default',
        datacl: null,
      },
    ];

    const columns = ['datname', 'datdba', 'encoding', 'datcollate', 'datctype', 'datistemplate', 'datallowconn', 'datconnlimit'];

    let rows = databases.map(db => columns.map(col => (db as any)[col]));

    if (whereClause) {
      rows = rows.filter(row => {
        for (const [key, value] of Object.entries(whereClause)) {
          const colIdx = columns.indexOf(key);
          if (colIdx !== -1 && row[colIdx] !== value) return false;
        }
        return true;
      });
    }

    return { columns, rows, rowCount: rows.length };
  }

  /**
   * pg_roles - Database roles
   */
  private getPgRoles(whereClause?: Record<string, any>): SQLResultSet {
    const roles: PostgresRole[] = [
      {
        rolname: 'postgres',
        rolsuper: true,
        rolinherit: true,
        rolcreaterole: true,
        rolcreatedb: true,
        rolcanlogin: true,
        rolreplication: true,
        rolbypassrls: true,
        rolconnlimit: -1,
        rolpassword: '********',
        rolvaliduntil: null,
      },
      {
        rolname: 'pg_database_owner',
        rolsuper: false,
        rolinherit: true,
        rolcreaterole: false,
        rolcreatedb: false,
        rolcanlogin: false,
        rolreplication: false,
        rolbypassrls: false,
        rolconnlimit: -1,
        rolpassword: null,
        rolvaliduntil: null,
      },
      {
        rolname: 'pg_read_all_data',
        rolsuper: false,
        rolinherit: true,
        rolcreaterole: false,
        rolcreatedb: false,
        rolcanlogin: false,
        rolreplication: false,
        rolbypassrls: false,
        rolconnlimit: -1,
        rolpassword: null,
        rolvaliduntil: null,
      },
    ];

    const columns = ['rolname', 'rolsuper', 'rolinherit', 'rolcreaterole', 'rolcreatedb', 'rolcanlogin', 'rolreplication', 'rolconnlimit'];

    let rows = roles.map(role => columns.map(col => (role as any)[col]));

    if (whereClause) {
      rows = rows.filter(row => {
        for (const [key, value] of Object.entries(whereClause)) {
          const colIdx = columns.indexOf(key);
          if (colIdx !== -1 && row[colIdx] !== value) return false;
        }
        return true;
      });
    }

    return { columns, rows, rowCount: rows.length };
  }

  /**
   * pg_tables - Tables in the database
   */
  private getPgTables(whereClause?: Record<string, any>): SQLResultSet {
    // Get user tables from engine
    const userTables: PostgresTable[] = this.engine.listTables().map(name => ({
      schemaname: 'public',
      tablename: name.toLowerCase(),
      tableowner: this.currentUser,
      tablespace: null,
      hasindexes: false,
      hasrules: false,
      hastriggers: false,
      rowsecurity: false,
    }));

    // Add system tables
    const systemTables: PostgresTable[] = [
      { schemaname: 'pg_catalog', tablename: 'pg_class', tableowner: 'postgres', tablespace: null, hasindexes: true, hasrules: false, hastriggers: false, rowsecurity: false },
      { schemaname: 'pg_catalog', tablename: 'pg_attribute', tableowner: 'postgres', tablespace: null, hasindexes: true, hasrules: false, hastriggers: false, rowsecurity: false },
      { schemaname: 'pg_catalog', tablename: 'pg_type', tableowner: 'postgres', tablespace: null, hasindexes: true, hasrules: false, hastriggers: false, rowsecurity: false },
      { schemaname: 'pg_catalog', tablename: 'pg_namespace', tableowner: 'postgres', tablespace: null, hasindexes: true, hasrules: false, hastriggers: false, rowsecurity: false },
      { schemaname: 'information_schema', tablename: 'tables', tableowner: 'postgres', tablespace: null, hasindexes: false, hasrules: false, hastriggers: false, rowsecurity: false },
      { schemaname: 'information_schema', tablename: 'columns', tableowner: 'postgres', tablespace: null, hasindexes: false, hasrules: false, hastriggers: false, rowsecurity: false },
    ];

    const allTables = [...userTables, ...systemTables];
    const columns = ['schemaname', 'tablename', 'tableowner', 'tablespace', 'hasindexes', 'hasrules', 'hastriggers', 'rowsecurity'];

    let rows = allTables.map(t => columns.map(col => (t as any)[col]));

    if (whereClause) {
      rows = rows.filter(row => {
        for (const [key, value] of Object.entries(whereClause)) {
          const colIdx = columns.indexOf(key);
          if (colIdx !== -1 && row[colIdx] !== value) return false;
        }
        return true;
      });
    }

    return { columns, rows, rowCount: rows.length };
  }

  /**
   * pg_views - Views in the database
   */
  private getPgViews(whereClause?: Record<string, any>): SQLResultSet {
    const views: PostgresView[] = [
      { schemaname: 'pg_catalog', viewname: 'pg_stat_activity', viewowner: 'postgres', definition: 'SELECT ...' },
      { schemaname: 'pg_catalog', viewname: 'pg_stat_database', viewowner: 'postgres', definition: 'SELECT ...' },
      { schemaname: 'pg_catalog', viewname: 'pg_tables', viewowner: 'postgres', definition: 'SELECT ...' },
      { schemaname: 'pg_catalog', viewname: 'pg_views', viewowner: 'postgres', definition: 'SELECT ...' },
      { schemaname: 'pg_catalog', viewname: 'pg_indexes', viewowner: 'postgres', definition: 'SELECT ...' },
    ];

    const columns = ['schemaname', 'viewname', 'viewowner', 'definition'];

    let rows = views.map(v => columns.map(col => (v as any)[col]));

    if (whereClause) {
      rows = rows.filter(row => {
        for (const [key, value] of Object.entries(whereClause)) {
          const colIdx = columns.indexOf(key);
          if (colIdx !== -1 && row[colIdx] !== value) return false;
        }
        return true;
      });
    }

    return { columns, rows, rowCount: rows.length };
  }

  /**
   * pg_indexes - Indexes
   */
  private getPgIndexes(whereClause?: Record<string, any>): SQLResultSet {
    // Get indexes from user tables
    const indexes: PostgresIndex[] = this.engine.listTables().flatMap(tableName => {
      const tableInfo = this.engine.describeTable(tableName);
      if (!tableInfo) return [];
      // Create a primary key index for tables with a primary key
      const pkCol = tableInfo.columns.find(c => c.primaryKey);
      if (pkCol) {
        return [{
          schemaname: 'public',
          tablename: tableName.toLowerCase(),
          indexname: `${tableName.toLowerCase()}_pkey`,
          tablespace: null,
          indexdef: `CREATE UNIQUE INDEX ${tableName.toLowerCase()}_pkey ON public.${tableName.toLowerCase()} USING btree (${pkCol.name.toLowerCase()})`,
        }];
      }
      return [];
    });

    const columns = ['schemaname', 'tablename', 'indexname', 'tablespace', 'indexdef'];

    let rows = indexes.map(idx => columns.map(col => (idx as any)[col]));

    if (whereClause) {
      rows = rows.filter(row => {
        for (const [key, value] of Object.entries(whereClause)) {
          const colIdx = columns.indexOf(key);
          if (colIdx !== -1 && row[colIdx] !== value) return false;
        }
        return true;
      });
    }

    return { columns, rows, rowCount: rows.length };
  }

  /**
   * pg_sequences - Sequences
   */
  private getPgSequences(whereClause?: Record<string, any>): SQLResultSet {
    // Simulated sequences
    const sequences: PostgresSequence[] = [];

    const columns = ['schemaname', 'sequencename', 'sequenceowner', 'data_type', 'start_value', 'min_value', 'max_value', 'increment_by', 'cycle', 'cache_size', 'last_value'];

    let rows = sequences.map(seq => columns.map(col => (seq as any)[col]));

    return { columns, rows, rowCount: rows.length };
  }

  /**
   * pg_namespace - Schemas
   */
  private getPgNamespace(whereClause?: Record<string, any>): SQLResultSet {
    const schemas = [
      { oid: 11, nspname: 'pg_catalog', nspowner: 10, nspacl: null },
      { oid: 2200, nspname: 'public', nspowner: 10, nspacl: '{postgres=UC/postgres,=UC/postgres}' },
      { oid: 99, nspname: 'pg_toast', nspowner: 10, nspacl: null },
      { oid: 12722, nspname: 'information_schema', nspowner: 10, nspacl: '{postgres=UC/postgres,=U/postgres}' },
    ];

    const columns = ['oid', 'nspname', 'nspowner', 'nspacl'];

    let rows = schemas.map(s => columns.map(col => (s as any)[col]));

    if (whereClause) {
      rows = rows.filter(row => {
        for (const [key, value] of Object.entries(whereClause)) {
          const colIdx = columns.indexOf(key);
          if (colIdx !== -1 && row[colIdx] !== value) return false;
        }
        return true;
      });
    }

    return { columns, rows, rowCount: rows.length };
  }

  /**
   * pg_class - Tables, indexes, sequences, views, etc.
   */
  private getPgClass(whereClause?: Record<string, any>): SQLResultSet {
    const classes = this.engine.listTables().map((name, idx) => ({
      oid: 16384 + idx,
      relname: name.toLowerCase(),
      relnamespace: 2200,
      reltype: 16385 + idx,
      relowner: 10,
      relkind: 'r',
      reltuples: 0,
      relpages: 0,
    }));

    const columns = ['oid', 'relname', 'relnamespace', 'reltype', 'relowner', 'relkind', 'reltuples', 'relpages'];

    let rows = classes.map(c => columns.map(col => (c as any)[col]));

    if (whereClause) {
      rows = rows.filter(row => {
        for (const [key, value] of Object.entries(whereClause)) {
          const colIdx = columns.indexOf(key);
          if (colIdx !== -1 && row[colIdx] !== value) return false;
        }
        return true;
      });
    }

    return { columns, rows, rowCount: rows.length };
  }

  /**
   * pg_attribute - Table columns
   */
  private getPgAttribute(whereClause?: Record<string, any>): SQLResultSet {
    const attributes: any[] = [];

    this.engine.listTables().forEach((tableName, tableIdx) => {
      const tableInfo = this.engine.describeTable(tableName);
      if (tableInfo) {
        tableInfo.columns.forEach((col, colIdx) => {
          attributes.push({
            attrelid: 16384 + tableIdx,
            attname: col.name.toLowerCase(),
            atttypid: 25, // text type OID
            attnum: colIdx + 1,
            attnotnull: !col.nullable,
            atthasdef: col.defaultValue !== null,
          });
        });
      }
    });

    const columns = ['attrelid', 'attname', 'atttypid', 'attnum', 'attnotnull', 'atthasdef'];

    let rows = attributes.map(a => columns.map(col => (a as any)[col]));

    if (whereClause) {
      rows = rows.filter(row => {
        for (const [key, value] of Object.entries(whereClause)) {
          const colIdx = columns.indexOf(key);
          if (colIdx !== -1 && row[colIdx] !== value) return false;
        }
        return true;
      });
    }

    return { columns, rows, rowCount: rows.length };
  }

  /**
   * pg_type - Data types
   */
  private getPgType(whereClause?: Record<string, any>): SQLResultSet {
    const types = [
      { oid: 16, typname: 'bool', typnamespace: 11, typlen: 1, typtype: 'b' },
      { oid: 20, typname: 'int8', typnamespace: 11, typlen: 8, typtype: 'b' },
      { oid: 21, typname: 'int2', typnamespace: 11, typlen: 2, typtype: 'b' },
      { oid: 23, typname: 'int4', typnamespace: 11, typlen: 4, typtype: 'b' },
      { oid: 25, typname: 'text', typnamespace: 11, typlen: -1, typtype: 'b' },
      { oid: 700, typname: 'float4', typnamespace: 11, typlen: 4, typtype: 'b' },
      { oid: 701, typname: 'float8', typnamespace: 11, typlen: 8, typtype: 'b' },
      { oid: 1043, typname: 'varchar', typnamespace: 11, typlen: -1, typtype: 'b' },
      { oid: 1082, typname: 'date', typnamespace: 11, typlen: 4, typtype: 'b' },
      { oid: 1083, typname: 'time', typnamespace: 11, typlen: 8, typtype: 'b' },
      { oid: 1114, typname: 'timestamp', typnamespace: 11, typlen: 8, typtype: 'b' },
      { oid: 1700, typname: 'numeric', typnamespace: 11, typlen: -1, typtype: 'b' },
      { oid: 2950, typname: 'uuid', typnamespace: 11, typlen: 16, typtype: 'b' },
      { oid: 114, typname: 'json', typnamespace: 11, typlen: -1, typtype: 'b' },
      { oid: 3802, typname: 'jsonb', typnamespace: 11, typlen: -1, typtype: 'b' },
    ];

    const columns = ['oid', 'typname', 'typnamespace', 'typlen', 'typtype'];

    let rows = types.map(t => columns.map(col => (t as any)[col]));

    if (whereClause) {
      rows = rows.filter(row => {
        for (const [key, value] of Object.entries(whereClause)) {
          const colIdx = columns.indexOf(key);
          if (colIdx !== -1 && row[colIdx] !== value) return false;
        }
        return true;
      });
    }

    return { columns, rows, rowCount: rows.length };
  }

  /**
   * pg_constraint - Constraints
   */
  private getPgConstraint(whereClause?: Record<string, any>): SQLResultSet {
    const constraints: any[] = [];

    this.engine.listTables().forEach((tableName, tableIdx) => {
      const tableInfo = this.engine.describeTable(tableName);
      if (tableInfo) {
        const pkCols = tableInfo.columns.filter(c => c.primaryKey);
        if (pkCols.length > 0) {
          constraints.push({
            oid: 20000 + tableIdx,
            conname: `${tableName.toLowerCase()}_pkey`,
            connamespace: 2200,
            contype: 'p',
            condeferrable: false,
            condeferred: false,
            conrelid: 16384 + tableIdx,
          });
        }
      }
    });

    const columns = ['oid', 'conname', 'connamespace', 'contype', 'condeferrable', 'condeferred', 'conrelid'];

    let rows = constraints.map(c => columns.map(col => (c as any)[col]));

    return { columns, rows, rowCount: rows.length };
  }

  /**
   * pg_stat_activity - Current activity
   */
  private getPgStatActivity(whereClause?: Record<string, any>): SQLResultSet {
    const activity: PgStatActivity[] = [
      {
        datid: 12689,
        datname: this.currentDatabase,
        pid: this.sessionId,
        usesysid: 10,
        usename: this.currentUser,
        application_name: 'psql',
        client_addr: '127.0.0.1',
        client_hostname: null,
        client_port: 49152,
        backend_start: new Date(Date.now() - 3600000),
        xact_start: null,
        query_start: new Date(),
        state_change: new Date(),
        wait_event_type: null,
        wait_event: null,
        state: 'active',
        backend_xid: null,
        backend_xmin: null,
        query: 'SELECT * FROM pg_stat_activity',
        backend_type: 'client backend',
      },
    ];

    const columns = ['datid', 'datname', 'pid', 'usename', 'application_name', 'client_addr', 'state', 'query', 'backend_type'];

    let rows = activity.map(a => columns.map(col => (a as any)[col]));

    return { columns, rows, rowCount: rows.length };
  }

  /**
   * pg_stat_database - Database statistics
   */
  private getPgStatDatabase(whereClause?: Record<string, any>): SQLResultSet {
    const stats: PgStatDatabase[] = [
      {
        datid: 12689,
        datname: 'postgres',
        numbackends: 1,
        xact_commit: 1234,
        xact_rollback: 5,
        blks_read: 5678,
        blks_hit: 98765,
        tup_returned: 123456,
        tup_fetched: 54321,
        tup_inserted: 1000,
        tup_updated: 500,
        tup_deleted: 100,
        conflicts: 0,
        temp_files: 0,
        temp_bytes: 0,
        deadlocks: 0,
        blk_read_time: 123.45,
        blk_write_time: 67.89,
        stats_reset: new Date(Date.now() - 86400000),
      },
    ];

    const columns = ['datid', 'datname', 'numbackends', 'xact_commit', 'xact_rollback', 'blks_read', 'blks_hit', 'tup_returned', 'tup_fetched', 'tup_inserted', 'tup_updated', 'tup_deleted'];

    let rows = stats.map(s => columns.map(col => (s as any)[col]));

    return { columns, rows, rowCount: rows.length };
  }

  /**
   * pg_stat_user_tables - User table statistics
   */
  private getPgStatUserTables(whereClause?: Record<string, any>): SQLResultSet {
    const stats = this.engine.listTables().map(tableName => ({
      relid: 16384,
      schemaname: 'public',
      relname: tableName.toLowerCase(),
      seq_scan: Math.floor(Math.random() * 100),
      seq_tup_read: Math.floor(Math.random() * 10000),
      idx_scan: Math.floor(Math.random() * 50),
      idx_tup_fetch: Math.floor(Math.random() * 5000),
      n_tup_ins: Math.floor(Math.random() * 1000),
      n_tup_upd: Math.floor(Math.random() * 500),
      n_tup_del: Math.floor(Math.random() * 100),
      n_live_tup: Math.floor(Math.random() * 10000),
      n_dead_tup: Math.floor(Math.random() * 100),
    }));

    const columns = ['schemaname', 'relname', 'seq_scan', 'seq_tup_read', 'idx_scan', 'idx_tup_fetch', 'n_tup_ins', 'n_tup_upd', 'n_tup_del', 'n_live_tup', 'n_dead_tup'];

    let rows = stats.map(s => columns.map(col => (s as any)[col]));

    return { columns, rows, rowCount: rows.length };
  }

  /**
   * pg_settings - Configuration parameters
   */
  private getPgSettings(whereClause?: Record<string, any>): SQLResultSet {
    const settings = [
      { name: 'max_connections', setting: '100', unit: null, category: 'Connections and Authentication' },
      { name: 'shared_buffers', setting: '128MB', unit: '8kB', category: 'Resource Usage / Memory' },
      { name: 'work_mem', setting: '4MB', unit: 'kB', category: 'Resource Usage / Memory' },
      { name: 'maintenance_work_mem', setting: '64MB', unit: 'kB', category: 'Resource Usage / Memory' },
      { name: 'effective_cache_size', setting: '4GB', unit: '8kB', category: 'Query Tuning / Planner Cost Constants' },
      { name: 'server_version', setting: '14.7', unit: null, category: 'Preset Options' },
      { name: 'server_encoding', setting: 'UTF8', unit: null, category: 'Client Connection Defaults' },
      { name: 'client_encoding', setting: 'UTF8', unit: null, category: 'Client Connection Defaults' },
      { name: 'timezone', setting: 'UTC', unit: null, category: 'Client Connection Defaults / Locale and Formatting' },
      { name: 'datestyle', setting: 'ISO, MDY', unit: null, category: 'Client Connection Defaults / Locale and Formatting' },
      { name: 'lc_messages', setting: 'en_US.UTF-8', unit: null, category: 'Client Connection Defaults / Locale and Formatting' },
      { name: 'log_destination', setting: 'stderr', unit: null, category: 'Reporting and Logging' },
      { name: 'log_statement', setting: 'none', unit: null, category: 'Reporting and Logging' },
    ];

    const columns = ['name', 'setting', 'unit', 'category'];

    let rows = settings.map(s => columns.map(col => (s as any)[col]));

    if (whereClause) {
      rows = rows.filter(row => {
        for (const [key, value] of Object.entries(whereClause)) {
          const colIdx = columns.indexOf(key);
          if (colIdx !== -1 && row[colIdx] !== value) return false;
        }
        return true;
      });
    }

    return { columns, rows, rowCount: rows.length };
  }

  /**
   * pg_tablespace - Tablespaces
   */
  private getPgTablespace(whereClause?: Record<string, any>): SQLResultSet {
    const tablespaces = [
      { oid: 1663, spcname: 'pg_default', spcowner: 10, spcacl: null, spcoptions: null },
      { oid: 1664, spcname: 'pg_global', spcowner: 10, spcacl: null, spcoptions: null },
    ];

    const columns = ['oid', 'spcname', 'spcowner', 'spcacl', 'spcoptions'];

    let rows = tablespaces.map(t => columns.map(col => (t as any)[col]));

    return { columns, rows, rowCount: rows.length };
  }

  /**
   * information_schema.tables
   */
  private getInformationSchemaTables(whereClause?: Record<string, any>): SQLResultSet {
    const tables = this.engine.listTables().map(name => ({
      table_catalog: this.currentDatabase,
      table_schema: 'public',
      table_name: name.toLowerCase(),
      table_type: 'BASE TABLE',
      self_referencing_column_name: null,
      reference_generation: null,
      user_defined_type_catalog: null,
      user_defined_type_schema: null,
      user_defined_type_name: null,
      is_insertable_into: 'YES',
      is_typed: 'NO',
      commit_action: null,
    }));

    const columns = ['table_catalog', 'table_schema', 'table_name', 'table_type', 'is_insertable_into', 'is_typed'];

    let rows = tables.map(t => columns.map(col => (t as any)[col]));

    if (whereClause) {
      rows = rows.filter(row => {
        for (const [key, value] of Object.entries(whereClause)) {
          const colIdx = columns.indexOf(key);
          if (colIdx !== -1 && row[colIdx] !== value) return false;
        }
        return true;
      });
    }

    return { columns, rows, rowCount: rows.length };
  }

  /**
   * information_schema.columns
   */
  private getInformationSchemaColumns(whereClause?: Record<string, any>): SQLResultSet {
    const columns: PostgresColumn[] = [];

    this.engine.listTables().forEach(tableName => {
      const tableInfo = this.engine.describeTable(tableName);
      if (tableInfo) {
        tableInfo.columns.forEach((col, idx) => {
          columns.push({
            table_schema: 'public',
            table_name: tableName.toLowerCase(),
            column_name: col.name.toLowerCase(),
            ordinal_position: idx + 1,
            column_default: col.defaultValue !== undefined ? String(col.defaultValue) : null,
            is_nullable: col.nullable ? 'YES' : 'NO',
            data_type: col.type,
            character_maximum_length: col.type === 'VARCHAR' ? col.size || 255 : null,
            numeric_precision: ['INTEGER', 'BIGINT', 'DECIMAL', 'NUMERIC'].includes(col.type) ? col.precision || null : null,
            numeric_scale: ['DECIMAL', 'NUMERIC'].includes(col.type) ? col.scale || null : null,
            udt_name: col.type.toLowerCase(),
          });
        });
      }
    });

    const colNames = ['table_schema', 'table_name', 'column_name', 'ordinal_position', 'column_default', 'is_nullable', 'data_type', 'character_maximum_length', 'numeric_precision', 'numeric_scale'];

    let rows = columns.map(c => colNames.map(col => (c as any)[col]));

    if (whereClause) {
      rows = rows.filter(row => {
        for (const [key, value] of Object.entries(whereClause)) {
          const colIdx = colNames.indexOf(key);
          if (colIdx !== -1 && row[colIdx] !== value) return false;
        }
        return true;
      });
    }

    return { columns: colNames, rows, rowCount: rows.length };
  }

  /**
   * information_schema.schemata
   */
  private getInformationSchemaSchemata(whereClause?: Record<string, any>): SQLResultSet {
    const schemas = [
      { catalog_name: this.currentDatabase, schema_name: 'public', schema_owner: 'postgres', default_character_set_name: null },
      { catalog_name: this.currentDatabase, schema_name: 'pg_catalog', schema_owner: 'postgres', default_character_set_name: null },
      { catalog_name: this.currentDatabase, schema_name: 'information_schema', schema_owner: 'postgres', default_character_set_name: null },
    ];

    const columns = ['catalog_name', 'schema_name', 'schema_owner', 'default_character_set_name'];

    let rows = schemas.map(s => columns.map(col => (s as any)[col]));

    return { columns, rows, rowCount: rows.length };
  }

  /**
   * information_schema.table_constraints
   */
  private getInformationSchemaTableConstraints(whereClause?: Record<string, any>): SQLResultSet {
    const constraints: any[] = [];

    this.engine.listTables().forEach(tableName => {
      const tableInfo = this.engine.describeTable(tableName);
      if (tableInfo) {
        const pkCols = tableInfo.columns.filter(c => c.primaryKey);
        if (pkCols.length > 0) {
          constraints.push({
            constraint_catalog: this.currentDatabase,
            constraint_schema: 'public',
            constraint_name: `${tableName.toLowerCase()}_pkey`,
            table_catalog: this.currentDatabase,
            table_schema: 'public',
            table_name: tableName.toLowerCase(),
            constraint_type: 'PRIMARY KEY',
            is_deferrable: 'NO',
            initially_deferred: 'NO',
          });
        }
      }
    });

    const columns = ['constraint_schema', 'constraint_name', 'table_schema', 'table_name', 'constraint_type', 'is_deferrable', 'initially_deferred'];

    let rows = constraints.map(c => columns.map(col => (c as any)[col]));

    return { columns, rows, rowCount: rows.length };
  }

  /**
   * information_schema.routines
   */
  private getInformationSchemaRoutines(whereClause?: Record<string, any>): SQLResultSet {
    // No user-defined routines in simulation
    const columns = ['routine_catalog', 'routine_schema', 'routine_name', 'routine_type', 'data_type', 'external_language'];
    return { columns, rows: [], rowCount: 0 };
  }

  /**
   * information_schema.views
   */
  private getInformationSchemaViews(whereClause?: Record<string, any>): SQLResultSet {
    // No user-defined views in simulation
    const columns = ['table_catalog', 'table_schema', 'table_name', 'view_definition', 'check_option', 'is_updatable'];
    return { columns, rows: [], rowCount: 0 };
  }
}
