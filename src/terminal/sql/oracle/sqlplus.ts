/**
 * STUB FILE - will be rebuilt with TDD
 * Oracle SQL*Plus implementation
 */

import { SQLSession } from '../../commands/database';

export interface SQLPlusResult {
  output: string;
  isError: boolean;
  affectedRows?: number;
}

export function executeSQLPlus(
  sql: string,
  session: SQLSession
): SQLPlusResult {
  // Stub implementation
  if (sql.trim().toLowerCase() === 'exit' || sql.trim().toLowerCase() === 'quit') {
    return {
      output: 'Disconnected from Oracle Database',
      isError: false
    };
  }

  return {
    output: `STUB: SQL*Plus execution result for: ${sql}`,
    isError: false
  };
}

export function getSQLPlusPrompt(session: SQLSession): string {
  if (!session.isConnected) {
    return 'SQL> ';
  }
  return `SQL> `;
}
