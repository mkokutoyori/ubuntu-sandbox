import type { OracleDatabase } from '../OracleDatabase';
import type { OracleExecutor } from '../OracleExecutor';
import type { OracleNetCallContext, OracleNetCallHandler } from '@/network/oracle-net/OracleNetService';
import {
  OracleNetCallId, OracleNetCallStatus, decodeRequest, encodeResponse,
  type OracleNetLogonRequest, type OracleNetResult,
} from '@/network/oracle-net/wire/OracleNetCall';
import type { OsSecurityContext } from '../security/types';

interface ServerSession {
  readonly sid: number;
  readonly executor: OracleExecutor;
}

function errorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.length > 0 ? text : 'ORA-03113: end-of-file on communication channel';
}

export class OracleNetServerHandler implements OracleNetCallHandler {
  private readonly sessions = new Map<string, ServerSession>();

  constructor(private readonly resolveDatabase: () => OracleDatabase | null) {}

  handleCall(request: Uint8Array, context: OracleNetCallContext): Uint8Array | null {
    const decoded = decodeRequest(request);
    if (!decoded) {
      return encodeResponse({
        status: OracleNetCallStatus.Error,
        error: 'ORA-03137: malformed TTC packet from client rejected',
      });
    }
    const database = this.resolveDatabase();
    if (!database) {
      return encodeResponse({
        status: OracleNetCallStatus.Error,
        error: 'ORA-01034: ORACLE not available',
      });
    }
    const key = `${context.peer.remoteIp}:${context.peer.remotePort}`;

    if (decoded.call === OracleNetCallId.Logon) {
      return this.logon(database, key, decoded.body, context);
    }
    if (decoded.call === OracleNetCallId.Execute) {
      return this.execute(database, key, decoded.body.sql);
    }
    return this.logoff(database, key);
  }

  private logon(
    database: OracleDatabase,
    key: string,
    body: OracleNetLogonRequest,
    context: OracleNetCallContext,
  ): Uint8Array {
    this.closeSession(database, key);
    const osContext: OsSecurityContext = {
      osUser: body.identity?.osUser ?? context.userName ?? 'oracle',
      osGroup: body.identity?.osGroup ?? 'dba',
      isDbaGroup: false,
      hostname: body.identity?.hostname ?? context.hostName ?? context.peer.remoteIp,
      terminal: body.identity?.terminal ?? 'unknown',
      program: body.identity?.program ?? context.programName ?? 'sqlplus',
      clientIp: context.peer.remoteIp,
    };
    try {
      const session = body.asSysdba
        ? database.connectAsSysdba(osContext, {
            username: body.username || 'SYS', password: body.password, transport: 'tcp',
          })
        : database.connect(body.username, body.password, osContext, 'tcp', body.proxyUser);
      this.sessions.set(key, session);
      return encodeResponse({ status: OracleNetCallStatus.Ok, result: null });
    } catch (error) {
      return encodeResponse({ status: OracleNetCallStatus.Error, error: errorText(error) });
    }
  }

  private execute(database: OracleDatabase, key: string, sql: string): Uint8Array {
    const session = this.sessions.get(key);
    if (!session) {
      return encodeResponse({
        status: OracleNetCallStatus.Error,
        error: 'ORA-01012: not logged on',
      });
    }
    try {
      const result = database.executeSql(session.executor, sql);
      const payload: OracleNetResult = {
        columns: result.columns.map((column) => ({
          name: column.name,
          dataType: typeof column.dataType === 'string'
            ? column.dataType
            : (column.dataType as { name?: string } | undefined)?.name ?? 'VARCHAR2',
        })),
        rows: result.rows.map((row) => [...row] as unknown[]),
        affectedRows: result.affectedRows,
        isQuery: result.isQuery,
        message: result.message,
      };
      return encodeResponse({ status: OracleNetCallStatus.Ok, result: payload });
    } catch (error) {
      return encodeResponse({ status: OracleNetCallStatus.Error, error: errorText(error) });
    }
  }

  private logoff(database: OracleDatabase, key: string): Uint8Array {
    this.closeSession(database, key);
    return encodeResponse({ status: OracleNetCallStatus.Ok, result: null });
  }

  private closeSession(database: OracleDatabase, key: string): void {
    const session = this.sessions.get(key);
    if (!session) return;
    this.sessions.delete(key);
    try { database.disconnect(session.sid); } catch { /* already gone */ }
  }
}
