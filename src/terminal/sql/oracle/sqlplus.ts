/**
 * Oracle SQL*Plus integration — re-exports from the real implementation.
 *
 * This file exists for backward compatibility with any existing imports.
 * The real SQL*Plus session is at src/database/oracle/commands/SQLPlusSession.ts.
 */

export { SQLPlusSession } from '@/database/oracle/commands/SQLPlusSession';
export type { SQLPlusResult, SQLPlusSettings } from '@/database/oracle/commands/SQLPlusSession';
