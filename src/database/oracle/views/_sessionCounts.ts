import type { OracleCatalog } from '../OracleCatalog';
import type { OracleRuntimeState } from './OracleRuntimeState';

export const BACKGROUND_SESSIONS: ReadonlyArray<string> = ['PMON', 'SMON', 'DBW0', 'LGWR'];

export interface SessionCounts {
  readonly current: number;
  readonly users: number;
  readonly highWater: number;
}

export function liveSessionCounts(
  catalog: OracleCatalog, runtime: OracleRuntimeState,
): SessionCounts {
  const tracked = catalog.getSecurityEngine()?.sessions.getAllSessions() ?? [];
  const visible = tracked.length > 0 ? tracked.length : runtime.sessions.size;
  const synthesised = tracked.some(s => s.type === 'BACKGROUND')
    ? 0 : BACKGROUND_SESSIONS.length;
  const current = visible + synthesised;
  const users = tracked.filter(s => s.type === 'USER').length;
  return {
    current,
    users,
    highWater: Math.max(current, runtime.counters.logonsCumulative),
  };
}
