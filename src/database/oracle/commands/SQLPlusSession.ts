/**
 * SQLPlusSession — Simulates the Oracle SQL*Plus command-line interface.
 *
 * Handles:
 *   - SQL> prompt with multi-line input (terminated by ;)
 *   - SET commands (LINESIZE, PAGESIZE, SERVEROUTPUT, TIMING, FEEDBACK, etc.)
 *   - SHOW commands (USER, PARAMETER, SGA, ALL, ERRORS)
 *   - DESC[RIBE] table
 *   - CONNECT username/password
 *   - EXIT / QUIT
 *   - HELP
 *   - Column-formatted output with headers and separators
 *   - / (re-execute last statement)
 *   - @ and START (run script — simulated)
 *   - SPOOL (simulated)
 *   - PROMPT, ACCEPT (simulated)
 */

import { OracleDatabase } from '../OracleDatabase';
import { OracleExecutor } from '../OracleExecutor';
import type { ResultSet, ColumnMeta } from '../../engine/executor/ResultSet';
import { ORACLE_ERRORS } from '../../../terminal/commands/OracleConfig';

export interface ColumnFormat {
  name: string;
  format?: string;
  heading?: string;
  width?: number;
}

export interface SQLPlusSettings {
  linesize: number;
  pagesize: number;
  serveroutput: boolean;
  feedback: boolean;
  timing: boolean;
  heading: boolean;
  echo: boolean;
  verify: boolean;
  autocommit: boolean;
  numformat: string;
  colsep: string;
  trimspool: boolean;
  termout: boolean;
  define: string;
  sqlprompt: string;
  wrap: boolean;
  underline: string;
  null_display: string;
}

export interface SQLPlusResult {
  output: string[];
  exit: boolean;
  needsMoreInput: boolean;
  prompt: string;
}

export class SQLPlusSession {
  private db: OracleDatabase;
  private executor: OracleExecutor | null = null;
  private sid: number = 0;
  private settings: SQLPlusSettings;
  private sqlBuffer: string = '';
  private lineNumber: number = 0;
  private lastStatement: string = '';
  private plsqlMode: boolean = false;
  private plsqlDepth: number = 0;
  private connected: boolean = false;
  private asSysdba: boolean = false;
  private currentUser: string = '';
  private spoolFile: string | null = null;
  /** User-defined substitution variables (DEFINE) */
  private defines: Map<string, string> = new Map();
  /** Bind variables (VARIABLE / PRINT) */
  private bindVariables: Map<string, { type: string; value: unknown }> = new Map();
  /** Column formatting rules (COLUMN ... FORMAT) */
  private columnFormats: Map<string, ColumnFormat> = new Map();

  constructor(db: OracleDatabase) {
    this.db = db;
    this.settings = this.defaultSettings();
  }

  private defaultSettings(): SQLPlusSettings {
    return {
      linesize: 80,
      pagesize: 14,
      serveroutput: false,
      feedback: true,
      timing: false,
      heading: true,
      echo: false,
      verify: true,
      autocommit: false,
      numformat: '',
      colsep: ' ',
      trimspool: false,
      termout: true,
      define: '&',
      sqlprompt: 'SQL> ',
      wrap: true,
      underline: '-',
      null_display: '',
    };
  }

  /** Access the underlying OracleDatabase for VFS sync. */
  getDatabase(): OracleDatabase | null {
    return this.connected ? this.db : null;
  }

  /**
   * Get the banner displayed when SQL*Plus starts.
   */
  getBanner(): string[] {
    return [
      '',
      'SQL*Plus: Release 19.0.0.0.0 - Production on ' + new Date().toDateString(),
      'Version 19.3.0.0.0',
      '',
      'Copyright (c) 1982, 2019, Oracle.  All rights reserved.',
      '',
    ];
  }

  /**
   * Attempt to connect with username/password.
   * Returns output lines.
   */
  login(username: string, password: string, asSysdba: boolean = false): string[] {
    const output: string[] = [];

    if (this.connected) {
      this.disconnect();
    }

    try {
      let result;
      if (asSysdba) {
        result = this.db.connectAsSysdba();
        this.asSysdba = true;
      } else {
        result = this.db.connect(username, password);
        this.asSysdba = false;
      }
      this.executor = result.executor;
      this.sid = result.sid;
      this.connected = true;
      this.currentUser = asSysdba ? 'SYS' : username.toUpperCase();

      if (this.executor) {
        this.executor.updateContext({
          serverOutput: this.settings.serveroutput,
          feedback: this.settings.feedback,
          timing: this.settings.timing,
          autoCommit: this.settings.autocommit,
        });
      }

      output.push('Connected.');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      output.push(`ERROR:`);
      output.push(msg);
    }

    return output;
  }

  disconnect(): void {
    if (this.connected && this.sid) {
      this.db.disconnect(this.sid);
    }
    this.executor = null;
    this.sid = 0;
    this.connected = false;
    this.currentUser = '';
    this.asSysdba = false;
  }

