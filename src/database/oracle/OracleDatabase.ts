/**
 * OracleDatabase — Main orchestrator that wires together all Oracle components.
 *
 * Provides a single entry point for SQL execution, combining:
 *   - OracleInstance (state machine, background processes)
 *   - OracleStorage (tables, tablespaces, DUAL)
 *   - OracleCatalog (users, roles, privileges, dictionary views)
 *   - OracleLexer + OracleParser (SQL parsing)
 *   - OracleExecutor (statement execution)
 */

import { OracleInstance } from './OracleInstance';
import { OracleStorage } from './OracleStorage';
import { OracleCatalog } from './OracleCatalog';
import { OracleLexer } from './OracleLexer';
import { OracleParser } from './OracleParser';
import { OracleExecutor } from './OracleExecutor';
import type { ExecutionContext } from '../engine/executor/BaseExecutor';
import type { ResultSet } from '../engine/executor/ResultSet';
import { ORACLE_ERRORS } from '../../terminal/commands/OracleConfig';
import { emptyResult } from '../engine/executor/ResultSet';
import type { OracleDatabaseConfig } from '../engine/types/DatabaseConfig';
import type { CellValue } from '../engine/storage/BaseStorage';

/** Runtime state for an explicit PL/SQL cursor */
export interface CursorState {
  query: string;
  params?: { name: string; type: string }[];
  rows: CellValue[][] | null;
  columns: string[];
  position: number; // -1 = before first row
  isOpen: boolean;
}

export interface ConnectionInfo {
  username: string;
  schema: string;
  connectedAt: Date;
  sid: number;
  serial: number;
}

/** Stored PL/SQL unit (procedure, function, or package) */
export interface StoredPLSQLUnit {
  schema: string;
  name: string;
  type: 'PROCEDURE' | 'FUNCTION' | 'PACKAGE' | 'PACKAGE BODY' | 'TRIGGER';
  parameters: Array<{ name: string; mode: 'IN' | 'OUT' | 'IN OUT'; dataType: string; defaultValue?: string }>;
  returnType?: string; // For functions only
  body: string; // Full PL/SQL source
  sourceLines: string[]; // Source split by lines (for DBA_SOURCE)
  created: Date;
  status: 'VALID' | 'INVALID';
}

export class OracleDatabase {
  readonly instance: OracleInstance;
  readonly storage: OracleStorage;
  readonly catalog: OracleCatalog;
  private lexer: OracleLexer;
  private connections: Map<number, ConnectionInfo> = new Map();
  private sidCounter: number = 1;
  /** Stored PL/SQL units (procedures, functions, packages) */
  private storedUnits: Map<string, StoredPLSQLUnit> = new Map();

  constructor(config?: Partial<OracleDatabaseConfig>) {
    this.instance = new OracleInstance(config);
    this.storage = new OracleStorage();
    this.catalog = new OracleCatalog(this.storage, this.instance);
    this.catalog.setStoredUnitsProvider(() => this.getStoredUnits());
    this.lexer = new OracleLexer();
  }

  /**
   * Authenticate a user and create a new connection/session.
   * Returns a session ID or throws on auth failure.
   */
  connect(username: string, password: string): { sid: number; executor: OracleExecutor } {
    if (!this.instance.isOpen) {
      throw new Error(ORACLE_ERRORS.ORA_01034);
    }

    const authResult = this.catalog.authenticate(username, password);
    if (!authResult) {
      throw new Error(ORACLE_ERRORS.ORA_01017);
    }

    const upperUser = username.toUpperCase();
    const sid = this.sidCounter++;
    const serial = Math.floor(Math.random() * 50000) + 1;

    const connInfo: ConnectionInfo = {
      username: upperUser,
      schema: upperUser,
      connectedAt: new Date(),
      sid,
      serial,
    };
    this.connections.set(sid, connInfo);

    const context: ExecutionContext = {
      currentUser: upperUser,
      currentSchema: upperUser,
      autoCommit: false,
      serverOutput: false,
      feedback: true,
      timing: false,
    };

    const executor = new OracleExecutor(this.storage, this.catalog, this.instance, context);
    return { sid, executor };
  }

  /**
   * Connect as SYSDBA (no password check, sets user to SYS).
   */
  connectAsSysdba(): { sid: number; executor: OracleExecutor } {
    const sid = this.sidCounter++;
    const serial = Math.floor(Math.random() * 50000) + 1;

    const connInfo: ConnectionInfo = {
      username: 'SYS',
      schema: 'SYS',
      connectedAt: new Date(),
      sid,
      serial,
    };
    this.connections.set(sid, connInfo);

    const context: ExecutionContext = {
      currentUser: 'SYS',
      currentSchema: 'SYS',
      autoCommit: false,
      serverOutput: false,
      feedback: true,
      timing: false,
    };

    const executor = new OracleExecutor(this.storage, this.catalog, this.instance, context);
    return { sid, executor };
  }

  /**
   * Disconnect a session.
   */
  disconnect(sid: number): void {
    this.connections.delete(sid);
  }

