/**
 * PostgreSQL psql Interface
 * Simulates the psql command-line interface
 */

import { SQLEngine } from '../generic/engine';
import { parseSQL } from '../generic/parser';
import { SQLResult, SQLStatement } from '../generic/types';
import { PostgresSessionSettings, createDefaultPostgresSettings, PsqlResult } from './types';
import { PostgresSystemCatalog } from './system';
import { getPostgresFunction } from './functions';
import { initializePostgresSeeds } from '../seeds';

/**
 * psql Session
 */
export interface PsqlSession {
  engine: SQLEngine;
  catalog: PostgresSystemCatalog;
  settings: PostgresSessionSettings;
  buffer: string;
  inTransaction: boolean;
  lastRowCount: number;
  connected: boolean;
  seeded: boolean;
}

/**
 * Create a new psql session
 */
export function createPsqlSession(): PsqlSession {
  const engine = new SQLEngine();
  const catalog = new PostgresSystemCatalog(engine);

  // Initialize e-commerce seed data
  const seedResult = initializePostgresSeeds(engine);

  return {
    engine,
    catalog,
    settings: createDefaultPostgresSettings(),
    buffer: '',
    inTransaction: false,
    lastRowCount: 0,
    connected: true,
    seeded: seedResult.success,
  };
}

/**
 * Get psql prompt
 */
