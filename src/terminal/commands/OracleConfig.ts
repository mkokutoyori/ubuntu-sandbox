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
  // ── Syntax & Parse Errors ──
  /** Unique constraint violated */
  ORA_00001: 'ORA-00001: unique constraint (%s) violated',
  /** Invalid SQL statement */
  ORA_00900: 'ORA-00900: invalid SQL statement',
  /** Invalid identifier */
  ORA_00904: 'ORA-00904: "%s": invalid identifier',
  /** Missing right parenthesis */
  ORA_00907: 'ORA-00907: missing right parenthesis',
  /** Invalid character */
  ORA_00911: 'ORA-00911: invalid character',
  /** Column ambiguously defined */
  ORA_00918: 'ORA-00918: column ambiguously defined',
  /** FROM keyword not found where expected */
  ORA_00923: 'ORA-00923: FROM keyword not found where expected',
  /** Inconsistent datatypes */
  ORA_00932: 'ORA-00932: inconsistent datatypes: expected %s got %s',
  /** SQL command not properly ended */
  ORA_00933: 'ORA-00933: SQL command not properly ended',
  /** Missing expression */
  ORA_00936: 'ORA-00936: missing expression',
  /** Not enough values */
  ORA_00947: 'ORA-00947: not enough values',
  /** Table or view does not exist */
  ORA_00942: 'ORA-00942: table or view does not exist',
  /** Invalid number of arguments */
  ORA_00909: 'ORA-00909: invalid number of arguments',
  /** Not a single-group group function */
  ORA_00937: 'ORA-00937: not a single-group group function',
  /** Not a GROUP BY expression */
  ORA_00979: 'ORA-00979: not a GROUP BY expression',

  // ── Authentication & Session Errors ──
  /** Not logged on */
  ORA_01012: 'ORA-01012: not logged on',
  /** Invalid username/password */
  ORA_01017: 'ORA-01017: invalid username/password; logon denied',
  /** Insufficient privileges */
  ORA_01031: 'ORA-01031: insufficient privileges',
  /** Instance not available */
  ORA_01034: 'ORA-01034: ORACLE not available',
  /** ORACLE only available to users with RESTRICTED SESSION privilege */
  ORA_01035: 'ORA-01035: ORACLE only available to users with RESTRICTED SESSION privilege',
  /** Cannot start already-running instance */
  ORA_01081: 'ORA-01081: cannot start already-running ORACLE - shut it down first',
  /** Database must be mounted */
  ORA_01126: 'ORA-01126: database must be mounted and not open for this operation',

  // ── Data Errors ──
  /** Cannot insert NULL */
  ORA_01400: 'ORA-01400: cannot insert NULL into ("%s"."%s"."%s")',
  /** NO_DATA_FOUND */
  ORA_01403: 'ORA-01403: no data found',
  /** Cannot update to NULL */
  ORA_01407: 'ORA-01407: cannot update ("%s"."%s"."%s") to NULL',
  /** TOO_MANY_ROWS */
  ORA_01422: 'ORA-01422: exact fetch returns more than requested number of rows',
  /** Value larger than specified precision */
  ORA_01438: 'ORA-01438: value larger than specified precision allowed for this column',
  /** Divisor is equal to zero */
  ORA_01476: 'ORA-01476: divisor is equal to zero',
  /** Snapshot too old */
  ORA_01555: 'ORA-01555: snapshot too old: rollback segment number %s with name "%s" too small',
  /** Unable to extend temp segment */
  ORA_01652: 'ORA-01652: unable to extend temp segment by %s in tablespace %s',
  /** Invalid number */
  ORA_01722: 'ORA-01722: invalid number',
  /** Not a valid month */
  ORA_01843: 'ORA-01843: not a valid month',
  /** Date format picture ends before input string */
  ORA_01830: 'ORA-01830: date format picture ends before converting entire input string',

  // ── Constraint Errors ──
  /** Integrity constraint violated - parent key not found */
  ORA_02291: 'ORA-02291: integrity constraint (%s) violated - parent key not found',
  /** Integrity constraint violated - child record found */
  ORA_02292: 'ORA-02292: integrity constraint (%s) violated - child record found',
  /** Name already used by an existing constraint */
  ORA_02264: 'ORA-02264: name already used by an existing constraint',
  /** Cannot drop parent key — child records exist */
  ORA_02449: 'ORA-02449: unique/primary keys in table referenced by foreign keys',

  // ── Object Errors ──
  /** Table already exists */
  ORA_00955: 'ORA-00955: name is already used by an existing object',
  /** Object does not exist */
  ORA_04043: 'ORA-04043: object %s does not exist',
  /** Sequence does not exist */
  ORA_02289: 'ORA-02289: sequence does not exist',
  /** Column already exists in table */
  ORA_01430: 'ORA-01430: column being added already exists in table',
  /** Cannot drop column — table has only one column */
  ORA_12983: 'ORA-12983: cannot drop all columns in a table',

  // ── SGA & Resource Errors ──
  /** Unable to allocate shared memory */
  ORA_04031: 'ORA-04031: unable to allocate %s bytes of shared memory ("%s","%s","%s")',

  // ── PL/SQL Errors ──
  /** PL/SQL numeric or value error */
  ORA_06502: 'ORA-06502: PL/SQL: numeric or value error%s',
  /** PL/SQL backtrace */
  ORA_06512: 'ORA-06512: at "%s", line %s',
  /** PL/SQL: compilation error */
  ORA_06550: 'ORA-06550: line %s, column %s:\nPLS-%s: %s',

  // ── TNS / Connection Errors ──
  /** TNS: could not resolve the connect identifier */
  ORA_12154: 'ORA-12154: TNS:could not resolve the connect identifier specified',
  /** TNS: connect timeout */
  ORA_12170: 'ORA-12170: TNS:Connect timeout occurred',
  /** TNS: connect failed */
  ORA_12545: 'ORA-12545: Connect failed because target host or object does not exist',

  // ── Account Errors ──
  /** Account is locked */
  ORA_28000: 'ORA-28000: the account is locked',
  /** Password has expired */
  ORA_28001: 'ORA-28001: the password has expired',

  // ── DDL Errors ──
  /** Cannot truncate table with FK references */
  ORA_02266: 'ORA-02266: unique/primary keys in table referenced by enabled foreign keys',
  /** Tablespace does not exist */
  ORA_00959: 'ORA-00959: tablespace \'%s\' does not exist',
  /** Tablespace already exists */
  ORA_01543: 'ORA-01543: tablespace \'%s\' already exists',
  /** User does not exist */
  ORA_01918: 'ORA-01918: user \'%s\' does not exist',
  /** User already exists */
  ORA_01920: 'ORA-01920: user name \'%s\' conflicts with another user or role name',
  /** Role already exists */
  ORA_01921: 'ORA-01921: role name \'%s\' conflicts with another user or role name',
  /** Role does not exist */
  ORA_01919: 'ORA-01919: role \'%s\' does not exist',

  // ── Miscellaneous ──
  /** Deadlock detected */
  ORA_00060: 'ORA-00060: deadlock detected while waiting for resource',
  /** Maximum number of processes exceeded */
  ORA_00020: 'ORA-00020: maximum number of processes (%s) exceeded',
  /** Internal error */
  ORA_00600: 'ORA-00600: internal error code, arguments: [%s], [%s], [%s]',
  /** Recursive SQL during typing */
  ORA_00604: 'ORA-00604: error occurred at recursive SQL level %s',
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