  /**
   * Parse and execute a SQL statement string.
   * Handles both regular SQL and PL/SQL anonymous blocks.
   */
  executeSql(executor: OracleExecutor, sql: string): ResultSet {
    const trimmed = sql.trim().replace(/;\s*$/, '');
    if (!trimmed) return emptyResult();

    // Check for PL/SQL block
    const upper = trimmed.toUpperCase();
    if (upper.startsWith('BEGIN') || upper.startsWith('DECLARE')) {
      return this.executePLSQL(executor, trimmed);
    }

    // Check for CREATE OR REPLACE PROCEDURE/FUNCTION
    if (/^CREATE\s+(OR\s+REPLACE\s+)?PROCEDURE\b/i.test(upper)) {
      return this.createStoredProcedure(executor, trimmed);
    }
    if (/^CREATE\s+(OR\s+REPLACE\s+)?FUNCTION\b/i.test(upper)) {
      return this.createStoredFunction(executor, trimmed);
    }
    // PACKAGE BODY must be checked before PACKAGE
    if (/^CREATE\s+(OR\s+REPLACE\s+)?PACKAGE\s+BODY\b/i.test(upper)) {
      return this.createPackageBody(executor, trimmed);
    }
    if (/^CREATE\s+(OR\s+REPLACE\s+)?PACKAGE\b/i.test(upper)) {
      return this.createPackageSpec(executor, trimmed);
    }

    // Check for EXEC[UTE] procedure_name
    if (/^EXEC(?:UTE)?\s+/i.test(upper)) {
      return this.executeProcedureCall(executor, trimmed);
    }

    // Check for standalone procedure call: proc_name(args) or pkg.proc(args)
    if (/^[A-Za-z_]\w*(?:\.\w+)?\s*\(/.test(trimmed) && !upper.startsWith('SELECT') && !upper.startsWith('INSERT')) {
      const callResult = this.tryExecuteProcedureCall(executor, trimmed);
      if (callResult) return callResult;
    }

    // Check for CREATE [OR REPLACE] TRIGGER (body may contain semicolons)
    if (/^CREATE\s+(OR\s+REPLACE\s+)?TRIGGER\b/i.test(upper)) {
      return this.executeCreateTrigger(executor, trimmed);
    }

    // Check for ALTER SESSION (handled specially)
    if (upper.startsWith('ALTER SESSION')) {
      return this.executeAlterSession(executor, trimmed);
    }

    // Check for DROP PROCEDURE/FUNCTION
    if (/^DROP\s+PROCEDURE\b/i.test(upper)) {
      return this.dropStoredUnit(executor, trimmed, 'PROCEDURE');
    }
    if (/^DROP\s+FUNCTION\b/i.test(upper)) {
      return this.dropStoredUnit(executor, trimmed, 'FUNCTION');
    }
    // DROP PACKAGE BODY must be checked before DROP PACKAGE
    if (/^DROP\s+PACKAGE\s+BODY\b/i.test(upper)) {
      return this.dropStoredUnit(executor, trimmed, 'PACKAGE BODY');
    }
    if (/^DROP\s+PACKAGE\b/i.test(upper)) {
      return this.dropPackage(executor, trimmed);
    }

    const tokens = this.lexer.tokenize(trimmed);
    const parser = new OracleParser();
    const statements = parser.parseMultiple(tokens);

    if (statements.length === 0) return emptyResult();

    let result: ResultSet = emptyResult();
    for (const stmt of statements) {
      result = executor.execute(stmt);
    }
    return result;
  }

  private executeAlterSession(executor: OracleExecutor, sql: string): ResultSet {
    const match = sql.match(/ALTER\s+SESSION\s+SET\s+(\w+)\s*=\s*(\S+)/i);
    if (match) {
      const param = match[1].toUpperCase();
      const value = match[2].replace(/['"]/g, '').toUpperCase();
      if (param === 'SERVEROUTPUT') {
        (executor as { context: ExecutionContext }).context.serverOutput = value === 'ON';
      }
    }
    return emptyResult('Session altered.');
  }

  /**
   * Execute a PL/SQL anonymous block.
   * Lightweight interpreter supporting:
   * - Variable declarations (DECLARE)
   * - DBMS_OUTPUT.PUT_LINE
   * - IF/ELSIF/ELSE/END IF
   * - FOR i IN a..b LOOP/END LOOP
   * - WHILE condition LOOP/END LOOP
   * - Assignment (:=)
   * - SELECT INTO
   * - DML (INSERT, UPDATE, DELETE)
   * - Exception handling (EXCEPTION WHEN ... THEN)
   */
  private executePLSQL(executor: OracleExecutor, sql: string): ResultSet {
    const output: string[] = [];
    const variables = new Map<string, { type: string; value: import('../engine/storage/BaseStorage').CellValue }>();

    let block: ReturnType<typeof this.parsePLSQLBlock>;
    try {
      // Parse the block structure
      block = this.parsePLSQLBlock(sql);
    } catch (e: unknown) {
      const errMsg = e instanceof Error ? e.message : String(e);
      return emptyResult(errMsg + '\n\nPL/SQL procedure completed with errors.');
    }

    try {
      // Process DECLARE section
      for (const decl of block.declarations) {
        variables.set(decl.name.toUpperCase(), { type: decl.type, value: decl.defaultValue ?? null });
      }

      // Execute body
      this.executePLSQLStatements(executor, block.body, variables, output);

    } catch (e: unknown) {
      const errMsg = e instanceof Error ? e.message : String(e);

      // Try exception handlers
      let handled = false;
      for (const handler of block.exceptionHandlers) {
        const handlerName = handler.name.toUpperCase();
        // Match specific exceptions
        if (handlerName === 'OTHERS' ||
            (handlerName === 'ZERO_DIVIDE' && errMsg.includes('divisor is equal to zero')) ||
            (handlerName === 'NO_DATA_FOUND' && errMsg.includes(ORACLE_ERRORS.ORA_01403)) ||
            (handlerName === 'TOO_MANY_ROWS' && errMsg.includes(ORACLE_ERRORS.ORA_01422))) {
          // Set SQLERRM in context for WHEN OTHERS
          const savedSqlerrm = errMsg;
          const origEval = this.evaluatePLSQLExpressionWithVars.bind(this);
          const patchedVars = new Map(variables);
          patchedVars.set('SQLERRM', { type: 'VARCHAR2', value: savedSqlerrm });
          this.executePLSQLStatements(executor, handler.body, patchedVars, output);
          handled = true;
          break;
        }
      }

      if (!handled) {
        if ((executor as { context: ExecutionContext }).context.serverOutput) {
          output.push(errMsg);
        }
      }
    }

    const ctx = (executor as { context: ExecutionContext }).context;
    if (ctx.serverOutput && output.length > 0) {
      return emptyResult(output.join('\n') + '\n\nPL/SQL procedure successfully completed.');
    }
    return emptyResult('PL/SQL procedure successfully completed.');
  }

  private parsePLSQLBlock(sql: string): {
    declarations: { name: string; type: string; defaultValue: import('../engine/storage/BaseStorage').CellValue | null }[];
    body: string[];
    exceptionHandlers: { name: string; body: string[] }[];
  } {
    let source = sql.trim();
    // Remove trailing ;
    if (source.endsWith(';')) source = source.slice(0, -1);

    const declarations: { name: string; type: string; defaultValue: import('../engine/storage/BaseStorage').CellValue | null }[] = [];
    let bodyStr = '';
    const exceptionHandlers: { name: string; body: string[] }[] = [];

    // Find DECLARE section
    const upperSrc = source.toUpperCase();
    let bodyStart: number;

    if (upperSrc.startsWith('DECLARE')) {
      const beginIdx = this.findKeyword(source, 'BEGIN');
      if (beginIdx < 0) throw new Error('PLS-00103: Encountered symbol "end-of-input" when expecting BEGIN');
      const declSection = source.substring(7, beginIdx).trim();
      this.parsePLSQLDeclarations(declSection, declarations);
      bodyStart = beginIdx;
    } else {
      bodyStart = 0;
    }

    // Find BEGIN...END
    const beginIdx = this.findKeyword(source, 'BEGIN', bodyStart);
    if (beginIdx < 0) throw new Error('PLS-00103: Expected BEGIN');

    // Find matching END
    const endIdx = this.findMatchingEnd(source, beginIdx);
    if (endIdx < 0) throw new Error('PLS-00103: Expected END');

    const inner = source.substring(beginIdx + 5, endIdx).trim();

    // Find EXCEPTION section
    const exceptIdx = this.findKeyword(inner, 'EXCEPTION');
    if (exceptIdx >= 0) {
      bodyStr = inner.substring(0, exceptIdx).trim();
      const exceptSection = inner.substring(exceptIdx + 9).trim();
      this.parsePLSQLExceptions(exceptSection, exceptionHandlers);
    } else {
      bodyStr = inner;
    }

    // Split body into statements
    const bodyStatements = this.splitPLSQLStatements(bodyStr);

    return { declarations, body: bodyStatements, exceptionHandlers };
  }

  private findKeyword(source: string, keyword: string, startFrom = 0): number {
    const re = new RegExp(`\\b${keyword}\\b`, 'gi');
    re.lastIndex = startFrom;
    const match = re.exec(source);
    return match ? match.index : -1;
  }

  private findMatchingEnd(source: string, beginIdx: number): number {
    // Scan from beginIdx, tracking depth for nested BEGIN/IF/LOOP/CASE blocks.
    // Match compound closers (END IF, END LOOP, END CASE) before standalone END.
    const pattern = /\b(END\s+IF|END\s+LOOP|END\s+CASE|BEGIN|IF\b(?!\s*\()|\bLOOP|CASE|END)\b/gi;
    pattern.lastIndex = beginIdx;
    let depth = 0;
    let match: RegExpExecArray | null;

    while ((match = pattern.exec(source)) !== null) {
      const keyword = match[1].toUpperCase().replace(/\s+/g, ' ');
      if (keyword === 'BEGIN' || keyword === 'CASE') {
        depth++;
      } else if (keyword === 'IF') {
        // Only count IF as opening if followed by a condition (not part of END IF)
        depth++;
      } else if (keyword === 'LOOP') {
        depth++;
      } else {
        // END IF, END LOOP, END CASE, or standalone END
        depth--;
        if (depth === 0) {
          return match.index;
        }
      }
    }
    return -1;
  }

  private parsePLSQLDeclarations(
    section: string,
    declarations: { name: string; type: string; defaultValue: import('../engine/storage/BaseStorage').CellValue | null }[]
  ): void {
    const stmts = section.split(';').map(s => s.trim()).filter(s => s);
    for (const stmt of stmts) {
      // variable_name type [:= default]
      const match = stmt.match(/^(\w+)\s+(\w[\w(),.]*(?:\(\d+(?:,\s*\d+)?\))?)\s*(?::=\s*(.+))?$/i);
      if (match) {
        const name = match[1];
        const type = match[2];
        let defaultValue: import('../engine/storage/BaseStorage').CellValue = null;
        if (match[3]) {
          defaultValue = this.evaluatePLSQLExpression(match[3].trim());
        }
        declarations.push({ name, type, defaultValue });
      }
    }
  }

  private parsePLSQLExceptions(
    section: string,
    handlers: { name: string; body: string[] }[]
  ): void {
    // Split by WHEN keyword
    const parts = section.split(/\bWHEN\b/i).filter(s => s.trim());
    for (const part of parts) {
      const thenIdx = part.toUpperCase().indexOf('THEN');
      if (thenIdx < 0) continue;
      const name = part.substring(0, thenIdx).trim().toUpperCase();
      const body = part.substring(thenIdx + 4).trim();
      handlers.push({ name, body: this.splitPLSQLStatements(body) });
    }
  }

  private splitPLSQLStatements(body: string): string[] {
    // Split by ; but respect nested blocks (FOR...END LOOP, IF...END IF, BEGIN...END)
    const stmts: string[] = [];
    let current = '';
    let depth = 0;
    const lines = body.split('\n');

    for (const line of lines) {
      const trimLine = line.trim();
      const upper = trimLine.toUpperCase();

      // Track depth for nested structures
      if (upper.startsWith('IF ') || upper.startsWith('FOR ') || upper.startsWith('WHILE ') || upper === 'BEGIN') {
        depth++;
      }
      if (upper.startsWith('END IF') || upper.startsWith('END LOOP') || upper === 'END;' || upper === 'END') {
        depth--;
      }

      current += (current ? '\n' : '') + line;

      if (depth <= 0 && trimLine.endsWith(';')) {
        const stmt = current.trim().replace(/;\s*$/, '');
        if (stmt) stmts.push(stmt);
        current = '';
        depth = 0;
      }
    }

    // Handle leftover
    if (current.trim()) {
      const parts = current.split(';').map(s => s.trim()).filter(s => s);
      stmts.push(...parts);
    }

    return stmts;
  }

  private executePLSQLStatements(
    executor: OracleExecutor,
    statements: string[],
    variables: Map<string, { type: string; value: import('../engine/storage/BaseStorage').CellValue }>,
    output: string[]
  ): void {
    for (const stmt of statements) {
      try {
        this.executePLSQLStatement(executor, stmt, variables, output);
      } catch (e) {
        throw e; // Let the caller handle exceptions
      }
    }
  }

  private executePLSQLStatement(
    executor: OracleExecutor,
    stmt: string,
    variables: Map<string, { type: string; value: import('../engine/storage/BaseStorage').CellValue }>,
    output: string[]
  ): void {
    const trimmed = stmt.trim();
    if (!trimmed || trimmed.toUpperCase() === 'NULL') return;

    const upper = trimmed.toUpperCase();

    // DBMS_OUTPUT.PUT_LINE
    if (upper.startsWith('DBMS_OUTPUT.PUT_LINE')) {
      const match = trimmed.match(/DBMS_OUTPUT\.PUT_LINE\s*\(\s*(.*)\s*\)/is);
      if (match) {
        const exprStr = match[1];
        const value = this.evaluatePLSQLExpressionWithVars(exprStr, variables, executor);
        output.push(String(value ?? 'NULL'));
      }
      return;
    }

    // DBMS_OUTPUT.PUT / DBMS_OUTPUT.NEW_LINE / DBMS_OUTPUT.ENABLE / DBMS_OUTPUT.DISABLE
    if (upper.startsWith('DBMS_OUTPUT.PUT(')) {
      const match = trimmed.match(/DBMS_OUTPUT\.PUT\s*\(\s*(.*)\s*\)/is);
      if (match) {
        const value = this.evaluatePLSQLExpressionWithVars(match[1], variables, executor);
        output.push(String(value ?? ''));
      }
      return;
    }
    if (upper.startsWith('DBMS_OUTPUT.ENABLE') || upper.startsWith('DBMS_OUTPUT.DISABLE') || upper.startsWith('DBMS_OUTPUT.NEW_LINE')) {
      return; // No-op in simulator
    }

    // DBMS_LOCK.SLEEP
    if (upper.startsWith('DBMS_LOCK.SLEEP')) {
      // Simulated sleep — no actual delay in browser environment
      return;
    }

    // DBMS_UTILITY functions
    if (upper.startsWith('DBMS_UTILITY.')) {
      // GET_TIME — returns a relative time value
      if (upper.includes('GET_TIME')) {
        const assignTarget = trimmed.match(/^(\w+)\s*:=\s*DBMS_UTILITY\.GET_TIME/i);
        if (assignTarget && variables.has(assignTarget[1].toUpperCase())) {
          variables.get(assignTarget[1].toUpperCase())!.value = Date.now() % 2147483647;
        }
      }
      return;
    }

    // DBMS_STATS.GATHER_TABLE_STATS / GATHER_SCHEMA_STATS
    if (upper.startsWith('DBMS_STATS.')) {
      // Simulated — no actual stats gathering
      return;
    }

    // DBMS_SESSION.SET_ROLE / SET_NLS
    if (upper.startsWith('DBMS_SESSION.')) {
      return; // No-op in simulator
    }

    // DBMS_SCHEDULER calls
    if (upper.startsWith('DBMS_SCHEDULER.')) {
      return; // No-op in simulator
    }

    // DBMS_METADATA.GET_DDL
    if (upper.startsWith('DBMS_METADATA.')) {
      return; // Handled as function in evaluateFunction
    }

    // UTL_FILE operations
    if (upper.startsWith('UTL_FILE.')) {
      return; // No-op in simulator
    }

    // DBMS_LOB operations
    if (upper.startsWith('DBMS_LOB.')) {
      return; // No-op in simulator
    }

    // DBMS_FLASHBACK
    if (upper.startsWith('DBMS_FLASHBACK.')) {
      return; // No-op in simulator
    }

    // DBMS_SPACE
    if (upper.startsWith('DBMS_SPACE.')) {
      return; // No-op in simulator
    }

    // RAISE_APPLICATION_ERROR
    if (upper.startsWith('RAISE_APPLICATION_ERROR')) {
      const match = trimmed.match(/RAISE_APPLICATION_ERROR\s*\(\s*(-?\d+)\s*,\s*'([^']*)'\s*\)/i);
      if (match) {
        throw new Error(`ORA${match[1]}: ${match[2]}`);
      }
      return;
    }

    // Assignment: variable := expression
    const assignMatch = trimmed.match(/^(\w+)\s*:=\s*(.+)$/is);
    if (assignMatch) {
      const varName = assignMatch[1].toUpperCase();
      const exprStr = assignMatch[2].trim();
      const value = this.evaluatePLSQLExpressionWithVars(exprStr, variables, executor);
      if (variables.has(varName)) {
        variables.get(varName)!.value = value;
      }
      return;
    }

    // SELECT ... INTO
    if (upper.startsWith('SELECT')) {
      const intoMatch = trimmed.match(/SELECT\s+(.+?)\s+INTO\s+(\w+)\s+FROM\s+(.+)/is);
      if (intoMatch) {
        const selectExpr = intoMatch[1];
        const varName = intoMatch[2].toUpperCase();
        const fromClause = intoMatch[3];
        const sql = `SELECT ${selectExpr} FROM ${fromClause}`;
        const result = this.executeSql(executor, sql);
        if (result.rows.length > 0 && variables.has(varName)) {
          variables.get(varName)!.value = result.rows[0][0];
        }
      }
      return;
    }

    // IF-ELSIF-ELSE-END IF
    if (upper.startsWith('IF ')) {
      this.executePLSQLIf(executor, trimmed, variables, output);
      return;
    }

    // FOR loop
    if (upper.startsWith('FOR ')) {
      this.executePLSQLFor(executor, trimmed, variables, output);
      return;
    }

    // WHILE loop
    if (upper.startsWith('WHILE ')) {
      this.executePLSQLWhile(executor, trimmed, variables, output);
      return;
    }

    // DML: INSERT, UPDATE, DELETE
    if (upper.startsWith('INSERT') || upper.startsWith('UPDATE') || upper.startsWith('DELETE')) {
      this.executeSql(executor, trimmed);
      return;
    }
  }

  private executePLSQLIf(
    executor: OracleExecutor,
    stmt: string,
    variables: Map<string, { type: string; value: import('../engine/storage/BaseStorage').CellValue }>,
    output: string[]
  ): void {
    // Parse IF...ELSIF...ELSE...END IF
    // Remove trailing END IF
    let body = stmt.replace(/\bEND\s+IF\s*$/i, '').trim();

    // Split into branches
    const branches: { condition: string | null; body: string }[] = [];
    const parts = body.split(/\bELSIF\b|\bELSE\b/i);
    const fullUpper = body.toUpperCase();

    // First branch: IF condition THEN body
    const firstMatch = body.match(/^IF\s+(.+?)\s+THEN\s+([\s\S]*)/is);
    if (!firstMatch) return;

    branches.push({ condition: firstMatch[1].trim(), body: firstMatch[2].trim() });

    // Find ELSIF/ELSE positions
    const branchPattern = /\b(ELSIF|ELSE)\b/gi;
    let match: RegExpExecArray | null;
    const branchPositions: { type: string; pos: number }[] = [];
    while ((match = branchPattern.exec(body)) !== null) {
      branchPositions.push({ type: match[1].toUpperCase(), pos: match.index });
    }

    // Re-parse branches from branchPositions
    if (branchPositions.length > 0) {
      // Reset branches, parse more carefully
      branches.length = 0;
      branches.push({ condition: firstMatch[1].trim(), body: '' });

      let currentBody = firstMatch[2];
      for (let i = 0; i < branchPositions.length; i++) {
        // Everything before this branch position in the remaining text is the previous branch's body
        const bp = branchPositions[i];
        const relStart = bp.pos - (body.length - currentBody.length - (body.length - body.indexOf(currentBody)));

        // Simpler approach: re-split the entire body after first IF...THEN
        const afterFirst = body.substring(body.toUpperCase().indexOf('THEN') + 4).trim();
        const reParts = afterFirst.split(/\b(ELSIF|ELSE)\b/i);

        branches.length = 0;
        branches.push({ condition: firstMatch[1].trim(), body: reParts[0].trim() });

        for (let j = 1; j < reParts.length; j += 2) {
          const keyword = reParts[j].toUpperCase();
          const content = (reParts[j + 1] || '').trim();
          if (keyword === 'ELSIF') {
            const condMatch = content.match(/^(.+?)\s+THEN\s+([\s\S]*)/is);
            if (condMatch) {
              branches.push({ condition: condMatch[1].trim(), body: condMatch[2].trim() });
            }
          } else if (keyword === 'ELSE') {
            branches.push({ condition: null, body: content });
          }
        }
        break;
      }
    }

    // Evaluate branches
    for (const branch of branches) {
      if (branch.condition === null || this.evaluatePLSQLCondition(branch.condition, variables, executor)) {
        const stmts = this.splitPLSQLStatements(branch.body);
        this.executePLSQLStatements(executor, stmts, variables, output);
        return;
      }
    }
  }

  private executePLSQLFor(
    executor: OracleExecutor,
    stmt: string,
    variables: Map<string, { type: string; value: import('../engine/storage/BaseStorage').CellValue }>,
    output: string[]
  ): void {
    // FOR var IN start..end LOOP ... END LOOP
    const match = stmt.match(/^FOR\s+(\w+)\s+IN\s+(\d+)\.\.(\d+)\s+LOOP\s+([\s\S]*?)\s*END\s+LOOP$/is);
    if (!match) return;

    const varName = match[1].toUpperCase();
    const start = parseInt(match[2]);
    const end = parseInt(match[3]);
    const body = match[4];
    const bodyStmts = this.splitPLSQLStatements(body);

    // Add loop variable
    variables.set(varName, { type: 'NUMBER', value: start });

    for (let i = start; i <= end; i++) {
      variables.get(varName)!.value = i;
      this.executePLSQLStatements(executor, bodyStmts, variables, output);
    }

    variables.delete(varName);
  }

  private executePLSQLWhile(
    executor: OracleExecutor,
    stmt: string,
    variables: Map<string, { type: string; value: import('../engine/storage/BaseStorage').CellValue }>,
    output: string[]
  ): void {
    // WHILE condition LOOP ... END LOOP
    const match = stmt.match(/^WHILE\s+(.+?)\s+LOOP\s+([\s\S]*?)\s*END\s+LOOP$/is);
    if (!match) return;

    const condition = match[1];
    const body = match[2];
    const bodyStmts = this.splitPLSQLStatements(body);
    let maxIterations = 10000;

    while (maxIterations-- > 0 && this.evaluatePLSQLCondition(condition, variables, executor)) {
      this.executePLSQLStatements(executor, bodyStmts, variables, output);
    }
  }

  private evaluatePLSQLExpression(exprStr: string): import('../engine/storage/BaseStorage').CellValue {
    const trimmed = exprStr.trim();
    // String literal
    if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
      return trimmed.slice(1, -1);
    }
    // Number
    if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
      return Number(trimmed);
    }
    // NULL
    if (trimmed.toUpperCase() === 'NULL') return null;
    return trimmed;
  }

  private evaluatePLSQLExpressionWithVars(
    exprStr: string,
    variables: Map<string, { type: string; value: import('../engine/storage/BaseStorage').CellValue }>,
    executor: OracleExecutor
  ): import('../engine/storage/BaseStorage').CellValue {
    const trimmed = exprStr.trim();

    // Handle concatenation (||)
    if (trimmed.includes('||')) {
      const parts = trimmed.split('||').map(p => p.trim());
      return parts.map(p => {
        const val = this.evaluatePLSQLExpressionWithVars(p, variables, executor);
        return val != null ? String(val) : '';
      }).join('');
    }

    // Handle arithmetic (+, -, *, /)
    const arithMatch = trimmed.match(/^(.+?)\s*([+\-*/])\s*(.+)$/);
    if (arithMatch && !trimmed.startsWith("'")) {
      const left = Number(this.evaluatePLSQLExpressionWithVars(arithMatch[1], variables, executor));
      const right = Number(this.evaluatePLSQLExpressionWithVars(arithMatch[3], variables, executor));
      switch (arithMatch[2]) {
        case '+': return left + right;
        case '-': return left - right;
        case '*': return left * right;
        case '/': {
          if (right === 0) throw new Error(ORACLE_ERRORS.ORA_01476);
          return left / right;
        }
      }
    }

    // String literal
    if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
      return trimmed.slice(1, -1);
    }

    // Number
    if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);

    // NULL
    if (trimmed.toUpperCase() === 'NULL') return null;

    // SQLERRM
    if (trimmed.toUpperCase() === 'SQLERRM') return 'User-defined exception';

    // Variable reference
    const varName = trimmed.toUpperCase();
    if (variables.has(varName)) {
      return variables.get(varName)!.value;
    }

    return trimmed;
  }

