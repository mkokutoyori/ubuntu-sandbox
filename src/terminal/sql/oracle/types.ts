/**
 * Oracle SQL Types - Oracle-specific type extensions
 */

import { SQLDataType, SQLValue, SQLRow, SessionSettings } from '../generic/types';

// Oracle-specific data types
export type OracleDataType = SQLDataType
  | 'VARCHAR2' | 'NVARCHAR2' | 'CHAR' | 'NCHAR'
  | 'NUMBER' | 'BINARY_FLOAT' | 'BINARY_DOUBLE'
  | 'LONG' | 'RAW' | 'LONG RAW'
  | 'ROWID' | 'UROWID'
  | 'CLOB' | 'NCLOB' | 'BLOB' | 'BFILE'
  | 'DATE' | 'TIMESTAMP' | 'TIMESTAMP WITH TIME ZONE' | 'TIMESTAMP WITH LOCAL TIME ZONE'
  | 'INTERVAL YEAR TO MONTH' | 'INTERVAL DAY TO SECOND'
  | 'XMLTYPE' | 'SDO_GEOMETRY';

// Oracle session settings (SQL*Plus SET commands)
export interface OracleSessionSettings extends SessionSettings {
  arraySize: number;
  autoCommit: boolean;
  autoprint: boolean;
  autotrace: 'OFF' | 'ON' | 'TRACE' | 'EXPLAIN';
  colsep: string;
  define: string;
  echo: boolean;
  escape: string;
  feedback: boolean | number;
  heading: boolean;
  headsep: string;
  lineSize: number;
  long: number;
  longChunkSize: number;
  newPage: number;
  null: string;
  numFormat: string;
  numWidth: number;
  pageSize: number;
  pause: boolean | string;
  recsep: 'WRAPPED' | 'EACH' | 'OFF';
  serverOutput: boolean;
  serverOutputSize: number;
  showMode: boolean;
  sqlBlankLines: boolean;
  sqlCase: 'MIXED' | 'UPPER' | 'LOWER';
  sqlContinue: string;
  sqlNumber: boolean;
  sqlPlusCompatibility: string;
  sqlPreFix: string;
  sqlPrompt: string;
  sqlTerminator: string;
  suffix: string;
  tab: boolean;
  termOut: boolean;
  time: boolean;
  timing: boolean;
  trimOut: boolean;
  trimSpool: boolean;
  underline: string;
  verify: boolean;
  wrap: boolean;
}

// Default Oracle session settings
export function createDefaultOracleSettings(): OracleSessionSettings {
  return {
    arraySize: 15,
    autoCommit: false,
    autoprint: false,
    autotrace: 'OFF',
    colsep: ' ',
    define: '&',
    echo: false,
    escape: '\\',
    feedback: true,
    heading: true,
    headsep: '|',
    lineSize: 80,
    long: 80,
    longChunkSize: 80,
    newPage: 1,
    null: '',
    numFormat: '',
    numWidth: 10,
    pageSize: 14,
    pause: false,
    recsep: 'WRAPPED',
    serverOutput: false,
    serverOutputSize: 20000,
    showMode: false,
    sqlBlankLines: false,
    sqlCase: 'MIXED',
    sqlContinue: '> ',
    sqlNumber: true,
    sqlPlusCompatibility: '12.2.0',
    sqlPreFix: '#',
    sqlPrompt: 'SQL> ',
    sqlTerminator: ';',
    suffix: 'sql',
    tab: true,
    termOut: true,
    time: false,
    timing: false,
    trimOut: true,
    trimSpool: false,
    underline: '-',
    verify: true,
    wrap: true,
    echoCommands: false,
    nullDisplay: ''
  };
}

// Oracle system privilege types
export type OracleSystemPrivilege =
  | 'CREATE SESSION' | 'ALTER SESSION'
  | 'CREATE TABLE' | 'CREATE ANY TABLE' | 'ALTER ANY TABLE' | 'DROP ANY TABLE'
  | 'CREATE VIEW' | 'CREATE ANY VIEW' | 'DROP ANY VIEW'
  | 'CREATE SEQUENCE' | 'CREATE ANY SEQUENCE' | 'ALTER ANY SEQUENCE' | 'DROP ANY SEQUENCE'
  | 'CREATE PROCEDURE' | 'CREATE ANY PROCEDURE' | 'ALTER ANY PROCEDURE' | 'DROP ANY PROCEDURE'
  | 'EXECUTE ANY PROCEDURE'
  | 'CREATE TRIGGER' | 'CREATE ANY TRIGGER' | 'ALTER ANY TRIGGER' | 'DROP ANY TRIGGER'
  | 'CREATE USER' | 'ALTER USER' | 'DROP USER'
  | 'CREATE ROLE' | 'ALTER ANY ROLE' | 'DROP ANY ROLE' | 'GRANT ANY ROLE'
  | 'CREATE TABLESPACE' | 'ALTER TABLESPACE' | 'DROP TABLESPACE'
  | 'CREATE PUBLIC SYNONYM' | 'DROP PUBLIC SYNONYM'
  | 'CREATE DATABASE LINK' | 'CREATE PUBLIC DATABASE LINK' | 'DROP PUBLIC DATABASE LINK'
  | 'SELECT ANY TABLE' | 'INSERT ANY TABLE' | 'UPDATE ANY TABLE' | 'DELETE ANY TABLE'
  | 'ANALYZE ANY' | 'AUDIT ANY' | 'COMMENT ANY TABLE'
  | 'GRANT ANY PRIVILEGE' | 'GRANT ANY OBJECT PRIVILEGE'
  | 'FLASHBACK ANY TABLE' | 'FLASHBACK ARCHIVE ADMINISTER'
  | 'UNLIMITED TABLESPACE'
  | 'SYSDBA' | 'SYSOPER' | 'SYSASM' | 'SYSBACKUP' | 'SYSDG' | 'SYSKM';

