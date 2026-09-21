import type { ResultSet } from '../engine/executor/ResultSet';
import type { Statement } from '../engine/parser/ASTNode';
import type { OracleDatabase } from './OracleDatabase';
import type { OracleExecutor } from './OracleExecutor';
import type { OracleNetSession } from '@/network/oracle-net/OracleNetClient';
import type { OsSecurityContext } from './security/types';
import {
  OracleNetCallId, OracleNetCallStatus, decodeResponse, encodeRequest,
  type OracleNetRequest, type OracleNetResponse,
} from '@/network/oracle-net/wire/OracleNetCall';

export interface DbLinkSession {
  executeSql(sql: string): ResultSet;
  executeStatement(statement: Statement): ResultSet;
  close(): void;
}

export class LocalDbLinkSession implements DbLinkSession {
  private readonly sid: number;
  private readonly executor: OracleExecutor;

  constructor(
    private readonly remote: OracleDatabase,
    username: string,
    password: string,
    osContext: OsSecurityContext,
  ) {
    const opened = this.remote.connect(username, password, osContext, 'tcp');
    this.sid = opened.sid;
    this.executor = opened.executor;
  }

  executeSql(sql: string): ResultSet {
    return this.remote.executeSql(this.executor, sql);
  }

  executeStatement(statement: Statement): ResultSet {
    return this.executor.execute(statement);
  }

  close(): void {
    this.remote.disconnect(this.sid);
  }
}

export class WireDbLinkSession implements DbLinkSession {
  constructor(private readonly session: OracleNetSession) {}

  static open(
    session: OracleNetSession,
    username: string,
    password: string,
    osContext: OsSecurityContext,
  ): WireDbLinkSession {
    const link = new WireDbLinkSession(session);
    const answer = link.call({
      call: OracleNetCallId.Logon,
      body: {
        username,
        password,
        asSysdba: false,
        identity: {
          osUser: osContext.osUser,
          osGroup: osContext.osGroup,
          hostname: osContext.hostname,
          terminal: osContext.terminal,
          program: osContext.program,
        },
      },
    });
    if (answer.status === OracleNetCallStatus.Error) {
      session.close();
      throw new Error(answer.error);
    }
    return link;
  }

  executeSql(sql: string): ResultSet {
    return this.resultOf(this.call({ call: OracleNetCallId.Execute, body: { sql } }));
  }

  executeStatement(statement: Statement): ResultSet {
    return this.resultOf(this.call({
      call: OracleNetCallId.ExecuteStatement,
      body: { statement: statement as unknown },
    }));
  }

  close(): void {
    try { this.call({ call: OracleNetCallId.Logoff, body: {} }); } catch { /* already gone */ }
    this.session.close();
  }

  private call(request: OracleNetRequest): OracleNetResponse {
    if (!this.session.isOpen()) {
      return {
        status: OracleNetCallStatus.Error,
        error: 'ORA-03113: end-of-file on communication channel',
      };
    }
    const answer = this.session.call(encodeRequest(request));
    const decoded = answer ? decodeResponse(answer) : null;
    return decoded ?? {
      status: OracleNetCallStatus.Error,
      error: 'ORA-03113: end-of-file on communication channel',
    };
  }

  private resultOf(answer: OracleNetResponse): ResultSet {
    if (answer.status === OracleNetCallStatus.Error) {
      throw new Error(answer.error);
    }
    const result = answer.result;
    if (!result) {
      throw new Error('ORA-03113: end-of-file on communication channel');
    }
    return {
      columns: result.columns.map((column) => ({
        name: column.name, dataType: column.dataType,
      })) as unknown as ResultSet['columns'],
      rows: result.rows as unknown as ResultSet['rows'],
      affectedRows: result.affectedRows,
      isQuery: result.isQuery,
      message: result.message,
    };
  }
}
