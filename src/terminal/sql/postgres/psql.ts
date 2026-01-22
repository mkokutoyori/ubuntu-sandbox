/**
 * STUB FILE - will be rebuilt with TDD
 * PostgreSQL psql implementation
 */

import { SQLSession } from '../../commands/database';

export interface PsqlResult {
  output: string;
  isError: boolean;
  affectedRows?: number;
}

export function executePsql(
  sql: string,
  session: SQLSession
): PsqlResult {
  // Stub implementation
  if (sql.trim() === '\\q') {
    return {
      output: '',
      isError: false
    };
  }

  return {
    output: `STUB: psql execution result for: ${sql}`,
    isError: false
  };
}

export function getPsqlPrompt(session: SQLSession): string {
  const dbName = session.currentDatabase || 'postgres';
  if (!session.isConnected) {
    return `${dbName}=# `;
  }
  return `${dbName}=# `;
}
