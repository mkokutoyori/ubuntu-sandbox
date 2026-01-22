/**
 * STUB FILE - will be rebuilt with TDD
 * Database command handlers (Oracle SQL*Plus and PostgreSQL psql)
 */

export interface SQLSession {
  id: string;
  type: 'sqlplus' | 'psql';
  deviceId: string;
  isConnected: boolean;
  connectionString?: string;
  currentDatabase?: string;
}

const sqlSessions: Map<string, SQLSession> = new Map();

// Oracle SQL*Plus functions
export function createOrGetSQLPlusSession(deviceId: string): SQLSession {
  const key = `sqlplus-${deviceId}`;
  if (!sqlSessions.has(key)) {
    sqlSessions.set(key, {
      id: key,
      type: 'sqlplus',
      deviceId,
      isConnected: false
    });
  }
  return sqlSessions.get(key)!;
}

export function deleteSQLPlusSession(deviceId: string): void {
  const key = `sqlplus-${deviceId}`;
  sqlSessions.delete(key);
}

// PostgreSQL psql functions
export function createOrGetPsqlSession(deviceId: string): SQLSession {
  const key = `psql-${deviceId}`;
  if (!sqlSessions.has(key)) {
    sqlSessions.set(key, {
      id: key,
      type: 'psql',
      deviceId,
      isConnected: false
    });
  }
  return sqlSessions.get(key)!;
}

export function deletePsqlSession(deviceId: string): void {
  const key = `psql-${deviceId}`;
  sqlSessions.delete(key);
}
