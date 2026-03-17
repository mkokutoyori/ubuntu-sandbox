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
      throw new Error('ORA-01034: ORACLE not available');
    }

    const authResult = this.catalog.authenticate(username, password);
    if (!authResult) {
      throw new Error('ORA-01017: invalid username/password; logon denied');
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
   */
  executeSql(executor: OracleExecutor, sql: string): ResultSet {
    const trimmed = sql.trim();
    if (!trimmed) return emptyResult();

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
