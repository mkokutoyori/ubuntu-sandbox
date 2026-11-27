import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import type { HostCapableDevice } from '@/network';
import { getOracleDatabase } from '@/terminal/commands/database';
import { resolveOracleConnectTarget } from '@/terminal/commands/oracleNet';
import { LocalDbLinkSession, WireDbLinkSession, type DbLinkSession } from '@/database/oracle/DbLinkSession';
import { DEFAULT_OS_CONTEXT } from '@/database/oracle/security/types';
import type { SqlConnector, SqlSession } from '@/network/devices/linux/freeradius/sql/SqlPort';

function textOf(cell: unknown): string | null {
  if (cell === null || cell === undefined) return null;
  return String(cell);
}

class OracleSqlSession implements SqlSession {
  constructor(private readonly link: DbLinkSession) {}

  execute(statement: string): ReturnType<SqlSession['execute']> {
    try {
      const result = this.link.executeSql(statement);
      return {
        rows: result.rows.map((row) => row.map(textOf)),
        affected: result.affectedRows ?? 0,
        isQuery: result.isQuery,
        columns: result.columns.map((column) => column.name),
      };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }

  close(): void { this.link.close(); }
}

export function oracleSqlConnector(deviceId: string): SqlConnector {
  return ({ connectString, login, password }) => {
    const local = EquipmentRegistry.getInstance().getById(deviceId);
    if (!local) return { error: 'ORA-12154: TNS:could not resolve the connect identifier specified' };
    const resolved = resolveOracleConnectTarget(local as HostCapableDevice, connectString, getOracleDatabase);
    if (resolved.ok === false) return { error: resolved.error };
    try {
      const link = resolved.session
        ? WireDbLinkSession.open(resolved.session, login, password, DEFAULT_OS_CONTEXT)
        : new LocalDbLinkSession(resolved.db, login, password, DEFAULT_OS_CONTEXT);
      return new OracleSqlSession(link);
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  };
}
