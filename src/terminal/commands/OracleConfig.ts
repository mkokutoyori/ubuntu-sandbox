/**
 * Oracle Configuration Constants
 *
 * Centralizes all Oracle-specific magic strings, paths, versions, and error
 * codes that were previously scattered across database.ts, OracleCommands.ts,
 * OracleCatalog.ts, and other files.
 */

// ─── Oracle Installation Paths ─────────────────────────────────────

export const ORACLE_CONFIG = {
  /** Oracle base directory */
  BASE: '/u01/app/oracle',
  /** Oracle home directory */
  HOME: '/u01/app/oracle/product/19c/dbhome_1',
  /** Oracle version string */
  VERSION: '19c',
  /** Default Oracle SID */
  SID: 'ORCL',
  /** Default listener port */
  PORT: 1521,
  /** Network admin directory (tnsnames.ora, listener.ora, sqlnet.ora) */
  get NETWORK_ADMIN(): string { return `${this.HOME}/network/admin`; },
  /** Binary directory */
  get BIN_DIR(): string { return `${this.HOME}/bin`; },
  /** DBS directory (init files) */
  get DBS_DIR(): string { return `${this.HOME}/dbs`; },
  /** Oracle data directory */
  get ORADATA(): string { return `${this.BASE}/oradata/${this.SID}`; },
  /** Diagnostic trace directory */
  get DIAG_TRACE(): string { return `${this.BASE}/diag/rdbms/orcl/${this.SID}/trace`; },
} as const;

// ─── Oracle Error Codes (ORA-XXXXX) ─────────────────────────────────

export const ORACLE_ERRORS = {
  /** SQL syntax error */
  ORA_00900: 'ORA-00900: invalid SQL statement',
  /** Table or view does not exist */
  ORA_00942: 'ORA-00942: table or view does not exist',
  /** Not logged on */
  ORA_01012: 'ORA-01012: not logged on',
  /** Invalid username/password */
  ORA_01017: 'ORA-01017: invalid username/password; logon denied',
  /** Insufficient privileges */
  ORA_01031: 'ORA-01031: insufficient privileges',
  /** Instance not available */
  ORA_01034: 'ORA-01034: ORACLE not available',
  /** Cannot start already-running instance */
  ORA_01081: 'ORA-01081: cannot start already-running ORACLE - shut it down first',
  /** Database must be mounted */
  ORA_01126: 'ORA-01126: database must be mounted and not open for this operation',
  /** NO_DATA_FOUND */
  ORA_01403: 'ORA-01403: no data found',
  /** TOO_MANY_ROWS */
  ORA_01422: 'ORA-01422: exact fetch returns more than requested number of rows',
  /** Divisor is equal to zero */
  ORA_01476: 'ORA-01476: divisor is equal to zero',
  /** Object does not exist */
  ORA_04043: 'ORA-04043: object does not exist',
} as const;

// ─── TNS Error Codes ────────────────────────────────────────────────

export const TNS_ERRORS = {
  /** No listener (secondary) */
  TNS_00511: 'TNS-00511: No listener',
  /** Listener already started */
  TNS_01106: 'TNS-01106: Listener using listener name LISTENER has already been started',
  /** Failed to resolve name */
  TNS_03505: 'TNS-03505: Failed to resolve name',
  /** No listener */
  TNS_12541: 'TNS-12541: TNS:no listener',
  /** Connection refused — service unknown */
  TNS_12514: 'TNS-12514: TNS:listener does not currently know of service requested in connect descriptor',
  /** Protocol adapter error */
  TNS_12560: 'TNS-12560: TNS:protocol adapter error',
} as const;

// ─── Oracle Output Templates ──────────────────────────────────────

export const ORACLE_BANNER = {
  SQLPLUS_HEADER: `SQL*Plus: Release ${ORACLE_CONFIG.VERSION}.0 - Production`,
  COPYRIGHT: 'Copyright (c) 1982, 2024, Oracle. All rights reserved.',
  LSNRCTL_HEADER: `LSNRCTL for Linux: Version ${ORACLE_CONFIG.VERSION}.0.0.0 - Production`,
  TNSPING_HEADER: `TNS Ping Utility for Linux: Version ${ORACLE_CONFIG.VERSION}.0.0.0 - Production`,
} as const;