  private evaluatePLSQLCondition(
    condition: string,
    variables: Map<string, { type: string; value: import('../engine/storage/BaseStorage').CellValue }>,
    executor: OracleExecutor
  ): boolean {
    const trimmed = condition.trim();

    // Comparison operators
    for (const op of ['>=', '<=', '<>', '!=', '>', '<', '=']) {
      const idx = trimmed.indexOf(op);
      if (idx > 0) {
        const left = this.evaluatePLSQLExpressionWithVars(trimmed.substring(0, idx), variables, executor);
        const right = this.evaluatePLSQLExpressionWithVars(trimmed.substring(idx + op.length), variables, executor);
        const l = Number(left);
        const r = Number(right);
        switch (op) {
          case '>=': return l >= r;
          case '<=': return l <= r;
          case '>': return l > r;
          case '<': return l < r;
          case '=': return l === r;
          case '<>': case '!=': return l !== r;
        }
      }
    }

    return false;
  }

  /**
   * Get active connections info (for V$SESSION).
   */
  getConnections(): ConnectionInfo[] {
    return Array.from(this.connections.values());
  }

  /**
   * Get the SID/service name for display.
   */
  getSid(): string {
    return this.instance.config.sid;
  }

  getServiceName(): string {
    return this.instance.config.serviceName;
  }

