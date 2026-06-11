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
import { ParserError } from '../../engine/parser/ParserError';
import { DatabaseError } from '../../engine/types/DatabaseError';
import type { HostCommandRunner } from './HostCommandRunner';

import { QueryResultRenderer, type ColumnFormat } from './QueryResultRenderer';
export type { ColumnFormat } from './QueryResultRenderer';

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

type CommandMatcher = (upper: string, trimmed: string) => boolean;

interface SqlPlusCommand {
  name: string;
  matches: CommandMatcher;
  run(trimmed: string, upper: string): SQLPlusResult;
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
  /** Collecting PL/SQL unit DDL (CREATE PACKAGE/PROCEDURE/…): only the
   *  terminating slash executes — END; lines belong to the unit. */
  private plsqlUnitMode: boolean = false;
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
  /** Optional host-shell executor for HOST / `!` commands. */
  private hostRunner: HostCommandRunner | null = null;

  private readonly commands: SqlPlusCommand[];

  constructor(db: OracleDatabase) {
    this.db = db;
    this.settings = this.defaultSettings();
    this.commands = this.buildCommands();
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

  /** Wire a HOST executor (typically delegated to the underlying device). */
  setHostCommandRunner(runner: HostCommandRunner | null): void {
    this.hostRunner = runner;
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
        // Phase 7: bind sessionId for oracle.session.*/transaction.*/dml.*/ddl.* events.
        this.executor.setSessionId(String(this.sid));
      }
      // Phase 7: emit oracle.session.connected on the same bus as the instance.
      this.db.instance.getBus().publish({
        topic: 'oracle.session.connected',
        payload: {
          deviceId: this.db.instance.getDeviceId(),
          sid: this.db.instance.config.sid,
          sessionId: String(this.sid),
          schema: this.currentUser,
          role: asSysdba ? 'SYSDBA' : undefined,
        },
      });

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
      // Phase 7: announce the disconnect on the bus.
      this.db.instance.getBus().publish({
        topic: 'oracle.session.disconnected',
        payload: {
          deviceId: this.db.instance.getDeviceId(),
          sid: this.db.instance.config.sid,
          sessionId: String(this.sid),
        },
      });
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

    const upper = trimmed.toUpperCase();

    for (const command of this.commands) {
      if (command.matches(upper, trimmed)) {
        return command.run(trimmed, upper);
      }
    }

    // PL/SQL unit DDL comes before the generic SQL path: its body
    // contains semicolons, so SQL*Plus collects source lines until the
    // terminating slash instead of executing on the first `;`.
    if (this.isPlsqlUnitStart(upper)) {
      // A complete one-line unit (`… END;` / `… END name;`) runs now.
      if (/\bEND(\s+\w+)?\s*;$/i.test(trimmed)) {
        return this.executeSql(trimmed.replace(/;\s*$/, ''));
      }
      this.plsqlMode = true;
      this.plsqlUnitMode = true;
      this.plsqlDepth = 0;
      this.sqlBuffer = trimmed;
      this.lineNumber = 2;
      return { output: [], exit: false, needsMoreInput: true, prompt: `  ${this.lineNumber}  ` };
    }

    if (this.isSqlStart(upper)) {
      if (trimmed.endsWith(';')) {
        return this.executeSql(trimmed.slice(0, -1));
      }
      this.sqlBuffer = trimmed;
      this.lineNumber = 2;
      return { output: [], exit: false, needsMoreInput: true, prompt: `  2  ` };
    }

    if (upper.startsWith('STARTUP') || upper.startsWith('SHUTDOWN')) {
      return this.executeSql(trimmed);
    }

    if (upper.startsWith('BEGIN') || upper.startsWith('DECLARE')) {
      return this.startPLSQLBlock(trimmed);
    }

    // Unknown command
    return { output: [`SP2-0734: unknown command beginning "${trimmed.substring(0, 20)}..." - rest of line ignored.`], exit: false, needsMoreInput: false, prompt: this.getPrompt() };
  }


  private ok(output: string[] = []): SQLPlusResult {
    return { output, exit: false, needsMoreInput: false, prompt: this.getPrompt() };
  }

