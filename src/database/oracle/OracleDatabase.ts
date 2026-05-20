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
import { SecurityEngine } from './security/SecurityEngine';
import { provisionPredefinedProfiles } from './security/classicProfiles';
import { DEFAULT_OS_CONTEXT, type OsSecurityContext } from './security/types';
import { OracleSession, type AuthenticationMethod } from './security/OracleSession';
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
  readonly securityEngine: SecurityEngine;
  private lexer: OracleLexer;
  private connections: Map<number, ConnectionInfo> = new Map();
  // SIDs 1-4 are reserved for simulated background processes (PMON/SMON/DBW0/LGWR)
  private sidCounter: number = 5;
  /** Stored PL/SQL units (procedures, functions, packages) */
  private storedUnits: Map<string, StoredPLSQLUnit> = new Map();

  /** Live OracleSession objects keyed by SID — the dictionary feeds
   *  V$SESSION, SYS_CONTEXT('USERENV', …) and DBMS_SESSION. */
  private sessions: Map<number, OracleSession> = new Map();

  /**
   * Build the instance-identity payload OracleSession needs.
   * Reads live values from `OracleInstance` parameters so renaming /
   * relocation is automatically reflected.
   */
  private buildInstanceIdentity(): {
    instanceId: number; instanceName: string;
    dbName: string; dbUniqueName: string; dbDomain: string; serverHost: string;
  } {
    const dbName = this.instance.getParameter('db_name') ?? 'orcl';
    return {
      instanceId: 1,
      instanceName: dbName,
      dbName,
      dbUniqueName: this.instance.getParameter('db_unique_name') ?? dbName,
      dbDomain: this.instance.getParameter('db_domain') ?? 'localdomain',
      serverHost: this.instance.getParameter('server_host') ?? 'localhost',
    };
  }

  /** Open OracleSession + register in the sessions map. */
  private openSession(args: {
    sid: number; serial: number; username: string; schema?: string;
    osCtx: OsSecurityContext; authenticationMethod: AuthenticationMethod;
    type?: 'USER' | 'BACKGROUND'; authenticatedIdentity?: string;
  }): OracleSession {
    const user = this.catalog.getUser(args.username.toUpperCase());
    const session = new OracleSession({
      sid: args.sid,
      serial: args.serial,
      username: args.username,
      schema: args.schema,
      osContext: args.osCtx,
      authenticationMethod: args.authenticationMethod,
      type: args.type,
      authenticatedIdentity: args.authenticatedIdentity ?? user?.externalName,
      instance: this.buildInstanceIdentity(),
    });
    this.sessions.set(args.sid, session);
    return session;
  }

  /** Close an OracleSession (called on disconnect). */
  closeSession(sid: number): void {
    this.sessions.delete(sid);
  }

  /** All currently-open sessions. */
  getOpenSessions(): readonly OracleSession[] {
    return [...this.sessions.values()];
  }

  /** Locate an open session by SID. */
  getSession(sid: number): OracleSession | undefined {
    return this.sessions.get(sid);
  }

  constructor(config?: Partial<OracleDatabaseConfig>) {
    this.instance = new OracleInstance(config);
    this.storage = new OracleStorage();
    this.catalog = new OracleCatalog(this.storage, this.instance);
    this.catalog.setStoredUnitsProvider(() => this.getStoredUnits());
    this.securityEngine = new SecurityEngine(this.catalog);
    this.catalog.setSecurityEngine(this.securityEngine);
    // Provision the predefined non-DEFAULT profiles (MONITORING_PROFILE,
    // ORA_STIG_PROFILE) so a fresh instance matches a real 19c install.
    provisionPredefinedProfiles(this.securityEngine.profiles);
    this.lexer = new OracleLexer();
  }

  /**
   * Authenticate a user and create a new connection/session.
   * Returns a session ID or throws on auth failure.
   */
  connect(
    username: string,
    password: string,
    osCtx: OsSecurityContext = DEFAULT_OS_CONTEXT
  ): { sid: number; executor: OracleExecutor } {
    if (!this.instance.isOpen) {
      throw new Error(ORACLE_ERRORS.ORA_01034);
    }

    const upperUser = username.toUpperCase();
    const user = this.catalog.getUser(upperUser);

    /**
     * Wrap a failed-auth throw so every rejection path also leaves a
     * trace in the audit trail and alert log. SESSIONID 0 is the
     * canonical Oracle marker for "no session was ever opened".
     */
    const failLogon = (code: number, message: string): never => {
      this.catalog.recordLogon(upperUser, 0, code, osCtx.osUser, osCtx.hostname, osCtx.terminal);
      this.instance.logAlertEvent(`Failed logon: user=${upperUser} ORA-${String(code).padStart(5, '0')}`);
      throw new Error(message);
    };

    // Dispatch on AUTHENTICATION_TYPE recorded at CREATE USER time.
    if (user?.authenticationType === 'EXTERNAL') {
      // OS-authenticated user: name must match `<os_prefix><osUser>` (default OPS$).
      // Real Oracle uses init parameter OS_AUTHENT_PREFIX; we simulate with 'OPS$'.
      const expected = `OPS$${osCtx.osUser.toUpperCase()}`;
      if (upperUser !== expected) {
        failLogon(1017, ORACLE_ERRORS.ORA_01017);
      }
    } else if (user?.authenticationType === 'GLOBAL') {
      // Directory-authenticated: no password path supported in this simulation.
      failLogon(1017, ORACLE_ERRORS.ORA_01017);
    } else {
      // Standard password authentication via SecurityEngine:
      // enforces lock, failed-login tracking, expiry.
      const storedPassword = this.catalog.getStoredPassword(upperUser);
      const authResult = this.securityEngine.authenticate(upperUser, password, this.catalog, storedPassword);
      if (!authResult.success) {
        failLogon(authResult.errorCode || 1017, authResult.message || ORACLE_ERRORS.ORA_01017);
      }
    }

    // Enforce CREATE SESSION privilege (direct or via role)
    if (!this.securityEngine.privileges.hasSystemPrivilege(upperUser, 'CREATE SESSION')) {
      failLogon(1045, 'ORA-01045: user ' + upperUser + ' lacks CREATE SESSION privilege; logon denied');
    }

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

    // Register session in SecurityEngine with the same sid/serial used by OracleDatabase
    const sessionId = String(sid);
    const sessionResult = this.securityEngine.openSession(sessionId, upperUser, upperUser, osCtx, this.catalog, sid, serial);
    if (!sessionResult.ok) {
      this.connections.delete(sid);
      this.catalog.recordLogon(upperUser, sid, 2391, osCtx.osUser, osCtx.hostname, osCtx.terminal);
      throw new Error(sessionResult.error ?? 'ORA-02391: exceeded simultaneous SESSIONS_PER_USER limit');
    }
    this.catalog.recordLogon(upperUser, sid, 0, osCtx.osUser, osCtx.hostname, osCtx.terminal);
    this.instance.logAlertEvent(`Logon: user=${upperUser} sid=${sid}`);

    const authMethod: AuthenticationMethod =
      user?.authenticationType === 'EXTERNAL' ? 'EXTERNAL'
      : user?.authenticationType === 'GLOBAL' ? 'GLOBAL'
      : 'PASSWORD';
    const session = this.openSession({
      sid, serial, username: upperUser, osCtx, authenticationMethod: authMethod,
    });

    const context: ExecutionContext = {
      currentUser: upperUser,
      currentSchema: upperUser,
      autoCommit: false,
      serverOutput: false,
      feedback: true,
      timing: false,
      session,
    };

    const executor = new OracleExecutor(this.storage, this.catalog, this.instance, context);
    return { sid, executor };
  }

  /**
   * Connect as SYSDBA (no password check, sets user to SYS).
   */
  connectAsSysdba(osCtx: OsSecurityContext = DEFAULT_OS_CONTEXT): { sid: number; executor: OracleExecutor } {
    // OS-group enforcement: SYSDBA requires the OS user to be in the dba group.
    if (osCtx !== DEFAULT_OS_CONTEXT && !osCtx.isDbaGroup) {
      throw new Error('ORA-01031: insufficient privileges');
    }
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

    // Register SYSDBA session with matching sid/serial
    const sessionId = String(sid);
    this.securityEngine.openSession(sessionId, 'SYS', 'SYS', { ...osCtx, program: osCtx.program ?? 'sqlplus@localhost' }, this.catalog, sid, serial);
    // Record audit + alert log — SYSDBA logons are first-class events.
    this.catalog.recordAudit({
      sessionId: sid, username: 'SYS', actionName: 'LOGON', returncode: 0,
      osUsername: osCtx.osUser, userhost: osCtx.hostname, terminal: osCtx.terminal,
      privUsed: 'SYSDBA', statementType: 'LOGON',
    });
    this.instance.logAlertEvent(`Logon: user=SYS sid=${sid} as SYSDBA`);

    const sysSession = this.openSession({
      sid, serial, username: 'SYS', osCtx: { ...osCtx, program: osCtx.program ?? 'sqlplus@localhost' },
      authenticationMethod: 'SYSDBA',
    });

    const context: ExecutionContext = {
      currentUser: 'SYS',
      currentSchema: 'SYS',
      autoCommit: false,
      serverOutput: false,
      feedback: true,
      timing: false,
      session: sysSession,
    };

    const executor = new OracleExecutor(this.storage, this.catalog, this.instance, context);
    return { sid, executor };
  }

  /**
   * Connect as SYSOPER — limited admin role (PUBLIC schema, no user-data access).
   * Like SYSDBA, requires OS dba group membership.
   */
  connectAsSysoper(osCtx: OsSecurityContext = DEFAULT_OS_CONTEXT): { sid: number; executor: OracleExecutor } {
    if (osCtx !== DEFAULT_OS_CONTEXT && !osCtx.isDbaGroup) {
      throw new Error('ORA-01031: insufficient privileges');
    }
    const sid = this.sidCounter++;
    const serial = Math.floor(Math.random() * 50000) + 1;

    const connInfo: ConnectionInfo = {
      username: 'PUBLIC',
      schema: 'PUBLIC',
      connectedAt: new Date(),
      sid,
      serial,
    };
    this.connections.set(sid, connInfo);

    const sessionId = String(sid);
    this.securityEngine.openSession(sessionId, 'PUBLIC', 'PUBLIC',
      { ...osCtx, program: osCtx.program ?? 'sqlplus@localhost' },
      this.catalog, sid, serial);

    const sysoperSession = this.openSession({
      sid, serial, username: 'PUBLIC', osCtx: { ...osCtx, program: osCtx.program ?? 'sqlplus@localhost' },
      authenticationMethod: 'SYSOPER',
    });

    const context: ExecutionContext = {
      currentUser: 'PUBLIC',
      currentSchema: 'PUBLIC',
      autoCommit: false,
      serverOutput: false,
      feedback: true,
      timing: false,
      session: sysoperSession,
    };

    const executor = new OracleExecutor(this.storage, this.catalog, this.instance, context);
    return { sid, executor };
  }

  /**
   * Disconnect a session.
   */
  disconnect(sid: number): void {
    const conn = this.connections.get(sid);
    if (conn) {
      this.catalog.recordLogoff(conn.username, sid);
      this.instance.logAlertEvent(`Logoff: user=${conn.username} sid=${sid}`);
    }
    this.connections.delete(sid);
    this.securityEngine.closeSession(String(sid));
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

    // ALTER {PROCEDURE | FUNCTION | PACKAGE} <name> COMPILE [BODY]
    // is a no-op recompile in the simulator — emits the canonical message.
    const alterCompile = trimmed.match(/^ALTER\s+(PROCEDURE|FUNCTION|PACKAGE)\s+(?:\w+\s*\.\s*)?\w+\s+COMPILE(\s+BODY)?\b/i);
    if (alterCompile) {
      const kind = alterCompile[1].toUpperCase();
      const label = kind === 'PROCEDURE' ? 'Procedure' : kind === 'FUNCTION' ? 'Function' : 'Package';
      return emptyResult(`${label} altered.`);
    }

    const tokens = this.lexer.tokenize(trimmed);
    const parser = new OracleParser();
    const statements = parser.parseMultiple(tokens);

    if (statements.length === 0) return emptyResult();

    let result: ResultSet = emptyResult();
    for (const stmt of statements) {
      // Attach the source SQL so audit/journaling records the original
      // user text — the AST type alone is useless to a DBA.
      (stmt as unknown as { sourceText?: string }).sourceText = trimmed;
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
      } else if (param === 'CURRENT_SCHEMA') {
        if (!this.catalog.userExists(value)) {
          return emptyResult('ORA-02248: invalid option for ALTER SESSION');
        }
        executor.updateContext({ currentSchema: value });
        // Keep the live OracleSession in sync — USERENV reads from it.
        const ctx = (executor as { context: ExecutionContext }).context;
        const sess = ctx.session as { setCurrentSchema?: (s: string) => void } | undefined;
        sess?.setCurrentSchema?.(value);
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

    // DBMS_RLS.{ADD_POLICY,ADD_GROUPED_POLICY,ENABLE_POLICY,DISABLE_POLICY,DROP_POLICY,DROP_GROUPED_POLICY}
    if (upper.startsWith('DBMS_RLS.')) {
      this.executeDbmsRlsCall(executor, trimmed);
      return;
    }

    // DBMS_FGA.{ADD_POLICY,ENABLE_POLICY,DISABLE_POLICY,DROP_POLICY}
    if (upper.startsWith('DBMS_FGA.')) {
      this.executeDbmsFgaCall(executor, trimmed);
      return;
    }

    // DBMS_MACADM — Database Vault administration; routed through the catalog.
    if (upper.startsWith('DBMS_MACADM.')) {
      this.executeDbmsMacadmCall(trimmed);
      return;
    }

    // DBMS_AUDIT_MGMT — accept maintenance procedures as no-ops.
    if (upper.startsWith('DBMS_AUDIT_MGMT.')) {
      return;
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

    // Package-qualified procedure call: PKG_NAME.PROC_NAME(args)
    if (/^\w+\.\w+\s*\(/.test(trimmed)) {
      const callResult = this.callStoredUnit(executor, trimmed);
      if (callResult) {
        // Collect any output from the called unit
        if (callResult.message) {
          const lines = callResult.message.split('\n');
          for (const line of lines) {
            if (line && !line.includes('PL/SQL procedure')) {
              output.push(line);
            }
          }
        }
      }
      return;
    }

    // Simple procedure call: PROC_NAME(args)
    if (/^\w+\s*\(/.test(trimmed)) {
      const callResult = this.tryExecuteProcedureCall(executor, trimmed);
      if (callResult) {
        if (callResult.message) {
          const lines = callResult.message.split('\n');
          for (const line of lines) {
            if (line && !line.includes('PL/SQL procedure')) {
              output.push(line);
            }
          }
        }
        return;
      }
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
    // Accept `schema.name` as well as bare `name`. The qualified form
    // takes precedence over the connected schema (real Oracle behaviour).
    const match = sql.match(/^CREATE\s+(OR\s+REPLACE\s+)?PROCEDURE\s+(?:(\w+)\s*\.\s*)?(\w+)\s*(?:\(([\s\S]*?)\))?\s*(?:IS|AS)\s+([\s\S]+)$/i);
    if (!match) return emptyResult('ORA-24344: success with compilation error');

    const ctxSchema = (executor as { context?: { currentSchema?: string } }).context?.currentSchema ?? 'SYS';
    const schema = (match[2] ?? ctxSchema).toUpperCase();
    const name = match[3].toUpperCase();
    const paramStr = match[4] || '';
    const body = match[5].trim();

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
    const match = sql.match(/^CREATE\s+(OR\s+REPLACE\s+)?FUNCTION\s+(?:(\w+)\s*\.\s*)?(\w+)\s*(?:\(([\s\S]*?)\))?\s*RETURN\s+(\w+(?:\([^)]*\))?)\s*(?:IS|AS)\s+([\s\S]+)$/i);
    if (!match) return emptyResult('ORA-24344: success with compilation error');

    const ctxSchema = (executor as { context?: { currentSchema?: string } }).context?.currentSchema ?? 'SYS';
    const schema = (match[2] ?? ctxSchema).toUpperCase();
    const name = match[3].toUpperCase();
    const paramStr = match[4] || '';
    const returnType = match[5].toUpperCase();
    const body = match[6].trim();

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
    const match = sql.match(/^DROP\s+(?:PROCEDURE|FUNCTION|PACKAGE\s+BODY)\s+(?:(\w+)\s*\.\s*)?(\w+)/i);
    if (!match) return emptyResult(ORACLE_ERRORS.ORA_00900);

    const ctxSchema = (_executor as { context?: { currentSchema?: string } }).context?.currentSchema ?? 'SYS';
    const schema = (match[1] ?? ctxSchema).toUpperCase();
    const name = match[2].toUpperCase();

    if (type === 'PACKAGE BODY') {
      const bodyKey = `${schema}.${name}.__BODY__`;
      if (!this.storedUnits.has(bodyKey)) {
        return emptyResult(`ORA-04043: object ${name} does not exist`);
      }
      this.storedUnits.delete(bodyKey);
      // Also remove member units
      this.removePackageMembers(schema, name);
      return emptyResult('Package body dropped.');
    }

    const key = `${schema}.${name}`;
    if (!this.storedUnits.has(key)) {
      return emptyResult(`ORA-04043: object ${name} does not exist`);
    }
    this.storedUnits.delete(key);
    const typeLabel = type === 'PROCEDURE' ? 'Procedure' : 'Function';
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

  // ═══════════════════════════════════════════════════════════════════
  // PL/SQL Packages
  // ═══════════════════════════════════════════════════════════════════

  /** Parse and store a CREATE [OR REPLACE] PACKAGE (specification) */
  private createPackageSpec(executor: OracleExecutor, sql: string): ResultSet {
    const match = sql.match(/^CREATE\s+(OR\s+REPLACE\s+)?PACKAGE\s+(?:(\w+)\s*\.\s*)?(\w+)\s+(?:IS|AS)\s+([\s\S]+)$/i);
    if (!match) return emptyResult('ORA-24344: success with compilation error');

    const ctxSchema = (executor as { context?: { currentSchema?: string } }).context?.currentSchema ?? 'SYS';
    const schema = (match[2] ?? ctxSchema).toUpperCase();
    const name = match[3].toUpperCase();
    const body = match[4].trim();
    const key = `${schema}.${name}`;

    // If OR REPLACE, remove existing spec (but keep body and members)
    if (match[1]) {
      this.storedUnits.delete(key);
    }

    this.storedUnits.set(key, {
      schema,
      name,
      type: 'PACKAGE',
      parameters: [],
      body,
      sourceLines: sql.split('\n'),
      created: new Date(),
      status: 'VALID',
    });

    return emptyResult('Package created.');
  }

  /** Parse and store a CREATE [OR REPLACE] PACKAGE BODY */
  private createPackageBody(executor: OracleExecutor, sql: string): ResultSet {
    const match = sql.match(/^CREATE\s+(OR\s+REPLACE\s+)?PACKAGE\s+BODY\s+(?:(\w+)\s*\.\s*)?(\w+)\s+(?:IS|AS)\s+([\s\S]+)$/i);
    if (!match) return emptyResult('ORA-24344: success with compilation error');

    const ctxSchema = (executor as { context?: { currentSchema?: string } }).context?.currentSchema ?? 'SYS';
    const schema = (match[2] ?? ctxSchema).toUpperCase();
    const pkgName = match[3].toUpperCase();
    const bodyContent = match[4].trim();
    const bodyKey = `${schema}.${pkgName}`;

    // If OR REPLACE, remove existing body and its member units
    if (match[1]) {
      this.removePackageMembers(schema, pkgName);
      // Remove the PACKAGE BODY entry
      const bodyKey = `${schema}.${pkgName}.__BODY__`;
      this.storedUnits.delete(bodyKey);
    }

    // Store the package body unit
    // Use a separate key pattern for PACKAGE BODY to avoid colliding with the spec
    const bodyUnitKey = `${schema}.${pkgName}.__BODY__`;
    this.storedUnits.set(bodyUnitKey, {
      schema,
      name: pkgName,
      type: 'PACKAGE BODY',
      parameters: [],
      body: bodyContent,
      sourceLines: sql.split('\n'),
      created: new Date(),
      status: 'VALID',
    });

    // Parse and extract individual procedures and functions from the body
    this.extractPackageMembers(schema, pkgName, bodyContent);

    return emptyResult('Package body created.');
  }

  /** Extract individual procedures/functions from a package body and store them */
  private extractPackageMembers(schema: string, pkgName: string, bodyContent: string): void {
    // Remove the final END [package_name]; from the body
    let content = bodyContent.replace(/\bEND\s+\w*\s*;?\s*$/i, '').trim();

    // Find PROCEDURE and FUNCTION definitions
    // We'll scan for PROCEDURE name(...) IS|AS and FUNCTION name(...) RETURN type IS|AS
    const memberPattern = /\b(PROCEDURE|FUNCTION)\s+(\w+)\s*(\([^)]*\))?\s*(?:RETURN\s+(\w+(?:\([^)]*\))?)\s*)?(?:IS|AS)\b/gi;
    let memberMatch: RegExpExecArray | null;
    const members: { type: string; name: string; paramStr: string; returnType: string; startIdx: number }[] = [];

    while ((memberMatch = memberPattern.exec(content)) !== null) {
      members.push({
        type: memberMatch[1].toUpperCase(),
        name: memberMatch[2].toUpperCase(),
        paramStr: memberMatch[3] ? memberMatch[3].slice(1, -1) : '', // remove parens
        returnType: memberMatch[4]?.toUpperCase() || '',
        startIdx: memberMatch.index,
      });
    }

    // Extract each member's body
    for (let i = 0; i < members.length; i++) {
      const member = members[i];
      // Body starts after the IS|AS keyword
      const headerEnd = content.indexOf(content.substring(member.startIdx).match(/\b(?:IS|AS)\b/i)![0], member.startIdx) +
        content.substring(member.startIdx).match(/\b(?:IS|AS)\b/i)![0].length;

      // Body ends at the start of the next member, or at the end of content
      let bodyEnd: number;
      if (i + 1 < members.length) {
        bodyEnd = members[i + 1].startIdx;
      } else {
        bodyEnd = content.length;
      }

      const memberBody = content.substring(headerEnd, bodyEnd).trim();
      const parameters = this.parseParameters(member.paramStr);

      const qualifiedKey = `${schema}.${pkgName}.${member.name}`;

      const unit: StoredPLSQLUnit = {
        schema,
        name: `${pkgName}.${member.name}`,
        type: member.type === 'FUNCTION' ? 'FUNCTION' : 'PROCEDURE',
        parameters,
        body: memberBody,
        sourceLines: memberBody.split('\n'),
        created: new Date(),
        status: 'VALID',
      };

      if (member.type === 'FUNCTION') {
        unit.returnType = member.returnType;
      }

      this.storedUnits.set(qualifiedKey, unit);
    }
  }

  /** Remove all stored members of a package */
  private removePackageMembers(schema: string, pkgName: string): void {
    const prefix = `${schema}.${pkgName}.`;
    const keysToDelete = Array.from(this.storedUnits.keys()).filter(k => k.startsWith(prefix));
    keysToDelete.forEach(key => this.storedUnits.delete(key));
  }

  /** DROP PACKAGE — drops spec, body, and all member procedures/functions */
  private dropPackage(_executor: OracleExecutor, sql: string): ResultSet {
    const match = sql.match(/^DROP\s+PACKAGE\s+(\w+)/i);
    if (!match) return emptyResult(ORACLE_ERRORS.ORA_00900);

    const name = match[1].toUpperCase();
    const schema = (_executor as any).context?.currentSchema || 'SYS';

    const specKey = `${schema}.${name}`;
    const bodyKey = `${schema}.${name}.__BODY__`;

    if (!this.storedUnits.has(specKey) && !this.storedUnits.has(bodyKey)) {
      return emptyResult(`ORA-04043: object ${name} does not exist`);
    }

    // Remove spec
    this.storedUnits.delete(specKey);
    // Remove body
    this.storedUnits.delete(bodyKey);
    // Remove all member units
    this.removePackageMembers(schema, name);

    return emptyResult('Package dropped.');
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

  // ═══════════════════════════════════════════════════════════════════
  // DBMS_RLS / DBMS_FGA / DBMS_MACADM dispatchers
  //
  // PL/SQL procedure calls are parsed with a permissive regex: the call
  // body is split on commas and each `name => value` pair is captured.
  // Positional arguments are tolerated by falling back on declaration
  // order, mirroring real PL/SQL invocation.
  // ═══════════════════════════════════════════════════════════════════

  /** Extract named arguments from a procedure call body like
   *  `object_schema=>'HR', policy_name=>'p1', statement_types=>'SELECT'`. */
  private parseNamedArgs(call: string): Record<string, string> {
    // Strip the leading `<PKG>.<PROC>(` and trailing `);`.
    const open = call.indexOf('(');
    const close = call.lastIndexOf(')');
    if (open < 0 || close < 0 || close <= open) return {};
    const body = call.slice(open + 1, close);
    const args: Record<string, string> = {};
    // Split on top-level commas only (so quoted commas survive).
    const parts: string[] = [];
    let depth = 0; let buf = ''; let inStr = false;
    for (let i = 0; i < body.length; i++) {
      const ch = body[i];
      if (ch === "'" && body[i - 1] !== '\\') inStr = !inStr;
      if (!inStr && ch === '(') depth++;
      if (!inStr && ch === ')') depth--;
      if (!inStr && ch === ',' && depth === 0) { parts.push(buf); buf = ''; continue; }
      buf += ch;
    }
    if (buf.trim()) parts.push(buf);
    for (const raw of parts) {
      const m = raw.match(/^\s*(\w+)\s*=>\s*([\s\S]+?)\s*$/);
      if (m) args[m[1].toUpperCase()] = OracleDatabase.unquote(m[2]);
    }
    return args;
  }

  private static unquote(value: string): string {
    const trimmed = value.trim();
    if ((trimmed.startsWith("'") && trimmed.endsWith("'")) || (trimmed.startsWith('"') && trimmed.endsWith('"'))) {
      return trimmed.slice(1, -1);
    }
    return trimmed;
  }

  private executeDbmsRlsCall(_executor: OracleExecutor, call: string): void {
    const upper = call.toUpperCase();
    const args = this.parseNamedArgs(call);
    const get = (key: string): string => args[key] ?? '';
    if (upper.includes('.ADD_POLICY')) {
      this.catalog.addRlsPolicy({
        objectSchema: get('OBJECT_SCHEMA'),
        objectName: get('OBJECT_NAME'),
        policyName: get('POLICY_NAME'),
        functionSchema: get('FUNCTION_SCHEMA'),
        policyFunction: get('POLICY_FUNCTION'),
        statementTypes: get('STATEMENT_TYPES'),
        policyType: get('POLICY_TYPE'),
        secRelevantCols: get('SEC_RELEVANT_COLS'),
      });
    } else if (upper.includes('.ADD_GROUPED_POLICY')) {
      this.catalog.addRlsPolicy({
        objectSchema: get('OBJECT_SCHEMA'),
        objectName: get('OBJECT_NAME'),
        policyName: get('POLICY_NAME'),
        policyGroup: get('POLICY_GROUP'),
        functionSchema: get('FUNCTION_SCHEMA'),
        policyFunction: get('POLICY_FUNCTION'),
        statementTypes: get('STATEMENT_TYPES'),
      });
    } else if (upper.includes('.ENABLE_POLICY')) {
      // Positional: (object_schema, object_name, policy_name, enable)
      const positional = this.parsePositionalArgs(call);
      const enable = positional[3]?.toUpperCase() !== 'FALSE';
      this.catalog.enableRlsPolicy(positional[0] ?? '', positional[1] ?? '', positional[2] ?? '', enable);
    } else if (upper.includes('.DISABLE_POLICY')) {
      const positional = this.parsePositionalArgs(call);
      this.catalog.enableRlsPolicy(positional[0] ?? '', positional[1] ?? '', positional[2] ?? '', false);
    } else if (upper.includes('.DROP_POLICY') || upper.includes('.DROP_GROUPED_POLICY')) {
      const positional = this.parsePositionalArgs(call);
      // DROP_GROUPED_POLICY signature: (object_schema, object_name, policy_group, policy_name)
      const policyName = upper.includes('GROUPED') ? positional[3] ?? '' : positional[2] ?? '';
      this.catalog.dropRlsPolicy(positional[0] ?? '', positional[1] ?? '', policyName);
    }
  }

  private executeDbmsFgaCall(_executor: OracleExecutor, call: string): void {
    const upper = call.toUpperCase();
    const args = this.parseNamedArgs(call);
    const get = (key: string): string => args[key] ?? '';
    if (upper.includes('.ADD_POLICY')) {
      const types = (get('STATEMENT_TYPES') || 'SELECT').toUpperCase();
      this.catalog.addFgaPolicy({
        objectSchema: get('OBJECT_SCHEMA').toUpperCase(),
        objectName: get('OBJECT_NAME').toUpperCase(),
        policyName: get('POLICY_NAME').toUpperCase(),
        policyOwner: get('OBJECT_SCHEMA').toUpperCase(),
        policyText: get('AUDIT_CONDITION') || '',
        enabled: true,
        select: types.includes('SELECT'),
        insert: types.includes('INSERT'),
        update: types.includes('UPDATE'),
        delete: types.includes('DELETE'),
      });
    } else if (upper.includes('.ENABLE_POLICY') || upper.includes('.DISABLE_POLICY')) {
      const positional = this.parsePositionalArgs(call);
      const enable = upper.includes('.ENABLE_POLICY');
      const policies = this.catalog.getFgaPolicies();
      const p = policies.find(x => x.objectSchema === (positional[0] ?? '').toUpperCase()
                                && x.objectName === (positional[1] ?? '').toUpperCase()
                                && x.policyName === (positional[2] ?? '').toUpperCase());
      if (p) (p as { enabled: boolean }).enabled = enable;
    } else if (upper.includes('.DROP_POLICY')) {
      const positional = this.parsePositionalArgs(call);
      this.catalog.dropFgaPolicy(positional[0] ?? '', positional[1] ?? '', positional[2] ?? '');
    }
  }

  private executeDbmsMacadmCall(call: string): void {
    const upper = call.toUpperCase();
    const args = this.parseNamedArgs(call);
    const get = (key: string): string => args[key] ?? '';
    if (upper.includes('.CREATE_REALM')) {
      this.catalog.createDvRealm(get('REALM_NAME'), get('DESCRIPTION'), Number(get('AUDIT_OPTIONS') || '1'));
    } else if (upper.includes('.DELETE_REALM')) {
      // Best-effort removal — there's no dedicated DV remove in the catalog.
      const all = this.catalog.getDvRealms() as { name: string }[];
      const idx = all.findIndex(r => r.name === get('REALM_NAME').toUpperCase());
      if (idx >= 0) (all as { name: string }[]).splice(idx, 1);
    } else if (upper.includes('.ADD_OBJECT_TO_REALM') || upper.includes('.ADD_AUTH_TO_REALM')) {
      if (upper.includes('AUTH')) {
        this.catalog.addDvRealmAuth(get('REALM_NAME'), get('GRANTEE'), '', get('AUTH_OPTIONS') || 'PARTICIPANT');
      }
    } else if (upper.includes('.CREATE_ROLE')) {
      this.catalog.createDvRole(get('ROLE'), '');
    } else if (upper.includes('.DELETE_ROLE')) {
      const all = this.catalog.getDvRoles() as { name: string }[];
      const idx = all.findIndex(r => r.name === get('ROLE').toUpperCase());
      if (idx >= 0) (all as { name: string }[]).splice(idx, 1);
    } else if (upper.includes('.CREATE_COMMAND_RULE')) {
      this.catalog.createDvCommandRule(get('COMMAND'), get('RULE_SET_NAME'), get('OBJECT_OWNER'), get('OBJECT_NAME'));
    } else if (upper.includes('.DELETE_COMMAND_RULE')) {
      const all = this.catalog.getDvCommandRules() as { command: string; objectOwner: string; objectName: string }[];
      const idx = all.findIndex(r => r.command === get('COMMAND').toUpperCase()
                                  && r.objectOwner === get('OBJECT_OWNER').toUpperCase()
                                  && r.objectName === get('OBJECT_NAME').toUpperCase());
      if (idx >= 0) (all as unknown[]).splice(idx, 1);
    } else if (upper.includes('.CREATE_FACTOR')) {
      this.catalog.createDvFactor({
        name: get('FACTOR_NAME'),
        description: get('DESCRIPTION'),
        factorType: get('FACTOR_TYPE_NAME'),
        validateExpr: get('VALIDATE_EXPR'),
        identifyBy: get('IDENTIFY_BY'),
        labeledBy: get('LABELED_BY'),
        evalOptions: get('EVAL_OPTIONS'),
        auditOptions: Number(get('AUDIT_OPTIONS') || '1'),
        failOptions: Number(get('FAIL_OPTIONS') || '1'),
      });
    } else if (upper.includes('.DELETE_FACTOR')) {
      const all = this.catalog.getDvFactors() as { name: string }[];
      const idx = all.findIndex(r => r.name === get('FACTOR_NAME').toUpperCase());
      if (idx >= 0) (all as { name: string }[]).splice(idx, 1);
    }
  }

  /** Parse positional arguments — used for procedures like
   *  DBMS_RLS.DROP_POLICY('HR','EMPLOYEES','pol'). */
  private parsePositionalArgs(call: string): string[] {
    const open = call.indexOf('(');
    const close = call.lastIndexOf(')');
    if (open < 0 || close < 0) return [];
    const body = call.slice(open + 1, close);
    if (body.includes('=>')) return []; // Named-arg call — use parseNamedArgs.
    return body.split(',').map(p => OracleDatabase.unquote(p));
  }
}
