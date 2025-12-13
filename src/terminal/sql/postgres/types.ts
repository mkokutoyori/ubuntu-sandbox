/**
 * PostgreSQL-specific types and interfaces
 */

import { SQLDataType, SessionSettings } from '../generic/types';

/**
 * PostgreSQL data types
 */
export type PostgresDataType =
  // Numeric types
  | 'SMALLINT' | 'INTEGER' | 'INT' | 'BIGINT'
  | 'DECIMAL' | 'NUMERIC' | 'REAL' | 'DOUBLE PRECISION'
  | 'SMALLSERIAL' | 'SERIAL' | 'BIGSERIAL'
  | 'MONEY'
  // Character types
  | 'CHARACTER VARYING' | 'VARCHAR' | 'CHARACTER' | 'CHAR' | 'TEXT'
  // Binary types
  | 'BYTEA'
  // Date/time types
  | 'TIMESTAMP' | 'TIMESTAMP WITH TIME ZONE' | 'TIMESTAMPTZ'
  | 'DATE' | 'TIME' | 'TIME WITH TIME ZONE' | 'TIMETZ'
  | 'INTERVAL'
  // Boolean
  | 'BOOLEAN' | 'BOOL'
  // Geometric types
  | 'POINT' | 'LINE' | 'LSEG' | 'BOX' | 'PATH' | 'POLYGON' | 'CIRCLE'
  // Network types
  | 'CIDR' | 'INET' | 'MACADDR' | 'MACADDR8'
  // UUID
  | 'UUID'
  // JSON types
  | 'JSON' | 'JSONB'
  // Array types
  | 'ARRAY'
  // XML
  | 'XML'
  // Other
  | 'OID' | 'REGCLASS' | 'REGTYPE';

/**
 * Map PostgreSQL types to generic SQL types
 */
export function mapPostgresTypeToGeneric(pgType: PostgresDataType): SQLDataType {
  const typeMap: Record<string, SQLDataType> = {
    'SMALLINT': 'SMALLINT',
    'INTEGER': 'INTEGER',
    'INT': 'INTEGER',
    'BIGINT': 'BIGINT',
    'DECIMAL': 'DECIMAL',
    'NUMERIC': 'NUMERIC',
    'REAL': 'FLOAT',
    'DOUBLE PRECISION': 'DOUBLE',
    'SMALLSERIAL': 'SMALLINT',
    'SERIAL': 'INTEGER',
    'BIGSERIAL': 'BIGINT',
    'MONEY': 'DECIMAL',
    'CHARACTER VARYING': 'VARCHAR',
    'VARCHAR': 'VARCHAR',
    'CHARACTER': 'CHAR',
    'CHAR': 'CHAR',
    'TEXT': 'TEXT',
    'BYTEA': 'BLOB',
    'TIMESTAMP': 'TIMESTAMP',
    'TIMESTAMP WITH TIME ZONE': 'TIMESTAMP',
    'TIMESTAMPTZ': 'TIMESTAMP',
    'DATE': 'DATE',
    'TIME': 'TIME',
    'TIME WITH TIME ZONE': 'TIME',
    'TIMETZ': 'TIME',
    'INTERVAL': 'VARCHAR',
    'BOOLEAN': 'BOOLEAN',
    'BOOL': 'BOOLEAN',
    'JSON': 'JSON',
    'JSONB': 'JSON',
    'XML': 'XML',
    'UUID': 'VARCHAR',
  };
  return typeMap[pgType] || 'VARCHAR';
}

/**
 * PostgreSQL session settings (psql variables)
 */
export interface PostgresSessionSettings extends SessionSettings {
  // Display settings
  expanded: boolean;           // \x - expanded display
  tuples_only: boolean;        // \t - tuples only
  aligned: boolean;            // \a - aligned/unaligned
  border: number;              // Border style (0, 1, 2)
  format: 'aligned' | 'unaligned' | 'wrapped' | 'html' | 'latex' | 'csv';
  null_display: string;        // \pset null - null display string
  fieldsep: string;            // Field separator for unaligned
  recordsep: string;           // Record separator