  /**
   * Process a line of input. Returns structured result.
   */
  processLine(line: string): SQLPlusResult {
    const trimmed = line.trim();

    // If we're accumulating a PL/SQL block
    if (this.plsqlMode) {
      return this.handlePLSQLLine(trimmed);
    }

    // If we're accumulating a multi-line SQL buffer
    if (this.sqlBuffer.length > 0) {
      // Single / on its own line means "execute buffer"
      if (trimmed === '/') {
        return this.executeBuffer();
      }
      // Blank line — clear buffer in SQL*Plus
      if (trimmed === '') {
        this.sqlBuffer = '';
        this.lineNumber = 0;
        return { output: [], exit: false, needsMoreInput: false, prompt: this.getPrompt() };
      }
      // Check if line ends with ;
      if (trimmed.endsWith(';')) {
        this.sqlBuffer += (this.sqlBuffer ? '\n' : '') + trimmed.slice(0, -1);
        return this.executeBuffer();
      }
      // Continue accumulating
      this.sqlBuffer += (this.sqlBuffer ? '\n' : '') + trimmed;
      this.lineNumber++;
      return { output: [], exit: false, needsMoreInput: true, prompt: `  ${this.lineNumber}  ` };
    }

    // Fresh input line
    if (!trimmed) {
      return { output: [], exit: false, needsMoreInput: false, prompt: this.getPrompt() };
    }

    // SQL*Plus commands (case-insensitive)
    const upper = trimmed.toUpperCase();

    // EXIT / QUIT
    if (upper === 'EXIT' || upper === 'QUIT' || upper.startsWith('EXIT ') || upper.startsWith('QUIT ')) {
      this.disconnect();
      return { output: ['Disconnected from Oracle Database 19c Enterprise Edition Release 19.0.0.0.0 - Production'], exit: true, needsMoreInput: false, prompt: '' };
    }

    // / — re-execute last statement
    if (trimmed === '/') {
      if (this.lastStatement) {
        return this.executeSql(this.lastStatement);
      }
      return { output: ['SP2-0103: Nothing in SQL buffer to run.'], exit: false, needsMoreInput: false, prompt: this.getPrompt() };
    }

    // SET commands
    if (upper.startsWith('SET ')) {
      return this.handleSet(trimmed.substring(4).trim());
    }

    // SHOW commands
    if (upper.startsWith('SHOW ') || upper === 'SHOW') {
      return this.handleShow(trimmed.substring(4).trim());
    }

    // DESC / DESCRIBE
    if (upper.startsWith('DESC ') || upper.startsWith('DESCRIBE ')) {
      const obj = upper.startsWith('DESC ') ? trimmed.substring(5).trim() : trimmed.substring(9).trim();
      return this.handleDescribe(obj);
    }

    // CONNECT
    if (upper.startsWith('CONN ') || upper.startsWith('CONNECT ')) {
      const args = upper.startsWith('CONN ') ? trimmed.substring(5).trim() : trimmed.substring(8).trim();
      return this.handleConnect(args);
    }

    // HELP
    if (upper === 'HELP' || upper === 'HELP INDEX') {
      return this.handleHelp();
    }

    // CLEAR
    if (upper.startsWith('CLEAR ')) {
      return { output: [], exit: false, needsMoreInput: false, prompt: this.getPrompt() };
    }

    // SPOOL
    if (upper.startsWith('SPOOL ')) {
      return this.handleSpool(trimmed.substring(6).trim());
    }

    // PROMPT
    if (upper.startsWith('PROMPT ') || upper === 'PROMPT') {
      const text = trimmed.length > 7 ? trimmed.substring(7) : '';
      return { output: [text], exit: false, needsMoreInput: false, prompt: this.getPrompt() };
    }

    // HOST / ! — shell command (not supported in simulator)
    if (upper.startsWith('HOST ') || upper === 'HOST' || upper.startsWith('!')) {
      return { output: ['SP2-0734: HOST command is not available in this environment.'], exit: false, needsMoreInput: false, prompt: this.getPrompt() };
    }

    // @ / START — execute script (simulated)
    if (trimmed.startsWith('@') || upper.startsWith('START ')) {
      const scriptName = trimmed.startsWith('@') ? trimmed.substring(1).trim() : trimmed.substring(6).trim();
      return { output: [`SP2-0310: unable to open file "${scriptName}"`], exit: false, needsMoreInput: false, prompt: this.getPrompt() };
    }

    // COLUMN — column formatting
    if (upper.startsWith('COLUMN ') || upper === 'COLUMN') {
      return this.handleColumn(trimmed.substring(6).trim());
    }
    if (upper.startsWith('COL ')) {
      return this.handleColumn(trimmed.substring(4).trim());
    }

    // DEFINE — substitution variables
    if (upper.startsWith('DEFINE ') || upper === 'DEFINE') {
      return this.handleDefine(trimmed.substring(6).trim());
    }

    // VARIABLE — bind variable declaration
    if (upper.startsWith('VARIABLE ') || upper === 'VARIABLE' || upper.startsWith('VAR ')) {
      const offset = upper.startsWith('VAR ') ? 4 : upper.startsWith('VARIABLE') ? (upper === 'VARIABLE' ? 8 : 9) : 9;
      return this.handleVariable(trimmed.substring(offset).trim());
    }

    // PRINT — display bind variable
    if (upper.startsWith('PRINT ') || upper === 'PRINT') {
      return this.handlePrint(trimmed.substring(5).trim());
    }

    // EDIT — open editor (not supported in simulator)
    if (upper === 'EDIT' || upper.startsWith('EDIT ')) {
      return { output: ['SP2-0107: Nothing to save.'], exit: false, needsMoreInput: false, prompt: this.getPrompt() };
    }

    // SQL statements — check if ends with ;
    if (this.isSqlStart(upper)) {
      if (trimmed.endsWith(';')) {
        return this.executeSql(trimmed.slice(0, -1));
      }
      // Start multi-line accumulation
      this.sqlBuffer = trimmed;
      this.lineNumber = 2;
      return { output: [], exit: false, needsMoreInput: true, prompt: `  2  ` };
    }

    // Admin commands (STARTUP, SHUTDOWN) — execute immediately (no ; needed)
    if (upper.startsWith('STARTUP') || upper.startsWith('SHUTDOWN')) {
      return this.executeSql(trimmed);
    }

    // PL/SQL blocks: BEGIN or DECLARE start a multi-line block terminated by END; followed by /
    if (upper === 'BEGIN' || upper.startsWith('BEGIN') || upper === 'DECLARE' || upper.startsWith('DECLARE')) {
      return this.startPLSQLBlock(trimmed);
    }

    // Unknown command
    return { output: [`SP2-0734: unknown command beginning "${trimmed.substring(0, 20)}..." - rest of line ignored.`], exit: false, needsMoreInput: false, prompt: this.getPrompt() };
  }