  // ═══════════════════════════════════════════════════════════════════
  // Stored PL/SQL Units (Procedures, Functions)
  // ═══════════════════════════════════════════════════════════════════

  /** Parse and store a CREATE [OR REPLACE] PROCEDURE */
  private createStoredProcedure(executor: OracleExecutor, sql: string): ResultSet {
    const match = sql.match(/^CREATE\s+(OR\s+REPLACE\s+)?PROCEDURE\s+(\w+)\s*(?:\(([\s\S]*?)\))?\s*(?:IS|AS)\s+([\s\S]+)$/i);
    if (!match) return emptyResult('ORA-24344: success with compilation error');

    const name = match[2].toUpperCase();
    const paramStr = match[3] || '';
    const body = match[4].trim();
    const schema = (executor as any).context?.currentSchema || 'SYS';

    const parameters = this.parseParameters(paramStr);
    const key = `${schema}.${name}`;

    this.storedUnits.set(key, {
      schema,
      name,
      type: 'PROCEDURE',
      parameters,
      body,
      sourceLines: sql.split('\n'),
      created: new Date(),
      status: 'VALID',
    });

    return emptyResult('Procedure created.');
  }

  /** Parse and store a CREATE [OR REPLACE] FUNCTION */
  private createStoredFunction(executor: OracleExecutor, sql: string): ResultSet {
    const match = sql.match(/^CREATE\s+(OR\s+REPLACE\s+)?FUNCTION\s+(\w+)\s*(?:\(([\s\S]*?)\))?\s*RETURN\s+(\w+(?:\([^)]*\))?)\s*(?:IS|AS)\s+([\s\S]+)$/i);
    if (!match) return emptyResult('ORA-24344: success with compilation error');

