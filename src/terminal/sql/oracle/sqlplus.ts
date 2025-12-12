/**
 * Oracle SQL*Plus Interface - Command-line interface for Oracle
 */

import { SQLResult, SQLResultSet, SQLRow, sqlValueToString } from '../generic/types';
import { SQLEngine } from '../generic/engine';
import { parseSQL } from '../generic/parser';
import { OracleSessionSettings, createDefaultOracleSettings, ColumnFormat, SpoolSettings } from './types';
import { OracleSystemCatalog } from './system';
import { ORACLE_FUNCTIONS, getOracleFunction } from './functions';

export interface SQLPlusResult {
  output: string;
  error?: string;
  exit?: boolean;
  feedback?: string;
}

export interface SQLPlusSession {
  engine: SQLEngine;
  catalog: OracleSystemCatalog;
  settings: OracleSessionSettings;
  columnFormats: Map<string, ColumnFormat>;
  substitutionVars: Map<string, string>;
  spool: SpoolSettings;
  buffer: string[];
  connected: boolean;
  username: string;
  lastCommand: string;
  lastResult: SQLResult | null;
  runningScript: boolean;
}

/**
 * Create a new SQL*Plus session
 */
export function createSQLPlusSession(): SQLPlusSession {
  const engine = new SQLEngine({
    caseSensitiveIdentifiers: false,
    defaultSchema: 'SYSTEM',
    autoCommit: false
  });

  // Create default schema and user
  engine.createSchema('SYSTEM');
  engine.setCurrentSchema('SYSTEM');
  engine.setCurrentUser('SYSTEM');

  return {
    engine,
    catalog: new OracleSystemCatalog(engine),
    settings: createDefaultOracleSettings(),
    columnFormats: new Map(),
    substitutionVars: new Map(),
    spool: { file: null, append: false, create: false, replace: true },
    buffer: [],
    connected: true,
    username: 'SYSTEM',
    lastCommand: '',
    lastResult: null,
    runningScript: false
  };
}

/**
 * Execute a SQL*Plus command or SQL statement
 */
export function executeSQLPlus(session: SQLPlusSession, input: string): SQLPlusResult {
  const trimmed = input.trim();

  // Empty input
  if (!trimmed) {
    return { output: '' };
  }

  // Check for SQL*Plus commands (start with non-SQL keywords)
  const lowerInput = trimmed.toLowerCase();

  // EXIT/QUIT
  if (lowerInput === 'exit' || lowerInput === 'quit' || lowerInput.startsWith('exit;') || lowerInput.startsWith('quit;')) {
    return { output: 'Disconnected from Oracle Database 19c Enterprise Edition', exit: true };
  }

  // HELP
  if (lowerInput === 'help' || lowerInput === 'help;' || lowerInput === '?') {
    return { output: getSQLPlusHelp() };
  }

  // CONNECT
  if (lowerInput.startsWith('connect ') || lowerInput.startsWith('conn ')) {
    return handleConnect(session, trimmed);
  }

  // DISCONNECT
  if (lowerInput === 'disconnect' || lowerInput === 'disc') {
    session.connected = false;
    return { output: 'Disconnected.' };
  }

  // SET commands
  if (lowerInput.startsWith('set ')) {
    return handleSet(session, trimmed);
  }

  // SHOW commands
  if (lowerInput.startsWith('show ')) {
    return handleShow(session, trimmed);
  }

  // COLUMN command
  if (lowerInput.startsWith('column ') || lowerInput.startsWith('col ')) {
    return handleColumn(session, trimmed);
  }

  // DESCRIBE
  if (lowerInput.startsWith('describe ') || lowerInput.startsWith('desc ')) {
    return handleDescribe(session, trimmed);
  }

  // SPOOL
  if (lowerInput.startsWith('spool ')) {
    return handleSpool(session, trimmed);
  }

  // DEFINE
  if (lowerInput.startsWith('define ') || lowerInput === 'define') {
    return handleDefine(session, trimmed);
  }

  // UNDEFINE
  if (lowerInput.startsWith('undefine ') || lowerInput.startsWith('undef ')) {
    return handleUndefine(session, trimmed);
  }

  // PROMPT
  if (lowerInput.startsWith('prompt ')) {
    return { output: trimmed.substring(7) };
  }

  // CLEAR
  if (lowerInput.startsWith('clear ')) {
    return handleClear(session, trimmed);
  }

  // HOST / ! (shell command)
  if (lowerInput.startsWith('host ') || lowerInput.startsWith('! ') || lowerInput === 'host') {
    return { output: 'Shell commands not available in simulation.' };
  }

  // TIMING
  if (lowerInput.startsWith('timing ')) {
    return handleTiming(session, trimmed);
  }

  // LIST / L
  if (lowerInput === 'list' || lowerInput === 'l' || lowerInput.startsWith('list ') || lowerInput.startsWith('l ')) {
    return handleList(session);
  }

  // RUN / R / /
  if (lowerInput === 'run' || lowerInput === 'r' || lowerInput === '/') {
    return handleRun(session);
  }

  // SQL statement - check if it ends with ; or is complete
  return executeSQL(session, trimmed);
}