  private startPLSQLBlock(line: string): SQLPlusResult {
    this.plsqlMode = true;
    this.plsqlDepth = 0;
    this.sqlBuffer = line;
    this.lineNumber = 2;

    // Count initial depth
    this.updatePLSQLDepth(line);

    // Check if the entire block is on one line (e.g., BEGIN NULL; END;)
    const upper = line.toUpperCase().trim();
    if (upper.endsWith('END;') || upper.match(/\bEND\s+\w+\s*;$/i)) {
      // Check if depth is back to 0
      if (this.plsqlDepth <= 0) {
        return this.executePLSQLBuffer();
      }
    }

    return { output: [], exit: false, needsMoreInput: true, prompt: `  ${this.lineNumber}  ` };
  }

  private handlePLSQLLine(trimmed: string): SQLPlusResult {
    // / on its own executes the PL/SQL buffer
    if (trimmed === '/') {
      return this.executePLSQLBuffer();
    }

    // Blank line in PL/SQL doesn't cancel (unlike regular SQL)
    this.sqlBuffer += '\n' + trimmed;
    this.lineNumber++;
    this.updatePLSQLDepth(trimmed);

    // Check for END; at depth 0 — PL/SQL block complete, but SQL*Plus
    // traditionally requires / on the next line.  However, if the line
    // ends with END; and the depth is back to 0, auto-execute (common in simulators).
    const upper = trimmed.toUpperCase().replace(/\s+/g, ' ').trim();
    if ((upper === 'END;' || upper.match(/^END\s+\w+\s*;$/i)) && this.plsqlDepth <= 0) {
      return this.executePLSQLBuffer();
    }

    return { output: [], exit: false, needsMoreInput: true, prompt: `  ${this.lineNumber}  ` };
  }

  private updatePLSQLDepth(line: string): void {
    const upper = line.toUpperCase();
    // Count block openers
    const openers = /\b(BEGIN|LOOP|CASE)\b/gi;
    let m;
    while ((m = openers.exec(upper)) !== null) this.plsqlDepth++;

    // DECLARE doesn't need its own END but starts a block with BEGIN
    if (/\bIF\b/.test(upper) && /\bTHEN\b/.test(upper)) this.plsqlDepth++;

    // Count block closers
    const closers = /\bEND(\s+(IF|LOOP|CASE|\w+))?\s*;/gi;
    while ((m = closers.exec(upper)) !== null) this.plsqlDepth--;

    // Standalone END;
    if (/^\s*END\s*;\s*$/i.test(line) && !/\bEND\s+(IF|LOOP|CASE)/i.test(upper)) {
      // Already counted above
    }
  }

  private executePLSQLBuffer(): SQLPlusResult {
    const sql = this.sqlBuffer.trim();
    this.sqlBuffer = '';
    this.lineNumber = 0;
    this.plsqlMode = false;
    this.plsqlDepth = 0;

    if (!sql) {
      return { output: ['SP2-0103: Nothing in SQL buffer to run.'], exit: false, needsMoreInput: false, prompt: this.getPrompt() };
    }

    // Remove trailing ; from the whole block if present
    const cleanSql = sql.replace(/;\s*$/, '');
    return this.executeSql(cleanSql);
  }

