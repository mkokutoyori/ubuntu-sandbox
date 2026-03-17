/**
 * Common database configuration interface.
 * Each dialect provides its own implementation with additional parameters.
 */
export interface DatabaseConfig {
  /** Database name / SID */
  name: string;
  /** SQL dialect */
  dialect: string;
  /** Maximum number of sessions */
  maxSessions: number;
  /** Whether the database is in read-only mode */
  readOnly: boolean;
}

export interface OracleDatabaseConfig extends DatabaseConfig {
  dialect: 'oracle';
  sid: string;
  serviceName: string;
  dbBlockSize: number;
  sgaTarget: string;
  pgaAggregateTarget: string;
  processes: number;
  openCursors: number;
  undoManagement: 'AUTO' | 'MANUAL';
  undoTablespace: string;
  compatibleVersion: string;
  auditTrail: 'NONE' | 'DB' | 'OS' | 'XML';
  archiveLogMode: boolean;
}

export function defaultOracleConfig(sid: string = 'ORCL'): OracleDatabaseConfig {
  return {
    name: sid,
    dialect: 'oracle',
    sid,
    serviceName: sid,
    maxSessions: 472,
    readOnly: false,
    dbBlockSize: 8192,
    sgaTarget: '512M',
    pgaAggregateTarget: '128M',
    processes: 300,
    openCursors: 300,
    undoManagement: 'AUTO',
    undoTablespace: 'UNDOTBS1',
    compatibleVersion: '19.0.0',
    auditTrail: 'DB',
    archiveLogMode: false,
  };
}