/**
 * Execute SQL statement
 */
function executeSQL(session: SQLPlusSession, sql: string): SQLPlusResult {
  // Remove trailing semicolon for parsing
  const statement = sql.endsWith(';') ? sql.slice(0, -1).trim() : sql.trim();

  if (!statement) {
    return { output: '' };
  }

  // Store in buffer
  session.buffer = [statement];
  session.lastCommand = statement;

  // Variable substitution
  const substituted = substituteVariables(session, statement);

  const startTime = Date.now();

  try {
    // Check for special Oracle queries on system views
    const lowerStmt = substituted.toLowerCase();

    // Handle SELECT from DUAL or system views
    if (lowerStmt.startsWith('select ')) {
      return executeSelect(session, substituted, startTime);
    }

    // Parse and execute
    const parseResult = parseSQL(substituted);

    if (!parseResult.success || parseResult.statements.length === 0) {
      const errorMsg = parseResult.errors.length > 0
        ? parseResult.errors.map(e => `ORA-00900: invalid SQL statement at line ${e.line}, column ${e.column}`).join('\n')
        : 'ORA-00900: invalid SQL statement';
      return { output: '', error: errorMsg };
    }

    for (const stmt of parseResult.statements) {
      const result = executeStatement(session, stmt, substituted);
      session.lastResult = result;

      if (!result.success) {
        return {
          output: '',
          error: `ORA-${result.error?.code || '00000'}: ${result.error?.message || 'Unknown error'}`
        };
      }

      if (result.resultSet) {
        return formatResultSet(session, result.resultSet, startTime);
      }

      if (result.affectedRows !== undefined) {
        const elapsed = Date.now() - startTime;
        let feedback = '';

        if (session.settings.feedback) {
          const stmtType = stmt.type;
          if (stmtType === 'INSERT') {
            feedback = `\n${result.affectedRows} row(s) created.`;
          } else if (stmtType === 'UPDATE') {
            feedback = `\n${result.affectedRows} row(s) updated.`;
          } else if (stmtType === 'DELETE') {
            feedback = `\n${result.affectedRows} row(s) deleted.`;
          } else if (stmtType.startsWith('CREATE')) {
            feedback = `\n${stmtType.replace('_', ' ').toLowerCase()} created.`;
          } else if (stmtType.startsWith('DROP')) {
            feedback = `\n${stmtType.replace('_', ' ').toLowerCase()} dropped.`;
          } else if (stmtType === 'TRUNCATE') {
            feedback = '\nTable truncated.';
          } else if (stmtType === 'GRANT') {
            feedback = '\nGrant succeeded.';
          } else if (stmtType === 'REVOKE') {
            feedback = '\nRevoke succeeded.';
          } else if (stmtType === 'COMMIT') {
            feedback = '\nCommit complete.';
          } else if (stmtType === 'ROLLBACK') {
            feedback = '\nRollback complete.';
          }
        }

        if (session.settings.timing) {
          feedback += `\n\nElapsed: ${(elapsed / 1000).toFixed(2)} sec`;
        }

        return { output: '', feedback };
      }
    }

    return { output: '' };
  } catch (e) {
    return { output: '', error: `ORA-00600: internal error: ${(e as Error).message}` };
  }
}

/**
 * Execute SELECT statement with system view handling
 */