  private isSqlStart(upper: string): boolean {
    const sqlKeywords = [
      'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'CREATE', 'DROP', 'ALTER',
      'GRANT', 'REVOKE', 'TRUNCATE', 'MERGE', 'WITH', 'COMMIT', 'ROLLBACK',
      'SAVEPOINT', 'COMMENT', 'EXPLAIN',
    ];
    return sqlKeywords.some(kw => upper.startsWith(kw + ' ') || upper === kw);
  }

  private executeBuffer(): SQLPlusResult {
    const sql = this.sqlBuffer.trim();
    this.sqlBuffer = '';
    this.lineNumber = 0;
    if (!sql) {
      return { output: ['SP2-0103: Nothing in SQL buffer to run.'], exit: false, needsMoreInput: false, prompt: this.getPrompt() };
    }
    return this.executeSql(sql);
  }

  private executeSql(sql: string): SQLPlusResult {
    if (!this.connected || !this.executor) {
      return { output: ['ERROR:', ORACLE_ERRORS.ORA_01012], exit: false, needsMoreInput: false, prompt: this.getPrompt() };
    }

    this.lastStatement = sql;
    const output: string[] = [];

    try {
      const startTime = Date.now();
      const result = this.db.executeSql(this.executor, sql);
      const elapsed = Date.now() - startTime;

      if (result.isQuery && result.columns.length > 0) {
        output.push(...this.formatQueryResult(result));
      } else if (result.message) {
        output.push('');
        output.push(result.message);
      }

      if (result.warnings) {
        for (const w of result.warnings) output.push(`WARNING: ${w}`);
      }

      if (result.isQuery && this.settings.feedback && result.rows.length > 0) {
        output.push('');
        if (result.rows.length === 1) output.push('1 row selected.');
        else output.push(`${result.rows.length} rows selected.`);
      }

      if (this.settings.timing) {
        output.push('');
        output.push(`Elapsed: 00:00:0${elapsed / 1000 < 10 ? '0' : ''}${(elapsed / 1000).toFixed(2)}`);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      output.push(`ERROR:`);
      // Check if it's an ORA- error
      if (msg.startsWith('ORA-')) {
        output.push(msg);
      } else {
        output.push(`${ORACLE_ERRORS.ORA_00900}: ${msg}`);
      }
    }

    return { output, exit: false, needsMoreInput: false, prompt: this.getPrompt() };
  }

  /**
   * Format a query result as a text table (SQL*Plus style).
   */
  private formatQueryResult(result: ResultSet): string[] {
    const output: string[] = [];
    const { columns, rows } = result;

    // Calculate column widths
    const widths = columns.map((col, i) => {
      const headerWidth = (col.alias || col.name).length;
      let maxData = 0;
      for (const row of rows) {
        const val = this.formatCell(row[i]);
        if (val.length > maxData) maxData = val.length;
      }
      return Math.max(headerWidth, maxData);
    });

    // Cap widths at linesize
    const totalWidth = widths.reduce((a, b) => a + b, 0) + (widths.length - 1) * this.settings.colsep.length;
    if (totalWidth > this.settings.linesize && !this.settings.wrap) {
      // Simple truncation for now
    }

    output.push('');

    if (this.settings.heading) {
      // Header row
      const headerParts = columns.map((col, i) => {
        const name = (col.alias || col.name).toUpperCase();
        return name.padEnd(widths[i]);
      });
      output.push(headerParts.join(this.settings.colsep));

      // Separator
      const sepParts = widths.map(w => this.settings.underline.repeat(w));
      output.push(sepParts.join(this.settings.colsep));
    }

    // Data rows
    let rowCount = 0;
    for (const row of rows) {
      const parts = columns.map((_, i) => {
        const val = this.formatCell(row[i]);
        return val.padEnd(widths[i]);
      });
      output.push(parts.join(this.settings.colsep));
      rowCount++;
      // Page break
      if (this.settings.pagesize > 0 && rowCount % this.settings.pagesize === 0 && rowCount < rows.length) {
        output.push('');
        if (this.settings.heading) {
          const headerParts = columns.map((col, i) => {
            const name = (col.alias || col.name).toUpperCase();
            return name.padEnd(widths[i]);
          });
          output.push(headerParts.join(this.settings.colsep));
          const sepParts = widths.map(w => this.settings.underline.repeat(w));
          output.push(sepParts.join(this.settings.colsep));
        }
      }
    }

    return output;
  }

  private formatCell(value: unknown): string {
    if (value === null || value === undefined) return this.settings.null_display;
    if (value instanceof Date) {
      // Oracle default date format: DD-MON-YY
      const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
      const d = value.getDate().toString().padStart(2, '0');
      const m = months[value.getMonth()];
      const y = (value.getFullYear() % 100).toString().padStart(2, '0');
      return `${d}-${m}-${y}`;
    }
    return String(value);
  }

  // ── SET command ──────────────────────────────────────────────────

  private handleSet(args: string): SQLPlusResult {
    const parts = args.split(/\s+/);
    const option = parts[0]?.toUpperCase();
    const value = parts.slice(1).join(' ');

    switch (option) {
      case 'LINESIZE': case 'LIN':
        this.settings.linesize = parseInt(value) || 80;
        break;
      case 'PAGESIZE': case 'PAGES':
        this.settings.pagesize = parseInt(value) || 14;
        break;
      case 'SERVEROUTPUT': case 'SERVEROUT':
        this.settings.serveroutput = value.toUpperCase() === 'ON';
        if (this.executor) this.executor.updateContext({ serverOutput: this.settings.serveroutput });
        break;
      case 'FEEDBACK': case 'FEED':
        if (value.toUpperCase() === 'OFF') this.settings.feedback = false;
        else if (value.toUpperCase() === 'ON') this.settings.feedback = true;
        else this.settings.feedback = true;
        if (this.executor) this.executor.updateContext({ feedback: this.settings.feedback });
        break;
      case 'TIMING': case 'TIM':
        this.settings.timing = value.toUpperCase() === 'ON';
        if (this.executor) this.executor.updateContext({ timing: this.settings.timing });
        break;
      case 'HEADING': case 'HEA':
        this.settings.heading = value.toUpperCase() !== 'OFF';
        break;
      case 'ECHO':
        this.settings.echo = value.toUpperCase() === 'ON';
        break;
      case 'VERIFY': case 'VER':
        this.settings.verify = value.toUpperCase() !== 'OFF';
        break;
      case 'AUTOCOMMIT': case 'AUTO':
        this.settings.autocommit = value.toUpperCase() === 'ON';
        if (this.executor) this.executor.updateContext({ autoCommit: this.settings.autocommit });
        break;
      case 'COLSEP':
        this.settings.colsep = value.replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
        break;
      case 'NULL':
        this.settings.null_display = value.replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
        break;
      case 'WRAP':
        this.settings.wrap = value.toUpperCase() !== 'OFF';
        break;
      case 'UNDERLINE': case 'UND':
        if (value.toUpperCase() === 'OFF') this.settings.underline = '';
        else this.settings.underline = value.charAt(0) || '-';
        break;
      case 'SQLPROMPT':
        this.settings.sqlprompt = value.replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
        break;
      case 'DEFINE': case 'DEF':
        if (value.toUpperCase() === 'OFF') this.settings.define = '';
        else this.settings.define = value.charAt(0) || '&';
        break;
      case 'TERMOUT': case 'TERM':
        this.settings.termout = value.toUpperCase() !== 'OFF';
        break;
      case 'TRIMSPOOL': case 'TRIMS':
        this.settings.trimspool = value.toUpperCase() === 'ON';
        break;
      default:
        return { output: [`SP2-0158: unknown SET option "${option}"`], exit: false, needsMoreInput: false, prompt: this.getPrompt() };
    }

    return { output: [], exit: false, needsMoreInput: false, prompt: this.getPrompt() };
  }

  // ── SHOW command ─────────────────────────────────────────────────

  private handleShow(args: string): SQLPlusResult {
    const option = args.trim().toUpperCase();
    const output: string[] = [];

    switch (option) {
      case 'USER':
        output.push(`USER is "${this.currentUser}"`);
        break;
      case 'LINESIZE': case 'LIN':
        output.push(`linesize ${this.settings.linesize}`);
        break;
      case 'PAGESIZE': case 'PAGES':
        output.push(`pagesize ${this.settings.pagesize}`);
        break;
      case 'SERVEROUTPUT': case 'SERVEROUT':
        output.push(`serveroutput ${this.settings.serveroutput ? 'ON' : 'OFF'}`);
        break;
      case 'FEEDBACK': case 'FEED':
        output.push(`FEEDBACK ON for ${this.settings.feedback ? '1' : '0'} or more rows`);
        break;
      case 'TIMING': case 'TIM':
        output.push(`timing ${this.settings.timing ? 'ON' : 'OFF'}`);
        break;
      case 'AUTOCOMMIT': case 'AUTO':
        output.push(`autocommit ${this.settings.autocommit ? 'ON' : 'OFF'}`);
        break;
      case 'HEADING': case 'HEA':
        output.push(`heading ${this.settings.heading ? 'ON' : 'OFF'}`);
        break;
      case 'SGA': {
        if (!this.connected || !this.executor) {
          output.push('ERROR:', ORACLE_ERRORS.ORA_01012);
          break;
        }
        const sga = this.db.instance.getSGAInfo();
        output.push('');
        output.push('Total System Global Area  ' + sga.totalSize);
        output.push('Fixed Size                2.0M');
        output.push('Variable Size             256.0M');
        output.push('Database Buffers          ' + sga.bufferCache);
        output.push('Redo Buffers              ' + sga.redoLogBuffer);
        break;
      }
      case 'PARAMETER':
      case 'PARAMETERS': {
        if (!this.connected) {
          output.push('ERROR:', ORACLE_ERRORS.ORA_01012);
          break;
        }
        const params = this.db.instance.getAllParameters();
        output.push('');
        output.push('NAME'.padEnd(44) + 'TYPE'.padEnd(12) + 'VALUE');
        output.push('-'.repeat(44) + ' ' + '-'.repeat(11) + ' ' + '-'.repeat(30));
        for (const [name, value] of params) {
          const type = this.getParamTypeStr(value);
          output.push(name.padEnd(44) + type.padEnd(12) + value);
        }
        break;
      }
      case 'ALL':
        output.push(`autocommit ${this.settings.autocommit ? 'ON' : 'OFF'}`);
        output.push(`colsep "${this.settings.colsep}"`);
        output.push(`echo ${this.settings.echo ? 'ON' : 'OFF'}`);
        output.push(`feedback ${this.settings.feedback ? 'ON' : 'OFF'}`);
        output.push(`heading ${this.settings.heading ? 'ON' : 'OFF'}`);
        output.push(`linesize ${this.settings.linesize}`);
        output.push(`null "${this.settings.null_display}"`);
        output.push(`pagesize ${this.settings.pagesize}`);
        output.push(`serveroutput ${this.settings.serveroutput ? 'ON' : 'OFF'}`);
        output.push(`timing ${this.settings.timing ? 'ON' : 'OFF'}`);
        output.push(`verify ${this.settings.verify ? 'ON' : 'OFF'}`);
        output.push(`wrap ${this.settings.wrap ? 'ON' : 'OFF'}`);
        break;
      case 'ERRORS':
        output.push('No errors.');
        break;
      case 'RELEASE':
        output.push('release 1903000000');
        break;
      case 'SQLPROMPT':
        output.push(`sqlprompt "${this.settings.sqlprompt}"`);
        break;
      default: {
        // SHOW PARAMETER <name> — show matching parameters with TYPE column
        if (option.startsWith('PARAMETER ') || option.startsWith('PARAMETERS ') || option === 'PARAMETER' || option === 'PARAMETERS') {
          const search = option.replace(/^PARAMETERS?\s*/, '').toLowerCase();
          if (this.connected) {
            const params = this.db.instance.getAllParameters();
            output.push('');
            output.push('NAME'.padEnd(44) + 'TYPE'.padEnd(12) + 'VALUE');
            output.push('-'.repeat(44) + ' ' + '-'.repeat(11) + ' ' + '-'.repeat(30));
            for (const [name, value] of params) {
              if (!search || name.includes(search)) {
                const type = this.getParamTypeStr(value);
                output.push(name.padEnd(44) + type.padEnd(12) + value);
              }
            }
          } else {
            output.push('ERROR:', ORACLE_ERRORS.ORA_01012);
          }
        // SHOW SPPARAMETER <name> — show server parameter file parameters
        } else if (option.startsWith('SPPARAMETER ') || option.startsWith('SPPARAMETERS ') || option === 'SPPARAMETER' || option === 'SPPARAMETERS') {
          const search = option.replace(/^SPPARAMETERS?\s*/, '').toLowerCase();
          if (this.connected) {
            const params = this.db.instance.getSpfileParameters();
            output.push('');
            output.push('SID'.padEnd(10) + 'NAME'.padEnd(44) + 'TYPE'.padEnd(12) + 'VALUE');
            output.push('-'.repeat(9) + ' ' + '-'.repeat(44) + ' ' + '-'.repeat(11) + ' ' + '-'.repeat(30));
            for (const [name, value] of params) {
              if (!search || name.includes(search)) {
                const type = this.getParamTypeStr(value);
                output.push('*'.padEnd(10) + name.padEnd(44) + type.padEnd(12) + value);
              }
            }
          } else {
            output.push('ERROR:', ORACLE_ERRORS.ORA_01012);
          }
        } else {
          output.push(`SP2-0158: unknown SHOW option "${option}"`);
        }
        break;
      }
    }

    return { output, exit: false, needsMoreInput: false, prompt: this.getPrompt() };
  }

  private getParamTypeStr(value: string): string {
    if (value === 'TRUE' || value === 'FALSE') return 'boolean';
    if (/^\d+$/.test(value)) return 'integer';
    if (/^\d+[MmGgKk]$/i.test(value)) return 'big integer';
    return 'string';
  }

  // ── DESCRIBE ─────────────────────────────────────────────────────

  private handleDescribe(objectName: string): SQLPlusResult {
    if (!this.connected || !this.executor) {
      return { output: ['ERROR:', ORACLE_ERRORS.ORA_01012], exit: false, needsMoreInput: false, prompt: this.getPrompt() };
    }

    const output: string[] = [];
    const upper = objectName.toUpperCase().replace(/;$/, '');

    // Parse schema.object
    let schema = this.executor.getContext().currentSchema;
    let name = upper;
    if (upper.includes('.')) {
      const parts = upper.split('.');
      schema = parts[0];
      name = parts[1];
    }

    const tableMeta = this.db.storage.getTableMeta(schema, name);
    if (!tableMeta) {
      output.push(`ERROR:`);
      output.push(`${ORACLE_ERRORS.ORA_04043}: ${upper}`);
      return { output, exit: false, needsMoreInput: false, prompt: this.getPrompt() };
    }

    output.push(` Name                                      Null?    Type`);
    output.push(` ----------------------------------------- -------- ----------------------------`);
    for (const col of tableMeta.columns) {
      const nullable = col.dataType.nullable === false ? 'NOT NULL' : '';
      let typeStr = col.dataType.name;
      if (col.dataType.precision !== undefined) {
        if (col.dataType.scale !== undefined && col.dataType.scale > 0) {
          typeStr += `(${col.dataType.precision},${col.dataType.scale})`;
        } else {
          typeStr += `(${col.dataType.precision})`;
        }
      }
      output.push(` ${col.name.padEnd(42)}${nullable.padEnd(9)}${typeStr}`);
    }

    return { output, exit: false, needsMoreInput: false, prompt: this.getPrompt() };
  }

  // ── CONNECT ──────────────────────────────────────────────────────

  private handleConnect(args: string): SQLPlusResult {
    // CONNECT user/pass  or  CONNECT user/pass AS SYSDBA  or  CONNECT / AS SYSDBA
    let username = '';
    let password = '';
    let sysdba = false;

    const upper = args.toUpperCase();
    if (upper.includes('AS SYSDBA')) {
      sysdba = true;
    }

    const connStr = args.replace(/\s+AS\s+SYSDBA/i, '').trim();
    if (connStr === '/' || connStr === '') {
      // OS authentication or SYSDBA
      if (sysdba) {
        const loginOutput = this.login('SYS', '', true);
        return { output: loginOutput, exit: false, needsMoreInput: false, prompt: this.getPrompt() };
      }
      return { output: ['ERROR:', 'SP2-0306: Invalid option.'], exit: false, needsMoreInput: false, prompt: this.getPrompt() };
    }

    if (connStr.includes('/')) {
      [username, password] = connStr.split('/', 2);
    } else {
      username = connStr;
      // In real SQL*Plus, this would prompt for password interactively.
      // Since interactive password prompt in CONNECT is not supported in simulator,
      // provide a helpful error message.
      return { output: ['ERROR:', `SP2-0306: Invalid option.`, `Usage: CONNECT username/password[@connect_identifier] [AS SYSDBA]`], exit: false, needsMoreInput: false, prompt: this.getPrompt() };
    }

    // Strip @tns_alias from password
    password = password.replace(/@.*$/, '');

    const loginOutput = this.login(username, password, sysdba);
    return { output: loginOutput, exit: false, needsMoreInput: false, prompt: this.getPrompt() };
  }

  // ── HELP ─────────────────────────────────────────────────────────

  private handleHelp(): SQLPlusResult {
    return {
      output: [
        '',
        'HELP',
        '----',
        ' @             Execute a script file',
        ' COLUMN        Define a column format',
        ' CONNECT       Connect to a database',
        ' DEFINE        Define a substitution variable',
        ' DESCRIBE      Describe an object',
        ' EDIT          Edit the SQL buffer',
        ' EXIT          Exit SQL*Plus',
        ' HOST          Execute a host operating system command',
        ' PRINT         Display the value of a bind variable',
        ' PROMPT        Display text to the screen',
        ' QUIT          Exit SQL*Plus',
        ' SET           Set a SQL*Plus system variable',
        ' SHOW          Show a SQL*Plus system variable',
        ' SPOOL         Store query results in a file',
        ' STARTUP       Start an Oracle instance',
        ' SHUTDOWN      Shut down an Oracle instance',
        ' VARIABLE      Declare a bind variable',
        '',
      ],
      exit: false,
      needsMoreInput: false,
      prompt: this.getPrompt(),
    };
  }

  // ── SPOOL ────────────────────────────────────────────────────────

  private handleSpool(args: string): SQLPlusResult {
    const upper = args.toUpperCase();
    if (upper === 'OFF') {
      this.spoolFile = null;
      return { output: [], exit: false, needsMoreInput: false, prompt: this.getPrompt() };
    }
    this.spoolFile = args;
    return { output: [], exit: false, needsMoreInput: false, prompt: this.getPrompt() };
  }

  // ── COLUMN ──────────────────────────────────────────────────────

  private handleColumn(args: string): SQLPlusResult {
    if (!args) {
      // Show all column formats
      const output: string[] = [];
      if (this.columnFormats.size === 0) {
        // No columns defined — silent like real SQL*Plus
      } else {
        for (const [, fmt] of this.columnFormats) {
          const parts: string[] = [`COLUMN   ${fmt.name}`];
          if (fmt.format) parts.push(`FORMAT   ${fmt.format}`);
          if (fmt.heading) parts.push(`HEADING  '${fmt.heading}'`);
          output.push(parts.join(' '));
        }
      }
      return { output, exit: false, needsMoreInput: false, prompt: this.getPrompt() };
    }

    const parts = args.split(/\s+/);
    const colName = parts[0].toUpperCase();
    const upper = args.toUpperCase();

    // COLUMN col CLEAR
    if (upper.includes(' CLEAR')) {
      this.columnFormats.delete(colName);
      return { output: [], exit: false, needsMoreInput: false, prompt: this.getPrompt() };
    }

    // Parse FORMAT and HEADING options
    const fmt: ColumnFormat = this.columnFormats.get(colName) || { name: colName };

    const fmtMatch = args.match(/FORMAT\s+(\S+)/i);
    if (fmtMatch) fmt.format = fmtMatch[1];

    const headMatch = args.match(/HEADING\s+'([^']+)'/i) || args.match(/HEADING\s+"([^"]+)"/i) || args.match(/HEADING\s+(\S+)/i);
    if (headMatch) fmt.heading = headMatch[1];

    // Parse width from format (e.g., A30 = 30 chars, 9999 = 4 digits)
    if (fmt.format) {
      const aMatch = fmt.format.match(/^A(\d+)$/i);
      if (aMatch) fmt.width = parseInt(aMatch[1]);
    }

    this.columnFormats.set(colName, fmt);
    return { output: [], exit: false, needsMoreInput: false, prompt: this.getPrompt() };
  }