  private buildCommands(): SqlPlusCommand[] {
    const exact = (...names: string[]): CommandMatcher =>
      (u) => names.some(n => u === n || u === `${n};`);
    const wordOrPrefix = (...names: string[]): CommandMatcher =>
      (u) => names.some(n => u === n || u === `${n};` || u.startsWith(`${n} `));
    const prefixOnly = (...names: string[]): CommandMatcher =>
      (u) => names.some(n => u.startsWith(`${n} `));

    return [
      {
        name: 'EXIT',
        matches: wordOrPrefix('EXIT', 'QUIT'),
        run: () => {
          this.disconnect();
          return { output: ['Disconnected from Oracle Database 19c Enterprise Edition Release 19.0.0.0.0 - Production'], exit: true, needsMoreInput: false, prompt: '' };
        },
      },
      {
        name: '/',
        matches: (_u, t) => t === '/',
        run: () => {
          if (this.lastStatement) return this.executeSql(this.lastStatement);
          return this.ok(['SP2-0103: Nothing in SQL buffer to run.']);
        },
      },
      {
        name: 'SET',
        matches: prefixOnly('SET'),
        run: (trimmed) => {
          const sqlSet = /^SET\s+(TRANSACTION|ROLE|CONSTRAINTS?)\b/i.exec(trimmed);
          if (sqlSet) {
            if (trimmed.endsWith(';')) return this.executeSql(trimmed.slice(0, -1));
            this.sqlBuffer = trimmed;
            this.lineNumber = 2;
            return { output: [], exit: false, needsMoreInput: true, prompt: '  2  ' };
          }
          return this.handleSet(trimmed.substring(4).trim());
        },
      },
      {
        name: 'SHOW',
        matches: (u) => u === 'SHOW' || u.startsWith('SHOW '),
        run: (trimmed) => this.handleShow(trimmed.substring(4).trim()),
      },
      {
        name: 'DESCRIBE',
        matches: prefixOnly('DESC', 'DESCRIBE'),
        run: (trimmed, upper) => {
          const obj = upper.startsWith('DESC ') ? trimmed.substring(5).trim() : trimmed.substring(9).trim();
          return this.handleDescribe(obj);
        },
      },
      {
        name: 'DISCONNECT',
        matches: (u) => u === 'DISCONNECT' || u === 'DISC',
        run: () => {
          if (!this.connected) return this.ok(['Not connected.']);
          this.disconnect();
          return this.ok(['Disconnected from Oracle Database 19c Enterprise Edition Release 19.0.0.0.0 - Production']);
        },
      },
      {
        name: 'CONNECT',
        matches: prefixOnly('CONN', 'CONNECT'),
        run: (trimmed, upper) => {
          const args = upper.startsWith('CONN ') ? trimmed.substring(5).trim() : trimmed.substring(8).trim();
          return this.handleConnect(args);
        },
      },
      {
        name: 'HELP',
        matches: (u) => u === 'HELP' || u === 'HELP INDEX',
        run: () => this.handleHelp(),
      },
      {
        name: 'CLEAR',
        matches: prefixOnly('CLEAR'),
        run: () => this.ok(),
      },
      {
        name: 'SPOOL',
        matches: prefixOnly('SPOOL'),
        run: (trimmed) => this.handleSpool(trimmed.substring(6).trim()),
      },
      {
        name: 'PROMPT',
        matches: (u) => u === 'PROMPT' || u.startsWith('PROMPT '),
        run: (trimmed) => this.ok([trimmed.length > 7 ? trimmed.substring(7) : '']),
      },
      {
        name: 'HOST',
        matches: (u) => u === 'HOST' || u.startsWith('HOST ') || u.startsWith('!'),
        run: (trimmed) => this.handleHost(trimmed),
      },
      {
        name: 'ORADEBUG',
        matches: wordOrPrefix('ORADEBUG'),
        run: (trimmed) => this.handleOradebug(trimmed),
      },
      {
        name: 'DDL',
        matches: (u) => u === 'DDL' || u.startsWith('DDL '),
        run: (trimmed) => this.handleDdlCommand(trimmed),
      },
      {
        name: 'USERACT',
        matches: wordOrPrefix('USERACT'),
        run: (trimmed) => this.handleUserAct(trimmed),
      },
      {
        name: 'PMON',
        matches: exact('PMON SWEEP'),
        run: () => {
          const n = this.db.idleMonitor.sweep();
          return this.ok([`PMON sweep complete — ${n.length} session(s) sniped.`]);
        },
      },
      {
        name: 'SECDEMO',
        matches: wordOrPrefix('SECDEMO'),
        run: (trimmed) => this.handleSecDemo(trimmed),
      },
      {
        name: 'ARCHIVE LOG LIST',
        matches: wordOrPrefix('ARCHIVE LOG LIST'),
        run: () => this.handleArchiveLogList(),
      },
      {
        name: 'EXECUTE',
        matches: wordOrPrefix('EXEC', 'EXECUTE'),
        run: (trimmed) => this.executeSql(trimmed.replace(/;\s*$/, '')),
      },
      {
        name: 'START',
        matches: (u, t) => t.startsWith('@') || u.startsWith('START '),
        run: (trimmed) => {
          const scriptName = trimmed.startsWith('@') ? trimmed.substring(1).trim() : trimmed.substring(6).trim();
          return this.ok([`SP2-0310: unable to open file "${scriptName}"`]);
        },
      },
      {
        name: 'COLUMN',
        matches: (u) => u === 'COLUMN' || u.startsWith('COLUMN ') || u.startsWith('COL '),
        run: (trimmed, upper) =>
          this.handleColumn(trimmed.substring(upper.startsWith('COL ') ? 4 : 6).trim()),
      },
      {
        name: 'DEFINE',
        matches: (u) => u === 'DEFINE' || u.startsWith('DEFINE '),
        run: (trimmed) => this.handleDefine(trimmed.substring(6).trim()),
      },
      {
        name: 'VARIABLE',
        matches: (u) => u === 'VARIABLE' || u.startsWith('VARIABLE ') || u.startsWith('VAR '),
        run: (trimmed, upper) => {
          const offset = upper.startsWith('VAR ') ? 4 : upper === 'VARIABLE' ? 8 : 9;
          return this.handleVariable(trimmed.substring(offset).trim());
        },
      },
      {
        name: 'PRINT',
        matches: (u) => u === 'PRINT' || u.startsWith('PRINT '),
        run: (trimmed) => this.handlePrint(trimmed.substring(5).trim()),
      },
      {
        name: 'EDIT',
        matches: (u) => u === 'EDIT' || u.startsWith('EDIT '),
        run: () => this.ok(['SP2-0107: Nothing to save.']),
      },
    ];
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
    // ends with END; and the depth is back to 0, auto-execute (common in
    // simulators). Unit DDL (CREATE PACKAGE/PROCEDURE/…) never
    // auto-executes: a member's `END;` is indistinguishable from the
    // unit's, so only the terminating slash runs it — real SQL*Plus
    // behaviour.
    const upper = trimmed.toUpperCase().replace(/\s+/g, ' ').trim();
    if (!this.plsqlUnitMode && (upper === 'END;' || upper.match(/^END\s+\w+\s*;$/i)) && this.plsqlDepth <= 0) {
      return this.executePLSQLBuffer();
    }

    return { output: [], exit: false, needsMoreInput: true, prompt: `  ${this.lineNumber}  ` };
  }