// Oracle object privilege types
export type OracleObjectPrivilege =
  | 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE'
  | 'ALTER' | 'INDEX' | 'REFERENCES'
  | 'EXECUTE' | 'DEBUG' | 'FLASHBACK'
  | 'READ' | 'WRITE' | 'ON COMMIT REFRESH' | 'QUERY REWRITE'
  | 'ALL' | 'ALL PRIVILEGES';

// Oracle built-in roles
export type OracleBuiltinRole =
  | 'CONNECT' | 'RESOURCE' | 'DBA'
  | 'SELECT_CATALOG_ROLE' | 'EXECUTE_CATALOG_ROLE'
  | 'EXP_FULL_DATABASE' | 'IMP_FULL_DATABASE'
  | 'DELETE_CATALOG_ROLE'
  | 'SCHEDULER_ADMIN' | 'AQ_ADMINISTRATOR_ROLE'
  | 'HS_ADMIN_SELECT_ROLE' | 'HS_ADMIN_EXECUTE_ROLE';

// Oracle user profile settings
export interface OracleProfile {
  name: string;
  sessionsPerUser: number | 'UNLIMITED' | 'DEFAULT';
  cpuPerSession: number | 'UNLIMITED' | 'DEFAULT';
  cpuPerCall: number | 'UNLIMITED' | 'DEFAULT';
  connectTime: number | 'UNLIMITED' | 'DEFAULT';
  idleTime: number | 'UNLIMITED' | 'DEFAULT';
  logicalReadsPerSession: number | 'UNLIMITED' | 'DEFAULT';
  logicalReadsPerCall: number | 'UNLIMITED' | 'DEFAULT';
  privateGA: number | 'UNLIMITED' | 'DEFAULT';
  compositeLimit: number | 'UNLIMITED' | 'DEFAULT';
  failedLoginAttempts: number | 'UNLIMITED' | 'DEFAULT';
  passwordLifeTime: number | 'UNLIMITED' | 'DEFAULT';
  passwordReuseTime: number | 'UNLIMITED' | 'DEFAULT';
  passwordReuseMax: number | 'UNLIMITED' | 'DEFAULT';
  passwordLockTime: number | 'UNLIMITED' | 'DEFAULT';
  passwordGraceTime: number | 'UNLIMITED' | 'DEFAULT';
  passwordVerifyFunction: string | null;
}

// Oracle user extended properties
export interface OracleUser {
  username: string;
  password?: string;
  defaultTablespace: string;
  temporaryTablespace: string;
  profile: string;
  accountStatus: 'OPEN' | 'LOCKED' | 'EXPIRED' | 'EXPIRED & LOCKED';
  lockDate?: Date;
  expiryDate?: Date;
  createdDate: Date;
  lastLogin?: Date;
  quotas: Map<string, number | 'UNLIMITED'>;
  grantedRoles: string[];
  grantedPrivileges: string[];
}

// Oracle tablespace
export interface OracleTablespace {
  name: string;
  contents: 'PERMANENT' | 'TEMPORARY' | 'UNDO';
  status: 'ONLINE' | 'OFFLINE' | 'READ ONLY';
  blockSize: number;
  initialExtent: number;
  nextExtent: number;
  minExtents: number;
  maxExtents: number | 'UNLIMITED';
  pctIncrease: number;
  autoExtend: boolean;
  maxSize: number | 'UNLIMITED';
  files: string[];
}

// Oracle database instance info
export interface OracleDatabaseInfo {
  name: string;
  dbid: number;
  created: Date;
  openMode: 'READ WRITE' | 'READ ONLY' | 'MOUNTED';
  logMode: 'ARCHIVELOG' | 'NOARCHIVELOG';
  forceLogging: boolean;
  platformName: string;
  version: string;
  versionFull: string;
  banner: string;
  edition: 'Enterprise Edition' | 'Standard Edition' | 'Express Edition' | 'Personal Edition';
  characterSet: string;
  nationalCharacterSet: string;
}

// Oracle V$ view types
export interface OracleVSession {
  sid: number;
  serial: number;
  username: string;
  status: 'ACTIVE' | 'INACTIVE' | 'KILLED' | 'CACHED' | 'SNIPED';
  schemaName: string;
  osUser: string;
  machine: string;
  terminal: string;
  program: string;
  type: string;
  sqlId: string | null;
  sqlChildNumber: number | null;
  sqlExecStart: Date | null;
  state: string;
  waitClass: string | null;
  waitTime: number;
  secondsInWait: number;
  event: string;
  logonTime: Date;
  lastCallEt: number;
}