function executeSelect(session: SQLPlusSession, sql: string, startTime: number): SQLPlusResult {
  const lowerSql = sql.toLowerCase();

  // Check for system view queries
  const fromMatch = lowerSql.match(/from\s+(\S+)/);
  if (fromMatch) {
    const tableName = fromMatch[1].replace(/;$/, '').toUpperCase();

    // Check if it's a system view
    if (tableName.startsWith('V$') || tableName.startsWith('V_$') ||
        tableName.startsWith('USER_') || tableName.startsWith('ALL_') ||
        tableName.startsWith('DBA_') || tableName === 'DUAL' ||
        tableName === 'DICTIONARY' || tableName === 'DICT') {

      // Handle special SELECT from system view
      const resultSet = session.catalog.queryView(tableName);

      // Apply basic column selection (simplified)
      if (lowerSql.includes('select *')) {
        return formatResultSet(session, resultSet, startTime);
      }

      // For specific columns, we'd need to parse more carefully
      // For now, return full result
      return formatResultSet(session, resultSet, startTime);
    }
  }

  // Regular SELECT - parse and execute
  const parseResult = parseSQL(sql);

  if (!parseResult.success || parseResult.statements.length === 0) {
    return { output: '', error: 'ORA-00900: invalid SQL statement' };
  }

  const result = session.engine.executeSelect(parseResult.statements[0] as any);
  session.lastResult = result;

  if (!result.success) {
    return {
      output: '',
      error: `ORA-${result.error?.code || '00942'}: ${result.error?.message || 'table or view does not exist'}`
    };
  }

  return formatResultSet(session, result.resultSet!, startTime);
}

/**
 * Execute a parsed statement
 */
function executeStatement(session: SQLPlusSession, stmt: any, originalSql: string): SQLResult {
  switch (stmt.type) {
    case 'SELECT':
      return session.engine.executeSelect(stmt);
    case 'INSERT':
      return session.engine.executeInsert(stmt);
    case 'UPDATE':
      return session.engine.executeUpdate(stmt);
    case 'DELETE':
      return session.engine.executeDelete(stmt);
    case 'CREATE_TABLE':
      return session.engine.createTable(stmt);
    case 'DROP_TABLE':
      return session.engine.dropTable(stmt.name, stmt.schema, stmt.ifExists, stmt.cascade);
    case 'TRUNCATE':
      return session.engine.truncateTable(stmt.table, stmt.schema);
    case 'CREATE_SCHEMA':
    case 'CREATE_DATABASE':
      return session.engine.createSchema(stmt.name);
    case 'DROP_SCHEMA':
    case 'DROP_DATABASE':
      return session.engine.dropSchema(stmt.name, stmt.cascade);
    case 'CREATE_USER':
      return session.engine.createUser(stmt.name, stmt.password);
    case 'DROP_USER':
      return session.engine.dropUser(stmt.name);
    case 'GRANT':
      return session.engine.grant(stmt.privileges[0], stmt.objectType, stmt.objectName, stmt.grantee, stmt.withGrantOption);
    case 'REVOKE':
      return session.engine.revoke(stmt.privileges[0], stmt.objectType, stmt.objectName, stmt.grantee);
    case 'BEGIN':
      return session.engine.beginTransaction();
    case 'COMMIT':
      return session.engine.commit();
    case 'ROLLBACK':
      return session.engine.rollback(stmt.savepoint);
    case 'SAVEPOINT':
      return session.engine.savepoint(stmt.name);
    case 'CREATE_SEQUENCE':
      return session.engine.createSequence(stmt.name, undefined, stmt);
    default:
      return { success: true };
  }
}

/**
 * Format result set as SQL*Plus output
 */