export function getPsqlPrompt(session: PsqlSession): string {
  if (!session.connected) {
    return '=> ';
  }

  const { settings, buffer, inTransaction } = session;

  // Build prompt from template
  let prompt = settings.prompt1;

  // Replace placeholders
  prompt = prompt.replace(/%n/g, settings.user);
  prompt = prompt.replace(/%\//g, settings.dbname);
  prompt = prompt.replace(/%~/g, settings.dbname === settings.user ? '~' : settings.dbname);

  // Transaction indicator
  if (inTransaction) {
    prompt = prompt.replace(/%R/g, '*');
  } else {
    prompt = prompt.replace(/%R/g, '');
  }

  // Prompt character based on user
  const isSuper = settings.user === 'postgres';
  prompt = prompt.replace(/%#/g, isSuper ? '#' : '>');

  // If we have a partial statement in buffer, use continuation prompt
  if (buffer.trim()) {
    return settings.dbname + '-# ';
  }

  return prompt;
}

/**
 * Execute psql input (command or SQL)
 */
export function executePsql(session: PsqlSession, input: string): PsqlResult {
  const trimmed = input.trim();

  // Empty input
  if (!trimmed) {
    return { output: '' };
  }

  // Meta-commands start with backslash
  if (trimmed.startsWith('\\')) {
    return executeMetaCommand(session, trimmed);
  }

  // Add to buffer
  session.buffer += (session.buffer ? ' ' : '') + input;

  // Check if statement is complete (ends with semicolon)
  if (!session.buffer.trim().endsWith(';')) {
    return { output: '' };
  }

  // Execute the buffered SQL
  const sql = session.buffer;
  session.buffer = '';

  return executeSQLStatement(session, sql);
}

/**
 * Execute a meta-command
 */
function executeMetaCommand(session: PsqlSession, command: string): PsqlResult {
  const parts = command.slice(1).split(/\s+/);
  const cmd = parts[0].toLowerCase();
  const args = parts.slice(1);

  switch (cmd) {
    case 'q':
    case 'quit':
      return { output: '', exit: true };

    case '?':
    case 'help':
      return { output: getHelpText() };

    case 'h':
      return { output: getSQLHelpText(args[0]) };

    case 'l':
    case 'l+':
    case 'list':
      return listDatabases(session, cmd.includes('+'));

    case 'c':
    case 'connect':
      return connectDatabase(session, args);

    case 'conninfo':
      return showConnectionInfo(session);

    case 'd':
      return describeObject(session, args, false);

    case 'd+':
      return describeObject(session, args, true);

    case 'dt':
    case 'dt+':
      return listTables(session, args, cmd.includes('+'));

    case 'di':
    case 'di+':
      return listIndexes(session, args, cmd.includes('+'));

    case 'dv':
    case 'dv+':
      return listViews(session, args, cmd.includes('+'));

    case 'ds':
    case 'ds+':
      return listSequences(session, args, cmd.includes('+'));

    case 'dn':
    case 'dn+':
      return listSchemas(session, cmd.includes('+'));

    case 'du':
    case 'du+':
    case 'dg':
    case 'dg+':
      return listRoles(session, cmd.includes('+'));

    case 'df':
    case 'df+':
      return listFunctions(session, args, cmd.includes('+'));

    case 'db':
    case 'db+':
      return listTablespaces(session, cmd.includes('+'));

    case 'dp':
    case 'z':
      return listPrivileges(session, args);

    case 'x':
      return toggleExpanded(session);

    case 'a':
      return toggleAligned(session);

    case 't':
      return toggleTuplesOnly(session);

    case 'timing':
      return toggleTiming(session);

    case 'pset':
      return setPsetOption(session, args);

    case 'set':
      return setVariable(session, args);

    case 'unset':
      return unsetVariable(session, args);

    case 'echo':
      return { output: args.join(' ') };

    case 'i':
    case 'include':
      return { output: 'File inclusion not supported in simulation.', error: 'ERROR' };

    case 'o':
    case 'out':
      return { output: 'Output redirection not supported in simulation.', error: 'ERROR' };

    case 'e':
    case 'edit':
      return { output: 'Editor not supported in simulation.', error: 'ERROR' };

    case 'g':
      // Execute buffer
      if (session.buffer.trim()) {
        const sql = session.buffer;
        session.buffer = '';
        return executeSQLStatement(session, sql);
      }
      return { output: '' };

    case 'r':
    case 'reset':
      session.buffer = '';
      return { output: 'Query buffer reset (cleared).' };

    case 'p':
    case 'print':
      return { output: session.buffer || '(Query buffer is empty)' };

    case 'w':
      return { output: 'File writing not supported in simulation.', error: 'ERROR' };

    case 'copyright':
      return { output: 'PostgreSQL Database Management System\n(portions Copyright (c) 1996-2023, PostgreSQL Global Development Group)' };

    default:
      return { output: `Invalid command \\${cmd}. Try \\? for help.`, error: 'ERROR' };
  }
}

/**
 * Execute SQL statement
 */
function executeSQLStatement(session: PsqlSession, sql: string): PsqlResult {
  const startTime = Date.now();

  try {
    // Check for system catalog queries
    const lowerSql = sql.toLowerCase();

    // Handle BEGIN/COMMIT/ROLLBACK
    if (lowerSql.match(/^\s*begin\b/i)) {
      session.inTransaction = true;
      session.engine.beginTransaction();
      return { output: 'BEGIN' };
    }
    if (lowerSql.match(/^\s*commit\b/i)) {
      session.inTransaction = false;
      const result = session.engine.commit();
      return { output: result.success ? 'COMMIT' : result.error || 'ERROR' };
    }
    if (lowerSql.match(/^\s*rollback\b/i)) {
      session.inTransaction = false;
      const result = session.engine.rollback();
      return { output: result.success ? 'ROLLBACK' : result.error || 'ERROR' };
    }

    // Parse and execute
    const parseResult = parseSQL(sql);
    if (!parseResult.success || parseResult.statements.length === 0) {
      const errorMsg = parseResult.errors.length > 0
        ? parseResult.errors[0].message
        : 'syntax error';
      return { output: '', error: `ERROR:  ${errorMsg}` };
    }

    const stmt = parseResult.statements[0];

    // Handle SELECT on system views
    if (stmt.type === 'SELECT' && stmt.from) {
      const tableName = stmt.from[0].table.toLowerCase();
      if (isSystemView(tableName)) {
        const result = session.catalog.queryView(tableName);
        // Convert SQLRow objects to arrays for formatResultSet
        const rowArrays = result.rows.map(row =>
          result.columns.map(col => row[col])
        );
        return formatResultSet(session, result.columns, rowArrays, startTime);
      }
    }

    // Execute through engine based on statement type
    const result = executeStatement(session, stmt);

    if (!result.success) {
      const errorMsg = result.error
        ? (typeof result.error === 'string' ? result.error : result.error.message)
        : 'unknown error';
      return { output: '', error: `ERROR:  ${errorMsg}` };
    }

    // Format output based on statement type
    switch (stmt.type) {
      case 'SELECT':
        if (result.resultSet) {
          // Convert SQLRow objects to arrays for formatResultSet
          const rowArrays = result.resultSet.rows.map(row =>
            result.resultSet!.columns.map(col => row[col])
          );
          return formatResultSet(session, result.resultSet.columns, rowArrays, startTime);
        }
        return { output: '(0 rows)', rowCount: 0 };

      case 'INSERT':
        return {
          output: `INSERT 0 ${result.affectedRows || 0}`,
          rowCount: result.affectedRows || 0,
          timing: session.settings.timing ? Date.now() - startTime : undefined,
        };

      case 'UPDATE':
        return {
          output: `UPDATE ${result.affectedRows || 0}`,
          rowCount: result.affectedRows || 0,
          timing: session.settings.timing ? Date.now() - startTime : undefined,
        };

      case 'DELETE':
        return {
          output: `DELETE ${result.affectedRows || 0}`,
          rowCount: result.affectedRows || 0,
          timing: session.settings.timing ? Date.now() - startTime : undefined,
        };

      case 'CREATE_TABLE':
        return { output: 'CREATE TABLE', timing: session.settings.timing ? Date.now() - startTime : undefined };

      case 'DROP_TABLE':
        return { output: 'DROP TABLE', timing: session.settings.timing ? Date.now() - startTime : undefined };

      case 'CREATE_INDEX':
        return { output: 'CREATE INDEX', timing: session.settings.timing ? Date.now() - startTime : undefined };

      case 'DROP_INDEX':
        return { output: 'DROP INDEX', timing: session.settings.timing ? Date.now() - startTime : undefined };

      default:
        return { output: result.message || 'OK', timing: session.settings.timing ? Date.now() - startTime : undefined };
    }
  } catch (err) {
    return { output: '', error: `ERROR:  ${err instanceof Error ? err.message : 'unknown error'}` };
  }
}

/**
 * Execute a SQL statement through the engine
 */
function executeStatement(session: PsqlSession, stmt: SQLStatement): SQLResult {
  switch (stmt.type) {
    case 'SELECT':
      return session.engine.executeSelect(stmt as any);
    case 'INSERT':
      return session.engine.executeInsert(stmt as any);
    case 'UPDATE':
      return session.engine.executeUpdate(stmt as any);
    case 'DELETE':
      return session.engine.executeDelete(stmt as any);
    case 'CREATE_TABLE':
      return session.engine.createTable(stmt as any);
    case 'DROP_TABLE':
      return session.engine.dropTable((stmt as any).name, (stmt as any).schema, (stmt as any).ifExists, (stmt as any).cascade);
    case 'TRUNCATE':
      return session.engine.truncateTable((stmt as any).table, (stmt as any).schema);
    case 'CREATE_SCHEMA':
    case 'CREATE_DATABASE':
      return session.engine.createSchema((stmt as any).name);
    case 'DROP_SCHEMA':
    case 'DROP_DATABASE':
      return session.engine.dropSchema((stmt as any).name, (stmt as any).cascade);
    case 'CREATE_USER':
      return session.engine.createUser((stmt as any).name, (stmt as any).password);
    case 'DROP_USER':
      return session.engine.dropUser((stmt as any).name);
    case 'GRANT':
      return session.engine.grant((stmt as any).privileges[0], (stmt as any).objectType, (stmt as any).objectName, (stmt as any).grantee, (stmt as any).withGrantOption);
    case 'REVOKE':
      return session.engine.revoke((stmt as any).privileges[0], (stmt as any).objectType, (stmt as any).objectName, (stmt as any).grantee);
    case 'BEGIN':
      return session.engine.beginTransaction();
    case 'COMMIT':
      return session.engine.commit();
    case 'ROLLBACK':
      return session.engine.rollback((stmt as any).savepoint);
    case 'SAVEPOINT':
      return session.engine.savepoint((stmt as any).name);
    case 'CREATE_SEQUENCE':
      return session.engine.createSequence((stmt as any).name, undefined, stmt as any);
    default:
      return { success: true };
  }
}

/**
 * Check if table name is a system view
 */
function isSystemView(name: string): boolean {
  const systemViews = [
    'pg_database', 'pg_roles', 'pg_user', 'pg_tables', 'pg_views', 'pg_indexes',
    'pg_sequences', 'pg_namespace', 'pg_class', 'pg_attribute', 'pg_type',
    'pg_constraint', 'pg_stat_activity', 'pg_stat_database', 'pg_stat_user_tables',
    'pg_settings', 'pg_tablespace',
    'information_schema.tables', 'information_schema.columns', 'information_schema.schemata',
    'information_schema.table_constraints', 'information_schema.routines', 'information_schema.views',
    'tables', 'columns', 'schemata', 'table_constraints', 'routines', 'views',
  ];
  return systemViews.includes(name.toLowerCase());
}

/**
 * Format result set for display
 */
function formatResultSet(session: PsqlSession, columns: string[], rows: any[][], startTime: number): PsqlResult {
  const { settings } = session;

  if (settings.expanded) {
    return formatExpanded(session, columns, rows, startTime);
  }

  if (!settings.aligned || settings.format === 'unaligned') {
    return formatUnaligned(session, columns, rows, startTime);
  }

  return formatAligned(session, columns, rows, startTime);
}

/**
 * Format aligned output (default)
 */
function formatAligned(session: PsqlSession, columns: string[], rows: any[][], startTime: number): PsqlResult {
  const { settings } = session;

  if (rows.length === 0 && !settings.tuples_only) {
    const header = columns.join(' | ');
    const sep = columns.map(c => '-'.repeat(c.length)).join('-+-');
    return {
      output: ` ${header}\n${sep}\n(0 rows)`,
      rowCount: 0,
      timing: settings.timing ? Date.now() - startTime : undefined,
    };
  }

  // Calculate column widths
  const widths = columns.map((col, idx) => {
    const dataWidth = Math.max(...rows.map(row => formatValue(row[idx]).length), 0);
    return Math.max(col.length, dataWidth);
  });

  const lines: string[] = [];

  // Header
  if (!settings.tuples_only) {
    const header = columns.map((col, idx) => col.padEnd(widths[idx])).join(' | ');
    const sep = widths.map(w => '-'.repeat(w)).join('-+-');
    lines.push(` ${header}`);
    lines.push(sep);
  }

  // Rows
  for (const row of rows) {
    const formatted = row.map((val, idx) => formatValue(val).padEnd(widths[idx])).join(' | ');
    lines.push(` ${formatted}`);
  }

  // Footer
  if (!settings.tuples_only && settings.footer) {
    lines.push(`(${rows.length} row${rows.length !== 1 ? 's' : ''})`);
  }

  let output = lines.join('\n');

  if (settings.timing) {
    output += `\nTime: ${(Date.now() - startTime).toFixed(3)} ms`;
  }

  return { output, rowCount: rows.length };
}

/**
 * Format expanded output (\x)
 */
function formatExpanded(session: PsqlSession, columns: string[], rows: any[][], startTime: number): PsqlResult {
  const { settings } = session;

  if (rows.length === 0) {
    return {
      output: '(0 rows)',
      rowCount: 0,
      timing: settings.timing ? Date.now() - startTime : undefined,
    };
  }

  const maxColWidth = Math.max(...columns.map(c => c.length));
  const lines: string[] = [];

  rows.forEach((row, rowIdx) => {
    lines.push(`-[ RECORD ${rowIdx + 1} ]` + '-'.repeat(Math.max(0, 60 - 14 - String(rowIdx + 1).length)));
    columns.forEach((col, colIdx) => {
      lines.push(`${col.padEnd(maxColWidth)} | ${formatValue(row[colIdx])}`);
    });
  });

  let output = lines.join('\n');

  if (settings.timing) {
    output += `\nTime: ${(Date.now() - startTime).toFixed(3)} ms`;
  }

  return { output, rowCount: rows.length };
}

/**
 * Format unaligned output
 */
function formatUnaligned(session: PsqlSession, columns: string[], rows: any[][], startTime: number): PsqlResult {
  const { settings } = session;
  const sep = settings.fieldsep;
  const lines: string[] = [];

  if (!settings.tuples_only) {
    lines.push(columns.join(sep));
  }

  for (const row of rows) {
    lines.push(row.map(val => formatValue(val)).join(sep));
  }

  if (!settings.tuples_only && settings.footer) {
    lines.push(`(${rows.length} row${rows.length !== 1 ? 's' : ''})`);
  }

  let output = lines.join(settings.recordsep);

  if (settings.timing) {
    output += `\nTime: ${(Date.now() - startTime).toFixed(3)} ms`;
  }

  return { output, rowCount: rows.length };
}

/**
 * Format a value for display
 */
function formatValue(val: any): string {
  if (val === null || val === undefined) return '';
  if (val instanceof Date) return val.toISOString();
  if (typeof val === 'boolean') return val ? 't' : 'f';
  if (typeof val === 'object') return JSON.stringify(val);
  return String(val);
}

// ========================================
// Meta-command implementations
// ========================================

function getHelpText(): string {
  return `General
  \\copyright             show PostgreSQL usage and distribution terms
  \\g [FILE]              execute query (and send results to file or |pipe)
  \\h [NAME]              help on syntax of SQL commands
  \\q                     quit psql

Query Buffer
  \\p                     show the contents of the query buffer
  \\r                     reset (clear) the query buffer

Informational
  \\d[S+] [NAME]          list tables, views, and sequences
  \\dt[S+] [PATTERN]      list tables
  \\di[S+] [PATTERN]      list indexes
  \\dv[S+] [PATTERN]      list views
  \\ds[S+] [PATTERN]      list sequences
  \\dn[S+] [PATTERN]      list schemas
  \\du[S+] [PATTERN]      list roles
  \\df[S+] [PATTERN]      list functions
  \\db[S+] [PATTERN]      list tablespaces
  \\l[+]                  list databases
  \\z  [PATTERN]          list table privileges

Formatting
  \\a                     toggle between unaligned and aligned output
  \\t                     toggle tuples-only mode
  \\x                     toggle expanded output
  \\timing                toggle timing of commands
  \\pset [NAME [VALUE]]   set table output option

Connection
  \\c[onnect] [DBNAME]    connect to database
  \\conninfo              display current connection info

Operating System
  \\! [COMMAND]           execute command in shell (not supported)`;
}

function getSQLHelpText(command?: string): string {
  if (!command) {
    return `Available help topics:
  SELECT      INSERT      UPDATE      DELETE
  CREATE      DROP        ALTER       TRUNCATE
  BEGIN       COMMIT      ROLLBACK    SAVEPOINT
Type \\h <command> for more information.`;
  }

  const help: Record<string, string> = {
    select: 'SELECT [ ALL | DISTINCT [ ON ( expression [, ...] ) ] ]\n    * | expression [ [ AS ] output_name ] [, ...]\n    [ FROM from_item [, ...] ]\n    [ WHERE condition ]\n    [ GROUP BY expression [, ...] ]\n    [ HAVING condition [, ...] ]\n    [ ORDER BY expression [ ASC | DESC ] [, ...] ]\n    [ LIMIT count ]\n    [ OFFSET start ]',
    insert: 'INSERT INTO table_name [ ( column_name [, ...] ) ]\n    { VALUES ( { expression | DEFAULT } [, ...] ) [, ...] | query }',
    update: 'UPDATE table_name\n    SET { column_name = { expression | DEFAULT } } [, ...]\n    [ WHERE condition ]',
    delete: 'DELETE FROM table_name\n    [ WHERE condition ]',
    create: 'CREATE TABLE table_name (\n    column_name data_type [ constraint ] [, ...]\n)',
    drop: 'DROP TABLE [ IF EXISTS ] name [, ...] [ CASCADE | RESTRICT ]',
  };

  return help[command.toLowerCase()] || `No help available for "${command}"`;
}

function listDatabases(session: PsqlSession, extended: boolean): PsqlResult {
  const result = session.catalog.queryView('pg_database');
  const cols = extended
    ? ['Name', 'Owner', 'Encoding', 'Collate', 'Ctype', 'Access privileges']
    : ['Name', 'Owner', 'Encoding', 'Collate', 'Ctype'];

  const rows = result.rows.map(row => {
    const base = [row[0], row[1], row[2], row[3], row[4]];
    return extended ? [...base, ''] : base;
  });

  return formatResultSet(session, cols, rows, Date.now());
}

function connectDatabase(session: PsqlSession, args: string[]): PsqlResult {
  const dbname = args[0] || session.settings.dbname;
  const user = args[1] || session.settings.user;

  session.settings.dbname = dbname;
  session.settings.user = user;
  session.catalog.setCurrentUser(user);
  session.catalog.setCurrentDatabase(dbname);

  return { output: `You are now connected to database "${dbname}" as user "${user}".` };
}

function showConnectionInfo(session: PsqlSession): PsqlResult {
  const { settings } = session;
  return {
    output: `You are connected to database "${settings.dbname}" as user "${settings.user}" on host "${settings.host}" at port "${settings.port}".`,
  };
}

function describeObject(session: PsqlSession, args: string[], extended: boolean): PsqlResult {
  if (args.length === 0) {
    // List all tables, views, sequences
    return listTables(session, [], extended);
  }

  const objectName = args[0].toLowerCase();

  // Try to describe as table
  const tableInfo = session.engine.describeTable(objectName);
  if (tableInfo) {
    const cols = extended
      ? ['Column', 'Type', 'Collation', 'Nullable', 'Default', 'Storage', 'Description']
      : ['Column', 'Type', 'Collation', 'Nullable', 'Default'];

    const rows = tableInfo.columns.map(col => {
      const base = [
        col.name,
        col.type + (col.size ? `(${col.size})` : ''),
        '',
        col.nullable ? 'YES' : 'NO',
        col.defaultValue !== undefined ? String(col.defaultValue) : '',
      ];
      return extended ? [...base, 'plain', ''] : base;
    });

    let output = `Table "public.${objectName}"\n`;
    const result = formatResultSet(session, cols, rows, Date.now());

    // Add indexes
    const indexes = session.catalog.queryView('pg_indexes', { tablename: objectName });
    if (indexes.rows.length > 0) {
      output += '\nIndexes:\n';
      indexes.rows.forEach(idx => {
        output += `    "${idx[2]}" ${idx[4]?.includes('UNIQUE') ? 'UNIQUE' : 'btree'}\n`;
      });
    }

    return { output: output + result.output };
  }

  return { output: `Did not find any relation named "${args[0]}".`, error: 'ERROR' };
}

function listTables(session: PsqlSession, args: string[], extended: boolean): PsqlResult {
  const result = session.catalog.queryView('pg_tables', { schemaname: 'public' });

  if (result.rows.length === 0) {
    return { output: 'Did not find any relations.' };
  }

  const cols = extended
    ? ['Schema', 'Name', 'Type', 'Owner', 'Size', 'Description']
    : ['Schema', 'Name', 'Type', 'Owner'];

  const rows = result.rows.map(row => {
    const base = [row[0], row[1], 'table', row[2]];
    return extended ? [...base, '8192 bytes', ''] : base;
  });

  let output = 'List of relations\n';
  const formatted = formatResultSet(session, cols, rows, Date.now());
  return { output: output + formatted.output };
}

function listIndexes(session: PsqlSession, args: string[], extended: boolean): PsqlResult {
  const result = session.catalog.queryView('pg_indexes', { schemaname: 'public' });

  if (result.rows.length === 0) {
    return { output: 'Did not find any indexes.' };
  }

  const cols = extended
    ? ['Schema', 'Name', 'Type', 'Owner', 'Table', 'Size', 'Description']
    : ['Schema', 'Name', 'Type', 'Owner', 'Table'];

  const rows = result.rows.map(row => {
    const base = [row[0], row[2], 'index', 'postgres', row[1]];
    return extended ? [...base, '8192 bytes', ''] : base;
  });

  let output = 'List of indexes\n';
  const formatted = formatResultSet(session, cols, rows, Date.now());
  return { output: output + formatted.output };
}

function listViews(session: PsqlSession, args: string[], extended: boolean): PsqlResult {
  const result = session.catalog.queryView('pg_views', { schemaname: 'public' });

  if (result.rows.length === 0) {
    return { output: 'Did not find any views.' };
  }

  const cols = extended
    ? ['Schema', 'Name', 'Type', 'Owner', 'Size', 'Description']
    : ['Schema', 'Name', 'Type', 'Owner'];

  const rows = result.rows.map(row => {
    const base = [row[0], row[1], 'view', row[2]];
    return extended ? [...base, '0 bytes', ''] : base;
  });

  let output = 'List of views\n';
  const formatted = formatResultSet(session, cols, rows, Date.now());
  return { output: output + formatted.output };
}

function listSequences(session: PsqlSession, args: string[], extended: boolean): PsqlResult {
  const result = session.catalog.queryView('pg_sequences');

  if (result.rows.length === 0) {
    return { output: 'Did not find any sequences.' };
  }

  return formatResultSet(session, result.columns, result.rows, Date.now());
}

function listSchemas(session: PsqlSession, extended: boolean): PsqlResult {
  const result = session.catalog.queryView('pg_namespace');

  const cols = extended
    ? ['Name', 'Owner', 'Access privileges', 'Description']
    : ['Name', 'Owner'];

  const rows = result.rows.map(row => {
    const base = [row[1], 'postgres'];
    return extended ? [...base, '', ''] : base;
  });

  let output = 'List of schemas\n';
  const formatted = formatResultSet(session, cols, rows, Date.now());
  return { output: output + formatted.output };
}

function listRoles(session: PsqlSession, extended: boolean): PsqlResult {
  const result = session.catalog.queryView('pg_roles');

  const cols = extended
    ? ['Role name', 'Attributes', 'Member of', 'Description']
    : ['Role name', 'Attributes', 'Member of'];

  const rows = result.rows.map(row => {
    const attrs: string[] = [];
    if (row[1]) attrs.push('Superuser');
    if (row[3]) attrs.push('Create role');
    if (row[4]) attrs.push('Create DB');
    if (!row[5]) attrs.push('Cannot login');
    if (row[6]) attrs.push('Replication');

    const base = [row[0], attrs.join(', ') || '', '{}'];
    return extended ? [...base, ''] : base;
  });

  let output = 'List of roles\n';
  const formatted = formatResultSet(session, cols, rows, Date.now());
  return { output: output + formatted.output };
}

function listFunctions(session: PsqlSession, args: string[], extended: boolean): PsqlResult {
  // List some built-in functions
  const functions = [
    ['pg_catalog', 'now', 'timestamp with time zone', '', 'func'],
    ['pg_catalog', 'current_date', 'date', '', 'func'],
    ['pg_catalog', 'current_user', 'name', '', 'func'],
    ['pg_catalog', 'version', 'text', '', 'func'],
  ];

  const cols = extended
    ? ['Schema', 'Name', 'Result data type', 'Argument data types', 'Type', 'Description']
    : ['Schema', 'Name', 'Result data type', 'Argument data types', 'Type'];

  const rows = functions.map(f => extended ? [...f, ''] : f);

  let output = 'List of functions\n';
  const formatted = formatResultSet(session, cols, rows, Date.now());
  return { output: output + formatted.output };
}

function listTablespaces(session: PsqlSession, extended: boolean): PsqlResult {
  const result = session.catalog.queryView('pg_tablespace');

  const cols = extended
    ? ['Name', 'Owner', 'Location', 'Access privileges', 'Options', 'Size', 'Description']
    : ['Name', 'Owner', 'Location'];

  const rows = result.rows.map(row => {
    const base = [row[1], 'postgres', ''];
    return extended ? [...base, '', '', '', ''] : base;
  });

  let output = 'List of tablespaces\n';
  const formatted = formatResultSet(session, cols, rows, Date.now());
  return { output: output + formatted.output };
}

function listPrivileges(session: PsqlSession, args: string[]): PsqlResult {
  const result = session.catalog.queryView('pg_tables', { schemaname: 'public' });

  const cols = ['Schema', 'Name', 'Type', 'Access privileges', 'Column privileges', 'Policies'];
  const rows = result.rows.map(row => [row[0], row[1], 'table', '', '', '']);

  let output = 'Access privileges\n';
  const formatted = formatResultSet(session, cols, rows, Date.now());
  return { output: output + formatted.output };
}

function toggleExpanded(session: PsqlSession): PsqlResult {
  session.settings.expanded = !session.settings.expanded;
  return { output: `Expanded display is ${session.settings.expanded ? 'on' : 'off'}.` };
}

function toggleAligned(session: PsqlSession): PsqlResult {
  session.settings.aligned = !session.settings.aligned;
  session.settings.format = session.settings.aligned ? 'aligned' : 'unaligned';
  return { output: `Output format is ${session.settings.aligned ? 'aligned' : 'unaligned'}.` };
}

function toggleTuplesOnly(session: PsqlSession): PsqlResult {
  session.settings.tuples_only = !session.settings.tuples_only;
  return { output: `Tuples only is ${session.settings.tuples_only ? 'on' : 'off'}.` };
}

function toggleTiming(session: PsqlSession): PsqlResult {
  session.settings.timing = !session.settings.timing;
  return { output: `Timing is ${session.settings.timing ? 'on' : 'off'}.` };
}

function setPsetOption(session: PsqlSession, args: string[]): PsqlResult {
  if (args.length === 0) {
    return {
      output: `border      ${session.settings.border}
expanded    ${session.settings.expanded ? 'on' : 'off'}
fieldsep    '${session.settings.fieldsep}'
footer      ${session.settings.footer ? 'on' : 'off'}
format      ${session.settings.format}
null        '${session.settings.null_display}'
recordsep   '${session.settings.recordsep}'
tuples_only ${session.settings.tuples_only ? 'on' : 'off'}`,
    };
  }

  const option = args[0].toLowerCase();
  const value = args[1];

  switch (option) {
    case 'border':
      session.settings.border = parseInt(value) || 0;
      break;
    case 'expanded':
      session.settings.expanded = value === 'on' || value === 'true';
      break;
    case 'fieldsep':
      session.settings.fieldsep = value || '|';
      break;
    case 'footer':
      session.settings.footer = value !== 'off' && value !== 'false';
      break;
    case 'format':
      session.settings.format = value as any || 'aligned';
      break;
    case 'null':
      session.settings.null_display = value || '';
      break;
    case 'tuples_only':
      session.settings.tuples_only = value === 'on' || value === 'true';
      break;
    default:
      return { output: `Unknown option: ${option}`, error: 'ERROR' };
  }

  return { output: '' };
}

function setVariable(session: PsqlSession, args: string[]): PsqlResult {
  if (args.length === 0) {
    return {
      output: `AUTOCOMMIT = '${session.settings.autoCommit ? 'on' : 'off'}'
DBNAME = '${session.settings.dbname}'
ECHO = '${session.settings.echo}'
ECHO_HIDDEN = '${session.settings.echo_hidden ? 'on' : 'off'}'
HOST = '${session.settings.host}'
ON_ERROR_ROLLBACK = '${session.settings.on_error_rollback ? 'on' : 'off'}'
ON_ERROR_STOP = '${session.settings.on_error_stop ? 'on' : 'off'}'
PORT = '${session.settings.port}'
USER = '${session.settings.user}'
VERBOSITY = '${session.settings.verbosity}'`,
    };
  }

  // Parse NAME=VALUE or NAME VALUE
  let name = args[0];
  let value = args.length > 1 ? args.slice(1).join(' ') : '';

  if (name.includes('=')) {
    [name, value] = name.split('=');
  }

  // Set the variable (simplified)
  return { output: '' };
}

function unsetVariable(session: PsqlSession, args: string[]): PsqlResult {
  if (args.length === 0) {
    return { output: '\\unset: missing required argument', error: 'ERROR' };
  }
  return { output: '' };
}