  private updatePLSQLDepth(line: string): void {
    const upper = line.toUpperCase();
    const withoutClosers = upper.replace(/\bEND(\s+\w+)?\s*;/g, ' ; ');

    let m;
    const openers = /\b(BEGIN|LOOP|CASE)\b/gi;
    while ((m = openers.exec(withoutClosers)) !== null) this.plsqlDepth++;

    if (/\bIF\b/.test(withoutClosers) && /\bTHEN\b/.test(withoutClosers)) this.plsqlDepth++;

    const closers = /\bEND(\s+(IF|LOOP|CASE|\w+))?\s*;/gi;
    while ((m = closers.exec(upper)) !== null) this.plsqlDepth--;
  }

  private executePLSQLBuffer(): SQLPlusResult {
    const sql = this.sqlBuffer.trim();
    this.sqlBuffer = '';
    this.lineNumber = 0;
    this.plsqlMode = false;
    this.plsqlUnitMode = false;
    this.plsqlDepth = 0;

    if (!sql) {
      return { output: ['SP2-0103: Nothing in SQL buffer to run.'], exit: false, needsMoreInput: false, prompt: this.getPrompt() };
    }

    // Remove trailing ; from the whole block if present
    const cleanSql = sql.replace(/;\s*$/, '');
    return this.executeSql(cleanSql);
  }

  /**
   * CREATE statements that introduce a PL/SQL unit. Their source embeds
   * semicolons, so they are collected until the terminating slash rather
   * than executed at the first `;` like plain SQL. CREATE TYPE is left
   * to the SQL path: its spec form (AS OBJECT/TABLE OF/VARRAY) carries
   * no PL/SQL body and executes as a single statement here.
   */
  private isPlsqlUnitStart(upper: string): boolean {
    return /^CREATE\s+(OR\s+REPLACE\s+)?(EDITIONABLE\s+|NONEDITIONABLE\s+)?(PROCEDURE|FUNCTION|PACKAGE(\s+BODY)?|TRIGGER)\b/.test(upper);
  }