    const name = match[2].toUpperCase();
    const paramStr = match[3] || '';
    const returnType = match[4].toUpperCase();
    const body = match[5].trim();
    const schema = (executor as any).context?.currentSchema || 'SYS';

    const parameters = this.parseParameters(paramStr);
    const key = `${schema}.${name}`;

    this.storedUnits.set(key, {
      schema,
      name,
      type: 'FUNCTION',
      parameters,
      returnType,
      body,
      sourceLines: sql.split('\n'),
      created: new Date(),
      status: 'VALID',
    });

    return emptyResult('Function created.');
  }

  /** Parse parameter list like "p_id IN NUMBER, p_name IN VARCHAR2 DEFAULT 'X'" */
  private parseParameters(paramStr: string): StoredPLSQLUnit['parameters'] {
    if (!paramStr.trim()) return [];
    const params: StoredPLSQLUnit['parameters'] = [];
    // Split by comma but respect parentheses
    const parts = paramStr.split(',');
    for (const part of parts) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const m = trimmed.match(/^(\w+)\s+(IN\s+OUT|OUT|IN)?\s*(\w+(?:\([^)]*\))?)\s*(?:DEFAULT\s+(.+))?$/i);
      if (m) {
        params.push({
          name: m[1].toUpperCase(),
          mode: (m[2]?.toUpperCase().replace(/\s+/g, ' ') || 'IN') as 'IN' | 'OUT' | 'IN OUT',
          dataType: m[3].toUpperCase(),
          defaultValue: m[4]?.trim(),
        });
      }
    }
    return params;
  }

  /** Execute EXEC[UTE] procedure_name(args) */
  private executeProcedureCall(executor: OracleExecutor, sql: string): ResultSet {
    const cleaned = sql.replace(/^EXEC(?:UTE)?\s+/i, '').trim();
    return this.callStoredUnit(executor, cleaned);
  }

  /** Try to execute a standalone procedure call (including pkg.proc) */
  private tryExecuteProcedureCall(executor: OracleExecutor, sql: string): ResultSet | null {
    // Match pkg.proc(args) or proc(args)
    const match = sql.match(/^(\w+(?:\.\w+)?)\s*\(([\s\S]*)\)\s*$/);
    if (!match) return null;
    const name = match[1].toUpperCase();
    const schema = (executor as any).context?.currentSchema || 'SYS';
    // For package-qualified calls, look for SCHEMA.PKG.MEMBER
    if (name.includes('.')) {
      const key = `${schema}.${name}`;
      if (!this.storedUnits.has(key) && !this.storedUnits.has(`SYS.${name}`)) return null;
    } else {
      const key = `${schema}.${name}`;
      if (!this.storedUnits.has(key) && !this.storedUnits.has(`SYS.${name}`)) return null;
    }
    return this.callStoredUnit(executor, sql);
  }

  /** Call a stored procedure or function by name with arguments (supports pkg.proc) */
  private callStoredUnit(executor: OracleExecutor, callExpr: string): ResultSet {
    // Match pkg.proc(args) or proc(args)
    const match = callExpr.match(/^(\w+(?:\.\w+)?)(?:\s*\(([\s\S]*)\))?\s*$/);
    if (!match) return emptyResult(ORACLE_ERRORS.ORA_00900);

    const name = match[1].toUpperCase();
    const argsStr = match[2] || '';
    const schema = (executor as any).context?.currentSchema || 'SYS';

    const unit = this.storedUnits.get(`${schema}.${name}`) || this.storedUnits.get(`SYS.${name}`);
    if (!unit) return emptyResult(`${ORACLE_ERRORS.ORA_00900}\nPLS-00201: identifier '${name}' must be declared`);

    // Parse arguments
    const args = argsStr ? argsStr.split(',').map(a => a.trim()) : [];

    // Build variable map from parameters + arguments
    const body = unit.body;

    // Construct a PL/SQL block that declares params as variables and runs the body
    let block = 'DECLARE\n';
    for (let i = 0; i < unit.parameters.length; i++) {
      const p = unit.parameters[i];
      const argValue = args[i] ?? p.defaultValue ?? 'NULL';
      block += `  ${p.name} ${p.dataType} := ${argValue};\n`;
    }
    // If the body already has DECLARE/BEGIN, unwrap it
    const upperBody = body.toUpperCase().trim();
    if (upperBody.startsWith('BEGIN')) {
      block += body;
    } else if (upperBody.startsWith('DECLARE')) {
      // Merge declarations
      const declareMatch = body.match(/^DECLARE\s+([\s\S]*?)\s*BEGIN\s+([\s\S]*)$/i);
      if (declareMatch) {
        block += declareMatch[1] + '\n';
        block += 'BEGIN\n' + declareMatch[2];
      } else {
        block += 'BEGIN\n' + body + '\nEND;';
      }
    } else {
      block += 'BEGIN\n' + body + '\nEND;';
    }

    return this.executePLSQL(executor, block);
  }

  /** DROP PROCEDURE/FUNCTION/PACKAGE BODY */
  private dropStoredUnit(_executor: OracleExecutor, sql: string, type: 'PROCEDURE' | 'FUNCTION' | 'PACKAGE BODY'): ResultSet {
    const match = sql.match(/^DROP\s+(?:PROCEDURE|FUNCTION|PACKAGE\s+BODY)\s+(\w+)/i);
    if (!match) return emptyResult(ORACLE_ERRORS.ORA_00900);

    const name = match[1].toUpperCase();
    const schema = (_executor as any).context?.currentSchema || 'SYS';
    const key = `${schema}.${name}`;

    if (!this.storedUnits.has(key)) {
      return emptyResult(`ORA-04043: object ${name} does not exist`);
    }
    this.storedUnits.delete(key);
    const typeLabel = type === 'PROCEDURE' ? 'Procedure' : type === 'FUNCTION' ? 'Function' : 'Package body';
    return emptyResult(`${typeLabel} dropped.`);
  }

  /** Get all stored PL/SQL units (for DBA_SOURCE, DBA_PROCEDURES, DBA_OBJECTS) */
  getStoredUnits(): StoredPLSQLUnit[] {
    return Array.from(this.storedUnits.values());
  }

  /** Get a specific stored unit by name */
  getStoredUnit(schema: string, name: string): StoredPLSQLUnit | undefined {
    return this.storedUnits.get(`${schema}.${name}`);
  }

  /** Parse and execute CREATE [OR REPLACE] TRIGGER using regex (body may contain semicolons) */
  private executeCreateTrigger(executor: OracleExecutor, sql: string): ResultSet {
    const match = sql.match(
      /^CREATE\s+(OR\s+REPLACE\s+)?TRIGGER\s+(?:(\w+)\.)?(\w+)\s+(BEFORE|AFTER|INSTEAD\s+OF)\s+(INSERT|UPDATE|DELETE)(?:\s+OR\s+(INSERT|UPDATE|DELETE))?(?:\s+OR\s+(INSERT|UPDATE|DELETE))?\s+ON\s+(?:(\w+)\.)?(\w+)(?:\s+FOR\s+EACH\s+ROW)?\s*([\s\S]*)$/i
    );
    if (!match) return emptyResult('ORA-24344: success with compilation error');

    const orReplace = !!match[1];
    const schema = (match[2] || (executor as any).context?.currentSchema || 'SYS').toUpperCase();
    const name = match[3].toUpperCase();
    const timing = match[4].toUpperCase().replace(/\s+/g, ' ') as 'BEFORE' | 'AFTER' | 'INSTEAD OF';
    const events: Array<'INSERT' | 'UPDATE' | 'DELETE'> = [];
    if (match[5]) events.push(match[5].toUpperCase() as any);
    if (match[6]) events.push(match[6].toUpperCase() as any);
    if (match[7]) events.push(match[7].toUpperCase() as any);
    const tableSchema = (match[8] || schema).toUpperCase();
    const tableName = match[9].toUpperCase();
    const forEachRow = /FOR\s+EACH\s+ROW/i.test(sql);
    const body = (match[10] || '').trim();

    if (orReplace) {
      try { this.storage.dropTrigger(schema, name); } catch { /* ignore */ }
    }

    this.storage.createTrigger({
      schema, name, timing, events,
      tableName, tableSchema,
      forEachRow, body, enabled: true,
    });

    return emptyResult('Trigger created.');
  }
}