function formatResultSet(session: SQLPlusSession, resultSet: SQLResultSet, startTime: number): SQLPlusResult {
  const settings = session.settings;
  const lines: string[] = [];

  if (resultSet.rows.length === 0) {
    return {
      output: settings.feedback ? 'no rows selected\n' : '',
      feedback: settings.timing ? `Elapsed: ${((Date.now() - startTime) / 1000).toFixed(2)} sec` : undefined
    };
  }

  // Calculate column widths
  const columnWidths: number[] = resultSet.columns.map((col, i) => {
    const format = session.columnFormats.get(col.toUpperCase());
    if (format && format.format) {
      // Parse format like A20, 999,999, etc.
      const match = format.format.match(/^A(\d+)$/i);
      if (match) return parseInt(match[1], 10);
    }

    // Default width based on data
    let maxWidth = col.length;
    for (const row of resultSet.rows) {
      const val = sqlValueToString(row[col], settings.null || '');
      maxWidth = Math.max(maxWidth, val.length);
    }
    return Math.min(maxWidth, settings.lineSize / resultSet.columns.length);
  });

  // Header
  if (settings.heading) {
    const headers = resultSet.columns.map((col, i) => {
      const format = session.columnFormats.get(col.toUpperCase());
      const displayName = format?.heading || col;
      return displayName.padEnd(columnWidths[i]);
    });
    lines.push(headers.join(settings.colsep));

    // Underline
    const underlines = columnWidths.map(w => settings.underline.repeat(w));
    lines.push(underlines.join(settings.colsep));
  }

  // Data rows
  let rowCount = 0;
  for (const row of resultSet.rows) {
    const values = resultSet.columns.map((col, i) => {
      const val = sqlValueToString(row[col], settings.null || '');
      const width = columnWidths[i];

      // Truncate or pad based on settings
      if (val.length > width) {
        return settings.wrap ? val : val.substring(0, width);
      }

      const format = session.columnFormats.get(col.toUpperCase());
      const justify = format?.justify || 'LEFT';

      if (justify === 'RIGHT') {
        return val.padStart(width);
      } else if (justify === 'CENTER') {
        const leftPad = Math.floor((width - val.length) / 2);
        return val.padStart(leftPad + val.length).padEnd(width);
      }
      return val.padEnd(width);
    });

    lines.push(values.join(settings.colsep));
    rowCount++;

    // Page break
    if (settings.pageSize > 0 && rowCount % settings.pageSize === 0) {
      lines.push('');
    }
  }

  // Feedback
  let feedback = '';
  if (settings.feedback) {
    feedback = `\n${resultSet.rowCount} row${resultSet.rowCount !== 1 ? 's' : ''} selected.`;
  }

  if (settings.timing) {
    feedback += `\n\nElapsed: ${((Date.now() - startTime) / 1000).toFixed(2)} sec`;
  }

  return {
    output: lines.join('\n'),
    feedback
  };
}

/**
 * Variable substitution
 */
function substituteVariables(session: SQLPlusSession, sql: string): string {
  let result = sql;

  for (const [name, value] of session.substitutionVars) {
    const pattern = new RegExp(`${session.settings.define}${name}`, 'gi');
    result = result.replace(pattern, value);
  }

  return result;
}

// Command handlers
function handleConnect(session: SQLPlusSession, cmd: string): SQLPlusResult {
  const match = cmd.match(/conn(?:ect)?\s+(\w+)(?:\/(\w+))?(?:@(\w+))?/i);
  if (match) {
    const username = match[1].toUpperCase();
    session.username = username;
    session.engine.setCurrentUser(username);
    session.engine.setCurrentSchema(username);
    session.connected = true;
    return { output: `Connected to ${username}.` };
  }
  return { output: '', error: 'Usage: CONNECT username/password@database' };
}