  private isSqlStart(upper: string): boolean {
    const sqlKeywords = [
      'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'CREATE', 'DROP', 'ALTER',
      'GRANT', 'REVOKE', 'TRUNCATE', 'MERGE', 'WITH', 'COMMIT', 'ROLLBACK',
      'SAVEPOINT', 'COMMENT', 'EXPLAIN', 'AUDIT', 'NOAUDIT',
      'ANALYZE', 'LOCK', 'SET',
      'FLASHBACK', 'PURGE',
      // 19c TDE / keystore administration commands.
      'ADMINISTER',
    ];
    // Match the keyword followed by a space, the bare keyword, or the
    // keyword with a trailing semicolon (e.g. "COMMIT;" — real SQL*Plus
    // executes it without complaint).
    return sqlKeywords.some(kw =>
      upper === kw || upper === kw + ';' || upper.startsWith(kw + ' '),
    );
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
        if (result.rows.length === 0) {
          // Real SQL*Plus prints no header for an empty result — just
          // "no rows selected" (suppressed under SET FEEDBACK OFF).
          if (this.settings.feedback) {
            output.push('');
            output.push('no rows selected');
          }
        } else {
          output.push(...this.formatQueryResult(result));
        }
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
      output.push(...this.renderSqlError(sql, err));
    }