export interface OracleVProcess {
  addr: string;
  pid: number;
  spid: string;
  username: string;
  serial: number;
  terminal: string;
  program: string;
  background: boolean;
  pga_used_mem: number;
  pga_alloc_mem: number;
  pga_max_mem: number;
}

export interface OracleVSysstat {
  statistic: number;
  name: string;
  class: number;
  value: number;
}

// Oracle DBMS_OUTPUT buffer
export interface OracleDbmsOutput {
  enabled: boolean;
  bufferSize: number;
  buffer: string[];
}

// Oracle PL/SQL block result
export interface OraclePLSQLResult {
  success: boolean;
  output: string[];
  error?: {
    code: string;
    message: string;
    line?: number;
    position?: number;
  };
  affectedRows?: number;
}

// Oracle EXPLAIN PLAN output
export interface OracleExplainPlan {
  planId: number;
  timestamp: Date;
  operation: string;
  options?: string;
  objectOwner?: string;
  objectName?: string;
  objectType?: string;
  optimizer?: string;
  id: number;
  parentId?: number;
  depth: number;
  position: number;
  cost?: number;
  cardinality?: number;
  bytes?: number;
  cpuCost?: number;
  ioCost?: number;
}

// Oracle date/time formats
export const ORACLE_DATE_FORMATS: Record<string, string> = {
  'YYYY': '%Y',
  'YY': '%y',
  'MM': '%m',
  'MON': '%b',
  'MONTH': '%B',
  'DD': '%d',
  'DY': '%a',
  'DAY': '%A',
  'HH': '%H',
  'HH12': '%I',
  'HH24': '%H',
  'MI': '%M',
  'SS': '%S',
  'SSSSS': '%S',
  'AM': '%p',
  'PM': '%p',
  'A.M.': '%p',
  'P.M.': '%p',
};

// Oracle NLS parameters
export interface OracleNLSParameters {
  NLS_CALENDAR: string;
  NLS_COMP: string;
  NLS_CURRENCY: string;
  NLS_DATE_FORMAT: string;
  NLS_DATE_LANGUAGE: string;
  NLS_DUAL_CURRENCY: string;
  NLS_ISO_CURRENCY: string;
  NLS_LANGUAGE: string;
  NLS_LENGTH_SEMANTICS: string;
  NLS_NCHAR_CONV_EXCP: string;
  NLS_NUMERIC_CHARACTERS: string;
  NLS_SORT: string;
  NLS_TERRITORY: string;
  NLS_TIMESTAMP_FORMAT: string;
  NLS_TIMESTAMP_TZ_FORMAT: string;
  NLS_TIME_FORMAT: string;
  NLS_TIME_TZ_FORMAT: string;
}

export function createDefaultNLSParameters(): OracleNLSParameters {
  return {
    NLS_CALENDAR: 'GREGORIAN',
    NLS_COMP: 'BINARY',
    NLS_CURRENCY: '$',
    NLS_DATE_FORMAT: 'DD-MON-RR',
    NLS_DATE_LANGUAGE: 'AMERICAN',
    NLS_DUAL_CURRENCY: '$',
    NLS_ISO_CURRENCY: 'AMERICA',
    NLS_LANGUAGE: 'AMERICAN',
    NLS_LENGTH_SEMANTICS: 'BYTE',
    NLS_NCHAR_CONV_EXCP: 'FALSE',
    NLS_NUMERIC_CHARACTERS: '.,',
    NLS_SORT: 'BINARY',
    NLS_TERRITORY: 'AMERICA',
    NLS_TIMESTAMP_FORMAT: 'DD-MON-RR HH.MI.SSXFF AM',
    NLS_TIMESTAMP_TZ_FORMAT: 'DD-MON-RR HH.MI.SSXFF AM TZR',
    NLS_TIME_FORMAT: 'HH.MI.SSXFF AM',
    NLS_TIME_TZ_FORMAT: 'HH.MI.SSXFF AM TZR'
  };
}

// Format SQL*Plus column output
export interface ColumnFormat {
  name: string;
  format?: string;
  heading?: string;
  justify?: 'LEFT' | 'CENTER' | 'RIGHT';
  wordWrap?: boolean;
  truncate?: boolean;
  null?: string;
  print?: boolean;
  newValue?: boolean;
  oldValue?: boolean;
}

// SQL*Plus BREAK settings
export interface BreakSettings {
  column?: string;
  row?: boolean;
  report?: boolean;
  skipLines?: number;
  skipPages?: number;
  nodup?: boolean;
}

// SQL*Plus COMPUTE settings
export interface ComputeSettings {
  function: 'AVG' | 'COUNT' | 'MAX' | 'MIN' | 'NUM' | 'STD' | 'SUM' | 'VAR';
  label?: string;
  of: string;
  on: string | 'REPORT';
}

// Spool file settings
export interface SpoolSettings {
  file: string | null;
  append: boolean;
  create: boolean;
  replace: boolean;
}