  // Output settings
  pager: boolean;              // Use pager
  footer: boolean;             // Show footer

  // Prompt settings
  prompt1: string;             // Primary prompt
  prompt2: string;             // Continuation prompt
  prompt3: string;             // Prompt in --single-line

  // Timing
  timing: boolean;             // \timing - show query execution time

  // Echo settings
  echo: 'none' | 'queries' | 'errors' | 'all';
  echo_hidden: boolean;        // Show internal queries

  // Error handling
  on_error_stop: boolean;      // Stop on error
  on_error_rollback: boolean;  // Rollback on error

  // Verbosity
  verbosity: 'default' | 'verbose' | 'terse' | 'sqlstate';
  show_context: 'never' | 'errors' | 'always';

  // Connection info
  dbname: string;
  user: string;
  host: string;
  port: number;

  // Search path
  search_path: string[];
}

/**
 * Default PostgreSQL session settings
 */
export function createDefaultPostgresSettings(): PostgresSessionSettings {
  return {
    autoCommit: true,
    echoCommands: false,
    timing: false,
    pageSize: 0,
    lineSize: 80,

    expanded: false,
    tuples_only: false,
    aligned: true,
    border: 1,
    format: 'aligned',
    null_display: '',
    fieldsep: '|',
    recordsep: '\n',

    pager: false,
    footer: true,

    prompt1: '%n@%/%R%# ',
    prompt2: '%n@%/%R%# ',
    prompt3: '>> ',

    echo: 'none',
    echo_hidden: false,

    on_error_stop: false,
    on_error_rollback: false,

    verbosity: 'default',
    show_context: 'errors',

    dbname: 'postgres',
    user: 'postgres',
    host: 'localhost',
    port: 5432,

    search_path: ['public'],
  };
}

/**
 * PostgreSQL user/role
 */
export interface PostgresRole {
  rolname: string;
  rolsuper: boolean;
  rolinherit: boolean;
  rolcreaterole: boolean;
  rolcreatedb: boolean;
  rolcanlogin: boolean;
  rolreplication: boolean;
  rolbypassrls: boolean;
  rolconnlimit: number;
  rolpassword: string | null;
  rolvaliduntil: Date | null;
}

/**
 * PostgreSQL database
 */
export interface PostgresDatabase {
  datname: string;
  datdba: string;
  encoding: string;
  datcollate: string;
  datctype: string;
  datistemplate: boolean;
  datallowconn: boolean;
  datconnlimit: number;
  datlastsysoid: number;
  datfrozenxid: number;
  dattablespace: string;
  datacl: string | null;
}

/**
 * PostgreSQL schema
 */
export interface PostgresSchema {
  schema_name: string;
  schema_owner: string;
  default_character_set_name: string | null;
}

/**
 * PostgreSQL table information
 */
export interface PostgresTable {
  schemaname: string;
  tablename: string;
  tableowner: string;
  tablespace: string | null;
  hasindexes: boolean;
  hasrules: boolean;
  hastriggers: boolean;
  rowsecurity: boolean;
}

/**
 * PostgreSQL column information
 */
export interface PostgresColumn {
  table_schema: string;
  table_name: string;
  column_name: string;
  ordinal_position: number;
  column_default: string | null;
  is_nullable: 'YES' | 'NO';
  data_type: string;
  character_maximum_length: number | null;
  numeric_precision: number | null;
  numeric_scale: number | null;
  udt_name: string;
}

/**
 * PostgreSQL index information
 */
export interface PostgresIndex {
  schemaname: string;
  tablename: string;
  indexname: string;
  tablespace: string | null;
  indexdef: string;
}

/**
 * PostgreSQL constraint
 */
export interface PostgresConstraint {
  constraint_schema: string;
  constraint_name: string;
  table_schema: string;
  table_name: string;
  constraint_type: 'CHECK' | 'FOREIGN KEY' | 'PRIMARY KEY' | 'UNIQUE';
  is_deferrable: 'YES' | 'NO';
  initially_deferred: 'YES' | 'NO';
}

/**
 * PostgreSQL function/procedure
 */