    return { output, exit: false, needsMoreInput: false, prompt: this.getPrompt() };
  }

  /**
   * Real SQL*Plus error report for a failed statement: echo the offending
   * source line, point at the error column with an asterisk, then
   * `ERROR at line N:` followed by the ORA-/PLS- message. Errors without
   * position information (typical of execution-time ORA- errors) point at
   * column 1 of line 1, exactly like the real client.
   */
  private renderSqlError(sql: string, err: unknown): string[] {
    const srcLines = sql.replace(/;\s*$/, '').split('\n');
    let line = 1;
    let column = 1;
    if (err instanceof ParserError) {
      line = Math.min(Math.max(err.position.line, 1), srcLines.length);
      column = Math.max(err.position.column, 1);
    } else if (err instanceof DatabaseError && typeof err.position === 'number') {
      // DatabaseError.position is a character offset into the statement.
      let remaining = err.position;
      for (let i = 0; i < srcLines.length; i++) {
        if (remaining <= srcLines[i].length) { line = i + 1; column = remaining + 1; break; }
        remaining -= srcLines[i].length + 1;
      }
    }
    const msg = err instanceof Error ? err.message : String(err);
    const message = msg.startsWith('ORA-') || msg.startsWith('PLS-')
      ? msg
      : `${ORACLE_ERRORS.ORA_00900}: ${msg}`;
    const echoed = srcLines[line - 1] ?? '';
    return [
      echoed,
      `${' '.repeat(Math.min(column - 1, echoed.length))}*`,
      `ERROR at line ${line}:`,
      message,
    ];
  }

  private formatQueryResult(result: ResultSet): string[] {
    const renderer = new QueryResultRenderer(
      {
        heading: this.settings.heading,
        pagesize: this.settings.pagesize,
        linesize: this.settings.linesize,
        colsep: this.settings.colsep,
        underline: this.settings.underline,
        nullDisplay: this.settings.null_display,
        wrap: this.settings.wrap,
      },
      this.columnFormats,
    );
    return renderer.render(result);
  }


  private renderShowErrors(target: string | null): string[] {
    let owner: string | null = null;
    let name: string | null = null;
    let type: string | null = null;

    if (target) {
      const parts = target.trim().split(/\s+/);
      type = parts.length > 1 ? parts[0].toUpperCase() : null;
      const qualified = (parts.length > 1 ? parts[1] : parts[0]).toUpperCase();
      const dotted = qualified.split('.');
      owner = dotted.length > 1 ? dotted[0] : this.currentUser.toUpperCase();
      name = dotted.length > 1 ? dotted[1] : dotted[0];
    } else {
      const last = this.db.getLastCompiledUnit();
      if (!last) return ['No errors.'];
      owner = last.schema;
      name = last.name;
      type = last.type;
    }

    const entry = this.db.catalog.getCompilationErrors(owner, name);
    if (!entry || entry.errors.length === 0) return ['No errors.'];

    const lines: string[] = [];
    lines.push(`Errors for ${type ?? entry.type} ${entry.owner}.${entry.name}:`);
    lines.push('');
    lines.push('LINE/COL ERROR');
    lines.push('-------- ' + '-'.repeat(65));
    for (const err of entry.errors) {
      lines.push(`${`${err.line}/${err.position}`.padEnd(8)} ${err.text}`);
    }
    return lines;
  }

  // ── SET command ──────────────────────────────────────────────────

  private handleSet(args: string): SQLPlusResult {
    const parts = args.split(/\s+/);
    const option = parts[0]?.toUpperCase();
    const value = parts.slice(1).join(' ');

    switch (option) {
      case 'LINESIZE': case 'LIN': {
        const parsed = parseInt(value);
        this.settings.linesize = isNaN(parsed) ? 80 : parsed;
        break;
      }
      case 'PAGESIZE': case 'PAGES': {
        const parsed = parseInt(value);
        this.settings.pagesize = isNaN(parsed) ? 14 : parsed;
        break;
      }
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
    // Strip trailing semicolon (SHOW USER; is valid SQL*Plus syntax)
    const option = args.trim().replace(/;+$/, '').toUpperCase();
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
        output.push(...this.renderShowErrors(null));
        break;
      case 'RELEASE':
        output.push('release 1903000000');
        break;
      case 'SQLPROMPT':
        output.push(`sqlprompt "${this.settings.sqlprompt}"`);
        break;
      default: {
        if (option.startsWith('ERRORS ') || option.startsWith('ERR ')) {
          output.push(...this.renderShowErrors(option.replace(/^ERR(ORS)?\s+/, '')));
          break;
        }
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

    const upper = objectName.toUpperCase().replace(/;$/, '');

    // Parse schema.object
    let schema = this.executor.getContext().currentSchema;
    let name = upper;
    if (upper.includes('.')) {
      const parts = upper.split('.');
      schema = parts[0];
      name = parts[1];
    }

    // 1. Plain table.
    const tableMeta = this.db.storage.getTableMeta(schema, name);
    if (tableMeta) {
      return this.formatDescribe(tableMeta.columns.map(c => ({
        name: c.name,
        nullable: c.dataType.nullable !== false,
        type: c.dataType.name,
        precision: c.dataType.precision,
        scale: c.dataType.scale,
      })));
    }

    // 2. User-defined view — execute its stored query and describe the
    //    resulting columns. Views are SELECT-driven so we cannot inspect
    //    them statically without running their AST.
    const viewMeta = this.db.storage.getViewMeta(schema, name);
    if (viewMeta) {
      try {
        const rs = this.db.executeSql(this.executor, `SELECT * FROM ${schema}.${name} WHERE 1=0`);
        if (rs.isQuery && rs.columns.length) {
          return this.formatDescribe(rs.columns.map(c => ({
            name: c.name,
            nullable: c.dataType?.nullable !== false,
            type: c.dataType?.name ?? 'VARCHAR2',
            precision: c.dataType?.precision,
            scale: c.dataType?.scale,
          })));
        }
      } catch { /* fall through to ORA-04043 */ }
    }

    // 3. Stored PL/SQL unit — procedure, function, or package spec.
    const unit = this.db.getStoredUnit(schema, name) ?? this.db.getStoredUnit('SYS', name);
    if (unit) {
      if (unit.type === 'PACKAGE') {
        const members = this.db.describePackage(unit.schema, unit.name);
        if (members) return this.formatPackageDescribe(members);
      }
      return this.formatStoredUnitDescribe(unit);
    }

    // 4. Dictionary view (DBA_*/ALL_*/USER_*/V$*/UNIFIED_AUDIT_TRAIL …).
    //    These live in the catalog rather than storage; resolve them
    //    via the catalog so DESC ALL_VIEWS et al. work out of the box.
    const dictCols = this.db.catalog.describeCatalogView(name, this.executor.getContext().currentSchema);
    if (dictCols && dictCols.length) {
      return this.formatDescribe(dictCols);
    }

    return {
      output: [`ERROR:`, `${ORACLE_ERRORS.ORA_04043}: ${upper}`],
      exit: false, needsMoreInput: false, prompt: this.getPrompt(),
    };
  }

  /**
   * Render a package's public subprograms in SQL*Plus DESC format: one
   * header per member followed by its argument table, like real Oracle.
   */
  private formatPackageDescribe(
    members: NonNullable<ReturnType<import('../OracleDatabase').OracleDatabase['describePackage']>>,
  ): SQLPlusResult {
    const output: string[] = [];
    for (const m of members) {
      output.push(m.kind === 'FUNCTION'
        ? `FUNCTION ${m.name} RETURNS ${m.returnType ?? 'VARCHAR2'}`
        : `PROCEDURE ${m.name}`);
      if (m.parameters.length > 0) {
        output.push(' Argument Name                  Type                    In/Out Default?');
        output.push(' ------------------------------ ----------------------- ------ --------');
        for (const p of m.parameters) {
          output.push(` ${p.name.padEnd(31)}${p.dataType.padEnd(24)}${p.mode.padEnd(7)}${p.hasDefault ? 'DEFAULT' : ''}`);
        }
      }
    }
    return { output, exit: false, needsMoreInput: false, prompt: this.getPrompt() };
  }

  /** Render the procedure/function/package spec in SQL*Plus DESC format. */
  private formatStoredUnitDescribe(unit: import('../OracleDatabase').StoredPLSQLUnit): SQLPlusResult {
    const output: string[] = [];
    if (unit.type === 'FUNCTION') {
      output.push(`FUNCTION ${unit.name} RETURNS ${unit.returnType ?? 'VARCHAR2'}`);
    } else if (unit.type === 'PROCEDURE') {
      output.push(`PROCEDURE ${unit.name}`);
    } else if (unit.type === 'PACKAGE') {
      output.push(`PACKAGE ${unit.name}`);
    } else {
      output.push(`${unit.type} ${unit.name}`);
    }
    if (unit.parameters.length > 0) {
      output.push(` Argument Name                  Type                    In/Out Default?`);
      output.push(` ------------------------------ ----------------------- ------ --------`);
      for (const p of unit.parameters) {
        const dflt = p.defaultValue ? 'DEFAULT' : '';
        output.push(` ${p.name.padEnd(31)}${p.dataType.padEnd(24)}${p.mode.padEnd(7)}${dflt}`);
      }
    }
    return { output, exit: false, needsMoreInput: false, prompt: this.getPrompt() };
  }

  /** Render a column list in classic SQL*Plus DESCRIBE format. */
  private formatDescribe(cols: ReadonlyArray<{ name: string; nullable: boolean; type: string; precision?: number; scale?: number }>): SQLPlusResult {
    const output: string[] = [];
    output.push(` Name                                      Null?    Type`);
    output.push(` ----------------------------------------- -------- ----------------------------`);
    for (const col of cols) {
      const nullable = col.nullable ? '' : 'NOT NULL';
      let typeStr = col.type;
      if (col.precision !== undefined) {
        if (col.scale !== undefined && col.scale > 0) typeStr += `(${col.precision},${col.scale})`;
        else typeStr += `(${col.precision})`;
      }
      output.push(` ${col.name.padEnd(42)}${nullable.padEnd(9)}${typeStr}`);
    }
    return { output, exit: false, needsMoreInput: false, prompt: this.getPrompt() };
  }

  // ── CONNECT ──────────────────────────────────────────────────────

  private handleConnect(args: string): SQLPlusResult {
    // CONNECT user/pass  or  CONNECT user/pass AS SYSDBA  or  CONNECT / AS SYSDBA
    // Tolerate the trailing `;` real SQL*Plus also strips before parsing.
    args = args.replace(/;\s*$/, '').trim();
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

    // user/password@connect_identifier goes through the TNS listener;
    // a plain user/password is a local bequeath connection and does not.
    const atIdx = password.indexOf('@');
    if (atIdx >= 0) {
      const alias = password.slice(atIdx + 1).trim();
      password = password.slice(0, atIdx);
      const outcome = this.db.instance.listener.attemptConnect(alias);
      if (!outcome.ok) {
        return {
          output: ['ERROR:', outcome.error],
          exit: false, needsMoreInput: false, prompt: this.getPrompt(),
        };
      }
    }

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

  // ── ORADEBUG ─────────────────────────────────────────────────────

  private handleOradebug(line: string): SQLPlusResult {
    const rest = line.replace(/;\s*$/, '').replace(/^ORADEBUG\s*/i, '').trim();
    const upper = rest.toUpperCase();
    const inst = this.db.instance;
    if (upper === 'TRACEFILE_NAME') {
      const path = `${inst.config.diagDest ?? '/u01/app/oracle'}/diag/rdbms/${inst.config.sid.toLowerCase()}/${inst.config.sid}/trace/${inst.config.sid.toLowerCase()}_ora_${process.pid ?? 1000}.trc`;
      return { output: [path], exit: false, needsMoreInput: false, prompt: this.getPrompt() };
    }
    if (upper.startsWith('SETMYPID')) {
      return { output: ['Statement processed.'], exit: false, needsMoreInput: false, prompt: this.getPrompt() };
    }
    if (upper.startsWith('SETOSPID') || upper.startsWith('SETORAPID')) {
      return { output: ['Oracle pid: 1, Unix process pid: 1000, image: oracle@localhost'], exit: false, needsMoreInput: false, prompt: this.getPrompt() };
    }
    if (upper.startsWith('DUMP ') || upper.startsWith('EVENT ') || upper.startsWith('SESSION_EVENT')
        || upper.startsWith('SHORT_STACK') || upper.startsWith('UNLIMIT') || upper.startsWith('SUSPEND')
        || upper.startsWith('RESUME')) {
      return { output: ['Statement processed.'], exit: false, needsMoreInput: false, prompt: this.getPrompt() };
    }
    return { output: ['Statement processed.'], exit: false, needsMoreInput: false, prompt: this.getPrompt() };
  }

  // ── USERACT (UserActivityTracker inspector) ──────────────────────

  private handleUserAct(line: string): SQLPlusResult {
    const arg = line.replace(/;\s*$/, '').replace(/^USERACT\s*/i, '').trim().toUpperCase();
    const all = this.db.userActivity.getAllStats();
    const rows = arg ? all.filter(s => s.username === arg) : all;
    if (rows.length === 0) {
      return { output: [arg ? `No activity recorded for ${arg}.` : 'No user activity recorded yet.'],
               exit: false, needsMoreInput: false, prompt: this.getPrompt() };
    }
    const out: string[] = ['USER       LOGONS  FAILED  PWD_CHG  LOCKS  LAST_LOGON               LAST_LOGOFF             TOTAL_SECS'];
    out.push('---------- ------- ------- -------- ------ ------------------------ ------------------------ ----------');
    for (const s of rows) {
      const fmt = (d: Date | null) => d ? d.toISOString().slice(0, 19).replace('T', ' ') : '                   ';
      out.push(
        `${s.username.padEnd(10)} ${String(s.logonCount).padStart(7)} ${String(s.failedLogonCount).padStart(7)} ${String(s.passwordChangeCount).padStart(8)} ${String(s.lockEvents).padStart(6)} ${fmt(s.lastLogonAt).padEnd(24)} ${fmt(s.lastLogoffAt).padEnd(24)} ${String(s.totalSessionSeconds).padStart(10)}`,
      );
    }
    return { output: out, exit: false, needsMoreInput: false, prompt: this.getPrompt() };
  }

  // ── DDL (DBMS_METADATA.GET_DDL shortcut) ─────────────────────────

  private handleDdlCommand(line: string): SQLPlusResult {
    const rest = line.replace(/;\s*$/, '').replace(/^DDL\s*/i, '').trim();
    if (!rest) {
      return { output: [
        'Usage: DDL [object_type] [schema.]object_name',
        '  e.g. DDL TABLE HR.EMPLOYEES',
        '       DDL VIEW DBA_USERS',
        '       DDL HR.EMPLOYEES        (defaults to TABLE)',
      ], exit: false, needsMoreInput: false, prompt: this.getPrompt() };
    }
    const parts = rest.split(/\s+/);
    let objType: 'TABLE' | 'VIEW' | 'INDEX' | 'SEQUENCE' | 'SYNONYM'
      | 'TRIGGER' | 'USER' | 'ROLE' | 'PROCEDURE' | 'FUNCTION' | 'PACKAGE' = 'TABLE';
    let identifier = parts[0];
    if (parts.length >= 2 && /^(TABLE|VIEW|INDEX|SEQUENCE|SYNONYM|TRIGGER|USER|ROLE|PROCEDURE|FUNCTION|PACKAGE)$/i.test(parts[0])) {
      objType = parts[0].toUpperCase() as typeof objType;
      identifier = parts.slice(1).join(' ');
    }
    const m = identifier.replace(/"/g, '').match(/^(?:([\w$#]+)\.)?([\w$#]+)$/);
    if (!m) {
      return { output: [`SP2-0734: cannot parse object identifier "${identifier}"`],
               exit: false, needsMoreInput: false, prompt: this.getPrompt() };
    }
    const owner = (m[1] ?? this.currentUser ?? 'SYS').toUpperCase();
    const name = m[2].toUpperCase();
    const ddl = this.db.metadata.getDdl(objType, name, owner);
    if (ddl === null) {
      return { output: [`ORA-31603: object "${name}" of type ${objType} not found in schema "${owner}"`],
               exit: false, needsMoreInput: false, prompt: this.getPrompt() };
    }
    return { output: ddl.split('\n'), exit: false, needsMoreInput: false, prompt: this.getPrompt() };
  }

  // ── SECDEMO ──────────────────────────────────────────────────────

  /**
   * Drive the security-audit demonstration. Accepted forms:
   *   SECDEMO RUN              run every canonical fraud scenario
   *   SECDEMO SCAN SOD         re-run the SoD evaluator on every user
   *   SECDEMO SCAN DORMANT     re-run the dormant-account analyzer
   *   SECDEMO STATUS           summarise journal sizes
   *   SECDEMO (default)        run every scenario then print status
   */
  private handleSecDemo(line: string): SQLPlusResult {
    const args = line.replace(/;\s*$/, '').replace(/^SECDEMO\s*/i, '').trim().toUpperCase();
    const out: string[] = [];
    const journal = this.db.instance.getAuditJournal();

    if (args === 'STATUS' || args === '') {
      // fall-through: STATUS handled below
    }

    if (args === '' || args === 'RUN' || args === 'RUN ALL') {
      out.push('Running security-audit fraud scenarios...');
      const results = this.db.fraudSimulator.runAll();
      for (const r of results) {
        out.push(`  [${r.scenario}] steps=${r.steps.length}`);
      }
      out.push('');
    } else if (args === 'SCAN SOD') {
      const n = this.db.sodEvaluator.scanAll();
      out.push(`SoD scan complete — ${n} new violation(s) journaled.`);
      return { output: out, exit: false, needsMoreInput: false, prompt: this.getPrompt() };
    } else if (args === 'SCAN DORMANT') {
      const n = this.db.dormantAnalyzer.sweep();
      out.push(`Dormant-account sweep complete — ${n} account(s) flagged.`);
      return { output: out, exit: false, needsMoreInput: false, prompt: this.getPrompt() };
    } else if (args !== 'STATUS') {
      out.push(`SP2-0734: unknown SECDEMO subcommand "${args}"`);
      out.push('Available: RUN | SCAN SOD | SCAN DORMANT | STATUS');
      return { output: out, exit: false, needsMoreInput: false, prompt: this.getPrompt() };
    }

    out.push('Security audit journal status:');
    out.push(`  Connection traces:    ${journal.getConnectionTraces().length}`);
    out.push(`  DDL history:          ${journal.getDdlHistory().length}`);
    out.push(`  DML history:          ${journal.getDmlHistory().length}`);
    out.push(`  Sensitive accesses:   ${journal.getSensitiveAccessRecords().length}`);
    out.push(`  Privilege usage rows: ${journal.getPrivilegeUsage().length}`);
    out.push(`  SoD policies:         ${journal.getSodPolicies().length}`);
    out.push(`  SoD violations:       ${journal.getSodViolations().length}`);
    out.push(`  Dormant accounts:     ${journal.getDormantAccounts().length}`);
    out.push(`  Anomalies:            ${journal.getAnomalies().length}`);
    return { output: out, exit: false, needsMoreInput: false, prompt: this.getPrompt() };
  }

  // ── ARCHIVE LOG LIST ─────────────────────────────────────────────

  private handleArchiveLogList(): SQLPlusResult {
    const inst = this.db.instance;
    const params = inst.getAllParameters();
    const dest = params.get('log_archive_dest') ?? params.get('log_archive_dest_1') ?? 'USE_DB_RECOVERY_FILE_DEST';
    const format = params.get('log_archive_format') ?? 'arch_%t_%s_%r.arc';
    const groups = inst.getRedoLogGroups();
    const current = groups.find(g => g.status === 'CURRENT') ?? groups[0];
    const currentSeq = current?.sequence ?? 1;
    const lines = [
      `Database log mode              ${inst.archiveLogMode ? 'Archive Mode' : 'No Archive Mode'}`,
      `Automatic archival             ${inst.archiveLogMode ? 'Enabled' : 'Disabled'}`,
      `Archive destination            ${dest}`,
      `Archive format                 ${format}`,
      `Oldest online log sequence     ${Math.max(1, currentSeq - groups.length + 1)}`,
      `Next log sequence to archive   ${currentSeq}`,
      `Current log sequence           ${currentSeq}`,
    ];
    return { output: lines, exit: false, needsMoreInput: false, prompt: this.getPrompt() };
  }

  // ── HOST / ! ────────────────────────────────────────────────────

  private handleHost(line: string): SQLPlusResult {
    let cmd: string;
    if (line.startsWith('!')) cmd = line.substring(1).trim();
    else if (line.length <= 4) cmd = '';
    else cmd = line.substring(5).trim();

    if (!this.hostRunner) {
      return { output: ['SP2-0734: HOST command is not available in this environment.'], exit: false, needsMoreInput: false, prompt: this.getPrompt() };
    }
    if (!cmd) {
      // Real SQL*Plus drops to a subshell here — not supported.
      return { output: ['SP2-0738: interactive HOST subshell is not supported in this environment.'], exit: false, needsMoreInput: false, prompt: this.getPrompt() };
    }
    return { output: this.hostRunner.execute(cmd), exit: false, needsMoreInput: false, prompt: this.getPrompt() };
  }

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

    if (/(^|\s)NOPRINT(\s|$)/i.test(args)) fmt.noprint = true;
    if (/(^|\s)PRINT(\s|$)/i.test(args)) fmt.noprint = false;

    if (fmt.format) {
      const aMatch = fmt.format.match(/^A(\d+)$/i);
      if (aMatch) {
        fmt.width = parseInt(aMatch[1]);
      } else if (/^[$]?[09,.]+$/.test(fmt.format)) {
        fmt.width = fmt.format.length;
      }
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