  // ── DEFINE ─────────────────────────────────────────────────────

  private handleDefine(args: string): SQLPlusResult {
    if (!args) {
      // Show all defines
      const output: string[] = [];
      for (const [name, value] of this.defines) {
        output.push(`DEFINE ${name}           = "${value}"`);
      }
      if (output.length === 0) {
        // Show built-in defines
        output.push(`DEFINE _SQLPLUS_RELEASE = "1903000000"`);
        output.push(`DEFINE _EDITOR         = "vi"`);
      }
      return { output, exit: false, needsMoreInput: false, prompt: this.getPrompt() };
    }

    // Check if it's a query: DEFINE varname (no =)
    if (!args.includes('=')) {
      const varName = args.trim().toUpperCase();
      const value = this.defines.get(varName);
      if (value !== undefined) {
        return { output: [`DEFINE ${varName}           = "${value}"`], exit: false, needsMoreInput: false, prompt: this.getPrompt() };
      }
      return { output: [`SP2-0135: symbol ${varName.toLowerCase()} is UNDEFINED`], exit: false, needsMoreInput: false, prompt: this.getPrompt() };
    }

    // DEFINE var = value
    const eqIdx = args.indexOf('=');
    const varName = args.substring(0, eqIdx).trim().toUpperCase();
    let value = args.substring(eqIdx + 1).trim();
    // Strip surrounding quotes
    value = value.replace(/^['"]|['"]$/g, '');
    this.defines.set(varName, value);
    return { output: [], exit: false, needsMoreInput: false, prompt: this.getPrompt() };
  }

  // ── VARIABLE ───────────────────────────────────────────────────

  private handleVariable(args: string): SQLPlusResult {
    if (!args) {
      // List all bind variables
      const output: string[] = [];
      if (this.bindVariables.size === 0) {
        // Silent like real SQL*Plus
      } else {
        for (const [name, info] of this.bindVariables) {
          output.push(`variable   ${name}`);
          output.push(`datatype   ${info.type}`);
        }
      }
      return { output, exit: false, needsMoreInput: false, prompt: this.getPrompt() };
    }

    const parts = args.split(/\s+/);
    const varName = parts[0].toUpperCase();
    const varType = (parts[1] || 'VARCHAR2(100)').toUpperCase();

    this.bindVariables.set(varName, { type: varType, value: null });
    return { output: [], exit: false, needsMoreInput: false, prompt: this.getPrompt() };
  }

  // ── PRINT ──────────────────────────────────────────────────────

  private handlePrint(args: string): SQLPlusResult {
    if (!args) {
      // Print all bind variables
      const output: string[] = [];
      for (const [name, info] of this.bindVariables) {
        output.push('');
        output.push(name);
        output.push('-'.repeat(name.length > 10 ? name.length : 10));
        output.push(info.value !== null && info.value !== undefined ? String(info.value) : '');
      }
      return { output, exit: false, needsMoreInput: false, prompt: this.getPrompt() };
    }

    const varName = args.toUpperCase();
    const info = this.bindVariables.get(varName);
    if (!info) {
      return { output: [`SP2-0552: Bind variable "${varName}" not declared.`], exit: false, needsMoreInput: false, prompt: this.getPrompt() };
    }

    const output: string[] = [''];
    output.push(varName);
    output.push('-'.repeat(varName.length > 10 ? varName.length : 10));
    output.push(info.value !== null && info.value !== undefined ? String(info.value) : '');
    return { output, exit: false, needsMoreInput: false, prompt: this.getPrompt() };
  }

  // ── Prompt ───────────────────────────────────────────────────────

  getPrompt(): string {
    return this.settings.sqlprompt;
  }

  isConnected(): boolean {
    return this.connected;
  }

  getCurrentUser(): string {
    return this.currentUser;
  }

  isSysdba(): boolean {
    return this.asSysdba;
  }
}