function handleSet(session: SQLPlusSession, cmd: string): SQLPlusResult {
  const parts = cmd.substring(4).trim().split(/\s+/);
  if (parts.length < 2) {
    return { output: '', error: 'Usage: SET option value' };
  }

  const option = parts[0].toUpperCase();
  const value = parts.slice(1).join(' ');

  switch (option) {
    case 'LINESIZE':
    case 'LINE':
      session.settings.lineSize = parseInt(value, 10) || 80;
      break;
    case 'PAGESIZE':
    case 'PAGES':
      session.settings.pageSize = parseInt(value, 10) || 14;
      break;
    case 'FEEDBACK':
      session.settings.feedback = value.toUpperCase() === 'ON' || value === 'TRUE' || parseInt(value, 10) > 0;
      break;
    case 'HEADING':
    case 'HEA':
      session.settings.heading = value.toUpperCase() === 'ON' || value === 'TRUE';
      break;
    case 'TIMING':
      session.settings.timing = value.toUpperCase() === 'ON' || value === 'TRUE';
      break;
    case 'ECHO':
      session.settings.echo = value.toUpperCase() === 'ON' || value === 'TRUE';
      break;
    case 'VERIFY':
    case 'VER':
      session.settings.verify = value.toUpperCase() === 'ON' || value === 'TRUE';
      break;
    case 'WRAP':
      session.settings.wrap = value.toUpperCase() === 'ON' || value === 'TRUE';
      break;
    case 'NULL':
      session.settings.null = value;
      break;
    case 'COLSEP':
      session.settings.colsep = value.replace(/^['"]|['"]$/g, '');
      break;
    case 'UNDERLINE':
    case 'UND':
      session.settings.underline = value.replace(/^['"]|['"]$/g, '');
      break;
    case 'SERVEROUTPUT':
    case 'SERVEROUT':
      session.settings.serverOutput = value.toUpperCase() === 'ON';
      break;
    case 'AUTOCOMMIT':
    case 'AUTO':
      session.settings.autoCommit = value.toUpperCase() === 'ON' || value === 'IMMEDIATE';
      break;
    case 'LONG':
      session.settings.long = parseInt(value, 10) || 80;
      break;
    case 'NUMWIDTH':
    case 'NUM':
      session.settings.numWidth = parseInt(value, 10) || 10;
      break;
    case 'SQLPROMPT':
      session.settings.sqlPrompt = value.replace(/^['"]|['"]$/g, '');
      break;
    case 'TERMOUT':
    case 'TERM':
      session.settings.termOut = value.toUpperCase() === 'ON';
      break;
    case 'TIME':
      session.settings.time = value.toUpperCase() === 'ON';
      break;
    case 'AUTOTRACE':
      const traceVal = value.toUpperCase();
      if (traceVal === 'ON' || traceVal === 'OFF' || traceVal === 'TRACE' || traceVal === 'EXPLAIN') {
        session.settings.autotrace = traceVal as any;
      }
      break;
    default:
      return { output: '', error: `SP2-0735: unknown SET option "${option}"` };
  }

  return { output: '' };
}

function handleShow(session: SQLPlusSession, cmd: string): SQLPlusResult {
  const what = cmd.substring(5).trim().toUpperCase();

  switch (what) {
    case 'ALL':
      return { output: formatAllSettings(session.settings) };
    case 'USER':
      return { output: `USER is "${session.username}"` };
    case 'LINESIZE':
      return { output: `linesize ${session.settings.lineSize}` };
    case 'PAGESIZE':
      return { output: `pagesize ${session.settings.pageSize}` };
    case 'FEEDBACK':
      return { output: `FEEDBACK ON for ${session.settings.feedback ? '1' : '0'} or more rows` };
    case 'HEADING':
      return { output: `heading ${session.settings.heading ? 'ON' : 'OFF'}` };
    case 'TIMING':
      return { output: `timing ${session.settings.timing ? 'ON' : 'OFF'}` };
    case 'AUTOCOMMIT':
      return { output: `autocommit ${session.settings.autoCommit ? 'IMMEDIATE' : 'OFF'}` };
    case 'SERVEROUTPUT':
      return { output: `serveroutput ${session.settings.serverOutput ? 'ON' : 'OFF'}` };
    case 'SQLPROMPT':
      return { output: `sqlprompt "${session.settings.sqlPrompt}"` };
    case 'ERRORS':
      return { output: 'No errors.' };
    case 'SGA':
    case 'PARAMETERS':
      return { output: 'System parameters not available in simulation.' };
    case 'RELEASE':
      return { output: 'RELEASE: 190000 - Production' };
    default:
      return { output: '', error: `SP2-0158: unknown SHOW option "${what}"` };
  }
}

function handleColumn(session: SQLPlusSession, cmd: string): SQLPlusResult {
  const match = cmd.match(/col(?:umn)?\s+(\w+)(?:\s+(.+))?/i);
  if (!match) {
    return { output: '', error: 'Usage: COLUMN column_name [FORMAT format] [HEADING heading]' };
  }

  const columnName = match[1].toUpperCase();
  const options = match[2] || '';

  if (!options) {
    // Show column format
    const format = session.columnFormats.get(columnName);
    if (format) {
      return { output: `COLUMN ${columnName} FORMAT ${format.format || 'default'} HEADING "${format.heading || columnName}"` };
    }
    return { output: `COLUMN ${columnName} is not defined.` };
  }

  // Parse column options
  const format: ColumnFormat = session.columnFormats.get(columnName) || { name: columnName };

  const formatMatch = options.match(/format\s+(\S+)/i);
  if (formatMatch) {
    format.format = formatMatch[1];
  }

  const headingMatch = options.match(/heading\s+['"]?([^'"]+)['"]?/i);
  if (headingMatch) {
    format.heading = headingMatch[1];
  }

  const justifyMatch = options.match(/justify\s+(left|center|right)/i);
  if (justifyMatch) {
    format.justify = justifyMatch[1].toUpperCase() as any;
  }

  if (options.toLowerCase().includes('word_wrap')) {
    format.wordWrap = true;
  }

  if (options.toLowerCase().includes('truncate')) {
    format.truncate = true;
  }

  if (options.toLowerCase().includes('clear')) {
    session.columnFormats.delete(columnName);
    return { output: '' };
  }

  session.columnFormats.set(columnName, format);
  return { output: '' };
}

function handleDescribe(session: SQLPlusSession, cmd: string): SQLPlusResult {
  const match = cmd.match(/desc(?:ribe)?\s+(\S+)/i);
  if (!match) {
    return { output: '', error: 'Usage: DESCRIBE table_name' };
  }

  const objectName = match[1].toUpperCase();

  // Check if it's a table in the engine
  const tableDef = session.engine.getTableDefinition(objectName);

  if (tableDef) {
    const lines: string[] = [];
    lines.push(` Name                                      Null?    Type`);
    lines.push(` ----------------------------------------- -------- ----------------------------`);

    for (const col of tableDef.columns) {
      const name = col.name.padEnd(42);
      const nullable = col.nullable ? '        ' : 'NOT NULL';
      let type = col.dataType;
      if (col.length) {
        type += `(${col.length}${col.scale ? `,${col.scale}` : ''})`;
      } else if (col.precision) {
        type += `(${col.precision}${col.scale ? `,${col.scale}` : ''})`;
      }

      lines.push(` ${name}${nullable} ${type}`);
    }

    return { output: lines.join('\n') };
  }

  // Check system views
  const resultSet = session.catalog.queryView('USER_TAB_COLUMNS', row => row.TABLE_NAME === objectName);

  if (resultSet.rowCount > 0) {
    const lines: string[] = [];
    lines.push(` Name                                      Null?    Type`);
    lines.push(` ----------------------------------------- -------- ----------------------------`);

    for (const row of resultSet.rows) {
      const name = String(row.COLUMN_NAME).padEnd(42);
      const nullable = row.NULLABLE === 'Y' ? '        ' : 'NOT NULL';
      let type = String(row.DATA_TYPE);
      if (row.DATA_LENGTH) {
        type += `(${row.DATA_LENGTH})`;
      }

      lines.push(` ${name}${nullable} ${type}`);
    }

    return { output: lines.join('\n') };
  }

  return { output: '', error: `ORA-04043: object ${objectName} does not exist` };
}

function handleSpool(session: SQLPlusSession, cmd: string): SQLPlusResult {
  const match = cmd.match(/spool\s+(.+)/i);
  if (!match) {
    return { output: '', error: 'Usage: SPOOL filename | OFF' };
  }

  const arg = match[1].trim().toUpperCase();

  if (arg === 'OFF') {
    session.spool.file = null;
    return { output: '' };
  }

  session.spool.file = match[1].trim();
  session.spool.append = arg.includes('APPEND');
  session.spool.create = arg.includes('CREATE');
  session.spool.replace = !session.spool.append && !session.spool.create;

  return { output: '' };
}

function handleDefine(session: SQLPlusSession, cmd: string): SQLPlusResult {
  if (cmd.toLowerCase() === 'define') {
    // List all variables
    if (session.substitutionVars.size === 0) {
      return { output: 'No substitution variables defined.' };
    }

    const lines = Array.from(session.substitutionVars.entries())
      .map(([name, value]) => `DEFINE ${name} = "${value}"`);
    return { output: lines.join('\n') };
  }

  const match = cmd.match(/define\s+(\w+)\s*=\s*['"]?(.+?)['"]?\s*$/i);
  if (!match) {
    return { output: '', error: 'Usage: DEFINE variable = value' };
  }

  session.substitutionVars.set(match[1].toUpperCase(), match[2]);
  return { output: '' };
}

function handleUndefine(session: SQLPlusSession, cmd: string): SQLPlusResult {
  const match = cmd.match(/undef(?:ine)?\s+(\w+)/i);
  if (!match) {
    return { output: '', error: 'Usage: UNDEFINE variable' };
  }

  const varName = match[1].toUpperCase();
  if (session.substitutionVars.has(varName)) {
    session.substitutionVars.delete(varName);
    return { output: '' };
  }

  return { output: '', error: `SP2-0135: symbol ${varName} is UNDEFINED` };
}

function handleClear(session: SQLPlusSession, cmd: string): SQLPlusResult {
  const what = cmd.substring(6).trim().toUpperCase();

  switch (what) {
    case 'COLUMNS':
      session.columnFormats.clear();
      return { output: 'columns cleared' };
    case 'BUFFER':
      session.buffer = [];
      return { output: 'buffer cleared' };
    case 'SCREEN':
      return { output: '\x1b[2J\x1b[H' }; // ANSI clear screen
    default:
      return { output: '', error: `SP2-0158: unknown CLEAR option "${what}"` };
  }
}

function handleTiming(session: SQLPlusSession, cmd: string): SQLPlusResult {
  const match = cmd.match(/timing\s+(start|stop|show)\s*(\w*)/i);
  if (!match) {
    return { output: '', error: 'Usage: TIMING START name | STOP | SHOW' };
  }

  const action = match[1].toUpperCase();
  if (action === 'START') {
    return { output: 'Timing started.' };
  }
  if (action === 'STOP') {
    return { output: 'Timing stopped.' };
  }
  return { output: 'No timing.' };
}

function handleList(session: SQLPlusSession): SQLPlusResult {
  if (session.buffer.length === 0) {
    return { output: 'SP2-0223: No lines in SQL buffer.' };
  }

  const lines = session.buffer.map((line, i) => `  ${i + 1}* ${line}`);
  return { output: lines.join('\n') };
}

function handleRun(session: SQLPlusSession): SQLPlusResult {
  if (session.buffer.length === 0) {
    return { output: '', error: 'SP2-0223: No lines in SQL buffer.' };
  }

  const sql = session.buffer.join('\n');
  const listOutput = session.buffer.map((line, i) => `  ${i + 1}* ${line}`).join('\n');

  const result = executeSQL(session, sql + ';');
  return {
    output: listOutput + '\n' + result.output,
    error: result.error,
    feedback: result.feedback
  };
}

function formatAllSettings(settings: OracleSessionSettings): string {
  return `
arraysize ${settings.arraySize}
autocommit ${settings.autoCommit ? 'IMMEDIATE' : 'OFF'}
autotrace ${settings.autotrace}
colsep "${settings.colsep}"
echo ${settings.echo ? 'ON' : 'OFF'}
feedback ${settings.feedback ? 'ON' : 'OFF'}
heading ${settings.heading ? 'ON' : 'OFF'}
linesize ${settings.lineSize}
long ${settings.long}
null "${settings.null}"
numwidth ${settings.numWidth}
pagesize ${settings.pageSize}
serveroutput ${settings.serverOutput ? 'ON' : 'OFF'}
sqlprompt "${settings.sqlPrompt}"
termout ${settings.termOut ? 'ON' : 'OFF'}
time ${settings.time ? 'ON' : 'OFF'}
timing ${settings.timing ? 'ON' : 'OFF'}
verify ${settings.verify ? 'ON' : 'OFF'}
wrap ${settings.wrap ? 'ON' : 'OFF'}
`.trim();
}

function getSQLPlusHelp(): string {
  return `
SQL*Plus: Release 19.0.0.0.0 - Production

HELP
----
SQL*Plus commands:

  @file           Run a SQL script file
  /               Run the SQL statement in the buffer
  CLEAR           Clear options (BUFFER, COLUMNS, SCREEN)
  COLUMN          Define display format for a column
  CONNECT         Connect to a database
  DEFINE          Define a substitution variable
  DESCRIBE        Describe a table, view, or synonym
  DISCONNECT      Disconnect from the database
  EXIT/QUIT       Exit SQL*Plus
  HOST            Execute a host operating system command
  LIST            List the contents of the SQL buffer
  PROMPT          Display a message on screen
  RUN             Run the SQL statement in the buffer
  SET             Set SQL*Plus system variables
  SHOW            Show SQL*Plus system variables
  SPOOL           Store query results in a file
  UNDEFINE        Delete a substitution variable

Enter "HELP command" for help on a specific command.
`.trim();
}

/**
 * Get SQL*Plus prompt
 */
export function getSQLPlusPrompt(session: SQLPlusSession): string {
  let prompt = session.settings.sqlPrompt;

  if (session.settings.time) {
    const now = new Date();
    const time = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}`;
    prompt = time + ' ' + prompt;
  }

  return prompt;
}
