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

export interface ConnectionInfo {
  username: string;
  schema: string;
  connectedAt: Date;
  sid: number;
  serial: number;
}

export class OracleDatabase {
  readonly instance: OracleInstance;
  readonly storage: OracleStorage;
  readonly catalog: OracleCatalog;
  private lexer: OracleLexer;
  private connections: Map<number, ConnectionInfo> = new Map();
  private sidCounter: number = 1;

  constructor(config?: Partial<OracleDatabaseConfig>) {
    this.instance = new OracleInstance(config);
    this.storage = new OracleStorage();
    this.catalog = new OracleCatalog(this.storage, this.instance);
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

    // Check for ALTER SESSION (handled specially)
    if (upper.startsWith('ALTER SESSION')) {
      return this.executeAlterSession(executor, trimmed);
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
}