export interface PostgresFunction {
  routine_schema: string;
  routine_name: string;
  routine_type: 'FUNCTION' | 'PROCEDURE';
  data_type: string | null;
  type_udt_name: string | null;
  routine_definition: string | null;
  external_language: string;
  is_deterministic: 'YES' | 'NO';
  security_type: 'INVOKER' | 'DEFINER';
}

/**
 * PostgreSQL sequence
 */
export interface PostgresSequence {
  schemaname: string;
  sequencename: string;
  sequenceowner: string;
  data_type: string;
  start_value: number;
  min_value: number;
  max_value: number;
  increment_by: number;
  cycle: boolean;
  cache_size: number;
  last_value: number | null;
}

/**
 * PostgreSQL view
 */
export interface PostgresView {
  schemaname: string;
  viewname: string;
  viewowner: string;
  definition: string;
}

/**
 * PostgreSQL trigger
 */
export interface PostgresTrigger {
  trigger_schema: string;
  trigger_name: string;
  event_manipulation: 'INSERT' | 'UPDATE' | 'DELETE' | 'TRUNCATE';
  event_object_schema: string;
  event_object_table: string;
  action_order: number;
  action_condition: string | null;
  action_statement: string;
  action_orientation: 'ROW' | 'STATEMENT';
  action_timing: 'BEFORE' | 'AFTER' | 'INSTEAD OF';
}

/**
 * pg_stat_activity view row
 */
export interface PgStatActivity {
  datid: number;
  datname: string;
  pid: number;
  usesysid: number;
  usename: string;
  application_name: string;
  client_addr: string | null;
  client_hostname: string | null;
  client_port: number | null;
  backend_start: Date;
  xact_start: Date | null;
  query_start: Date | null;
  state_change: Date | null;
  wait_event_type: string | null;
  wait_event: string | null;
  state: 'active' | 'idle' | 'idle in transaction' | 'idle in transaction (aborted)' | 'fastpath function call' | 'disabled';
  backend_xid: number | null;
  backend_xmin: number | null;
  query: string;
  backend_type: string;
}

/**
 * pg_stat_database view row
 */
export interface PgStatDatabase {
  datid: number;
  datname: string;
  numbackends: number;
  xact_commit: number;
  xact_rollback: number;
  blks_read: number;
  blks_hit: number;
  tup_returned: number;
  tup_fetched: number;
  tup_inserted: number;
  tup_updated: number;
  tup_deleted: number;
  conflicts: number;
  temp_files: number;
  temp_bytes: number;
  deadlocks: number;
  blk_read_time: number;
  blk_write_time: number;
  stats_reset: Date | null;
}

/**
 * psql meta-command types
 */
export type PsqlMetaCommand =
  // General
  | '\\?' | '\\h' | '\\q'
  // Connection
  | '\\c' | '\\connect' | '\\conninfo'
  // Database info
  | '\\l' | '\\l+' | '\\list'
  // Schema info
  | '\\dn' | '\\dn+' | '\\ds' | '\\ds+'
  // Table info
  | '\\d' | '\\d+' | '\\dt' | '\\dt+' | '\\di' | '\\di+' | '\\dv' | '\\dv+' | '\\dm' | '\\dm+'
  // Column/constraints
  | '\\dC' | '\\dC+' | '\\df' | '\\df+'
  // Users/roles
  | '\\du' | '\\du+' | '\\dg' | '\\dg+'
  // Tablespaces
  | '\\db' | '\\db+'
  // Access privileges
  | '\\dp' | '\\z'
  // Settings
  | '\\x' | '\\a' | '\\t' | '\\timing' | '\\pset'
  // I/O
  | '\\i' | '\\include' | '\\o' | '\\out' | '\\e' | '\\edit'
  // Variables
  | '\\set' | '\\unset' | '\\echo'
  // Transaction
  | '\\begin' | '\\commit' | '\\rollback';

/**
 * psql command result
 */
export interface PsqlResult {
  output: string;
  error?: string;
  rowCount?: number;
  exit?: boolean;
  timing?: number;
}
