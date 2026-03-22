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

// ─── Oracle Error Codes ────────────────────────────────────────────

export const ORACLE_ERRORS = {
  /** Instance not available */
  ORA_01034: 'ORA-01034: ORACLE not available',
  /** Invalid username/password */
  ORA_01017: 'ORA-01017: invalid username/password; logon denied',
  /** Table or view does not exist */
  ORA_00942: 'ORA-00942: table or view does not exist',
  /** Insufficient privileges */
  ORA_01031: 'ORA-01031: insufficient privileges',
} as const;

export const TNS_ERRORS = {
  /** No listener */
  TNS_12541: 'TNS-12541: TNS:no listener',
  /** Protocol adapter error */
  TNS_12560: 'TNS-12560: TNS:protocol adapter error',
  /** Connection refused */
  TNS_12514: 'TNS-12514: TNS:listener does not currently know of service requested in connect descriptor',
} as const;

// ─── Oracle Output Templates ──────────────────────────────────────

export const ORACLE_BANNER = {
  SQLPLUS_HEADER: `SQL*Plus: Release ${ORACLE_CONFIG.VERSION}.0 - Production`,
  COPYRIGHT: 'Copyright (c) 1982, 2024, Oracle. All rights reserved.',
  LSNRCTL_HEADER: `LSNRCTL for Linux: Version ${ORACLE_CONFIG.VERSION}.0.0.0 - Production`,
  TNSPING_HEADER: `TNS Ping Utility for Linux: Version ${ORACLE_CONFIG.VERSION}.0.0.0 - Production`,
} as const;
