/**
 * Oracle Security Module - SQL-based implementation
 *
 * Uses actual SQL tables to store security data, just like a real Oracle database.
 * All security data is queryable via standard SQL SELECT statements.
 *
 * Core tables:
 * - SYS.USER$ - User accounts
 * - SYS.PROFILE$ - Security profiles
 * - SYS.ROLE$ - Role definitions
 * - SYS.SYSAUTH$ - System privileges granted
 * - SYS.OBJAUTH$ - Object privileges granted
 * - SYS.AUDIT$ - Audit trail
 */

import { SQLEngine } from '../generic/engine';
import { SQLResult, createSuccessResult, createErrorResult } from '../generic/types';
import { parseSQL } from '../generic/parser';

// ============================================================================
// Password Hashing
// ============================================================================

export function generateSalt(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let salt = '';
  for (let i = 0; i < 20; i++) {
    salt += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return salt;
}

export function hashPassword(password: string, salt?: string): string {
  const actualSalt = salt || generateSalt();
  let hash = 0;
  const combined = actualSalt + password;

  for (let i = 0; i < combined.length; i++) {
    const char = combined.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }

  const hashHex = Math.abs(hash).toString(16).toUpperCase().padStart(16, '0');
  return `S:${hashHex}${actualSalt}`;
}

export function verifyPassword(password: string, storedHash: string): boolean {
  if (!storedHash || !storedHash.startsWith('S:')) {
    return password === storedHash;
  }
  const salt = storedHash.slice(-20);
  const expectedHash = hashPassword(password, salt);
  return expectedHash === storedHash;
}

// ============================================================================
// SQL Schema Definitions for Security Tables
// ============================================================================

const SECURITY_SCHEMA_SQL = `
-- User accounts (maps to DBA_USERS view)
CREATE TABLE SYS.USER$ (
  USER_ID INTEGER PRIMARY KEY,
  USERNAME VARCHAR(128) NOT NULL UNIQUE,
  PASSWORD VARCHAR(256),
  ACCOUNT_STATUS VARCHAR(32) DEFAULT 'OPEN',
  LOCK_DATE TIMESTAMP,
  EXPIRY_DATE TIMESTAMP,
  DEFAULT_TABLESPACE VARCHAR(128) DEFAULT 'USERS',
  TEMPORARY_TABLESPACE VARCHAR(128) DEFAULT 'TEMP',
  PROFILE VARCHAR(128) DEFAULT 'DEFAULT',
  CREATED TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  LAST_LOGIN TIMESTAMP,
  FAILED_LOGIN_ATTEMPTS INTEGER DEFAULT 0
);

-- Security profiles (maps to DBA_PROFILES view)
CREATE TABLE SYS.PROFILE$ (
  PROFILE VARCHAR(128) NOT NULL,
  RESOURCE_NAME VARCHAR(128) NOT NULL,
  RESOURCE_TYPE VARCHAR(32),
  LIMIT VARCHAR(128),
  PRIMARY KEY (PROFILE, RESOURCE_NAME)
);

-- Roles (maps to DBA_ROLES view)
CREATE TABLE SYS.ROLE$ (
  ROLE_ID INTEGER PRIMARY KEY,
  ROLE VARCHAR(128) NOT NULL UNIQUE,
  PASSWORD_REQUIRED VARCHAR(1) DEFAULT 'N',
  PASSWORD VARCHAR(256),
  AUTHENTICATION_TYPE VARCHAR(32) DEFAULT 'NONE',
  CREATED_BY VARCHAR(128),
  CREATED TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- System privileges granted (maps to DBA_SYS_PRIVS view)
CREATE TABLE SYS.SYSAUTH$ (
  GRANTEE VARCHAR(128) NOT NULL,
  PRIVILEGE VARCHAR(128) NOT NULL,
  ADMIN_OPTION VARCHAR(3) DEFAULT 'NO',
  GRANTED_BY VARCHAR(128),
  GRANT_DATE TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (GRANTEE, PRIVILEGE)
);

-- Role privileges granted (maps to DBA_ROLE_PRIVS view)
CREATE TABLE SYS.ROLEAUTH$ (
  GRANTEE VARCHAR(128) NOT NULL,
  GRANTED_ROLE VARCHAR(128) NOT NULL,
  ADMIN_OPTION VARCHAR(3) DEFAULT 'NO',
  DEFAULT_ROLE VARCHAR(3) DEFAULT 'YES',
  GRANTED_BY VARCHAR(128),
  GRANT_DATE TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (GRANTEE, GRANTED_ROLE)
);

-- Object privileges granted (maps to DBA_TAB_PRIVS view)
CREATE TABLE SYS.OBJAUTH$ (
  GRANTEE VARCHAR(128) NOT NULL,
  OWNER VARCHAR(128) NOT NULL,
  TABLE_NAME VARCHAR(128) NOT NULL,
  PRIVILEGE VARCHAR(128) NOT NULL,
  GRANTABLE VARCHAR(3) DEFAULT 'NO',
  GRANTOR VARCHAR(128),
  GRANT_DATE TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (GRANTEE, OWNER, TABLE_NAME, PRIVILEGE)
);

-- Tablespace quotas (maps to DBA_TS_QUOTAS view)
CREATE TABLE SYS.TSQUOTA$ (
  USERNAME VARCHAR(128) NOT NULL,
  TABLESPACE_NAME VARCHAR(128) NOT NULL,
  MAX_BYTES INTEGER DEFAULT -1,
  PRIMARY KEY (USERNAME, TABLESPACE_NAME)
);

-- Audit trail (maps to DBA_AUDIT_TRAIL view)
CREATE TABLE SYS.AUD$ (
  AUDIT_ID INTEGER PRIMARY KEY,
  SESSION_ID INTEGER,
  TIMESTAMP TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  USERNAME VARCHAR(128),
  OS_USERNAME VARCHAR(255),
  TERMINAL VARCHAR(255),
  ACTION_NAME VARCHAR(128),
  OBJECT_SCHEMA VARCHAR(128),
  OBJECT_NAME VARCHAR(128),
  OBJECT_TYPE VARCHAR(32),
  SQL_TEXT VARCHAR(4000),
  RETURN_CODE INTEGER DEFAULT 0,
  CLIENT_ID VARCHAR(255),
  COMMENT_TEXT VARCHAR(4000)
);

-- Audit policies (maps to DBA_STMT_AUDIT_OPTS view)
CREATE TABLE SYS.AUDIT$ (
  USER_NAME VARCHAR(128),
  AUDIT_OPTION VARCHAR(128) NOT NULL,
  SUCCESS VARCHAR(10),
  FAILURE VARCHAR(10),
  PRIMARY KEY (AUDIT_OPTION)
);

-- Password history (for password reuse prevention)
CREATE TABLE SYS.PASSWORD_HISTORY$ (
  USER_ID INTEGER NOT NULL,
  USERNAME VARCHAR(128) NOT NULL,
  PASSWORD_HASH VARCHAR(256) NOT NULL,
  PASSWORD_DATE TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (USER_ID, PASSWORD_HASH)
);

-- Password verification functions (maps to DBA_USERS.PASSWORD_VERIFY_FUNCTION)
CREATE TABLE SYS.PASSWORD_VERIFY_FUNC$ (
  FUNCTION_NAME VARCHAR(128) PRIMARY KEY,
  MIN_LENGTH INTEGER DEFAULT 8,
  MAX_LENGTH INTEGER DEFAULT 30,
  REQUIRE_UPPERCASE VARCHAR(1) DEFAULT 'Y',
  REQUIRE_LOWERCASE VARCHAR(1) DEFAULT 'Y',
  REQUIRE_DIGIT VARCHAR(1) DEFAULT 'Y',
  REQUIRE_SPECIAL VARCHAR(1) DEFAULT 'N',
  SPECIAL_CHARS VARCHAR(128) DEFAULT '!@#$%^&*()_+-=[]{}|;:,.<>?',
  NO_USERNAME VARCHAR(1) DEFAULT 'Y',
  NO_REVERSE_USERNAME VARCHAR(1) DEFAULT 'Y',
  NO_SERVER_NAME VARCHAR(1) DEFAULT 'Y',
  DIFFER_FROM_PREVIOUS INTEGER DEFAULT 3,
  CREATED TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Fine-Grained Auditing policies (maps to DBA_AUDIT_POLICIES)
CREATE TABLE SYS.FGA_POLICY$ (
  POLICY_NAME VARCHAR(128) PRIMARY KEY,
  OBJECT_SCHEMA VARCHAR(128) NOT NULL,
  OBJECT_NAME VARCHAR(128) NOT NULL,
  POLICY_COLUMN VARCHAR(128),
  POLICY_CONDITION VARCHAR(4000),
  ENABLED VARCHAR(3) DEFAULT 'YES',
  STATEMENT_TYPES VARCHAR(128) DEFAULT 'SELECT',
  AUDIT_TRAIL VARCHAR(32) DEFAULT 'DB',
  AUDIT_COLUMN_OPTS VARCHAR(32) DEFAULT 'ANY_COLUMNS',
  CREATED TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Fine-Grained Auditing log (maps to DBA_FGA_AUDIT_TRAIL)
CREATE TABLE SYS.FGA_LOG$ (
  FGA_ID INTEGER PRIMARY KEY,
  SESSION_ID INTEGER,
  EVENT_TIMESTAMP TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  DB_USER VARCHAR(128),
  OS_USER VARCHAR(255),
  CLIENT_ID VARCHAR(255),
  POLICY_NAME VARCHAR(128),
  OBJECT_SCHEMA VARCHAR(128),
  OBJECT_NAME VARCHAR(128),
  SQL_TEXT VARCHAR(4000),
  SQL_BIND VARCHAR(4000),
  STATEMENT_TYPE VARCHAR(32),
  EXTENDED_TIMESTAMP TIMESTAMP
);

-- Unified audit policies (maps to AUDIT_UNIFIED_POLICIES)
CREATE TABLE SYS.UNIFIED_AUDIT_POLICY$ (
  POLICY_NAME VARCHAR(128) PRIMARY KEY,
  AUDIT_CONDITION VARCHAR(4000),
  AUDIT_OPTION VARCHAR(128),
  AUDIT_OPTION_TYPE VARCHAR(32),
  OBJECT_SCHEMA VARCHAR(128),
  OBJECT_NAME VARCHAR(128),
  OBJECT_TYPE VARCHAR(32),
  ENABLED VARCHAR(3) DEFAULT 'NO',
  ENABLED_BY VARCHAR(128),
  ENABLED_DATE TIMESTAMP
);

-- Unified audit trail (maps to UNIFIED_AUDIT_TRAIL)
CREATE TABLE SYS.UNIFIED_AUDIT_TRAIL$ (
  AUDIT_ID INTEGER PRIMARY KEY,
  UNIFIED_AUDIT_POLICIES VARCHAR(4000),
  FGA_POLICY_NAME VARCHAR(128),
  ACTION_NAME VARCHAR(128),
  OBJECT_SCHEMA VARCHAR(128),
  OBJECT_NAME VARCHAR(128),
  SQL_TEXT VARCHAR(4000),
  SQL_BINDS VARCHAR(4000),
  DBUSERNAME VARCHAR(128),
  OS_USERNAME VARCHAR(255),
  CLIENT_PROGRAM_NAME VARCHAR(128),
  EVENT_TIMESTAMP TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  RETURN_CODE INTEGER DEFAULT 0,
  SESSION_ID INTEGER,
  AUTHENTICATION_TYPE VARCHAR(32),
  SYSTEM_PRIVILEGE_USED VARCHAR(128),
  TARGET_USER VARCHAR(128),
  ROLE_NAME VARCHAR(128)
);

-- ============================================================================
-- Redo Logs & Archiving (V$LOG, V$LOGFILE, V$ARCHIVED_LOG)
-- ============================================================================

-- Redo log groups
CREATE TABLE SYS.V_LOG$ (
  GROUP_NUM INTEGER PRIMARY KEY,
  THREAD_NUM INTEGER DEFAULT 1,
  SEQUENCE_NUM INTEGER DEFAULT 0,
  LOG_BYTES INTEGER DEFAULT 52428800,
  BLOCKSIZE INTEGER DEFAULT 512,
  MEMBERS INTEGER DEFAULT 1,
  ARCHIVED VARCHAR(3) DEFAULT 'NO',
  STATUS VARCHAR(16) DEFAULT 'UNUSED',
  FIRST_CHANGE INTEGER DEFAULT 0,
  FIRST_TIME TIMESTAMP,
  NEXT_CHANGE INTEGER,
  NEXT_TIME TIMESTAMP,
  CON_ID INTEGER DEFAULT 0
);

-- Redo log files
CREATE TABLE SYS.V_LOGFILE$ (
  GROUP_NUM INTEGER NOT NULL,
  STATUS VARCHAR(16) DEFAULT 'VALID',
  FILE_TYPE VARCHAR(16) DEFAULT 'ONLINE',
  MEMBER VARCHAR(512) NOT NULL,
  IS_RECOVERY_DEST_FILE VARCHAR(3) DEFAULT 'NO',
  CON_ID INTEGER DEFAULT 0,
  PRIMARY KEY (GROUP_NUM, MEMBER)
);

-- Archived logs
CREATE TABLE SYS.V_ARCHIVED_LOG$ (
  RECID INTEGER PRIMARY KEY,
  STAMP INTEGER,
  NAME VARCHAR(512),
  DEST_ID INTEGER DEFAULT 1,
  THREAD_NUM INTEGER DEFAULT 1,
  SEQUENCE_NUM INTEGER,
  RESETLOGS_CHANGE INTEGER,
  RESETLOGS_TIME TIMESTAMP,
  RESETLOGS_ID INTEGER,
  FIRST_CHANGE INTEGER,
  FIRST_TIME TIMESTAMP,
  NEXT_CHANGE INTEGER,
  NEXT_TIME TIMESTAMP,
  BLOCKS INTEGER,
  BLOCK_SIZE INTEGER DEFAULT 512,
  CREATOR VARCHAR(16) DEFAULT 'ARCH',
  REGISTRAR VARCHAR(16) DEFAULT 'SMON',
  STANDBY_DEST VARCHAR(3) DEFAULT 'NO',
  ARCHIVED VARCHAR(3) DEFAULT 'YES',
  APPLIED VARCHAR(9) DEFAULT 'NO',
  DELETED VARCHAR(3) DEFAULT 'NO',
  STATUS VARCHAR(1) DEFAULT 'A',
  COMPLETION_TIME TIMESTAMP,
  COMPRESSED VARCHAR(3) DEFAULT 'NO',
  FAL VARCHAR(3) DEFAULT 'NO',
  END_OF_REDO VARCHAR(3) DEFAULT 'NO',
  CON_ID INTEGER DEFAULT 0
);

-- ============================================================================
-- RMAN Backup (V$BACKUP, V$RMAN_BACKUP_JOB_DETAILS)
-- ============================================================================

-- Backup status
CREATE TABLE SYS.V_BACKUP$ (
  FILE_NUM INTEGER PRIMARY KEY,
  STATUS VARCHAR(18) DEFAULT 'NOT ACTIVE',
  CHANGE_NUM INTEGER,
  BACKUP_TIME TIMESTAMP,
  CON_ID INTEGER DEFAULT 0
);

-- RMAN backup job details
CREATE TABLE SYS.V_RMAN_BACKUP_JOB_DETAILS$ (
  SESSION_KEY INTEGER PRIMARY KEY,
  SESSION_RECID INTEGER,
  SESSION_STAMP INTEGER,
  COMMAND_ID VARCHAR(128),
  START_TIME TIMESTAMP,
  END_TIME TIMESTAMP,
  INPUT_TYPE VARCHAR(32),
  STATUS VARCHAR(32) DEFAULT 'COMPLETED',
  OUTPUT_DEVICE_TYPE VARCHAR(32) DEFAULT 'DISK',
  INPUT_BYTES INTEGER DEFAULT 0,
  OUTPUT_BYTES INTEGER DEFAULT 0,
  INPUT_BYTES_PER_SEC INTEGER DEFAULT 0,
  OUTPUT_BYTES_PER_SEC INTEGER DEFAULT 0,
  ELAPSED_SECONDS INTEGER DEFAULT 0,
  COMPRESSION_RATIO DECIMAL(10,2) DEFAULT 1.00,
  INPUT_BYTES_DISPLAY VARCHAR(32),
  OUTPUT_BYTES_DISPLAY VARCHAR(32),
  AUTOBACKUP_COUNT INTEGER DEFAULT 0,
  AUTOBACKUP_DONE VARCHAR(3) DEFAULT 'NO',
  TIME_TAKEN_DISPLAY VARCHAR(32),
  CON_ID INTEGER DEFAULT 0
);

-- ============================================================================
-- Locks & Transactions (V$LOCK, V$TRANSACTION, V$SESSION_WAIT)
-- ============================================================================

-- Locks
CREATE TABLE SYS.V_LOCK$ (
  ADDR VARCHAR(32) PRIMARY KEY,
  KADDR VARCHAR(32),
  SID INTEGER NOT NULL,
  LOCK_TYPE VARCHAR(2) NOT NULL,
  ID1 INTEGER DEFAULT 0,
  ID2 INTEGER DEFAULT 0,
  LMODE INTEGER DEFAULT 0,
  REQUEST INTEGER DEFAULT 0,
  CTIME INTEGER DEFAULT 0,
  BLOCK_STATUS INTEGER DEFAULT 0,
  CON_ID INTEGER DEFAULT 0
);

-- Transactions
CREATE TABLE SYS.V_TRANSACTION$ (
  ADDR VARCHAR(32) PRIMARY KEY,
  XIDUSN INTEGER DEFAULT 0,
  XIDSLOT INTEGER DEFAULT 0,
  XIDSQN INTEGER DEFAULT 0,
  UBAFIL INTEGER DEFAULT 0,
  UBABLK INTEGER DEFAULT 0,
  UBASQN INTEGER DEFAULT 0,
  UBAREC INTEGER DEFAULT 0,
  STATUS VARCHAR(16) DEFAULT 'ACTIVE',
  START_TIME VARCHAR(32),
  START_SCNB INTEGER DEFAULT 0,
  START_SCNW INTEGER DEFAULT 0,
  SES_ADDR VARCHAR(32),
  FLAG INTEGER DEFAULT 0,
  SPACE VARCHAR(3) DEFAULT 'NO',
  RECURSIVE VARCHAR(3) DEFAULT 'NO',
  NOUNDO VARCHAR(3) DEFAULT 'NO',
  PTX VARCHAR(3) DEFAULT 'NO',
  NAME VARCHAR(256),
  USED_UBLK INTEGER DEFAULT 0,
  USED_UREC INTEGER DEFAULT 0,
  LOG_IO INTEGER DEFAULT 0,
  PHY_IO INTEGER DEFAULT 0,
  CR_GET INTEGER DEFAULT 0,
  CR_CHANGE INTEGER DEFAULT 0,
  CON_ID INTEGER DEFAULT 0
);

-- Session waits
CREATE TABLE SYS.V_SESSION_WAIT$ (
  SID INTEGER PRIMARY KEY,
  SEQ_NUM INTEGER DEFAULT 0,
  EVENT VARCHAR(64),
  P1TEXT VARCHAR(64),
  P1 INTEGER DEFAULT 0,
  P1RAW VARCHAR(32),
  P2TEXT VARCHAR(64),
  P2 INTEGER DEFAULT 0,
  P2RAW VARCHAR(32),
  P3TEXT VARCHAR(64),
  P3 INTEGER DEFAULT 0,
  P3RAW VARCHAR(32),
  WAIT_CLASS_ID INTEGER DEFAULT 0,
  WAIT_CLASS VARCHAR(64) DEFAULT 'Other',
  WAIT_TIME INTEGER DEFAULT 0,
  SECONDS_IN_WAIT INTEGER DEFAULT 0,
  STATE VARCHAR(32) DEFAULT 'WAITED SHORT TIME',
  TIME_REMAINING_MICRO INTEGER DEFAULT 0,
  TIME_SINCE_LAST_WAIT_MICRO INTEGER DEFAULT 0,
  CON_ID INTEGER DEFAULT 0
);

-- Wait statistics
CREATE TABLE SYS.V_WAITSTAT$ (
  WAIT_CLASS VARCHAR(64) PRIMARY KEY,
  COUNT_VAL INTEGER DEFAULT 0,
  TIME_VAL INTEGER DEFAULT 0,
  CON_ID INTEGER DEFAULT 0
);

-- ============================================================================
-- Memory/SGA (V$SGA, V$SGASTAT)
-- ============================================================================

-- SGA summary
CREATE TABLE SYS.V_SGA$ (
  NAME VARCHAR(64) PRIMARY KEY,
  VALUE_BYTES INTEGER DEFAULT 0,
  CON_ID INTEGER DEFAULT 0
);

-- SGA statistics
CREATE TABLE SYS.V_SGASTAT$ (
  POOL VARCHAR(32),
  COMPONENT_NAME VARCHAR(64),
  BYTES_VAL INTEGER DEFAULT 0,
  CON_ID INTEGER DEFAULT 0
);

-- ============================================================================
-- Performance SQL (V$SQL, V$SQLAREA)
-- ============================================================================

-- SQL statements
CREATE TABLE SYS.V_SQL$ (
  SQL_ID VARCHAR(32) PRIMARY KEY,
  CHILD_NUMBER INTEGER DEFAULT 0,
  SQL_TEXT VARCHAR(4000),
  SQL_FULLTEXT VARCHAR(4000),
  SHARABLE_MEM INTEGER DEFAULT 0,
  PERSISTENT_MEM INTEGER DEFAULT 0,
  RUNTIME_MEM INTEGER DEFAULT 0,
  SORTS INTEGER DEFAULT 0,
  LOADED_VERSIONS INTEGER DEFAULT 1,
  OPEN_VERSIONS INTEGER DEFAULT 0,
  USERS_OPENING INTEGER DEFAULT 0,
  FETCHES INTEGER DEFAULT 0,
  EXECUTIONS INTEGER DEFAULT 1,
  PX_SERVERS_EXECUTIONS INTEGER DEFAULT 0,
  END_OF_FETCH_COUNT INTEGER DEFAULT 0,
  PARSE_CALLS INTEGER DEFAULT 1,
  DISK_READS INTEGER DEFAULT 0,
  DIRECT_READS INTEGER DEFAULT 0,
  DIRECT_WRITES INTEGER DEFAULT 0,
  BUFFER_GETS INTEGER DEFAULT 0,
  APPLICATION_WAIT_TIME INTEGER DEFAULT 0,
  CONCURRENCY_WAIT_TIME INTEGER DEFAULT 0,
  CLUSTER_WAIT_TIME INTEGER DEFAULT 0,
  USER_IO_WAIT_TIME INTEGER DEFAULT 0,
  PLSQL_EXEC_TIME INTEGER DEFAULT 0,
  JAVA_EXEC_TIME INTEGER DEFAULT 0,
  ROWS_PROCESSED INTEGER DEFAULT 0,
  COMMAND_TYPE INTEGER DEFAULT 0,
  OPTIMIZER_MODE VARCHAR(32) DEFAULT 'ALL_ROWS',
  OPTIMIZER_COST INTEGER DEFAULT 0,
  PARSING_USER_ID INTEGER DEFAULT 0,
  PARSING_SCHEMA_ID INTEGER DEFAULT 0,
  PARSING_SCHEMA_NAME VARCHAR(128),
  FIRST_LOAD_TIME VARCHAR(32),
  LAST_LOAD_TIME TIMESTAMP,
  LAST_ACTIVE_TIME TIMESTAMP,
  PLAN_HASH_VALUE INTEGER DEFAULT 0,
  FULL_PLAN_HASH_VALUE INTEGER DEFAULT 0,
  MODULE VARCHAR(128),
  ACTION VARCHAR(128),
  SERIALIZABLE_ABORTS INTEGER DEFAULT 0,
  CPU_TIME INTEGER DEFAULT 0,
  ELAPSED_TIME INTEGER DEFAULT 0,
  OUTLINE_CATEGORY VARCHAR(128),
  IS_OBSOLETE VARCHAR(1) DEFAULT 'N',
  IS_SHAREABLE VARCHAR(1) DEFAULT 'Y',
  CHILD_LATCH INTEGER DEFAULT 0,
  OBJECT_STATUS VARCHAR(32) DEFAULT 'VALID',
  PROGRAM_ID INTEGER DEFAULT 0,
  PROGRAM_LINE INTEGER DEFAULT 0,
  EXACT_MATCHING_SIGNATURE INTEGER DEFAULT 0,
  FORCE_MATCHING_SIGNATURE INTEGER DEFAULT 0,
  CON_ID INTEGER DEFAULT 0
);

-- SQL area
CREATE TABLE SYS.V_SQLAREA$ (
  SQL_ID VARCHAR(32) PRIMARY KEY,
  SQL_TEXT VARCHAR(4000),
  SHARABLE_MEM INTEGER DEFAULT 0,
  PERSISTENT_MEM INTEGER DEFAULT 0,
  RUNTIME_MEM INTEGER DEFAULT 0,
  SORTS INTEGER DEFAULT 0,
  VERSION_COUNT INTEGER DEFAULT 1,
  LOADED_VERSIONS INTEGER DEFAULT 1,
  OPEN_VERSIONS INTEGER DEFAULT 0,
  USERS_OPENING INTEGER DEFAULT 0,
  USERS_EXECUTING INTEGER DEFAULT 0,
  FETCHES INTEGER DEFAULT 0,
  EXECUTIONS INTEGER DEFAULT 1,
  END_OF_FETCH_COUNT INTEGER DEFAULT 0,
  LOADS INTEGER DEFAULT 1,
  FIRST_LOAD_TIME VARCHAR(32),
  LAST_LOAD_TIME TIMESTAMP,
  LAST_ACTIVE_TIME TIMESTAMP,
  INVALIDATIONS INTEGER DEFAULT 0,
  PARSE_CALLS INTEGER DEFAULT 1,
  DISK_READS INTEGER DEFAULT 0,
  DIRECT_READS INTEGER DEFAULT 0,
  DIRECT_WRITES INTEGER DEFAULT 0,
  BUFFER_GETS INTEGER DEFAULT 0,
  ROWS_PROCESSED INTEGER DEFAULT 0,
  CPU_TIME INTEGER DEFAULT 0,
  ELAPSED_TIME INTEGER DEFAULT 0,
  AVG_HARD_PARSE_TIME INTEGER DEFAULT 0,
  APPLICATION_WAIT_TIME INTEGER DEFAULT 0,
  CONCURRENCY_WAIT_TIME INTEGER DEFAULT 0,
  CLUSTER_WAIT_TIME INTEGER DEFAULT 0,
  USER_IO_WAIT_TIME INTEGER DEFAULT 0,
  PLSQL_EXEC_TIME INTEGER DEFAULT 0,
  JAVA_EXEC_TIME INTEGER DEFAULT 0,
  COMMAND_TYPE INTEGER DEFAULT 0,
  PARSING_USER_ID INTEGER DEFAULT 0,
  PARSING_SCHEMA_ID INTEGER DEFAULT 0,
  PARSING_SCHEMA_NAME VARCHAR(128),
  OPTIMIZER_MODE VARCHAR(32) DEFAULT 'ALL_ROWS',
  MODULE VARCHAR(128),
  ACTION VARCHAR(128),
  SERIALIZABLE_ABORTS INTEGER DEFAULT 0,
  OUTLINE_CATEGORY VARCHAR(128),
  PROGRAM_ID INTEGER DEFAULT 0,
  EXACT_MATCHING_SIGNATURE INTEGER DEFAULT 0,
  FORCE_MATCHING_SIGNATURE INTEGER DEFAULT 0,
  CON_ID INTEGER DEFAULT 0
);

-- ============================================================================
-- Scheduler Jobs (DBA_SCHEDULER_JOBS, DBA_SCHEDULER_JOB_LOG)
-- ============================================================================

-- Scheduler jobs
CREATE TABLE SYS.SCHEDULER_JOB$ (
  OWNER VARCHAR(128) NOT NULL,
  JOB_NAME VARCHAR(128) NOT NULL,
  JOB_SUBNAME VARCHAR(128),
  JOB_STYLE VARCHAR(32) DEFAULT 'REGULAR',
  JOB_CREATOR VARCHAR(128),
  CLIENT_ID VARCHAR(128),
  GLOBAL_UID VARCHAR(128),
  PROGRAM_OWNER VARCHAR(128),
  PROGRAM_NAME VARCHAR(128),
  JOB_TYPE VARCHAR(32),
  JOB_ACTION VARCHAR(4000),
  NUMBER_OF_ARGUMENTS INTEGER DEFAULT 0,
  SCHEDULE_OWNER VARCHAR(128),
  SCHEDULE_NAME VARCHAR(128),
  SCHEDULE_TYPE VARCHAR(32) DEFAULT 'ONCE',
  START_DATE TIMESTAMP,
  REPEAT_INTERVAL VARCHAR(256),
  EVENT_QUEUE_OWNER VARCHAR(128),
  EVENT_QUEUE_NAME VARCHAR(128),
  EVENT_QUEUE_AGENT VARCHAR(1024),
  EVENT_CONDITION VARCHAR(4000),
  EVENT_RULE VARCHAR(256),
  FILE_WATCHER_OWNER VARCHAR(128),
  FILE_WATCHER_NAME VARCHAR(128),
  END_DATE TIMESTAMP,
  JOB_CLASS VARCHAR(128) DEFAULT 'DEFAULT_JOB_CLASS',
  ENABLED VARCHAR(5) DEFAULT 'FALSE',
  AUTO_DROP VARCHAR(5) DEFAULT 'TRUE',
  RESTART_ON_RECOVERY VARCHAR(5) DEFAULT 'FALSE',
  RESTART_ON_FAILURE VARCHAR(5) DEFAULT 'FALSE',
  STATE VARCHAR(32) DEFAULT 'DISABLED',
  JOB_PRIORITY INTEGER DEFAULT 3,
  RUN_COUNT INTEGER DEFAULT 0,
  MAX_RUNS INTEGER,
  FAILURE_COUNT INTEGER DEFAULT 0,
  MAX_FAILURES INTEGER,
  RETRY_COUNT INTEGER DEFAULT 0,
  LAST_START_DATE TIMESTAMP,
  LAST_RUN_DURATION INTEGER,
  NEXT_RUN_DATE TIMESTAMP,
  SCHEDULE_LIMIT INTEGER,
  MAX_RUN_DURATION INTEGER,
  LOGGING_LEVEL VARCHAR(32) DEFAULT 'RUNS',
  STORE_OUTPUT VARCHAR(5) DEFAULT 'FALSE',
  STOP_ON_WINDOW_CLOSE VARCHAR(5) DEFAULT 'FALSE',
  INSTANCE_STICKINESS VARCHAR(5) DEFAULT 'FALSE',
  RAISE_EVENTS VARCHAR(128),
  SYSTEM_JOB VARCHAR(5) DEFAULT 'FALSE',
  JOB_WEIGHT INTEGER DEFAULT 1,
  NLS_ENV VARCHAR(4000),
  SOURCE VARCHAR(256),
  NUMBER_OF_DESTINATIONS INTEGER DEFAULT 1,
  DESTINATION_OWNER VARCHAR(256),
  DESTINATION VARCHAR(4000),
  CREDENTIAL_OWNER VARCHAR(128),
  CREDENTIAL_NAME VARCHAR(128),
  INSTANCE_ID INTEGER,
  DEFERRED_DROP VARCHAR(5) DEFAULT 'FALSE',
  ALLOW_RUNS_IN_RESTRICTED_MODE VARCHAR(5) DEFAULT 'FALSE',
  COMMENTS VARCHAR(4000),
  FLAGS INTEGER DEFAULT 0,
  RESTARTABLE VARCHAR(5) DEFAULT 'FALSE',
  HAS_CONSTRAINTS VARCHAR(5) DEFAULT 'FALSE',
  CONNECT_CREDENTIAL_OWNER VARCHAR(128),
  CONNECT_CREDENTIAL_NAME VARCHAR(128),
  FAIL_ON_SCRIPT_ERROR VARCHAR(5) DEFAULT 'FALSE',
  PRIMARY KEY (OWNER, JOB_NAME)
);

-- Scheduler job log
CREATE TABLE SYS.SCHEDULER_JOB_LOG$ (
  LOG_ID INTEGER PRIMARY KEY,
  LOG_DATE TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  OWNER VARCHAR(128) NOT NULL,
  JOB_NAME VARCHAR(128) NOT NULL,
  JOB_SUBNAME VARCHAR(128),
  JOB_CLASS VARCHAR(128) DEFAULT 'DEFAULT_JOB_CLASS',
  OPERATION VARCHAR(32),
  STATUS VARCHAR(32),
  USER_NAME VARCHAR(128),
  CLIENT_ID VARCHAR(128),
  GLOBAL_UID VARCHAR(128),
  CREDENTIAL_OWNER VARCHAR(128),
  CREDENTIAL_NAME VARCHAR(128),
  DESTINATION_OWNER VARCHAR(256),
  DESTINATION VARCHAR(4000),
  REQ_START_DATE TIMESTAMP,
  ACTUAL_START_DATE TIMESTAMP,
  RUN_DURATION INTEGER,
  INSTANCE_ID INTEGER,
  SESSION_ID INTEGER,
  SLAVE_PID INTEGER,
  CPU_USED INTEGER,
  ADDITIONAL_INFO VARCHAR(4000),
  ERRORS VARCHAR(4000),
  OUTPUT VARCHAR(4000)
);

-- ============================================================================
-- Database Links (DBA_DB_LINKS)
-- ============================================================================

CREATE TABLE SYS.DB_LINK$ (
  OWNER VARCHAR(128) NOT NULL,
  DB_LINK VARCHAR(128) NOT NULL,
  USERNAME VARCHAR(128),
  PASSWORD VARCHAR(128),
  HOST VARCHAR(2000),
  CREATED TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  HIDDEN VARCHAR(3) DEFAULT 'NO',
  SHARD_INTERNAL VARCHAR(3) DEFAULT 'NO',
  VALID VARCHAR(3) DEFAULT 'YES',
  INTRA_CDB VARCHAR(3) DEFAULT 'NO',
  PRIMARY KEY (OWNER, DB_LINK)
);

-- ============================================================================
-- Resource Manager (DBA_RSRC_PLANS, DBA_RSRC_CONSUMER_GROUPS)
-- ============================================================================

-- Resource plans
CREATE TABLE SYS.RSRC_PLAN$ (
  PLAN VARCHAR(128) PRIMARY KEY,
  NUM_PLAN_DIRECTIVES INTEGER DEFAULT 0,
  CPU_METHOD VARCHAR(128) DEFAULT 'EMPHASIS',
  MGMT_METHOD VARCHAR(128) DEFAULT 'EMPHASIS',
  ACTIVE_SESS_POOL_MTH VARCHAR(128) DEFAULT 'ACTIVE_SESS_POOL_ABSOLUTE',
  PARALLEL_DEGREE_LIMIT_MTH VARCHAR(128) DEFAULT 'PARALLEL_DEGREE_LIMIT_ABSOLUTE',
  QUEUING_MTH VARCHAR(128) DEFAULT 'FIFO_TIMEOUT',
  STATUS VARCHAR(16),
  MANDATORY VARCHAR(3) DEFAULT 'NO',
  COMMENTS VARCHAR(2000),
  CON_ID INTEGER DEFAULT 0
);

-- Resource consumer groups
CREATE TABLE SYS.RSRC_CONSUMER_GROUP$ (
  CONSUMER_GROUP VARCHAR(128) PRIMARY KEY,
  CPU_METHOD VARCHAR(128) DEFAULT 'ROUND-ROBIN',
  MGMT_METHOD VARCHAR(128) DEFAULT 'ROUND-ROBIN',
  INTERNAL_USE VARCHAR(3) DEFAULT 'NO',
  COMMENTS VARCHAR(2000),
  CATEGORY VARCHAR(128) DEFAULT 'OTHER',
  STATUS VARCHAR(16),
  MANDATORY VARCHAR(3) DEFAULT 'NO',
  CON_ID INTEGER DEFAULT 0
);

-- Resource plan directives
CREATE TABLE SYS.RSRC_PLAN_DIRECTIVE$ (
  PLAN VARCHAR(128) NOT NULL,
  GROUP_OR_SUBPLAN VARCHAR(128) NOT NULL,
  DIRECTIVE_TYPE VARCHAR(32) DEFAULT 'PLAN_DIRECTIVE',
  MGMT_P1 INTEGER DEFAULT 0,
  MGMT_P2 INTEGER DEFAULT 0,
  MGMT_P3 INTEGER DEFAULT 0,
  MGMT_P4 INTEGER DEFAULT 0,
  MGMT_P5 INTEGER DEFAULT 0,
  MGMT_P6 INTEGER DEFAULT 0,
  MGMT_P7 INTEGER DEFAULT 0,
  MGMT_P8 INTEGER DEFAULT 0,
  ACTIVE_SESS_POOL_P1 INTEGER,
  QUEUEING_P1 INTEGER,
  PARALLEL_TARGET_PERCENTAGE INTEGER,
  PARALLEL_DEGREE_LIMIT_P1 INTEGER,
  SWITCH_GROUP VARCHAR(128),
  SWITCH_FOR_CALL VARCHAR(5) DEFAULT 'FALSE',
  SWITCH_TIME INTEGER,
  SWITCH_IO_MEGABYTES INTEGER,
  SWITCH_IO_REQS INTEGER,
  SWITCH_ELAPSED_TIME INTEGER,
  SWITCH_TIME_IN_CALL INTEGER,
  MAX_EST_EXEC_TIME INTEGER,
  UNDO_POOL INTEGER,
  MAX_IDLE_TIME INTEGER,
  MAX_IDLE_BLOCKER_TIME INTEGER,
  MAX_UTILIZATION_LIMIT INTEGER,
  PARALLEL_QUEUE_TIMEOUT INTEGER,
  SWITCH_IO_LOGICAL INTEGER,
  SHARES INTEGER DEFAULT 1,
  UTILIZATION_LIMIT INTEGER DEFAULT 100,
  PARALLEL_SERVER_LIMIT INTEGER DEFAULT 100,
  PQ_TIMEOUT_ACTION VARCHAR(16) DEFAULT 'RUN',
  COMMENTS VARCHAR(2000),
  STATUS VARCHAR(16),
  MANDATORY VARCHAR(3) DEFAULT 'NO',
  CON_ID INTEGER DEFAULT 0,
  PRIMARY KEY (PLAN, GROUP_OR_SUBPLAN)
);

-- ============================================================================
-- Flashback (DBA_FLASHBACK_ARCHIVE, V$FLASHBACK_DATABASE_LOG)
-- ============================================================================

-- Flashback archives
CREATE TABLE SYS.FLASHBACK_ARCHIVE$ (
  FLASHBACK_ARCHIVE_NAME VARCHAR(255) PRIMARY KEY,
  FLASHBACK_ARCHIVE_NUM INTEGER,
  RETENTION_IN_DAYS INTEGER DEFAULT 365,
  CREATE_TIME TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  LAST_PURGE_TIME TIMESTAMP,
  STATUS VARCHAR(16) DEFAULT 'ENABLED',
  QUOTA_IN_MB INTEGER
);

-- Flashback archive tables
CREATE TABLE SYS.FLASHBACK_ARCHIVE_TABLES$ (
  TABLE_NAME VARCHAR(128) NOT NULL,
  OWNER_NAME VARCHAR(128) NOT NULL,
  FLASHBACK_ARCHIVE_NAME VARCHAR(255) NOT NULL,
  ARCHIVE_TABLE_NAME VARCHAR(128),
  STATUS VARCHAR(16) DEFAULT 'ENABLED',
  PRIMARY KEY (OWNER_NAME, TABLE_NAME)
);

-- Flashback database log
CREATE TABLE SYS.V_FLASHBACK_DATABASE_LOG$ (
  OLDEST_FLASHBACK_SCN INTEGER,
  OLDEST_FLASHBACK_TIME TIMESTAMP,
  RETENTION_TARGET INTEGER DEFAULT 1440,
  FLASHBACK_SIZE INTEGER DEFAULT 0,
  ESTIMATED_FLASHBACK_SIZE INTEGER DEFAULT 0,
  CON_ID INTEGER DEFAULT 0
);

-- ============================================================================
-- Alert/Diagnostics (V$DIAG_ALERT_EXT)
-- ============================================================================

CREATE TABLE SYS.V_DIAG_ALERT_EXT$ (
  RECORD_ID INTEGER PRIMARY KEY,
  ORIGINATING_TIMESTAMP TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  NORMALIZED_TIMESTAMP TIMESTAMP,
  ORGANIZATION_ID VARCHAR(128),
  COMPONENT_ID VARCHAR(128),
  HOST_ID VARCHAR(256),
  HOST_ADDRESS VARCHAR(64),
  MESSAGE_TYPE INTEGER DEFAULT 0,
  MESSAGE_LEVEL INTEGER DEFAULT 0,
  MESSAGE_ID VARCHAR(128),
  MESSAGE_GROUP VARCHAR(128),
  CLIENT_ID VARCHAR(256),
  MODULE_ID VARCHAR(256),
  PROCESS_ID VARCHAR(128),
  THREAD_ID VARCHAR(128),
  USER_ID VARCHAR(128),
  INSTANCE_ID VARCHAR(128),
  DETAILED_LOCATION VARCHAR(256),
  PROBLEM_KEY VARCHAR(256),
  UPSTREAM_COMP_ID VARCHAR(128),
  DOWNSTREAM_COMP_ID VARCHAR(128),
  EXECUTION_CONTEXT_ID VARCHAR(128),
  EXECUTION_CONTEXT_SEQUENCE INTEGER,
  ERROR_INSTANCE_ID INTEGER,
  ERROR_INSTANCE_SEQUENCE INTEGER,
  MESSAGE_TEXT VARCHAR(4000),
  MESSAGE_ARGUMENTS VARCHAR(4000),
  SUPPLEMENTAL_ATTRIBUTES VARCHAR(4000),
  SUPPLEMENTAL_DETAILS VARCHAR(4000),
  PARTITION INTEGER DEFAULT 0,
  RECORD_TYPE INTEGER DEFAULT 0,
  FILENAME VARCHAR(512),
  CON_ID INTEGER DEFAULT 0
);
`;

// ============================================================================
// Initial Data Population
// ============================================================================

function getInitialDataSQL(): string[] {
  const statements: string[] = [];
  const now = new Date().toISOString();

  // Create profiles with password policies
  const profileSettings = [
    // DEFAULT profile - resource settings
    { profile: 'DEFAULT', resource: 'SESSIONS_PER_USER', type: 'KERNEL', value: 'UNLIMITED' },
    { profile: 'DEFAULT', resource: 'CPU_PER_SESSION', type: 'KERNEL', value: 'UNLIMITED' },
    { profile: 'DEFAULT', resource: 'CONNECT_TIME', type: 'KERNEL', value: 'UNLIMITED' },
    { profile: 'DEFAULT', resource: 'IDLE_TIME', type: 'KERNEL', value: 'UNLIMITED' },
    // DEFAULT profile - password settings
    { profile: 'DEFAULT', resource: 'FAILED_LOGIN_ATTEMPTS', type: 'PASSWORD', value: '10' },
    { profile: 'DEFAULT', resource: 'PASSWORD_LIFE_TIME', type: 'PASSWORD', value: '180' },
    { profile: 'DEFAULT', resource: 'PASSWORD_REUSE_TIME', type: 'PASSWORD', value: 'UNLIMITED' },
    { profile: 'DEFAULT', resource: 'PASSWORD_REUSE_MAX', type: 'PASSWORD', value: 'UNLIMITED' },
    { profile: 'DEFAULT', resource: 'PASSWORD_LOCK_TIME', type: 'PASSWORD', value: '1' },
    { profile: 'DEFAULT', resource: 'PASSWORD_GRACE_TIME', type: 'PASSWORD', value: '7' },
    { profile: 'DEFAULT', resource: 'PASSWORD_VERIFY_FUNCTION', type: 'PASSWORD', value: 'NULL' },
    // SECURE_PROFILE - stricter settings
    { profile: 'SECURE_PROFILE', resource: 'FAILED_LOGIN_ATTEMPTS', type: 'PASSWORD', value: '3' },
    { profile: 'SECURE_PROFILE', resource: 'PASSWORD_LIFE_TIME', type: 'PASSWORD', value: '60' },
    { profile: 'SECURE_PROFILE', resource: 'PASSWORD_LOCK_TIME', type: 'PASSWORD', value: '1' },
    { profile: 'SECURE_PROFILE', resource: 'PASSWORD_GRACE_TIME', type: 'PASSWORD', value: '3' },
    { profile: 'SECURE_PROFILE', resource: 'PASSWORD_REUSE_TIME', type: 'PASSWORD', value: '365' },
    { profile: 'SECURE_PROFILE', resource: 'PASSWORD_REUSE_MAX', type: 'PASSWORD', value: '10' },
    { profile: 'SECURE_PROFILE', resource: 'PASSWORD_VERIFY_FUNCTION', type: 'PASSWORD', value: 'ORA12C_VERIFY_FUNCTION' },
    { profile: 'SECURE_PROFILE', resource: 'CONNECT_TIME', type: 'KERNEL', value: '480' },
    { profile: 'SECURE_PROFILE', resource: 'IDLE_TIME', type: 'KERNEL', value: '30' },
  ];

  for (const p of profileSettings) {
    statements.push(
      `INSERT INTO PROFILE$ (PROFILE_NAME, RESOURCE_NAME, RESOURCE_TYPE, LIMIT_VALUE) ` +
      `VALUES ('${p.profile}', '${p.resource}', '${p.type}', '${p.value}')`
    );
  }

  // Create password verification functions
  const passwordVerifyFunctions = [
    {
      name: 'ORA12C_VERIFY_FUNCTION',
      minLength: 8,
      maxLength: 30,
      requireUpper: 'Y',
      requireLower: 'Y',
      requireDigit: 'Y',
      requireSpecial: 'N',
      noUsername: 'Y',
      noReverse: 'Y',
      noServerName: 'Y',
      differFromPrev: 3
    },
    {
      name: 'ORA12C_STRONG_VERIFY_FUNCTION',
      minLength: 12,
      maxLength: 30,
      requireUpper: 'Y',
      requireLower: 'Y',
      requireDigit: 'Y',
      requireSpecial: 'Y',
      noUsername: 'Y',
      noReverse: 'Y',
      noServerName: 'Y',
      differFromPrev: 4
    },
    {
      name: 'VERIFY_FUNCTION_11G',
      minLength: 8,
      maxLength: 30,
      requireUpper: 'Y',
      requireLower: 'Y',
      requireDigit: 'Y',
      requireSpecial: 'N',
      noUsername: 'Y',
      noReverse: 'N',
      noServerName: 'N',
      differFromPrev: 3
    }
  ];

  for (const f of passwordVerifyFunctions) {
    statements.push(
      `INSERT INTO PASSWORD_VERIFY_FUNC$ (FUNCTION_NAME, MIN_LENGTH, MAX_LENGTH, REQUIRE_UPPERCASE, REQUIRE_LOWERCASE, REQUIRE_DIGIT, REQUIRE_SPECIAL, NO_USERNAME, NO_REVERSE_USERNAME, NO_SERVER_NAME, DIFFER_FROM_PREVIOUS, CREATED) ` +
      `VALUES ('${f.name}', ${f.minLength}, ${f.maxLength}, '${f.requireUpper}', '${f.requireLower}', '${f.requireDigit}', '${f.requireSpecial}', '${f.noUsername}', '${f.noReverse}', '${f.noServerName}', ${f.differFromPrev}, '${now}')`
    );
  }

  // Create system users
  const users = [
    { id: 0, name: 'SYS', password: hashPassword('oracle'), status: 'OPEN' },
    { id: 1, name: 'SYSTEM', password: hashPassword('oracle'), status: 'OPEN' },
    { id: 2, name: 'SCOTT', password: hashPassword('tiger'), status: 'OPEN' },
    { id: 3, name: 'HR', password: hashPassword('hr'), status: 'OPEN' },
  ];

  for (const u of users) {
    statements.push(
      `INSERT INTO USER$ (USER_ID, USERNAME, PASSWORD_HASH, ACCOUNT_STATUS, DEFAULT_TABLESPACE, TEMPORARY_TABLESPACE, USER_PROFILE, CREATED, FAILED_LOGIN_ATTEMPTS) ` +
      `VALUES (${u.id}, '${u.name}', '${u.password}', '${u.status}', '${u.name === 'SYS' || u.name === 'SYSTEM' ? 'SYSTEM' : 'USERS'}', 'TEMP', 'DEFAULT', '${now}', 0)`
    );
  }

  // Create roles
  const roles = [
    { id: 1, name: 'CONNECT', createdBy: 'SYS' },
    { id: 2, name: 'RESOURCE', createdBy: 'SYS' },
    { id: 3, name: 'DBA', createdBy: 'SYS' },
    { id: 4, name: 'SELECT_CATALOG_ROLE', createdBy: 'SYS' },
    { id: 5, name: 'EXECUTE_CATALOG_ROLE', createdBy: 'SYS' },
  ];

  for (const r of roles) {
    statements.push(
      `INSERT INTO ROLE$ (ROLE_ID, ROLE_NAME, PASSWORD_REQUIRED, AUTHENTICATION_TYPE, CREATED_BY, CREATED) ` +
      `VALUES (${r.id}, '${r.name}', 'N', 'NONE', '${r.createdBy}', '${now}')`
    );
  }

  // Grant privileges to roles
  const rolePrivs = [
    { role: 'CONNECT', priv: 'CREATE SESSION' },
    { role: 'RESOURCE', priv: 'CREATE TABLE' },
    { role: 'RESOURCE', priv: 'CREATE SEQUENCE' },
    { role: 'RESOURCE', priv: 'CREATE PROCEDURE' },
    { role: 'RESOURCE', priv: 'CREATE TRIGGER' },
    { role: 'DBA', priv: 'CREATE SESSION' },
    { role: 'DBA', priv: 'CREATE USER' },
    { role: 'DBA', priv: 'ALTER USER' },
    { role: 'DBA', priv: 'DROP USER' },
    { role: 'DBA', priv: 'CREATE ROLE' },
    { role: 'DBA', priv: 'DROP ANY ROLE' },
    { role: 'DBA', priv: 'GRANT ANY ROLE' },
    { role: 'DBA', priv: 'CREATE TABLE' },
    { role: 'DBA', priv: 'CREATE ANY TABLE' },
    { role: 'DBA', priv: 'ALTER ANY TABLE' },
    { role: 'DBA', priv: 'DROP ANY TABLE' },
    { role: 'DBA', priv: 'SELECT ANY TABLE' },
    { role: 'DBA', priv: 'INSERT ANY TABLE' },
    { role: 'DBA', priv: 'UPDATE ANY TABLE' },
    { role: 'DBA', priv: 'DELETE ANY TABLE' },
    { role: 'DBA', priv: 'CREATE SEQUENCE' },
    { role: 'DBA', priv: 'CREATE ANY SEQUENCE' },
    { role: 'DBA', priv: 'GRANT ANY PRIVILEGE' },
    { role: 'DBA', priv: 'GRANT ANY OBJECT PRIVILEGE' },
    { role: 'DBA', priv: 'AUDIT ANY' },
  ];

  for (const rp of rolePrivs) {
    statements.push(
      `INSERT INTO SYSAUTH$ (GRANTEE, PRIVILEGE, ADMIN_OPTION, GRANTED_BY, GRANT_DATE) ` +
      `VALUES ('${rp.role}', '${rp.priv}', 'YES', 'SYS', '${now}')`
    );
  }

  // Grant roles to users
  const userRoles = [
    { grantee: 'SYS', role: 'DBA' },
    { grantee: 'SYSTEM', role: 'DBA' },
    { grantee: 'SCOTT', role: 'CONNECT' },
    { grantee: 'SCOTT', role: 'RESOURCE' },
    { grantee: 'HR', role: 'CONNECT' },
    { grantee: 'HR', role: 'RESOURCE' },
  ];

  for (const ur of userRoles) {
    statements.push(
      `INSERT INTO ROLEAUTH$ (GRANTEE, GRANTED_ROLE, ADMIN_OPTION, DEFAULT_ROLE, GRANTED_BY, GRANT_DATE) ` +
      `VALUES ('${ur.grantee}', '${ur.role}', 'NO', 'YES', 'SYS', '${now}')`
    );
  }

  // Grant DBA nested roles
  statements.push(
    `INSERT INTO ROLEAUTH$ (GRANTEE, GRANTED_ROLE, ADMIN_OPTION, DEFAULT_ROLE, GRANTED_BY, GRANT_DATE) ` +
    `VALUES ('DBA', 'CONNECT', 'YES', 'YES', 'SYS', '${now}')`
  );
  statements.push(
    `INSERT INTO ROLEAUTH$ (GRANTEE, GRANTED_ROLE, ADMIN_OPTION, DEFAULT_ROLE, GRANTED_BY, GRANT_DATE) ` +
    `VALUES ('DBA', 'RESOURCE', 'YES', 'YES', 'SYS', '${now}')`
  );

  // Grant SYSDBA to SYS
  statements.push(
    `INSERT INTO SYSAUTH$ (GRANTEE, PRIVILEGE, ADMIN_OPTION, GRANTED_BY, GRANT_DATE) ` +
    `VALUES ('SYS', 'SYSDBA', 'YES', 'SYS', '${now}')`
  );
  statements.push(
    `INSERT INTO SYSAUTH$ (GRANTEE, PRIVILEGE, ADMIN_OPTION, GRANTED_BY, GRANT_DATE) ` +
    `VALUES ('SYS', 'SYSOPER', 'YES', 'SYS', '${now}')`
  );

  // ========================================================================
  // Tablespaces (TS$)
  // ========================================================================
  const tablespaces = [
    { id: 0, name: 'SYSTEM', contents: 'PERMANENT', status: 'ONLINE' },
    { id: 1, name: 'SYSAUX', contents: 'PERMANENT', status: 'ONLINE' },
    { id: 2, name: 'USERS', contents: 'PERMANENT', status: 'ONLINE' },
    { id: 3, name: 'TEMP', contents: 'TEMPORARY', status: 'ONLINE' },
    { id: 4, name: 'UNDOTBS1', contents: 'UNDO', status: 'ONLINE' },
  ];

  for (const ts of tablespaces) {
    statements.push(
      `INSERT INTO TS$ (TS_ID, TABLESPACE_NAME, BLOCK_SIZE, STATUS, CONTENTS, LOGGING) ` +
      `VALUES (${ts.id}, '${ts.name}', 8192, '${ts.status}', '${ts.contents}', 'LOGGING')`
    );
  }

  // ========================================================================
  // Data Files (FILE$)
  // ========================================================================
  const dataFiles = [
    { id: 1, ts: 'SYSTEM', file: '/u01/app/oracle/oradata/ORCL/system01.dbf', bytes: 880803840 },
    { id: 2, ts: 'SYSAUX', file: '/u01/app/oracle/oradata/ORCL/sysaux01.dbf', bytes: 587202560 },
    { id: 3, ts: 'USERS', file: '/u01/app/oracle/oradata/ORCL/users01.dbf', bytes: 5242880 },
    { id: 4, ts: 'UNDOTBS1', file: '/u01/app/oracle/oradata/ORCL/undotbs01.dbf', bytes: 26214400 },
  ];

  for (const df of dataFiles) {
    statements.push(
      `INSERT INTO FILE$ (FILE_ID, TABLESPACE_NAME, FILE_NAME, BYTES, STATUS, AUTOEXTENSIBLE) ` +
      `VALUES (${df.id}, '${df.ts}', '${df.file}', ${df.bytes}, 'AVAILABLE', 'YES')`
    );
  }

  // ========================================================================
  // Database Parameters (PARAMETER$) - V$PARAMETER equivalent
  // ========================================================================
  const parameters = [
    { num: 1, name: 'db_name', value: 'ORCL', desc: 'Database name' },
    { num: 2, name: 'db_block_size', value: '8192', desc: 'Size of database block in bytes' },
    { num: 3, name: 'db_cache_size', value: '100M', desc: 'Size of buffer cache' },
    { num: 4, name: 'shared_pool_size', value: '200M', desc: 'Size of shared pool' },
    { num: 5, name: 'pga_aggregate_target', value: '100M', desc: 'Target PGA memory' },
    { num: 6, name: 'sga_target', value: '500M', desc: 'Target SGA memory' },
    { num: 7, name: 'processes', value: '300', desc: 'Max number of user processes' },
    { num: 8, name: 'sessions', value: '472', desc: 'Max number of sessions' },
    { num: 9, name: 'open_cursors', value: '300', desc: 'Max number of open cursors' },
    { num: 10, name: 'cursor_sharing', value: 'EXACT', desc: 'Cursor sharing mode' },
    { num: 11, name: 'optimizer_mode', value: 'ALL_ROWS', desc: 'Optimizer mode' },
    { num: 12, name: 'nls_language', value: 'AMERICAN', desc: 'NLS language' },
    { num: 13, name: 'nls_territory', value: 'AMERICA', desc: 'NLS territory' },
    { num: 14, name: 'nls_date_format', value: 'DD-MON-RR', desc: 'NLS date format' },
    { num: 15, name: 'compatible', value: '19.0.0', desc: 'Database compatibility level' },
    { num: 16, name: 'undo_management', value: 'AUTO', desc: 'Undo management mode' },
    { num: 17, name: 'undo_tablespace', value: 'UNDOTBS1', desc: 'Undo tablespace' },
    { num: 18, name: 'audit_trail', value: 'DB', desc: 'Enable database auditing' },
    { num: 19, name: 'remote_login_passwordfile', value: 'EXCLUSIVE', desc: 'Password file usage' },
    { num: 20, name: 'control_files', value: '/u01/app/oracle/oradata/ORCL/control01.ctl', desc: 'Control file locations' },
  ];

  for (const p of parameters) {
    statements.push(
      `INSERT INTO PARAMETER$ (PARAM_NUM, PARAM_NAME, PARAM_VALUE, DISPLAY_VALUE, ISDEFAULT, DESCRIPTION) ` +
      `VALUES (${p.num}, '${p.name}', '${p.value}', '${p.value}', 'TRUE', '${p.desc}')`
    );
  }

  // ========================================================================
  // DBA Training Data - Redo Logs
  // ========================================================================
  const redoLogs = [
    { group: 1, thread: 1, seq: 100, bytes: 52428800, status: 'CURRENT', archived: 'NO' },
    { group: 2, thread: 1, seq: 99, bytes: 52428800, status: 'INACTIVE', archived: 'YES' },
    { group: 3, thread: 1, seq: 98, bytes: 52428800, status: 'INACTIVE', archived: 'YES' },
  ];

  for (const log of redoLogs) {
    statements.push(
      `INSERT INTO V_LOG$ (GROUP_NUM, THREAD_NUM, SEQUENCE_NUM, LOG_BYTES, STATUS, ARCHIVED, FIRST_TIME) ` +
      `VALUES (${log.group}, ${log.thread}, ${log.seq}, ${log.bytes}, '${log.status}', '${log.archived}', '${now}')`
    );
  }

  // Redo log files
  const logFiles = [
    { group: 1, member: '/u01/app/oracle/oradata/ORCL/redo01a.log', status: '' },
    { group: 1, member: '/u01/app/oracle/oradata/ORCL/redo01b.log', status: '' },
    { group: 2, member: '/u01/app/oracle/oradata/ORCL/redo02a.log', status: '' },
    { group: 2, member: '/u01/app/oracle/oradata/ORCL/redo02b.log', status: '' },
    { group: 3, member: '/u01/app/oracle/oradata/ORCL/redo03a.log', status: '' },
    { group: 3, member: '/u01/app/oracle/oradata/ORCL/redo03b.log', status: '' },
  ];

  for (const lf of logFiles) {
    statements.push(
      `INSERT INTO V_LOGFILE$ (GROUP_NUM, MEMBER, STATUS, FILE_TYPE) ` +
      `VALUES (${lf.group}, '${lf.member}', '${lf.status || 'VALID'}', 'ONLINE')`
    );
  }

  // Archived logs
  for (let i = 1; i <= 5; i++) {
    statements.push(
      `INSERT INTO V_ARCHIVED_LOG$ (RECID, STAMP, NAME, THREAD_NUM, SEQUENCE_NUM, FIRST_CHANGE, BLOCKS, COMPLETION_TIME, ARCHIVED, STATUS) ` +
      `VALUES (${i}, ${Date.now() - i * 3600000}, '/u01/app/oracle/fast_recovery_area/ORCL/archivelog/arc_${100 - i}.arc', 1, ${100 - i}, ${(100 - i) * 10000}, ${10240 + i * 1000}, '${now}', 'YES', 'A')`
    );
  }

  // ========================================================================
  // DBA Training Data - RMAN Backups
  // ========================================================================
  const backupJobs = [
    { key: 1, cmdId: 'FULL_DB_BACKUP', inputType: 'DB FULL', status: 'COMPLETED', inputBytes: 10737418240, outputBytes: 5368709120, elapsed: 3600 },
    { key: 2, cmdId: 'ARCH_BACKUP', inputType: 'ARCHIVELOG', status: 'COMPLETED', inputBytes: 1073741824, outputBytes: 536870912, elapsed: 600 },
    { key: 3, cmdId: 'INCR_LEVEL1', inputType: 'DB INCR', status: 'COMPLETED', inputBytes: 2147483648, outputBytes: 1073741824, elapsed: 1800 },
    { key: 4, cmdId: 'CONTROLFILE_BACKUP', inputType: 'CONTROLFILE', status: 'COMPLETED', inputBytes: 16777216, outputBytes: 8388608, elapsed: 60 },
  ];

  for (const job of backupJobs) {
    statements.push(
      `INSERT INTO V_RMAN_BACKUP_JOB_DETAILS$ (SESSION_KEY, COMMAND_ID, START_TIME, END_TIME, INPUT_TYPE, STATUS, INPUT_BYTES, OUTPUT_BYTES, ELAPSED_SECONDS, INPUT_BYTES_DISPLAY, OUTPUT_BYTES_DISPLAY, TIME_TAKEN_DISPLAY) ` +
      `VALUES (${job.key}, '${job.cmdId}', '${now}', '${now}', '${job.inputType}', '${job.status}', ${job.inputBytes}, ${job.outputBytes}, ${job.elapsed}, '${Math.round(job.inputBytes / 1073741824)}G', '${Math.round(job.outputBytes / 1073741824)}G', '${Math.floor(job.elapsed / 60)}m ${job.elapsed % 60}s')`
    );
  }

  // ========================================================================
  // DBA Training Data - SGA Memory
  // ========================================================================
  const sgaComponents = [
    { name: 'Fixed Size', value: 2932632 },
    { name: 'Variable Size', value: 436207720 },
    { name: 'Database Buffers', value: 104857600 },
    { name: 'Redo Buffers', value: 7340032 },
  ];

  for (const comp of sgaComponents) {
    statements.push(
      `INSERT INTO V_SGA$ (NAME, VALUE_BYTES) VALUES ('${comp.name}', ${comp.value})`
    );
  }

  // SGA Stats
  const sgaStats = [
    { pool: 'shared pool', name: 'free memory', bytes: 50331648 },
    { pool: 'shared pool', name: 'library cache', bytes: 67108864 },
    { pool: 'shared pool', name: 'sql area', bytes: 33554432 },
    { pool: 'shared pool', name: 'dictionary cache', bytes: 16777216 },
    { pool: 'large pool', name: 'free memory', bytes: 8388608 },
    { pool: 'java pool', name: 'free memory', bytes: 16777216 },
    { pool: null, name: 'buffer_cache', bytes: 104857600 },
    { pool: null, name: 'log_buffer', bytes: 7340032 },
  ];

  for (const stat of sgaStats) {
    statements.push(
      `INSERT INTO V_SGASTAT$ (POOL, COMPONENT_NAME, BYTES_VAL) ` +
      `VALUES (${stat.pool ? `'${stat.pool}'` : 'NULL'}, '${stat.name}', ${stat.bytes})`
    );
  }

  // ========================================================================
  // DBA Training Data - Wait Statistics
  // ========================================================================
  const waitStats = [
    { waitClass: 'User I/O', count: 15420, time: 245000 },
    { waitClass: 'System I/O', count: 8540, time: 125000 },
    { waitClass: 'Concurrency', count: 1250, time: 45000 },
    { waitClass: 'Application', count: 350, time: 12000 },
    { waitClass: 'Network', count: 25000, time: 85000 },
    { waitClass: 'Commit', count: 4500, time: 15000 },
    { waitClass: 'Configuration', count: 120, time: 5000 },
    { waitClass: 'Scheduler', count: 80, time: 2000 },
    { waitClass: 'Administrative', count: 25, time: 500 },
    { waitClass: 'Other', count: 500, time: 8000 },
  ];

  for (const ws of waitStats) {
    statements.push(
      `INSERT INTO V_WAITSTAT$ (WAIT_CLASS, COUNT_VAL, TIME_VAL) VALUES ('${ws.waitClass}', ${ws.count}, ${ws.time})`
    );
  }

  // ========================================================================
  // DBA Training Data - Sample SQL Statements
  // ========================================================================
  const sampleSQLs = [
    { id: 'a1b2c3d4e5', text: 'SELECT * FROM EMPLOYEES WHERE DEPARTMENT_ID = :1', executions: 15420, bufferGets: 245000, diskReads: 1200, cpuTime: 125000, elapsedTime: 180000, rowsProcessed: 45000, parsingSchema: 'HR' },
    { id: 'f6g7h8i9j0', text: 'SELECT E.*, D.DEPARTMENT_NAME FROM EMPLOYEES E JOIN DEPARTMENTS D ON E.DEPARTMENT_ID = D.DEPARTMENT_ID', executions: 8200, bufferGets: 180000, diskReads: 850, cpuTime: 95000, elapsedTime: 140000, rowsProcessed: 32000, parsingSchema: 'HR' },
    { id: 'k1l2m3n4o5', text: 'INSERT INTO AUDIT_LOG (ACTION, USER_ID, TIMESTAMP) VALUES (:1, :2, SYSDATE)', executions: 45000, bufferGets: 90000, diskReads: 100, cpuTime: 45000, elapsedTime: 60000, rowsProcessed: 45000, parsingSchema: 'SYSTEM' },
    { id: 'p6q7r8s9t0', text: 'UPDATE EMPLOYEES SET SALARY = SALARY * 1.1 WHERE EMPLOYEE_ID = :1', executions: 520, bufferGets: 15600, diskReads: 50, cpuTime: 8000, elapsedTime: 12000, rowsProcessed: 520, parsingSchema: 'HR' },
    { id: 'u1v2w3x4y5', text: 'SELECT COUNT(*) FROM DBA_OBJECTS', executions: 1200, bufferGets: 48000, diskReads: 200, cpuTime: 24000, elapsedTime: 36000, rowsProcessed: 1200, parsingSchema: 'SYS' },
  ];

  for (const sql of sampleSQLs) {
    statements.push(
      `INSERT INTO V_SQL$ (SQL_ID, SQL_TEXT, EXECUTIONS, BUFFER_GETS, DISK_READS, CPU_TIME, ELAPSED_TIME, ROWS_PROCESSED, PARSING_SCHEMA_NAME, FIRST_LOAD_TIME, LAST_ACTIVE_TIME) ` +
      `VALUES ('${sql.id}', '${sql.text.replace(/'/g, "''")}', ${sql.executions}, ${sql.bufferGets}, ${sql.diskReads}, ${sql.cpuTime}, ${sql.elapsedTime}, ${sql.rowsProcessed}, '${sql.parsingSchema}', '${now}', '${now}')`
    );
    statements.push(
      `INSERT INTO V_SQLAREA$ (SQL_ID, SQL_TEXT, EXECUTIONS, BUFFER_GETS, DISK_READS, CPU_TIME, ELAPSED_TIME, ROWS_PROCESSED, PARSING_SCHEMA_NAME, FIRST_LOAD_TIME, LAST_ACTIVE_TIME) ` +
      `VALUES ('${sql.id}', '${sql.text.replace(/'/g, "''")}', ${sql.executions}, ${sql.bufferGets}, ${sql.diskReads}, ${sql.cpuTime}, ${sql.elapsedTime}, ${sql.rowsProcessed}, '${sql.parsingSchema}', '${now}', '${now}')`
    );
  }

  // ========================================================================
  // DBA Training Data - Scheduler Jobs
  // ========================================================================
  const schedulerJobs = [
    { owner: 'SYS', name: 'GATHER_STATS_JOB', type: 'PLSQL_BLOCK', action: 'BEGIN DBMS_STATS.GATHER_DATABASE_STATS; END;', schedule: 'FREQ=DAILY;BYHOUR=2', enabled: 'TRUE', state: 'SCHEDULED' },
    { owner: 'SYS', name: 'PURGE_LOG', type: 'PLSQL_BLOCK', action: 'BEGIN DBMS_SCHEDULER.PURGE_LOG; END;', schedule: 'FREQ=WEEKLY;BYDAY=SUN', enabled: 'TRUE', state: 'SCHEDULED' },
    { owner: 'SYS', name: 'AUTO_SPACE_ADVISOR_JOB', type: 'PLSQL_BLOCK', action: 'BEGIN DBMS_SPACE.AUTO_SPACE_ADVISOR_JOB_PROC; END;', schedule: 'FREQ=DAILY;BYHOUR=3', enabled: 'TRUE', state: 'SCHEDULED' },
    { owner: 'HR', name: 'EMPLOYEE_REPORT', type: 'STORED_PROCEDURE', action: 'HR.GENERATE_EMPLOYEE_REPORT', schedule: 'FREQ=MONTHLY;BYMONTHDAY=1', enabled: 'TRUE', state: 'SCHEDULED' },
    { owner: 'SYS', name: 'BACKUP_JOB', type: 'EXECUTABLE', action: '/u01/app/scripts/rman_backup.sh', schedule: 'FREQ=DAILY;BYHOUR=23', enabled: 'TRUE', state: 'SCHEDULED' },
  ];

  for (const job of schedulerJobs) {
    statements.push(
      `INSERT INTO SCHEDULER_JOB$ (OWNER, JOB_NAME, JOB_TYPE, JOB_ACTION, REPEAT_INTERVAL, ENABLED, STATE, JOB_CREATOR, START_DATE, NEXT_RUN_DATE) ` +
      `VALUES ('${job.owner}', '${job.name}', '${job.type}', '${job.action.replace(/'/g, "''")}', '${job.schedule}', '${job.enabled}', '${job.state}', 'SYS', '${now}', '${now}')`
    );
  }

  // ========================================================================
  // DBA Training Data - Resource Plans
  // ========================================================================
  const resourcePlans = [
    { plan: 'DEFAULT_PLAN', directives: 3, status: 'ACTIVE', comment: 'Default resource plan' },
    { plan: 'MIXED_WORKLOAD_PLAN', directives: 4, status: 'PENDING', comment: 'Plan for mixed OLTP and reporting workload' },
    { plan: 'MAINTENANCE_PLAN', directives: 2, status: 'PENDING', comment: 'Plan for maintenance windows' },
  ];

  for (const plan of resourcePlans) {
    statements.push(
      `INSERT INTO RSRC_PLAN$ (PLAN, NUM_PLAN_DIRECTIVES, STATUS, COMMENTS) VALUES ('${plan.plan}', ${plan.directives}, '${plan.status}', '${plan.comment}')`
    );
  }

  // Consumer groups
  const consumerGroups = [
    { group: 'SYS_GROUP', comment: 'System consumer group for SYS users', mandatory: 'YES' },
    { group: 'LOW_GROUP', comment: 'Low priority consumer group', mandatory: 'NO' },
    { group: 'INTERACTIVE_GROUP', comment: 'For interactive OLTP sessions', mandatory: 'NO' },
    { group: 'BATCH_GROUP', comment: 'For batch processing jobs', mandatory: 'NO' },
    { group: 'OTHER_GROUPS', comment: 'Default consumer group', mandatory: 'YES' },
  ];

  for (const cg of consumerGroups) {
    statements.push(
      `INSERT INTO RSRC_CONSUMER_GROUP$ (CONSUMER_GROUP, COMMENTS, MANDATORY) VALUES ('${cg.group}', '${cg.comment}', '${cg.mandatory}')`
    );
  }

  // ========================================================================
  // DBA Training Data - Flashback Archive
  // ========================================================================
  statements.push(
    `INSERT INTO FLASHBACK_ARCHIVE$ (FLASHBACK_ARCHIVE_NAME, FLASHBACK_ARCHIVE_NUM, RETENTION_IN_DAYS, CREATE_TIME, STATUS, QUOTA_IN_MB) ` +
    `VALUES ('FLA_1YEAR', 1, 365, '${now}', 'ENABLED', 10240)`
  );
  statements.push(
    `INSERT INTO FLASHBACK_ARCHIVE$ (FLASHBACK_ARCHIVE_NAME, FLASHBACK_ARCHIVE_NUM, RETENTION_IN_DAYS, CREATE_TIME, STATUS, QUOTA_IN_MB) ` +
    `VALUES ('FLA_5YEAR', 2, 1825, '${now}', 'ENABLED', 51200)`
  );

  // Flashback database log
  statements.push(
    `INSERT INTO V_FLASHBACK_DATABASE_LOG$ (OLDEST_FLASHBACK_SCN, OLDEST_FLASHBACK_TIME, RETENTION_TARGET, FLASHBACK_SIZE, ESTIMATED_FLASHBACK_SIZE, CON_ID) ` +
    `VALUES (1000000, '${now}', 1440, 1073741824, 2147483648, 0)`
  );

  // ========================================================================
  // DBA Training Data - Alert Log Entries
  // ========================================================================
  const alertMessages = [
    { id: 1, level: 16, group: 'startup', text: 'Starting ORACLE instance (normal)' },
    { id: 2, level: 16, group: 'startup', text: 'LICENSE_MAX_SESSION = 0' },
    { id: 3, level: 16, group: 'startup', text: 'SGA size: 524288000 bytes' },
    { id: 4, level: 16, group: 'startup', text: 'Database mounted' },
    { id: 5, level: 16, group: 'startup', text: 'Database opened' },
    { id: 6, level: 8, group: 'checkpoint', text: 'Completed checkpoint' },
    { id: 7, level: 8, group: 'archiver', text: 'Thread 1 advanced to log sequence 101' },
    { id: 8, level: 8, group: 'archiver', text: 'Archived Log entry 100 added for thread 1 sequence 100' },
    { id: 9, level: 4, group: 'warning', text: 'ORA-01555: snapshot too old: rollback segment number with name "" too small' },
    { id: 10, level: 2, group: 'error', text: 'ORA-00600: internal error code, arguments: [kghstack_free3], [0x7F4D2C1A8B00]' },
  ];

  for (const alert of alertMessages) {
    statements.push(
      `INSERT INTO V_DIAG_ALERT_EXT$ (RECORD_ID, ORIGINATING_TIMESTAMP, MESSAGE_LEVEL, MESSAGE_GROUP, MESSAGE_TEXT, HOST_ID, INSTANCE_ID, COMPONENT_ID) ` +
      `VALUES (${alert.id}, '${now}', ${alert.level}, '${alert.group}', '${alert.text.replace(/'/g, "''")}', 'dbserver01', 'ORCL1', 'rdbms')`
    );
  }

  return statements;
}

// ============================================================================
// Oracle Security Manager - SQL-based
// ============================================================================

export class OracleSecurityManager {
  private engine: SQLEngine;
  private initialized: boolean = false;
  private currentSessionId: number = 1;
  private auditSequence: number = 1;
  private userSequence: number = 100;
  private roleSequence: number = 100;
  private objectSequence: number = 1000;
  private constraintSequence: number = 1;
  private tablespaceSequence: number = 10;
  private fileSequence: number = 10;
  private fgaSequence: number = 1;
  private unifiedAuditSequence: number = 1;

  constructor(engine?: SQLEngine) {
    if (engine) {
      this.engine = engine;
      this.initializeSecurityTables();
    }
  }

  /**
   * Set the SQL engine (for deferred initialization)
   */
  setEngine(engine: SQLEngine): void {
    this.engine = engine;
    if (!this.initialized) {
      this.initializeSecurityTables();
    }
  }

  /**
   * Initialize security tables in the database
   */
  private initializeSecurityTables(): void {
    if (this.initialized || !this.engine) return;

    // Create SYS schema if not exists
    this.engine.createSchema('SYS');
    const originalSchema = this.engine.getCurrentSchema();
    this.engine.setCurrentSchema('SYS');

    // Create security tables
    const tables = [
      {
        name: 'USER$',
        columns: [
          { name: 'USER_ID', dataType: 'INTEGER', nullable: false },
          { name: 'USERNAME', dataType: 'VARCHAR', length: 128, nullable: false },
          { name: 'PASSWORD_HASH', dataType: 'VARCHAR', length: 256, nullable: true },
          { name: 'ACCOUNT_STATUS', dataType: 'VARCHAR', length: 32, nullable: true, defaultValue: 'OPEN' },
          { name: 'LOCK_DATE', dataType: 'TIMESTAMP', nullable: true },
          { name: 'EXPIRY_DATE', dataType: 'TIMESTAMP', nullable: true },
          { name: 'DEFAULT_TABLESPACE', dataType: 'VARCHAR', length: 128, nullable: true, defaultValue: 'USERS' },
          { name: 'TEMPORARY_TABLESPACE', dataType: 'VARCHAR', length: 128, nullable: true, defaultValue: 'TEMP' },
          { name: 'USER_PROFILE', dataType: 'VARCHAR', length: 128, nullable: true, defaultValue: 'DEFAULT' },
          { name: 'CREATED', dataType: 'TIMESTAMP', nullable: true },
          { name: 'LAST_LOGIN', dataType: 'TIMESTAMP', nullable: true },
          { name: 'FAILED_LOGIN_ATTEMPTS', dataType: 'INTEGER', nullable: true, defaultValue: 0 },
        ],
        primaryKey: ['USER_ID']
      },
      {
        name: 'PROFILE$',
        columns: [
          { name: 'PROFILE_NAME', dataType: 'VARCHAR', length: 128, nullable: false },
          { name: 'RESOURCE_NAME', dataType: 'VARCHAR', length: 128, nullable: false },
          { name: 'RESOURCE_TYPE', dataType: 'VARCHAR', length: 32, nullable: true },
          { name: 'LIMIT_VALUE', dataType: 'VARCHAR', length: 128, nullable: true },
        ],
        primaryKey: ['PROFILE_NAME', 'RESOURCE_NAME']
      },
      {
        name: 'ROLE$',
        columns: [
          { name: 'ROLE_ID', dataType: 'INTEGER', nullable: false },
          { name: 'ROLE_NAME', dataType: 'VARCHAR', length: 128, nullable: false },
          { name: 'PASSWORD_REQUIRED', dataType: 'VARCHAR', length: 1, nullable: true, defaultValue: 'N' },
          { name: 'PASSWORD_HASH', dataType: 'VARCHAR', length: 256, nullable: true },
          { name: 'AUTHENTICATION_TYPE', dataType: 'VARCHAR', length: 32, nullable: true, defaultValue: 'NONE' },
          { name: 'CREATED_BY', dataType: 'VARCHAR', length: 128, nullable: true },
          { name: 'CREATED', dataType: 'TIMESTAMP', nullable: true },
        ],
        primaryKey: ['ROLE_ID']
      },
      {
        name: 'SYSAUTH$',
        columns: [
          { name: 'GRANTEE', dataType: 'VARCHAR', length: 128, nullable: false },
          { name: 'PRIVILEGE', dataType: 'VARCHAR', length: 128, nullable: false },
          { name: 'ADMIN_OPTION', dataType: 'VARCHAR', length: 3, nullable: true, defaultValue: 'NO' },
          { name: 'GRANTED_BY', dataType: 'VARCHAR', length: 128, nullable: true },
          { name: 'GRANT_DATE', dataType: 'TIMESTAMP', nullable: true },
        ],
        primaryKey: ['GRANTEE', 'PRIVILEGE']
      },
      {
        name: 'ROLEAUTH$',
        columns: [
          { name: 'GRANTEE', dataType: 'VARCHAR', length: 128, nullable: false },
          { name: 'GRANTED_ROLE', dataType: 'VARCHAR', length: 128, nullable: false },
          { name: 'ADMIN_OPTION', dataType: 'VARCHAR', length: 3, nullable: true, defaultValue: 'NO' },
          { name: 'DEFAULT_ROLE', dataType: 'VARCHAR', length: 3, nullable: true, defaultValue: 'YES' },
          { name: 'GRANTED_BY', dataType: 'VARCHAR', length: 128, nullable: true },
          { name: 'GRANT_DATE', dataType: 'TIMESTAMP', nullable: true },
        ],
        primaryKey: ['GRANTEE', 'GRANTED_ROLE']
      },
      {
        name: 'OBJAUTH$',
        columns: [
          { name: 'GRANTEE', dataType: 'VARCHAR', length: 128, nullable: false },
          { name: 'OWNER', dataType: 'VARCHAR', length: 128, nullable: false },
          { name: 'TABLE_NAME', dataType: 'VARCHAR', length: 128, nullable: false },
          { name: 'PRIVILEGE', dataType: 'VARCHAR', length: 128, nullable: false },
          { name: 'GRANTABLE', dataType: 'VARCHAR', length: 3, nullable: true, defaultValue: 'NO' },
          { name: 'GRANTOR', dataType: 'VARCHAR', length: 128, nullable: true },
          { name: 'GRANT_DATE', dataType: 'TIMESTAMP', nullable: true },
        ],
        primaryKey: ['GRANTEE', 'OWNER', 'TABLE_NAME', 'PRIVILEGE']
      },
      {
        name: 'TSQUOTA$',
        columns: [
          { name: 'USERNAME', dataType: 'VARCHAR', length: 128, nullable: false },
          { name: 'TABLESPACE_NAME', dataType: 'VARCHAR', length: 128, nullable: false },
          { name: 'MAX_BYTES', dataType: 'INTEGER', nullable: true, defaultValue: -1 },
        ],
        primaryKey: ['USERNAME', 'TABLESPACE_NAME']
      },
      {
        name: 'AUD$',
        columns: [
          { name: 'AUDIT_ID', dataType: 'INTEGER', nullable: false },
          { name: 'SESSION_ID', dataType: 'INTEGER', nullable: true },
          { name: 'EVENT_TIME', dataType: 'TIMESTAMP', nullable: true },
          { name: 'USERNAME', dataType: 'VARCHAR', length: 128, nullable: true },
          { name: 'OS_USERNAME', dataType: 'VARCHAR', length: 255, nullable: true },
          { name: 'TERMINAL', dataType: 'VARCHAR', length: 255, nullable: true },
          { name: 'ACTION_NAME', dataType: 'VARCHAR', length: 128, nullable: true },
          { name: 'OBJECT_SCHEMA', dataType: 'VARCHAR', length: 128, nullable: true },
          { name: 'OBJECT_NAME', dataType: 'VARCHAR', length: 128, nullable: true },
          { name: 'OBJECT_TYPE', dataType: 'VARCHAR', length: 32, nullable: true },
          { name: 'SQL_TEXT', dataType: 'VARCHAR', length: 4000, nullable: true },
          { name: 'RETURN_CODE', dataType: 'INTEGER', nullable: true, defaultValue: 0 },
          { name: 'CLIENT_ID', dataType: 'VARCHAR', length: 255, nullable: true },
          { name: 'COMMENT_TEXT', dataType: 'VARCHAR', length: 4000, nullable: true },
        ],
        primaryKey: ['AUDIT_ID']
      },
      {
        name: 'AUDIT$',
        columns: [
          { name: 'USER_NAME', dataType: 'VARCHAR', length: 128, nullable: true },
          { name: 'AUDIT_OPTION', dataType: 'VARCHAR', length: 128, nullable: false },
          { name: 'SUCCESS', dataType: 'VARCHAR', length: 10, nullable: true },
          { name: 'FAILURE', dataType: 'VARCHAR', length: 10, nullable: true },
        ],
        primaryKey: ['AUDIT_OPTION']
      },
      // ========================================================================
      // Password Policy Tables
      // ========================================================================
      {
        name: 'PASSWORD_HISTORY$',
        columns: [
          { name: 'USER_ID', dataType: 'INTEGER', nullable: false },
          { name: 'USERNAME', dataType: 'VARCHAR', length: 128, nullable: false },
          { name: 'PASSWORD_HASH', dataType: 'VARCHAR', length: 256, nullable: false },
          { name: 'PASSWORD_DATE', dataType: 'TIMESTAMP', nullable: true },
        ],
        primaryKey: ['USER_ID', 'PASSWORD_HASH']
      },
      {
        name: 'PASSWORD_VERIFY_FUNC$',
        columns: [
          { name: 'FUNCTION_NAME', dataType: 'VARCHAR', length: 128, nullable: false },
          { name: 'MIN_LENGTH', dataType: 'INTEGER', nullable: true, defaultValue: 8 },
          { name: 'MAX_LENGTH', dataType: 'INTEGER', nullable: true, defaultValue: 30 },
          { name: 'REQUIRE_UPPERCASE', dataType: 'VARCHAR', length: 1, nullable: true, defaultValue: 'Y' },
          { name: 'REQUIRE_LOWERCASE', dataType: 'VARCHAR', length: 1, nullable: true, defaultValue: 'Y' },
          { name: 'REQUIRE_DIGIT', dataType: 'VARCHAR', length: 1, nullable: true, defaultValue: 'Y' },
          { name: 'REQUIRE_SPECIAL', dataType: 'VARCHAR', length: 1, nullable: true, defaultValue: 'N' },
          { name: 'SPECIAL_CHARS', dataType: 'VARCHAR', length: 128, nullable: true, defaultValue: '!@#$%^&*()_+-=[]{}|;:,.<>?' },
          { name: 'NO_USERNAME', dataType: 'VARCHAR', length: 1, nullable: true, defaultValue: 'Y' },
          { name: 'NO_REVERSE_USERNAME', dataType: 'VARCHAR', length: 1, nullable: true, defaultValue: 'Y' },
          { name: 'NO_SERVER_NAME', dataType: 'VARCHAR', length: 1, nullable: true, defaultValue: 'Y' },
          { name: 'DIFFER_FROM_PREVIOUS', dataType: 'INTEGER', nullable: true, defaultValue: 3 },
          { name: 'CREATED', dataType: 'TIMESTAMP', nullable: true },
        ],
        primaryKey: ['FUNCTION_NAME']
      },
      // ========================================================================
      // Fine-Grained Auditing Tables
      // ========================================================================
      {
        name: 'FGA_POLICY$',
        columns: [
          { name: 'POLICY_NAME', dataType: 'VARCHAR', length: 128, nullable: false },
          { name: 'OBJECT_SCHEMA', dataType: 'VARCHAR', length: 128, nullable: false },
          { name: 'OBJECT_NAME', dataType: 'VARCHAR', length: 128, nullable: false },
          { name: 'POLICY_COLUMN', dataType: 'VARCHAR', length: 128, nullable: true },
          { name: 'POLICY_CONDITION', dataType: 'VARCHAR', length: 4000, nullable: true },
          { name: 'ENABLED', dataType: 'VARCHAR', length: 3, nullable: true, defaultValue: 'YES' },
          { name: 'STATEMENT_TYPES', dataType: 'VARCHAR', length: 128, nullable: true, defaultValue: 'SELECT' },
          { name: 'AUDIT_TRAIL', dataType: 'VARCHAR', length: 32, nullable: true, defaultValue: 'DB' },
          { name: 'AUDIT_COLUMN_OPTS', dataType: 'VARCHAR', length: 32, nullable: true, defaultValue: 'ANY_COLUMNS' },
          { name: 'CREATED', dataType: 'TIMESTAMP', nullable: true },
        ],
        primaryKey: ['POLICY_NAME']
      },
      {
        name: 'FGA_LOG$',
        columns: [
          { name: 'FGA_ID', dataType: 'INTEGER', nullable: false },
          { name: 'SESSION_ID', dataType: 'INTEGER', nullable: true },
          { name: 'EVENT_TIMESTAMP', dataType: 'TIMESTAMP', nullable: true },
          { name: 'DB_USER', dataType: 'VARCHAR', length: 128, nullable: true },
          { name: 'OS_USER', dataType: 'VARCHAR', length: 255, nullable: true },
          { name: 'CLIENT_ID', dataType: 'VARCHAR', length: 255, nullable: true },
          { name: 'POLICY_NAME', dataType: 'VARCHAR', length: 128, nullable: true },
          { name: 'OBJECT_SCHEMA', dataType: 'VARCHAR', length: 128, nullable: true },
          { name: 'OBJECT_NAME', dataType: 'VARCHAR', length: 128, nullable: true },
          { name: 'SQL_TEXT', dataType: 'VARCHAR', length: 4000, nullable: true },
          { name: 'SQL_BIND', dataType: 'VARCHAR', length: 4000, nullable: true },
          { name: 'STATEMENT_TYPE', dataType: 'VARCHAR', length: 32, nullable: true },
          { name: 'EXTENDED_TIMESTAMP', dataType: 'TIMESTAMP', nullable: true },
        ],
        primaryKey: ['FGA_ID']
      },
      {
        name: 'UNIFIED_AUDIT_POLICY$',
        columns: [
          { name: 'POLICY_NAME', dataType: 'VARCHAR', length: 128, nullable: false },
          { name: 'AUDIT_CONDITION', dataType: 'VARCHAR', length: 4000, nullable: true },
          { name: 'AUDIT_OPTION', dataType: 'VARCHAR', length: 128, nullable: true },
          { name: 'AUDIT_OPTION_TYPE', dataType: 'VARCHAR', length: 32, nullable: true },
          { name: 'OBJECT_SCHEMA', dataType: 'VARCHAR', length: 128, nullable: true },
          { name: 'OBJECT_NAME', dataType: 'VARCHAR', length: 128, nullable: true },
          { name: 'OBJECT_TYPE', dataType: 'VARCHAR', length: 32, nullable: true },
          { name: 'ENABLED', dataType: 'VARCHAR', length: 3, nullable: true, defaultValue: 'NO' },
          { name: 'ENABLED_BY', dataType: 'VARCHAR', length: 128, nullable: true },
          { name: 'ENABLED_DATE', dataType: 'TIMESTAMP', nullable: true },
        ],
        primaryKey: ['POLICY_NAME']
      },
      {
        name: 'UNIFIED_AUDIT_TRAIL$',
        columns: [
          { name: 'AUDIT_ID', dataType: 'INTEGER', nullable: false },
          { name: 'UNIFIED_AUDIT_POLICIES', dataType: 'VARCHAR', length: 4000, nullable: true },
          { name: 'FGA_POLICY_NAME', dataType: 'VARCHAR', length: 128, nullable: true },
          { name: 'ACTION_NAME', dataType: 'VARCHAR', length: 128, nullable: true },
          { name: 'OBJECT_SCHEMA', dataType: 'VARCHAR', length: 128, nullable: true },
          { name: 'OBJECT_NAME', dataType: 'VARCHAR', length: 128, nullable: true },
          { name: 'SQL_TEXT', dataType: 'VARCHAR', length: 4000, nullable: true },
          { name: 'SQL_BINDS', dataType: 'VARCHAR', length: 4000, nullable: true },
          { name: 'DBUSERNAME', dataType: 'VARCHAR', length: 128, nullable: true },
          { name: 'OS_USERNAME', dataType: 'VARCHAR', length: 255, nullable: true },
          { name: 'CLIENT_PROGRAM_NAME', dataType: 'VARCHAR', length: 128, nullable: true },
          { name: 'EVENT_TIMESTAMP', dataType: 'TIMESTAMP', nullable: true },
          { name: 'RETURN_CODE', dataType: 'INTEGER', nullable: true, defaultValue: 0 },
          { name: 'SESSION_ID', dataType: 'INTEGER', nullable: true },
          { name: 'AUTHENTICATION_TYPE', dataType: 'VARCHAR', length: 32, nullable: true },
          { name: 'SYSTEM_PRIVILEGE_USED', dataType: 'VARCHAR', length: 128, nullable: true },
          { name: 'TARGET_USER', dataType: 'VARCHAR', length: 128, nullable: true },
          { name: 'ROLE_NAME', dataType: 'VARCHAR', length: 128, nullable: true },
        ],
        primaryKey: ['AUDIT_ID']
      },
      // ========================================================================
      // Data Dictionary Tables (DBA_OBJECTS, DBA_TABLES, etc.)
      // ========================================================================
      {
        name: 'OBJ$',
        columns: [
          { name: 'OBJ_ID', dataType: 'INTEGER', nullable: false },
          { name: 'OWNER', dataType: 'VARCHAR', length: 128, nullable: false },
          { name: 'OBJECT_NAME', dataType: 'VARCHAR', length: 128, nullable: false },
          { name: 'OBJECT_TYPE', dataType: 'VARCHAR', length: 32, nullable: false },
          { name: 'CREATED', dataType: 'TIMESTAMP', nullable: true },
          { name: 'LAST_DDL_TIME', dataType: 'TIMESTAMP', nullable: true },
          { name: 'STATUS', dataType: 'VARCHAR', length: 10, nullable: true, defaultValue: 'VALID' },
          { name: 'TEMPORARY', dataType: 'VARCHAR', length: 1, nullable: true, defaultValue: 'N' },
          { name: 'GENERATED', dataType: 'VARCHAR', length: 1, nullable: true, defaultValue: 'N' },
        ],
        primaryKey: ['OBJ_ID']
      },
      {
        name: 'TAB$',
        columns: [
          { name: 'OBJ_ID', dataType: 'INTEGER', nullable: false },
          { name: 'OWNER', dataType: 'VARCHAR', length: 128, nullable: false },
          { name: 'TABLE_NAME', dataType: 'VARCHAR', length: 128, nullable: false },
          { name: 'TABLESPACE_NAME', dataType: 'VARCHAR', length: 128, nullable: true, defaultValue: 'USERS' },
          { name: 'NUM_ROWS', dataType: 'INTEGER', nullable: true, defaultValue: 0 },
          { name: 'BLOCKS', dataType: 'INTEGER', nullable: true, defaultValue: 0 },
          { name: 'AVG_ROW_LEN', dataType: 'INTEGER', nullable: true },
          { name: 'LAST_ANALYZED', dataType: 'TIMESTAMP', nullable: true },
          { name: 'PARTITIONED', dataType: 'VARCHAR', length: 3, nullable: true, defaultValue: 'NO' },
          { name: 'TEMPORARY', dataType: 'VARCHAR', length: 1, nullable: true, defaultValue: 'N' },
          { name: 'IOT_TYPE', dataType: 'VARCHAR', length: 12, nullable: true },
          { name: 'COMPRESSION', dataType: 'VARCHAR', length: 8, nullable: true, defaultValue: 'DISABLED' },
        ],
        primaryKey: ['OBJ_ID']
      },
      {
        name: 'COL$',
        columns: [
          { name: 'OBJ_ID', dataType: 'INTEGER', nullable: false },
          { name: 'OWNER', dataType: 'VARCHAR', length: 128, nullable: false },
          { name: 'TABLE_NAME', dataType: 'VARCHAR', length: 128, nullable: false },
          { name: 'COLUMN_NAME', dataType: 'VARCHAR', length: 128, nullable: false },
          { name: 'COLUMN_ID', dataType: 'INTEGER', nullable: false },
          { name: 'DATA_TYPE', dataType: 'VARCHAR', length: 106, nullable: true },
          { name: 'DATA_LENGTH', dataType: 'INTEGER', nullable: true },
          { name: 'DATA_PRECISION', dataType: 'INTEGER', nullable: true },
          { name: 'DATA_SCALE', dataType: 'INTEGER', nullable: true },
          { name: 'NULLABLE', dataType: 'VARCHAR', length: 1, nullable: true, defaultValue: 'Y' },
          { name: 'DEFAULT_VALUE', dataType: 'VARCHAR', length: 4000, nullable: true },
          { name: 'HIDDEN_COLUMN', dataType: 'VARCHAR', length: 3, nullable: true, defaultValue: 'NO' },
          { name: 'VIRTUAL_COLUMN', dataType: 'VARCHAR', length: 3, nullable: true, defaultValue: 'NO' },
        ],
        primaryKey: ['OBJ_ID', 'COLUMN_ID']
      },
      {
        name: 'IND$',
        columns: [
          { name: 'OBJ_ID', dataType: 'INTEGER', nullable: false },
          { name: 'OWNER', dataType: 'VARCHAR', length: 128, nullable: false },
          { name: 'INDEX_NAME', dataType: 'VARCHAR', length: 128, nullable: false },
          { name: 'TABLE_OWNER', dataType: 'VARCHAR', length: 128, nullable: false },
          { name: 'TABLE_NAME', dataType: 'VARCHAR', length: 128, nullable: false },
          { name: 'INDEX_TYPE', dataType: 'VARCHAR', length: 27, nullable: true, defaultValue: 'NORMAL' },
          { name: 'UNIQUENESS', dataType: 'VARCHAR', length: 9, nullable: true, defaultValue: 'NONUNIQUE' },
          { name: 'TABLESPACE_NAME', dataType: 'VARCHAR', length: 128, nullable: true },
          { name: 'STATUS', dataType: 'VARCHAR', length: 8, nullable: true, defaultValue: 'VALID' },
          { name: 'NUM_ROWS', dataType: 'INTEGER', nullable: true },
          { name: 'LAST_ANALYZED', dataType: 'TIMESTAMP', nullable: true },
          { name: 'COMPRESSION', dataType: 'VARCHAR', length: 8, nullable: true, defaultValue: 'DISABLED' },
        ],
        primaryKey: ['OBJ_ID']
      },
      {
        name: 'ICOL$',
        columns: [
          { name: 'INDEX_OBJ_ID', dataType: 'INTEGER', nullable: false },
          { name: 'COLUMN_NAME', dataType: 'VARCHAR', length: 128, nullable: false },
          { name: 'COLUMN_POSITION', dataType: 'INTEGER', nullable: false },
          { name: 'DESCEND', dataType: 'VARCHAR', length: 4, nullable: true, defaultValue: 'ASC' },
        ],
        primaryKey: ['INDEX_OBJ_ID', 'COLUMN_POSITION']
      },
      {
        name: 'CON$',
        columns: [
          { name: 'CON_ID', dataType: 'INTEGER', nullable: false },
          { name: 'OWNER', dataType: 'VARCHAR', length: 128, nullable: false },
          { name: 'CONSTRAINT_NAME', dataType: 'VARCHAR', length: 128, nullable: false },
          { name: 'CONSTRAINT_TYPE', dataType: 'VARCHAR', length: 1, nullable: false },
          { name: 'TABLE_NAME', dataType: 'VARCHAR', length: 128, nullable: false },
          { name: 'SEARCH_CONDITION', dataType: 'VARCHAR', length: 4000, nullable: true },
          { name: 'R_OWNER', dataType: 'VARCHAR', length: 128, nullable: true },
          { name: 'R_CONSTRAINT_NAME', dataType: 'VARCHAR', length: 128, nullable: true },
          { name: 'DELETE_RULE', dataType: 'VARCHAR', length: 9, nullable: true },
          { name: 'STATUS', dataType: 'VARCHAR', length: 8, nullable: true, defaultValue: 'ENABLED' },
          { name: 'VALIDATED', dataType: 'VARCHAR', length: 13, nullable: true, defaultValue: 'VALIDATED' },
          { name: 'GENERATED', dataType: 'VARCHAR', length: 14, nullable: true },
          { name: 'INDEX_NAME', dataType: 'VARCHAR', length: 128, nullable: true },
        ],
        primaryKey: ['CON_ID']
      },
      {
        name: 'CCOL$',
        columns: [
          { name: 'CON_ID', dataType: 'INTEGER', nullable: false },
          { name: 'COLUMN_NAME', dataType: 'VARCHAR', length: 128, nullable: false },
          { name: 'POSITION', dataType: 'INTEGER', nullable: true },
        ],
        primaryKey: ['CON_ID', 'COLUMN_NAME']
      },
      {
        name: 'SEQ$',
        columns: [
          { name: 'OBJ_ID', dataType: 'INTEGER', nullable: false },
          { name: 'SEQUENCE_OWNER', dataType: 'VARCHAR', length: 128, nullable: false },
          { name: 'SEQUENCE_NAME', dataType: 'VARCHAR', length: 128, nullable: false },
          { name: 'MIN_VALUE', dataType: 'INTEGER', nullable: true, defaultValue: 1 },
          { name: 'MAX_VALUE', dataType: 'INTEGER', nullable: true },
          { name: 'INCREMENT_BY', dataType: 'INTEGER', nullable: true, defaultValue: 1 },
          { name: 'CYCLE_FLAG', dataType: 'VARCHAR', length: 1, nullable: true, defaultValue: 'N' },
          { name: 'ORDER_FLAG', dataType: 'VARCHAR', length: 1, nullable: true, defaultValue: 'N' },
          { name: 'CACHE_SIZE', dataType: 'INTEGER', nullable: true, defaultValue: 20 },
          { name: 'LAST_NUMBER', dataType: 'INTEGER', nullable: true },
        ],
        primaryKey: ['OBJ_ID']
      },
      {
        name: 'TS$',
        columns: [
          { name: 'TS_ID', dataType: 'INTEGER', nullable: false },
          { name: 'TABLESPACE_NAME', dataType: 'VARCHAR', length: 128, nullable: false },
          { name: 'BLOCK_SIZE', dataType: 'INTEGER', nullable: true, defaultValue: 8192 },
          { name: 'INITIAL_EXTENT', dataType: 'INTEGER', nullable: true },
          { name: 'NEXT_EXTENT', dataType: 'INTEGER', nullable: true },
          { name: 'MIN_EXTENTS', dataType: 'INTEGER', nullable: true, defaultValue: 1 },
          { name: 'MAX_EXTENTS', dataType: 'INTEGER', nullable: true },
          { name: 'STATUS', dataType: 'VARCHAR', length: 9, nullable: true, defaultValue: 'ONLINE' },
          { name: 'CONTENTS', dataType: 'VARCHAR', length: 9, nullable: true, defaultValue: 'PERMANENT' },
          { name: 'LOGGING', dataType: 'VARCHAR', length: 9, nullable: true, defaultValue: 'LOGGING' },
          { name: 'BIGFILE', dataType: 'VARCHAR', length: 3, nullable: true, defaultValue: 'NO' },
          { name: 'ENCRYPTED', dataType: 'VARCHAR', length: 3, nullable: true, defaultValue: 'NO' },
        ],
        primaryKey: ['TS_ID']
      },
      {
        name: 'FILE$',
        columns: [
          { name: 'FILE_ID', dataType: 'INTEGER', nullable: false },
          { name: 'TABLESPACE_NAME', dataType: 'VARCHAR', length: 128, nullable: false },
          { name: 'FILE_NAME', dataType: 'VARCHAR', length: 513, nullable: false },
          { name: 'BYTES', dataType: 'INTEGER', nullable: true },
          { name: 'BLOCKS', dataType: 'INTEGER', nullable: true },
          { name: 'STATUS', dataType: 'VARCHAR', length: 9, nullable: true, defaultValue: 'AVAILABLE' },
          { name: 'AUTOEXTENSIBLE', dataType: 'VARCHAR', length: 3, nullable: true, defaultValue: 'NO' },
          { name: 'MAXBYTES', dataType: 'INTEGER', nullable: true },
          { name: 'MAXBLOCKS', dataType: 'INTEGER', nullable: true },
          { name: 'INCREMENT_BY', dataType: 'INTEGER', nullable: true },
          { name: 'ONLINE_STATUS', dataType: 'VARCHAR', length: 7, nullable: true, defaultValue: 'ONLINE' },
        ],
        primaryKey: ['FILE_ID']
      },
      {
        name: 'SESSION$',
        columns: [
          { name: 'SID', dataType: 'INTEGER', nullable: false },
          { name: 'SERIAL_NUM', dataType: 'INTEGER', nullable: false },
          { name: 'USERNAME', dataType: 'VARCHAR', length: 128, nullable: true },
          { name: 'STATUS', dataType: 'VARCHAR', length: 8, nullable: true, defaultValue: 'ACTIVE' },
          { name: 'OSUSER', dataType: 'VARCHAR', length: 128, nullable: true },
          { name: 'MACHINE', dataType: 'VARCHAR', length: 64, nullable: true },
          { name: 'TERMINAL', dataType: 'VARCHAR', length: 30, nullable: true },
          { name: 'PROGRAM', dataType: 'VARCHAR', length: 48, nullable: true },
          { name: 'SQL_ID', dataType: 'VARCHAR', length: 13, nullable: true },
          { name: 'LOGON_TIME', dataType: 'TIMESTAMP', nullable: true },
          { name: 'LAST_CALL_ET', dataType: 'INTEGER', nullable: true },
          { name: 'BLOCKING_SESSION', dataType: 'INTEGER', nullable: true },
          { name: 'EVENT', dataType: 'VARCHAR', length: 64, nullable: true },
          { name: 'WAIT_CLASS', dataType: 'VARCHAR', length: 64, nullable: true },
          { name: 'SCHEMA_NAME', dataType: 'VARCHAR', length: 128, nullable: true },
        ],
        primaryKey: ['SID', 'SERIAL_NUM']
      },
      {
        name: 'SYNONYM$',
        columns: [
          { name: 'OWNER', dataType: 'VARCHAR', length: 128, nullable: false },
          { name: 'SYNONYM_NAME', dataType: 'VARCHAR', length: 128, nullable: false },
          { name: 'TABLE_OWNER', dataType: 'VARCHAR', length: 128, nullable: true },
          { name: 'TABLE_NAME', dataType: 'VARCHAR', length: 128, nullable: false },
          { name: 'DB_LINK', dataType: 'VARCHAR', length: 128, nullable: true },
        ],
        primaryKey: ['OWNER', 'SYNONYM_NAME']
      },
      {
        name: 'VIEW$',
        columns: [
          { name: 'OBJ_ID', dataType: 'INTEGER', nullable: false },
          { name: 'OWNER', dataType: 'VARCHAR', length: 128, nullable: false },
          { name: 'VIEW_NAME', dataType: 'VARCHAR', length: 128, nullable: false },
          { name: 'TEXT_LENGTH', dataType: 'INTEGER', nullable: true },
          { name: 'VIEW_TEXT', dataType: 'VARCHAR', length: 4000, nullable: true },
          { name: 'TYPE_TEXT_LENGTH', dataType: 'INTEGER', nullable: true },
          { name: 'TYPE_TEXT', dataType: 'VARCHAR', length: 4000, nullable: true },
          { name: 'OID_TEXT_LENGTH', dataType: 'INTEGER', nullable: true },
          { name: 'OID_TEXT', dataType: 'VARCHAR', length: 4000, nullable: true },
          { name: 'READ_ONLY', dataType: 'VARCHAR', length: 3, nullable: true, defaultValue: 'NO' },
        ],
        primaryKey: ['OBJ_ID']
      },
      {
        name: 'TRIGGER$',
        columns: [
          { name: 'OBJ_ID', dataType: 'INTEGER', nullable: false },
          { name: 'OWNER', dataType: 'VARCHAR', length: 128, nullable: false },
          { name: 'TRIGGER_NAME', dataType: 'VARCHAR', length: 128, nullable: false },
          { name: 'TRIGGER_TYPE', dataType: 'VARCHAR', length: 16, nullable: true },
          { name: 'TRIGGERING_EVENT', dataType: 'VARCHAR', length: 246, nullable: true },
          { name: 'TABLE_OWNER', dataType: 'VARCHAR', length: 128, nullable: true },
          { name: 'BASE_OBJECT_TYPE', dataType: 'VARCHAR', length: 18, nullable: true },
          { name: 'TABLE_NAME', dataType: 'VARCHAR', length: 128, nullable: true },
          { name: 'COLUMN_NAME', dataType: 'VARCHAR', length: 4000, nullable: true },
          { name: 'REFERENCING_NAMES', dataType: 'VARCHAR', length: 422, nullable: true },
          { name: 'WHEN_CLAUSE', dataType: 'VARCHAR', length: 4000, nullable: true },
          { name: 'STATUS', dataType: 'VARCHAR', length: 8, nullable: true, defaultValue: 'ENABLED' },
          { name: 'DESCRIPTION', dataType: 'VARCHAR', length: 4000, nullable: true },
          { name: 'ACTION_TYPE', dataType: 'VARCHAR', length: 11, nullable: true },
          { name: 'TRIGGER_BODY', dataType: 'VARCHAR', length: 4000, nullable: true },
        ],
        primaryKey: ['OBJ_ID']
      },
      {
        name: 'SOURCE$',
        columns: [
          { name: 'OWNER', dataType: 'VARCHAR', length: 128, nullable: false },
          { name: 'OBJ_NAME', dataType: 'VARCHAR', length: 128, nullable: false },
          { name: 'OBJ_TYPE', dataType: 'VARCHAR', length: 12, nullable: false },
          { name: 'LINE_NUM', dataType: 'INTEGER', nullable: false },
          { name: 'SOURCE_TEXT', dataType: 'VARCHAR', length: 4000, nullable: true },
        ],
        primaryKey: ['OWNER', 'OBJ_NAME', 'OBJ_TYPE', 'LINE_NUM']
      },
      {
        name: 'LINK$',
        columns: [
          { name: 'OWNER', dataType: 'VARCHAR', length: 128, nullable: false },
          { name: 'DB_LINK', dataType: 'VARCHAR', length: 128, nullable: false },
          { name: 'USERNAME', dataType: 'VARCHAR', length: 128, nullable: true },
          { name: 'HOST', dataType: 'VARCHAR', length: 2000, nullable: true },
          { name: 'CREATED', dataType: 'TIMESTAMP', nullable: true },
        ],
        primaryKey: ['OWNER', 'DB_LINK']
      },
      {
        name: 'PARAMETER$',
        columns: [
          { name: 'PARAM_NUM', dataType: 'INTEGER', nullable: false },
          { name: 'PARAM_NAME', dataType: 'VARCHAR', length: 80, nullable: false },
          { name: 'PARAM_TYPE', dataType: 'INTEGER', nullable: true },
          { name: 'PARAM_VALUE', dataType: 'VARCHAR', length: 4000, nullable: true },
          { name: 'DISPLAY_VALUE', dataType: 'VARCHAR', length: 4000, nullable: true },
          { name: 'ISDEFAULT', dataType: 'VARCHAR', length: 9, nullable: true },
          { name: 'ISSES_MODIFIABLE', dataType: 'VARCHAR', length: 5, nullable: true },
          { name: 'ISSYS_MODIFIABLE', dataType: 'VARCHAR', length: 9, nullable: true },
          { name: 'ISINSTANCE_MODIFIABLE', dataType: 'VARCHAR', length: 5, nullable: true },
          { name: 'DESCRIPTION', dataType: 'VARCHAR', length: 255, nullable: true },
        ],
        primaryKey: ['PARAM_NUM']
      },
      // ========================================================================
      // Redo Logs & Archiving (V$LOG, V$LOGFILE, V$ARCHIVED_LOG)
      // ========================================================================
      {
        name: 'V_LOG$',
        columns: [
          { name: 'GROUP_NUM', dataType: 'INTEGER', nullable: false },
          { name: 'THREAD_NUM', dataType: 'INTEGER', nullable: true, defaultValue: 1 },
          { name: 'SEQUENCE_NUM', dataType: 'INTEGER', nullable: true, defaultValue: 0 },
          { name: 'LOG_BYTES', dataType: 'INTEGER', nullable: true, defaultValue: 52428800 },
          { name: 'BLOCKSIZE', dataType: 'INTEGER', nullable: true, defaultValue: 512 },
          { name: 'MEMBERS', dataType: 'INTEGER', nullable: true, defaultValue: 1 },
          { name: 'ARCHIVED', dataType: 'VARCHAR', length: 3, nullable: true, defaultValue: 'NO' },
          { name: 'STATUS', dataType: 'VARCHAR', length: 16, nullable: true, defaultValue: 'UNUSED' },
          { name: 'FIRST_CHANGE', dataType: 'INTEGER', nullable: true, defaultValue: 0 },
          { name: 'FIRST_TIME', dataType: 'TIMESTAMP', nullable: true },
          { name: 'NEXT_CHANGE', dataType: 'INTEGER', nullable: true },
          { name: 'NEXT_TIME', dataType: 'TIMESTAMP', nullable: true },
          { name: 'CON_ID', dataType: 'INTEGER', nullable: true, defaultValue: 0 },
        ],
        primaryKey: ['GROUP_NUM']
      },
      {
        name: 'V_LOGFILE$',
        columns: [
          { name: 'GROUP_NUM', dataType: 'INTEGER', nullable: false },
          { name: 'STATUS', dataType: 'VARCHAR', length: 16, nullable: true, defaultValue: 'VALID' },
          { name: 'FILE_TYPE', dataType: 'VARCHAR', length: 16, nullable: true, defaultValue: 'ONLINE' },
          { name: 'MEMBER', dataType: 'VARCHAR', length: 512, nullable: false },
          { name: 'IS_RECOVERY_DEST_FILE', dataType: 'VARCHAR', length: 3, nullable: true, defaultValue: 'NO' },
          { name: 'CON_ID', dataType: 'INTEGER', nullable: true, defaultValue: 0 },
        ],
        primaryKey: ['GROUP_NUM', 'MEMBER']
      },
      {
        name: 'V_ARCHIVED_LOG$',
        columns: [
          { name: 'RECID', dataType: 'INTEGER', nullable: false },
          { name: 'STAMP', dataType: 'INTEGER', nullable: true },
          { name: 'NAME', dataType: 'VARCHAR', length: 512, nullable: true },
          { name: 'DEST_ID', dataType: 'INTEGER', nullable: true, defaultValue: 1 },
          { name: 'THREAD_NUM', dataType: 'INTEGER', nullable: true, defaultValue: 1 },
          { name: 'SEQUENCE_NUM', dataType: 'INTEGER', nullable: true },
          { name: 'RESETLOGS_CHANGE', dataType: 'INTEGER', nullable: true },
          { name: 'RESETLOGS_TIME', dataType: 'TIMESTAMP', nullable: true },
          { name: 'FIRST_CHANGE', dataType: 'INTEGER', nullable: true },
          { name: 'FIRST_TIME', dataType: 'TIMESTAMP', nullable: true },
          { name: 'NEXT_CHANGE', dataType: 'INTEGER', nullable: true },
          { name: 'NEXT_TIME', dataType: 'TIMESTAMP', nullable: true },
          { name: 'BLOCKS', dataType: 'INTEGER', nullable: true },
          { name: 'BLOCK_SIZE', dataType: 'INTEGER', nullable: true, defaultValue: 512 },
          { name: 'ARCHIVED', dataType: 'VARCHAR', length: 3, nullable: true, defaultValue: 'YES' },
          { name: 'APPLIED', dataType: 'VARCHAR', length: 9, nullable: true, defaultValue: 'NO' },
          { name: 'DELETED', dataType: 'VARCHAR', length: 3, nullable: true, defaultValue: 'NO' },
          { name: 'STATUS', dataType: 'VARCHAR', length: 1, nullable: true, defaultValue: 'A' },
          { name: 'COMPLETION_TIME', dataType: 'TIMESTAMP', nullable: true },
          { name: 'COMPRESSED', dataType: 'VARCHAR', length: 3, nullable: true, defaultValue: 'NO' },
          { name: 'CON_ID', dataType: 'INTEGER', nullable: true, defaultValue: 0 },
        ],
        primaryKey: ['RECID']
      },
      // ========================================================================
      // RMAN Backup (V$BACKUP, V$RMAN_BACKUP_JOB_DETAILS)
      // ========================================================================
      {
        name: 'V_BACKUP$',
        columns: [
          { name: 'FILE_NUM', dataType: 'INTEGER', nullable: false },
          { name: 'STATUS', dataType: 'VARCHAR', length: 18, nullable: true, defaultValue: 'NOT ACTIVE' },
          { name: 'CHANGE_NUM', dataType: 'INTEGER', nullable: true },
          { name: 'BACKUP_TIME', dataType: 'TIMESTAMP', nullable: true },
          { name: 'CON_ID', dataType: 'INTEGER', nullable: true, defaultValue: 0 },
        ],
        primaryKey: ['FILE_NUM']
      },
      {
        name: 'V_RMAN_BACKUP_JOB_DETAILS$',
        columns: [
          { name: 'SESSION_KEY', dataType: 'INTEGER', nullable: false },
          { name: 'SESSION_RECID', dataType: 'INTEGER', nullable: true },
          { name: 'SESSION_STAMP', dataType: 'INTEGER', nullable: true },
          { name: 'COMMAND_ID', dataType: 'VARCHAR', length: 128, nullable: true },
          { name: 'START_TIME', dataType: 'TIMESTAMP', nullable: true },
          { name: 'END_TIME', dataType: 'TIMESTAMP', nullable: true },
          { name: 'INPUT_TYPE', dataType: 'VARCHAR', length: 32, nullable: true },
          { name: 'STATUS', dataType: 'VARCHAR', length: 32, nullable: true, defaultValue: 'COMPLETED' },
          { name: 'OUTPUT_DEVICE_TYPE', dataType: 'VARCHAR', length: 32, nullable: true, defaultValue: 'DISK' },
          { name: 'INPUT_BYTES', dataType: 'INTEGER', nullable: true, defaultValue: 0 },
          { name: 'OUTPUT_BYTES', dataType: 'INTEGER', nullable: true, defaultValue: 0 },
          { name: 'INPUT_BYTES_PER_SEC', dataType: 'INTEGER', nullable: true, defaultValue: 0 },
          { name: 'OUTPUT_BYTES_PER_SEC', dataType: 'INTEGER', nullable: true, defaultValue: 0 },
          { name: 'ELAPSED_SECONDS', dataType: 'INTEGER', nullable: true, defaultValue: 0 },
          { name: 'COMPRESSION_RATIO', dataType: 'DECIMAL', nullable: true, defaultValue: 1.00 },
          { name: 'INPUT_BYTES_DISPLAY', dataType: 'VARCHAR', length: 32, nullable: true },
          { name: 'OUTPUT_BYTES_DISPLAY', dataType: 'VARCHAR', length: 32, nullable: true },
          { name: 'TIME_TAKEN_DISPLAY', dataType: 'VARCHAR', length: 32, nullable: true },
          { name: 'CON_ID', dataType: 'INTEGER', nullable: true, defaultValue: 0 },
        ],
        primaryKey: ['SESSION_KEY']
      },
      // ========================================================================
      // Locks & Transactions (V$LOCK, V$TRANSACTION, V$SESSION_WAIT)
      // ========================================================================
      {
        name: 'V_LOCK$',
        columns: [
          { name: 'ADDR', dataType: 'VARCHAR', length: 32, nullable: false },
          { name: 'KADDR', dataType: 'VARCHAR', length: 32, nullable: true },
          { name: 'SID', dataType: 'INTEGER', nullable: false },
          { name: 'LOCK_TYPE', dataType: 'VARCHAR', length: 2, nullable: false },
          { name: 'ID1', dataType: 'INTEGER', nullable: true, defaultValue: 0 },
          { name: 'ID2', dataType: 'INTEGER', nullable: true, defaultValue: 0 },
          { name: 'LMODE', dataType: 'INTEGER', nullable: true, defaultValue: 0 },
          { name: 'REQUEST', dataType: 'INTEGER', nullable: true, defaultValue: 0 },
          { name: 'CTIME', dataType: 'INTEGER', nullable: true, defaultValue: 0 },
          { name: 'BLOCK_STATUS', dataType: 'INTEGER', nullable: true, defaultValue: 0 },
          { name: 'CON_ID', dataType: 'INTEGER', nullable: true, defaultValue: 0 },
        ],
        primaryKey: ['ADDR']
      },
      {
        name: 'V_TRANSACTION$',
        columns: [
          { name: 'ADDR', dataType: 'VARCHAR', length: 32, nullable: false },
          { name: 'XIDUSN', dataType: 'INTEGER', nullable: true, defaultValue: 0 },
          { name: 'XIDSLOT', dataType: 'INTEGER', nullable: true, defaultValue: 0 },
          { name: 'XIDSQN', dataType: 'INTEGER', nullable: true, defaultValue: 0 },
          { name: 'UBAFIL', dataType: 'INTEGER', nullable: true, defaultValue: 0 },
          { name: 'UBABLK', dataType: 'INTEGER', nullable: true, defaultValue: 0 },
          { name: 'STATUS', dataType: 'VARCHAR', length: 16, nullable: true, defaultValue: 'ACTIVE' },
          { name: 'START_TIME', dataType: 'VARCHAR', length: 32, nullable: true },
          { name: 'SES_ADDR', dataType: 'VARCHAR', length: 32, nullable: true },
          { name: 'FLAG', dataType: 'INTEGER', nullable: true, defaultValue: 0 },
          { name: 'SPACE', dataType: 'VARCHAR', length: 3, nullable: true, defaultValue: 'NO' },
          { name: 'RECURSIVE', dataType: 'VARCHAR', length: 3, nullable: true, defaultValue: 'NO' },
          { name: 'NOUNDO', dataType: 'VARCHAR', length: 3, nullable: true, defaultValue: 'NO' },
          { name: 'NAME', dataType: 'VARCHAR', length: 256, nullable: true },
          { name: 'USED_UBLK', dataType: 'INTEGER', nullable: true, defaultValue: 0 },
          { name: 'USED_UREC', dataType: 'INTEGER', nullable: true, defaultValue: 0 },
          { name: 'LOG_IO', dataType: 'INTEGER', nullable: true, defaultValue: 0 },
          { name: 'PHY_IO', dataType: 'INTEGER', nullable: true, defaultValue: 0 },
          { name: 'CR_GET', dataType: 'INTEGER', nullable: true, defaultValue: 0 },
          { name: 'CR_CHANGE', dataType: 'INTEGER', nullable: true, defaultValue: 0 },
          { name: 'CON_ID', dataType: 'INTEGER', nullable: true, defaultValue: 0 },
        ],
        primaryKey: ['ADDR']
      },
      {
        name: 'V_SESSION_WAIT$',
        columns: [
          { name: 'SID', dataType: 'INTEGER', nullable: false },
          { name: 'SEQ_NUM', dataType: 'INTEGER', nullable: true, defaultValue: 0 },
          { name: 'EVENT', dataType: 'VARCHAR', length: 64, nullable: true },
          { name: 'P1TEXT', dataType: 'VARCHAR', length: 64, nullable: true },
          { name: 'P1', dataType: 'INTEGER', nullable: true, defaultValue: 0 },
          { name: 'P2TEXT', dataType: 'VARCHAR', length: 64, nullable: true },
          { name: 'P2', dataType: 'INTEGER', nullable: true, defaultValue: 0 },
          { name: 'P3TEXT', dataType: 'VARCHAR', length: 64, nullable: true },
          { name: 'P3', dataType: 'INTEGER', nullable: true, defaultValue: 0 },
          { name: 'WAIT_CLASS_ID', dataType: 'INTEGER', nullable: true, defaultValue: 0 },
          { name: 'WAIT_CLASS', dataType: 'VARCHAR', length: 64, nullable: true, defaultValue: 'Other' },
          { name: 'WAIT_TIME', dataType: 'INTEGER', nullable: true, defaultValue: 0 },
          { name: 'SECONDS_IN_WAIT', dataType: 'INTEGER', nullable: true, defaultValue: 0 },
          { name: 'STATE', dataType: 'VARCHAR', length: 32, nullable: true, defaultValue: 'WAITED SHORT TIME' },
          { name: 'CON_ID', dataType: 'INTEGER', nullable: true, defaultValue: 0 },
        ],
        primaryKey: ['SID']
      },
      {
        name: 'V_WAITSTAT$',
        columns: [
          { name: 'WAIT_CLASS', dataType: 'VARCHAR', length: 64, nullable: false },
          { name: 'COUNT_VAL', dataType: 'INTEGER', nullable: true, defaultValue: 0 },
          { name: 'TIME_VAL', dataType: 'INTEGER', nullable: true, defaultValue: 0 },
          { name: 'CON_ID', dataType: 'INTEGER', nullable: true, defaultValue: 0 },
        ],
        primaryKey: ['WAIT_CLASS']
      },
      // ========================================================================
      // Memory/SGA (V$SGA, V$SGASTAT)
      // ========================================================================
      {
        name: 'V_SGA$',
        columns: [
          { name: 'NAME', dataType: 'VARCHAR', length: 64, nullable: false },
          { name: 'VALUE_BYTES', dataType: 'INTEGER', nullable: true, defaultValue: 0 },
          { name: 'CON_ID', dataType: 'INTEGER', nullable: true, defaultValue: 0 },
        ],
        primaryKey: ['NAME']
      },
      {
        name: 'V_SGASTAT$',
        columns: [
          { name: 'POOL', dataType: 'VARCHAR', length: 32, nullable: true },
          { name: 'COMPONENT_NAME', dataType: 'VARCHAR', length: 64, nullable: false },
          { name: 'BYTES_VAL', dataType: 'INTEGER', nullable: true, defaultValue: 0 },
          { name: 'CON_ID', dataType: 'INTEGER', nullable: true, defaultValue: 0 },
        ],
        primaryKey: ['COMPONENT_NAME']
      },
      // ========================================================================
      // Performance SQL (V$SQL, V$SQLAREA)
      // ========================================================================
      {
        name: 'V_SQL$',
        columns: [
          { name: 'SQL_ID', dataType: 'VARCHAR', length: 32, nullable: false },
          { name: 'CHILD_NUMBER', dataType: 'INTEGER', nullable: true, defaultValue: 0 },
          { name: 'SQL_TEXT', dataType: 'VARCHAR', length: 4000, nullable: true },
          { name: 'SHARABLE_MEM', dataType: 'INTEGER', nullable: true, defaultValue: 0 },
          { name: 'PERSISTENT_MEM', dataType: 'INTEGER', nullable: true, defaultValue: 0 },
          { name: 'RUNTIME_MEM', dataType: 'INTEGER', nullable: true, defaultValue: 0 },
          { name: 'SORTS', dataType: 'INTEGER', nullable: true, defaultValue: 0 },
          { name: 'FETCHES', dataType: 'INTEGER', nullable: true, defaultValue: 0 },
          { name: 'EXECUTIONS', dataType: 'INTEGER', nullable: true, defaultValue: 1 },
          { name: 'PARSE_CALLS', dataType: 'INTEGER', nullable: true, defaultValue: 1 },
          { name: 'DISK_READS', dataType: 'INTEGER', nullable: true, defaultValue: 0 },
          { name: 'DIRECT_READS', dataType: 'INTEGER', nullable: true, defaultValue: 0 },
          { name: 'DIRECT_WRITES', dataType: 'INTEGER', nullable: true, defaultValue: 0 },
          { name: 'BUFFER_GETS', dataType: 'INTEGER', nullable: true, defaultValue: 0 },
          { name: 'ROWS_PROCESSED', dataType: 'INTEGER', nullable: true, defaultValue: 0 },
          { name: 'CPU_TIME', dataType: 'INTEGER', nullable: true, defaultValue: 0 },
          { name: 'ELAPSED_TIME', dataType: 'INTEGER', nullable: true, defaultValue: 0 },
          { name: 'OPTIMIZER_MODE', dataType: 'VARCHAR', length: 32, nullable: true, defaultValue: 'ALL_ROWS' },
          { name: 'OPTIMIZER_COST', dataType: 'INTEGER', nullable: true, defaultValue: 0 },
          { name: 'PARSING_SCHEMA_NAME', dataType: 'VARCHAR', length: 128, nullable: true },
          { name: 'FIRST_LOAD_TIME', dataType: 'VARCHAR', length: 32, nullable: true },
          { name: 'LAST_LOAD_TIME', dataType: 'TIMESTAMP', nullable: true },
          { name: 'LAST_ACTIVE_TIME', dataType: 'TIMESTAMP', nullable: true },
          { name: 'PLAN_HASH_VALUE', dataType: 'INTEGER', nullable: true, defaultValue: 0 },
          { name: 'MODULE', dataType: 'VARCHAR', length: 128, nullable: true },
          { name: 'ACTION', dataType: 'VARCHAR', length: 128, nullable: true },
          { name: 'IS_OBSOLETE', dataType: 'VARCHAR', length: 1, nullable: true, defaultValue: 'N' },
          { name: 'OBJECT_STATUS', dataType: 'VARCHAR', length: 32, nullable: true, defaultValue: 'VALID' },
          { name: 'CON_ID', dataType: 'INTEGER', nullable: true, defaultValue: 0 },
        ],
        primaryKey: ['SQL_ID']
      },
      {
        name: 'V_SQLAREA$',
        columns: [
          { name: 'SQL_ID', dataType: 'VARCHAR', length: 32, nullable: false },
          { name: 'SQL_TEXT', dataType: 'VARCHAR', length: 4000, nullable: true },
          { name: 'SHARABLE_MEM', dataType: 'INTEGER', nullable: true, defaultValue: 0 },
          { name: 'PERSISTENT_MEM', dataType: 'INTEGER', nullable: true, defaultValue: 0 },
          { name: 'RUNTIME_MEM', dataType: 'INTEGER', nullable: true, defaultValue: 0 },
          { name: 'SORTS', dataType: 'INTEGER', nullable: true, defaultValue: 0 },
          { name: 'VERSION_COUNT', dataType: 'INTEGER', nullable: true, defaultValue: 1 },
          { name: 'FETCHES', dataType: 'INTEGER', nullable: true, defaultValue: 0 },
          { name: 'EXECUTIONS', dataType: 'INTEGER', nullable: true, defaultValue: 1 },
          { name: 'LOADS', dataType: 'INTEGER', nullable: true, defaultValue: 1 },
          { name: 'FIRST_LOAD_TIME', dataType: 'VARCHAR', length: 32, nullable: true },
          { name: 'LAST_LOAD_TIME', dataType: 'TIMESTAMP', nullable: true },
          { name: 'LAST_ACTIVE_TIME', dataType: 'TIMESTAMP', nullable: true },
          { name: 'INVALIDATIONS', dataType: 'INTEGER', nullable: true, defaultValue: 0 },
          { name: 'PARSE_CALLS', dataType: 'INTEGER', nullable: true, defaultValue: 1 },
          { name: 'DISK_READS', dataType: 'INTEGER', nullable: true, defaultValue: 0 },
          { name: 'BUFFER_GETS', dataType: 'INTEGER', nullable: true, defaultValue: 0 },
          { name: 'ROWS_PROCESSED', dataType: 'INTEGER', nullable: true, defaultValue: 0 },
          { name: 'CPU_TIME', dataType: 'INTEGER', nullable: true, defaultValue: 0 },
          { name: 'ELAPSED_TIME', dataType: 'INTEGER', nullable: true, defaultValue: 0 },
          { name: 'PARSING_SCHEMA_NAME', dataType: 'VARCHAR', length: 128, nullable: true },
          { name: 'OPTIMIZER_MODE', dataType: 'VARCHAR', length: 32, nullable: true, defaultValue: 'ALL_ROWS' },
          { name: 'MODULE', dataType: 'VARCHAR', length: 128, nullable: true },
          { name: 'ACTION', dataType: 'VARCHAR', length: 128, nullable: true },
          { name: 'CON_ID', dataType: 'INTEGER', nullable: true, defaultValue: 0 },
        ],
        primaryKey: ['SQL_ID']
      },
      // ========================================================================
      // Scheduler Jobs (DBA_SCHEDULER_JOBS, DBA_SCHEDULER_JOB_LOG)
      // ========================================================================
      {
        name: 'SCHEDULER_JOB$',
        columns: [
          { name: 'OWNER', dataType: 'VARCHAR', length: 128, nullable: false },
          { name: 'JOB_NAME', dataType: 'VARCHAR', length: 128, nullable: false },
          { name: 'JOB_SUBNAME', dataType: 'VARCHAR', length: 128, nullable: true },
          { name: 'JOB_STYLE', dataType: 'VARCHAR', length: 32, nullable: true, defaultValue: 'REGULAR' },
          { name: 'JOB_CREATOR', dataType: 'VARCHAR', length: 128, nullable: true },
          { name: 'JOB_TYPE', dataType: 'VARCHAR', length: 32, nullable: true },
          { name: 'JOB_ACTION', dataType: 'VARCHAR', length: 4000, nullable: true },
          { name: 'NUMBER_OF_ARGUMENTS', dataType: 'INTEGER', nullable: true, defaultValue: 0 },
          { name: 'SCHEDULE_TYPE', dataType: 'VARCHAR', length: 32, nullable: true, defaultValue: 'ONCE' },
          { name: 'START_DATE', dataType: 'TIMESTAMP', nullable: true },
          { name: 'REPEAT_INTERVAL', dataType: 'VARCHAR', length: 256, nullable: true },
          { name: 'END_DATE', dataType: 'TIMESTAMP', nullable: true },
          { name: 'JOB_CLASS', dataType: 'VARCHAR', length: 128, nullable: true, defaultValue: 'DEFAULT_JOB_CLASS' },
          { name: 'ENABLED', dataType: 'VARCHAR', length: 5, nullable: true, defaultValue: 'FALSE' },
          { name: 'AUTO_DROP', dataType: 'VARCHAR', length: 5, nullable: true, defaultValue: 'TRUE' },
          { name: 'STATE', dataType: 'VARCHAR', length: 32, nullable: true, defaultValue: 'DISABLED' },
          { name: 'JOB_PRIORITY', dataType: 'INTEGER', nullable: true, defaultValue: 3 },
          { name: 'RUN_COUNT', dataType: 'INTEGER', nullable: true, defaultValue: 0 },
          { name: 'MAX_RUNS', dataType: 'INTEGER', nullable: true },
          { name: 'FAILURE_COUNT', dataType: 'INTEGER', nullable: true, defaultValue: 0 },
          { name: 'MAX_FAILURES', dataType: 'INTEGER', nullable: true },
          { name: 'RETRY_COUNT', dataType: 'INTEGER', nullable: true, defaultValue: 0 },
          { name: 'LAST_START_DATE', dataType: 'TIMESTAMP', nullable: true },
          { name: 'LAST_RUN_DURATION', dataType: 'INTEGER', nullable: true },
          { name: 'NEXT_RUN_DATE', dataType: 'TIMESTAMP', nullable: true },
          { name: 'LOGGING_LEVEL', dataType: 'VARCHAR', length: 32, nullable: true, defaultValue: 'RUNS' },
          { name: 'COMMENTS', dataType: 'VARCHAR', length: 4000, nullable: true },
          { name: 'RESTARTABLE', dataType: 'VARCHAR', length: 5, nullable: true, defaultValue: 'FALSE' },
        ],
        primaryKey: ['OWNER', 'JOB_NAME']
      },
      {
        name: 'SCHEDULER_JOB_LOG$',
        columns: [
          { name: 'LOG_ID', dataType: 'INTEGER', nullable: false },
          { name: 'LOG_DATE', dataType: 'TIMESTAMP', nullable: true },
          { name: 'OWNER', dataType: 'VARCHAR', length: 128, nullable: false },
          { name: 'JOB_NAME', dataType: 'VARCHAR', length: 128, nullable: false },
          { name: 'JOB_SUBNAME', dataType: 'VARCHAR', length: 128, nullable: true },
          { name: 'JOB_CLASS', dataType: 'VARCHAR', length: 128, nullable: true, defaultValue: 'DEFAULT_JOB_CLASS' },
          { name: 'OPERATION', dataType: 'VARCHAR', length: 32, nullable: true },
          { name: 'STATUS', dataType: 'VARCHAR', length: 32, nullable: true },
          { name: 'USER_NAME', dataType: 'VARCHAR', length: 128, nullable: true },
          { name: 'REQ_START_DATE', dataType: 'TIMESTAMP', nullable: true },
          { name: 'ACTUAL_START_DATE', dataType: 'TIMESTAMP', nullable: true },
          { name: 'RUN_DURATION', dataType: 'INTEGER', nullable: true },
          { name: 'INSTANCE_ID', dataType: 'INTEGER', nullable: true },
          { name: 'SESSION_ID', dataType: 'INTEGER', nullable: true },
          { name: 'CPU_USED', dataType: 'INTEGER', nullable: true },
          { name: 'ADDITIONAL_INFO', dataType: 'VARCHAR', length: 4000, nullable: true },
          { name: 'ERRORS', dataType: 'VARCHAR', length: 4000, nullable: true },
          { name: 'OUTPUT', dataType: 'VARCHAR', length: 4000, nullable: true },
        ],
        primaryKey: ['LOG_ID']
      },
      // ========================================================================
      // Database Links (DBA_DB_LINKS)
      // ========================================================================
      {
        name: 'DB_LINK$',
        columns: [
          { name: 'OWNER', dataType: 'VARCHAR', length: 128, nullable: false },
          { name: 'DB_LINK', dataType: 'VARCHAR', length: 128, nullable: false },
          { name: 'USERNAME', dataType: 'VARCHAR', length: 128, nullable: true },
          { name: 'HOST', dataType: 'VARCHAR', length: 2000, nullable: true },
          { name: 'CREATED', dataType: 'TIMESTAMP', nullable: true },
          { name: 'HIDDEN', dataType: 'VARCHAR', length: 3, nullable: true, defaultValue: 'NO' },
          { name: 'VALID', dataType: 'VARCHAR', length: 3, nullable: true, defaultValue: 'YES' },
        ],
        primaryKey: ['OWNER', 'DB_LINK']
      },
      // ========================================================================
      // Resource Manager (DBA_RSRC_PLANS, DBA_RSRC_CONSUMER_GROUPS)
      // ========================================================================
      {
        name: 'RSRC_PLAN$',
        columns: [
          { name: 'PLAN', dataType: 'VARCHAR', length: 128, nullable: false },
          { name: 'NUM_PLAN_DIRECTIVES', dataType: 'INTEGER', nullable: true, defaultValue: 0 },
          { name: 'CPU_METHOD', dataType: 'VARCHAR', length: 128, nullable: true, defaultValue: 'EMPHASIS' },
          { name: 'MGMT_METHOD', dataType: 'VARCHAR', length: 128, nullable: true, defaultValue: 'EMPHASIS' },
          { name: 'ACTIVE_SESS_POOL_MTH', dataType: 'VARCHAR', length: 128, nullable: true },
          { name: 'PARALLEL_DEGREE_LIMIT_MTH', dataType: 'VARCHAR', length: 128, nullable: true },
          { name: 'QUEUING_MTH', dataType: 'VARCHAR', length: 128, nullable: true, defaultValue: 'FIFO_TIMEOUT' },
          { name: 'STATUS', dataType: 'VARCHAR', length: 16, nullable: true },
          { name: 'MANDATORY', dataType: 'VARCHAR', length: 3, nullable: true, defaultValue: 'NO' },
          { name: 'COMMENTS', dataType: 'VARCHAR', length: 2000, nullable: true },
          { name: 'CON_ID', dataType: 'INTEGER', nullable: true, defaultValue: 0 },
        ],
        primaryKey: ['PLAN']
      },
      {
        name: 'RSRC_CONSUMER_GROUP$',
        columns: [
          { name: 'CONSUMER_GROUP', dataType: 'VARCHAR', length: 128, nullable: false },
          { name: 'CPU_METHOD', dataType: 'VARCHAR', length: 128, nullable: true, defaultValue: 'ROUND-ROBIN' },
          { name: 'MGMT_METHOD', dataType: 'VARCHAR', length: 128, nullable: true, defaultValue: 'ROUND-ROBIN' },
          { name: 'INTERNAL_USE', dataType: 'VARCHAR', length: 3, nullable: true, defaultValue: 'NO' },
          { name: 'COMMENTS', dataType: 'VARCHAR', length: 2000, nullable: true },
          { name: 'CATEGORY', dataType: 'VARCHAR', length: 128, nullable: true, defaultValue: 'OTHER' },
          { name: 'STATUS', dataType: 'VARCHAR', length: 16, nullable: true },
          { name: 'MANDATORY', dataType: 'VARCHAR', length: 3, nullable: true, defaultValue: 'NO' },
          { name: 'CON_ID', dataType: 'INTEGER', nullable: true, defaultValue: 0 },
        ],
        primaryKey: ['CONSUMER_GROUP']
      },
      {
        name: 'RSRC_PLAN_DIRECTIVE$',
        columns: [
          { name: 'PLAN', dataType: 'VARCHAR', length: 128, nullable: false },
          { name: 'GROUP_OR_SUBPLAN', dataType: 'VARCHAR', length: 128, nullable: false },
          { name: 'DIRECTIVE_TYPE', dataType: 'VARCHAR', length: 32, nullable: true, defaultValue: 'PLAN_DIRECTIVE' },
          { name: 'MGMT_P1', dataType: 'INTEGER', nullable: true, defaultValue: 0 },
          { name: 'MGMT_P2', dataType: 'INTEGER', nullable: true, defaultValue: 0 },
          { name: 'MGMT_P3', dataType: 'INTEGER', nullable: true, defaultValue: 0 },
          { name: 'MGMT_P4', dataType: 'INTEGER', nullable: true, defaultValue: 0 },
          { name: 'SWITCH_GROUP', dataType: 'VARCHAR', length: 128, nullable: true },
          { name: 'SWITCH_TIME', dataType: 'INTEGER', nullable: true },
          { name: 'MAX_EST_EXEC_TIME', dataType: 'INTEGER', nullable: true },
          { name: 'UNDO_POOL', dataType: 'INTEGER', nullable: true },
          { name: 'MAX_IDLE_TIME', dataType: 'INTEGER', nullable: true },
          { name: 'SHARES', dataType: 'INTEGER', nullable: true, defaultValue: 1 },
          { name: 'UTILIZATION_LIMIT', dataType: 'INTEGER', nullable: true, defaultValue: 100 },
          { name: 'PARALLEL_SERVER_LIMIT', dataType: 'INTEGER', nullable: true, defaultValue: 100 },
          { name: 'COMMENTS', dataType: 'VARCHAR', length: 2000, nullable: true },
          { name: 'STATUS', dataType: 'VARCHAR', length: 16, nullable: true },
          { name: 'CON_ID', dataType: 'INTEGER', nullable: true, defaultValue: 0 },
        ],
        primaryKey: ['PLAN', 'GROUP_OR_SUBPLAN']
      },
      // ========================================================================
      // Flashback (DBA_FLASHBACK_ARCHIVE, V$FLASHBACK_DATABASE_LOG)
      // ========================================================================
      {
        name: 'FLASHBACK_ARCHIVE$',
        columns: [
          { name: 'FLASHBACK_ARCHIVE_NAME', dataType: 'VARCHAR', length: 255, nullable: false },
          { name: 'FLASHBACK_ARCHIVE_NUM', dataType: 'INTEGER', nullable: true },
          { name: 'RETENTION_IN_DAYS', dataType: 'INTEGER', nullable: true, defaultValue: 365 },
          { name: 'CREATE_TIME', dataType: 'TIMESTAMP', nullable: true },
          { name: 'LAST_PURGE_TIME', dataType: 'TIMESTAMP', nullable: true },
          { name: 'STATUS', dataType: 'VARCHAR', length: 16, nullable: true, defaultValue: 'ENABLED' },
          { name: 'QUOTA_IN_MB', dataType: 'INTEGER', nullable: true },
        ],
        primaryKey: ['FLASHBACK_ARCHIVE_NAME']
      },
      {
        name: 'FLASHBACK_ARCHIVE_TABLES$',
        columns: [
          { name: 'TABLE_NAME', dataType: 'VARCHAR', length: 128, nullable: false },
          { name: 'OWNER_NAME', dataType: 'VARCHAR', length: 128, nullable: false },
          { name: 'FLASHBACK_ARCHIVE_NAME', dataType: 'VARCHAR', length: 255, nullable: false },
          { name: 'ARCHIVE_TABLE_NAME', dataType: 'VARCHAR', length: 128, nullable: true },
          { name: 'STATUS', dataType: 'VARCHAR', length: 16, nullable: true, defaultValue: 'ENABLED' },
        ],
        primaryKey: ['OWNER_NAME', 'TABLE_NAME']
      },
      {
        name: 'V_FLASHBACK_DATABASE_LOG$',
        columns: [
          { name: 'OLDEST_FLASHBACK_SCN', dataType: 'INTEGER', nullable: true },
          { name: 'OLDEST_FLASHBACK_TIME', dataType: 'TIMESTAMP', nullable: true },
          { name: 'RETENTION_TARGET', dataType: 'INTEGER', nullable: true, defaultValue: 1440 },
          { name: 'FLASHBACK_SIZE', dataType: 'INTEGER', nullable: true, defaultValue: 0 },
          { name: 'ESTIMATED_FLASHBACK_SIZE', dataType: 'INTEGER', nullable: true, defaultValue: 0 },
          { name: 'CON_ID', dataType: 'INTEGER', nullable: true, defaultValue: 0 },
        ],
        primaryKey: ['CON_ID']
      },
      // ========================================================================
      // Alert/Diagnostics (V$DIAG_ALERT_EXT)
      // ========================================================================
      {
        name: 'V_DIAG_ALERT_EXT$',
        columns: [
          { name: 'RECORD_ID', dataType: 'INTEGER', nullable: false },
          { name: 'ORIGINATING_TIMESTAMP', dataType: 'TIMESTAMP', nullable: true },
          { name: 'COMPONENT_ID', dataType: 'VARCHAR', length: 128, nullable: true },
          { name: 'HOST_ID', dataType: 'VARCHAR', length: 256, nullable: true },
          { name: 'HOST_ADDRESS', dataType: 'VARCHAR', length: 64, nullable: true },
          { name: 'MESSAGE_TYPE', dataType: 'INTEGER', nullable: true, defaultValue: 0 },
          { name: 'MESSAGE_LEVEL', dataType: 'INTEGER', nullable: true, defaultValue: 0 },
          { name: 'MESSAGE_ID', dataType: 'VARCHAR', length: 128, nullable: true },
          { name: 'MESSAGE_GROUP', dataType: 'VARCHAR', length: 128, nullable: true },
          { name: 'CLIENT_ID', dataType: 'VARCHAR', length: 256, nullable: true },
          { name: 'MODULE_ID', dataType: 'VARCHAR', length: 256, nullable: true },
          { name: 'PROCESS_ID', dataType: 'VARCHAR', length: 128, nullable: true },
          { name: 'USER_ID', dataType: 'VARCHAR', length: 128, nullable: true },
          { name: 'INSTANCE_ID', dataType: 'VARCHAR', length: 128, nullable: true },
          { name: 'PROBLEM_KEY', dataType: 'VARCHAR', length: 256, nullable: true },
          { name: 'MESSAGE_TEXT', dataType: 'VARCHAR', length: 4000, nullable: true },
          { name: 'FILENAME', dataType: 'VARCHAR', length: 512, nullable: true },
          { name: 'CON_ID', dataType: 'INTEGER', nullable: true, defaultValue: 0 },
        ],
        primaryKey: ['RECORD_ID']
      },
    ];

    for (const tableDef of tables) {
      this.engine.createTable({
        type: 'CREATE_TABLE',
        table: tableDef.name,
        schema: 'SYS',
        columns: tableDef.columns,
        primaryKey: tableDef.primaryKey,
        foreignKeys: [],
        uniqueConstraints: [],
        checkConstraints: [],
        ifNotExists: true
      });
    }

    // Insert initial data
    const initStatements = getInitialDataSQL();
    for (const sql of initStatements) {
      try {
        this.executeSQL(sql);
      } catch (e) {
        // Ignore duplicate key errors during initialization
      }
    }

    this.engine.setCurrentSchema(originalSchema);
    this.initialized = true;
  }

  /**
   * Execute SQL on the security tables
   */
  private executeSQL(sql: string): SQLResult {
    const originalSchema = this.engine.getCurrentSchema();
    this.engine.setCurrentSchema('SYS');

    try {
      // Parse and execute
      const parseResult = parseSQL(sql);

      if (!parseResult.success || parseResult.statements.length === 0) {
        return createErrorResult('PARSE_ERROR', 'Failed to parse SQL');
      }

      const stmt = parseResult.statements[0];
      let result: SQLResult;

      switch (stmt.type) {
        case 'SELECT':
          result = this.engine.executeSelect(stmt);
          break;
        case 'INSERT':
          result = this.engine.executeInsert(stmt);
          break;
        case 'UPDATE':
          result = this.engine.executeUpdate(stmt);
          break;
        case 'DELETE':
          result = this.engine.executeDelete(stmt);
          break;
        default:
          result = createSuccessResult();
      }

      return result;
    } finally {
      this.engine.setCurrentSchema(originalSchema);
    }
  }

  /**
   * Query a security table
   */
  private queryTable(sql: string): any[] {
    const result = this.executeSQL(sql);
    if (result.success && result.resultSet) {
      return result.resultSet.rows;
    }
    return [];
  }

  // ==========================================================================
  // Authentication
  // ==========================================================================

  authenticate(username: string, password: string, options?: {
    osUser?: string;
    terminal?: string;
    clientIp?: string;
  }): { success: boolean; error?: string; sessionId?: number } {
    const upperUsername = username.toUpperCase();

    // Query user from database
    const users = this.queryTable(
      `SELECT USER_ID, USERNAME, PASSWORD_HASH, ACCOUNT_STATUS, USER_PROFILE, FAILED_LOGIN_ATTEMPTS ` +
      `FROM USER$ WHERE USERNAME = '${upperUsername}'`
    );

    if (users.length === 0) {
      this.auditAction('LOGON_FAILED', upperUsername, { returnCode: 1017, comment: 'User does not exist' });
      return { success: false, error: 'ORA-01017: invalid username/password; logon denied' };
    }

    const user = users[0];

    // Check account status
    if (user.ACCOUNT_STATUS === 'LOCKED' || user.ACCOUNT_STATUS === 'EXPIRED & LOCKED') {
      this.auditAction('LOGON_FAILED', upperUsername, { returnCode: 28000, comment: 'Account is locked' });
      return { success: false, error: 'ORA-28000: the account is locked' };
    }

    // Verify password
    if (!verifyPassword(password, user.PASSWORD_HASH)) {
      const attempts = (user.FAILED_LOGIN_ATTEMPTS || 0) + 1;

      // Update failed attempts
      this.executeSQL(
        `UPDATE USER$ SET FAILED_LOGIN_ATTEMPTS = ${attempts} WHERE USERNAME = '${upperUsername}'`
      );

      // Get max attempts from profile
      const profileRows = this.queryTable(
        `SELECT LIMIT_VALUE FROM PROFILE$ WHERE PROFILE_NAME = '${user.USER_PROFILE || 'DEFAULT'}' AND RESOURCE_NAME = 'FAILED_LOGIN_ATTEMPTS'`
      );
      const maxAttempts = profileRows.length > 0 && profileRows[0].LIMIT_VALUE !== 'UNLIMITED'
        ? parseInt(profileRows[0].LIMIT_VALUE, 10)
        : 10;

      if (attempts >= maxAttempts) {
        this.executeSQL(
          `UPDATE USER$ SET ACCOUNT_STATUS = 'LOCKED', LOCK_DATE = '${new Date().toISOString()}' WHERE USERNAME = '${upperUsername}'`
        );
        this.auditAction('LOGON_FAILED', upperUsername, { returnCode: 28000, comment: `Account locked after ${attempts} failed attempts` });
        return { success: false, error: 'ORA-28000: the account is locked' };
      }

      this.auditAction('LOGON_FAILED', upperUsername, { returnCode: 1017, comment: `Failed attempt ${attempts}` });
      return { success: false, error: 'ORA-01017: invalid username/password; logon denied' };
    }

    // Check password expiration
    if (user.ACCOUNT_STATUS === 'EXPIRED') {
      this.auditAction('LOGON_FAILED', upperUsername, { returnCode: 28001, comment: 'Password expired' });
      return { success: false, error: 'ORA-28001: the password has expired' };
    }

    // Check CREATE SESSION privilege
    if (!this.hasPrivilege(upperUsername, 'CREATE SESSION')) {
      this.auditAction('LOGON_FAILED', upperUsername, { returnCode: 1045, comment: 'Lacks CREATE SESSION privilege' });
      return { success: false, error: 'ORA-01045: user lacks CREATE SESSION privilege; logon denied' };
    }

    // Success - reset failed attempts and update last login
    this.executeSQL(
      `UPDATE USER$ SET FAILED_LOGIN_ATTEMPTS = 0, LAST_LOGIN = '${new Date().toISOString()}' WHERE USERNAME = '${upperUsername}'`
    );

    const sessionId = this.currentSessionId++;
    this.auditAction('LOGON', upperUsername, { sessionId, returnCode: 0 });

    return { success: true, sessionId };
  }

  logout(username: string, sessionId: number): void {
    this.auditAction('LOGOFF', username.toUpperCase(), { sessionId, returnCode: 0 });
  }

  // ==========================================================================
  // User Management
  // ==========================================================================

  createUser(
    username: string,
    password: string,
    options?: {
      defaultTablespace?: string;
      temporaryTablespace?: string;
      profile?: string;
      quota?: Map<string, number | 'UNLIMITED'>;
      accountLocked?: boolean;
      passwordExpire?: boolean;
    },
    createdBy?: string
  ): SQLResult {
    const upperUsername = username.toUpperCase();

    // Check if user already exists
    const existing = this.queryTable(`SELECT 1 FROM USER$ WHERE USERNAME = '${upperUsername}'`);
    if (existing.length > 0) {
      return createErrorResult('01920', `ORA-01920: user name '${upperUsername}' conflicts with another user or role name`);
    }

    // Check if conflicts with role
    const roleConflict = this.queryTable(`SELECT 1 FROM ROLE$ WHERE ROLE_NAME = '${upperUsername}'`);
    if (roleConflict.length > 0) {
      return createErrorResult('01920', `ORA-01920: user name '${upperUsername}' conflicts with another user or role name`);
    }

    const userId = this.userSequence++;
    const hashedPassword = hashPassword(password);
    const status = options?.accountLocked ? 'LOCKED' : (options?.passwordExpire ? 'EXPIRED' : 'OPEN');
    const now = new Date().toISOString();

    const result = this.executeSQL(
      `INSERT INTO USER$ (USER_ID, USERNAME, PASSWORD_HASH, ACCOUNT_STATUS, DEFAULT_TABLESPACE, TEMPORARY_TABLESPACE, USER_PROFILE, CREATED, FAILED_LOGIN_ATTEMPTS) ` +
      `VALUES (${userId}, '${upperUsername}', '${hashedPassword}', '${status}', '${options?.defaultTablespace || 'USERS'}', '${options?.temporaryTablespace || 'TEMP'}', '${options?.profile || 'DEFAULT'}', '${now}', 0)`
    );

    if (result.success) {
      this.auditAction('CREATE_USER', createdBy || 'SYSTEM', {
        objectName: upperUsername,
        objectType: 'USER',
        returnCode: 0
      });
    }

    return result.success ? createSuccessResult() : result;
  }

  alterUser(
    username: string,
    changes: {
      password?: string;
      defaultTablespace?: string;
      temporaryTablespace?: string;
      profile?: string;
      accountLock?: boolean;
      accountUnlock?: boolean;
      passwordExpire?: boolean;
    },
    alteredBy?: string
  ): SQLResult {
    const upperUsername = username.toUpperCase();

    // Check user exists
    const existing = this.queryTable(`SELECT ACCOUNT_STATUS FROM USER$ WHERE USERNAME = '${upperUsername}'`);
    if (existing.length === 0) {
      return createErrorResult('01918', `ORA-01918: user '${upperUsername}' does not exist`);
    }

    const updates: string[] = [];

    if (changes.password !== undefined) {
      updates.push(`PASSWORD_HASH = '${hashPassword(changes.password)}'`);
      if (existing[0].ACCOUNT_STATUS === 'EXPIRED') {
        updates.push(`ACCOUNT_STATUS = 'OPEN'`);
      }
    }

    if (changes.defaultTablespace !== undefined) {
      updates.push(`DEFAULT_TABLESPACE = '${changes.defaultTablespace}'`);
    }

    if (changes.temporaryTablespace !== undefined) {
      updates.push(`TEMPORARY_TABLESPACE = '${changes.temporaryTablespace}'`);
    }

    if (changes.profile !== undefined) {
      updates.push(`USER_PROFILE = '${changes.profile}'`);
    }

    if (changes.accountLock) {
      updates.push(`ACCOUNT_STATUS = 'LOCKED'`);
      updates.push(`LOCK_DATE = '${new Date().toISOString()}'`);
    }

    if (changes.accountUnlock) {
      const currentStatus = existing[0].ACCOUNT_STATUS;
      if (currentStatus === 'LOCKED') {
        updates.push(`ACCOUNT_STATUS = 'OPEN'`);
      } else if (currentStatus === 'EXPIRED & LOCKED') {
        updates.push(`ACCOUNT_STATUS = 'EXPIRED'`);
      }
      updates.push(`LOCK_DATE = NULL`);
      updates.push(`FAILED_LOGIN_ATTEMPTS = 0`);
    }

    if (changes.passwordExpire) {
      const currentStatus = existing[0].ACCOUNT_STATUS;
      if (currentStatus === 'LOCKED') {
        updates.push(`ACCOUNT_STATUS = 'EXPIRED & LOCKED'`);
      } else {
        updates.push(`ACCOUNT_STATUS = 'EXPIRED'`);
      }
      updates.push(`EXPIRY_DATE = '${new Date().toISOString()}'`);
    }

    if (updates.length === 0) {
      return createSuccessResult();
    }

    const result = this.executeSQL(
      `UPDATE USER$ SET ${updates.join(', ')} WHERE USERNAME = '${upperUsername}'`
    );

    if (result.success) {
      this.auditAction('ALTER_USER', alteredBy || 'SYSTEM', {
        objectName: upperUsername,
        objectType: 'USER',
        returnCode: 0
      });
    }

    return result.success ? createSuccessResult() : result;
  }

  dropUser(username: string, cascade: boolean = false, droppedBy?: string): SQLResult {
    const upperUsername = username.toUpperCase();

    // Prevent dropping system users
    if (['SYS', 'SYSTEM', 'PUBLIC'].includes(upperUsername)) {
      return createErrorResult('01031', `ORA-01031: insufficient privileges to drop ${upperUsername}`);
    }

    // Check user exists
    const existing = this.queryTable(`SELECT 1 FROM USER$ WHERE USERNAME = '${upperUsername}'`);
    if (existing.length === 0) {
      return createErrorResult('01918', `ORA-01918: user '${upperUsername}' does not exist`);
    }

    // Delete user and related data
    this.executeSQL(`DELETE FROM ROLEAUTH$ WHERE GRANTEE = '${upperUsername}'`);
    this.executeSQL(`DELETE FROM SYSAUTH$ WHERE GRANTEE = '${upperUsername}'`);
    this.executeSQL(`DELETE FROM OBJAUTH$ WHERE GRANTEE = '${upperUsername}'`);
    this.executeSQL(`DELETE FROM TSQUOTA$ WHERE USERNAME = '${upperUsername}'`);

    const result = this.executeSQL(`DELETE FROM USER$ WHERE USERNAME = '${upperUsername}'`);

    if (result.success) {
      this.auditAction('DROP_USER', droppedBy || 'SYSTEM', {
        objectName: upperUsername,
        objectType: 'USER',
        returnCode: 0
      });
    }

    return result.success ? createSuccessResult() : result;
  }

  // ==========================================================================
  // Role Management
  // ==========================================================================

  createRole(roleName: string, password?: string, createdBy?: string): SQLResult {
    const upperRoleName = roleName.toUpperCase();

    // Check conflicts
    const roleExists = this.queryTable(`SELECT 1 FROM ROLE$ WHERE ROLE_NAME = '${upperRoleName}'`);
    if (roleExists.length > 0) {
      return createErrorResult('01921', `ORA-01921: role name '${upperRoleName}' conflicts with another user or role name`);
    }

    const userExists = this.queryTable(`SELECT 1 FROM USER$ WHERE USERNAME = '${upperRoleName}'`);
    if (userExists.length > 0) {
      return createErrorResult('01921', `ORA-01921: role name '${upperRoleName}' conflicts with another user or role name`);
    }

    const roleId = this.roleSequence++;
    const now = new Date().toISOString();
    const hashedPassword = password ? hashPassword(password) : '';
    const passwordRequired = password ? 'Y' : 'N';

    const result = this.executeSQL(
      `INSERT INTO ROLE$ (ROLE_ID, ROLE_NAME, PASSWORD_REQUIRED, PASSWORD_HASH, AUTHENTICATION_TYPE, CREATED_BY, CREATED) ` +
      `VALUES (${roleId}, '${upperRoleName}', '${passwordRequired}', '${hashedPassword}', '${password ? 'PASSWORD' : 'NONE'}', '${createdBy || 'SYSTEM'}', '${now}')`
    );

    if (result.success) {
      this.auditAction('CREATE_ROLE', createdBy || 'SYSTEM', {
        objectName: upperRoleName,
        objectType: 'ROLE',
        returnCode: 0
      });
    }

    return result.success ? createSuccessResult() : result;
  }

  dropRole(roleName: string, droppedBy?: string): SQLResult {
    const upperRoleName = roleName.toUpperCase();

    // Check role exists
    const existing = this.queryTable(`SELECT CREATED_BY FROM ROLE$ WHERE ROLE_NAME = '${upperRoleName}'`);
    if (existing.length === 0) {
      return createErrorResult('01919', `ORA-01919: role '${upperRoleName}' does not exist`);
    }

    // Prevent dropping built-in roles
    if (['CONNECT', 'RESOURCE', 'DBA'].includes(upperRoleName) && existing[0].CREATED_BY === 'SYS') {
      return createErrorResult('01031', `ORA-01031: insufficient privileges to drop built-in role ${upperRoleName}`);
    }

    // Remove role from all grantees
    this.executeSQL(`DELETE FROM ROLEAUTH$ WHERE GRANTED_ROLE = '${upperRoleName}'`);
    this.executeSQL(`DELETE FROM SYSAUTH$ WHERE GRANTEE = '${upperRoleName}'`);

    const result = this.executeSQL(`DELETE FROM ROLE$ WHERE ROLE_NAME = '${upperRoleName}'`);

    if (result.success) {
      this.auditAction('DROP_ROLE', droppedBy || 'SYSTEM', {
        objectName: upperRoleName,
        objectType: 'ROLE',
        returnCode: 0
      });
    }

    return result.success ? createSuccessResult() : result;
  }

  // ==========================================================================
  // Privilege Management
  // ==========================================================================

  grantSystemPrivilege(
    privilege: string,
    grantee: string,
    withAdminOption: boolean = false,
    grantedBy?: string
  ): SQLResult {
    const upperPrivilege = privilege.toUpperCase();
    const upperGrantee = grantee.toUpperCase();
    const now = new Date().toISOString();

    // Check grantee exists (user or role)
    const userExists = this.queryTable(`SELECT 1 FROM USER$ WHERE USERNAME = '${upperGrantee}'`);
    const roleExists = this.queryTable(`SELECT 1 FROM ROLE$ WHERE ROLE_NAME = '${upperGrantee}'`);

    if (userExists.length === 0 && roleExists.length === 0) {
      return createErrorResult('01917', `ORA-01917: user or role '${upperGrantee}' does not exist`);
    }

    // Delete existing grant first (to handle update of admin option)
    this.executeSQL(`DELETE FROM SYSAUTH$ WHERE GRANTEE = '${upperGrantee}' AND PRIVILEGE = '${upperPrivilege}'`);

    const result = this.executeSQL(
      `INSERT INTO SYSAUTH$ (GRANTEE, PRIVILEGE, ADMIN_OPTION, GRANTED_BY, GRANT_DATE) ` +
      `VALUES ('${upperGrantee}', '${upperPrivilege}', '${withAdminOption ? 'YES' : 'NO'}', '${grantedBy || 'SYSTEM'}', '${now}')`
    );

    if (result.success) {
      this.auditAction('GRANT', grantedBy || 'SYSTEM', {
        objectName: upperPrivilege,
        objectType: 'SYSTEM PRIVILEGE',
        comment: `Granted to ${upperGrantee}`,
        returnCode: 0
      });
    }

    return result.success ? createSuccessResult() : result;
  }

  revokeSystemPrivilege(privilege: string, grantee: string, revokedBy?: string): SQLResult {
    const upperPrivilege = privilege.toUpperCase();
    const upperGrantee = grantee.toUpperCase();

    const result = this.executeSQL(
      `DELETE FROM SYSAUTH$ WHERE GRANTEE = '${upperGrantee}' AND PRIVILEGE = '${upperPrivilege}'`
    );

    if (result.success) {
      this.auditAction('REVOKE', revokedBy || 'SYSTEM', {
        objectName: upperPrivilege,
        objectType: 'SYSTEM PRIVILEGE',
        comment: `Revoked from ${upperGrantee}`,
        returnCode: 0
      });
    }

    return result.success ? createSuccessResult() : result;
  }

  grantRole(
    roleName: string,
    grantee: string,
    withAdminOption: boolean = false,
    grantedBy?: string
  ): SQLResult {
    const upperRoleName = roleName.toUpperCase();
    const upperGrantee = grantee.toUpperCase();
    const now = new Date().toISOString();

    // Check role exists
    const roleExists = this.queryTable(`SELECT 1 FROM ROLE$ WHERE ROLE_NAME = '${upperRoleName}'`);
    if (roleExists.length === 0) {
      return createErrorResult('01919', `ORA-01919: role '${upperRoleName}' does not exist`);
    }

    // Check grantee exists
    const userExists = this.queryTable(`SELECT 1 FROM USER$ WHERE USERNAME = '${upperGrantee}'`);
    const granteeRoleExists = this.queryTable(`SELECT 1 FROM ROLE$ WHERE ROLE_NAME = '${upperGrantee}'`);

    if (userExists.length === 0 && granteeRoleExists.length === 0) {
      return createErrorResult('01917', `ORA-01917: user or role '${upperGrantee}' does not exist`);
    }

    // Check for circular grant
    if (granteeRoleExists.length > 0 && this.wouldCreateCircularGrant(upperRoleName, upperGrantee)) {
      return createErrorResult('01934', `ORA-01934: circular role grant detected`);
    }

    // Delete existing grant first
    this.executeSQL(`DELETE FROM ROLEAUTH$ WHERE GRANTEE = '${upperGrantee}' AND GRANTED_ROLE = '${upperRoleName}'`);

    const result = this.executeSQL(
      `INSERT INTO ROLEAUTH$ (GRANTEE, GRANTED_ROLE, ADMIN_OPTION, DEFAULT_ROLE, GRANTED_BY, GRANT_DATE) ` +
      `VALUES ('${upperGrantee}', '${upperRoleName}', '${withAdminOption ? 'YES' : 'NO'}', 'YES', '${grantedBy || 'SYSTEM'}', '${now}')`
    );

    if (result.success) {
      this.auditAction('GRANT', grantedBy || 'SYSTEM', {
        objectName: upperRoleName,
        objectType: 'ROLE',
        comment: `Granted to ${upperGrantee}`,
        returnCode: 0
      });
    }

    return result.success ? createSuccessResult() : result;
  }

  revokeRole(roleName: string, grantee: string, revokedBy?: string): SQLResult {
    const upperRoleName = roleName.toUpperCase();
    const upperGrantee = grantee.toUpperCase();

    const result = this.executeSQL(
      `DELETE FROM ROLEAUTH$ WHERE GRANTEE = '${upperGrantee}' AND GRANTED_ROLE = '${upperRoleName}'`
    );

    if (result.success) {
      this.auditAction('REVOKE', revokedBy || 'SYSTEM', {
        objectName: upperRoleName,
        objectType: 'ROLE',
        comment: `Revoked from ${upperGrantee}`,
        returnCode: 0
      });
    }

    return result.success ? createSuccessResult() : result;
  }

  grantObjectPrivilege(
    privilege: string,
    objectOwner: string,
    objectName: string,
    grantee: string,
    withGrantOption: boolean = false,
    grantedBy?: string
  ): SQLResult {
    const upperPrivilege = privilege.toUpperCase();
    const upperOwner = objectOwner.toUpperCase();
    const upperObject = objectName.toUpperCase();
    const upperGrantee = grantee.toUpperCase();
    const now = new Date().toISOString();

    // Delete existing grant first
    this.executeSQL(
      `DELETE FROM OBJAUTH$ WHERE GRANTEE = '${upperGrantee}' AND OWNER = '${upperOwner}' ` +
      `AND TABLE_NAME = '${upperObject}' AND PRIVILEGE = '${upperPrivilege}'`
    );

    const result = this.executeSQL(
      `INSERT INTO OBJAUTH$ (GRANTEE, OWNER, TABLE_NAME, PRIVILEGE, GRANTABLE, GRANTOR, GRANT_DATE) ` +
      `VALUES ('${upperGrantee}', '${upperOwner}', '${upperObject}', '${upperPrivilege}', '${withGrantOption ? 'YES' : 'NO'}', '${grantedBy || 'SYSTEM'}', '${now}')`
    );

    if (result.success) {
      this.auditAction('GRANT', grantedBy || 'SYSTEM', {
        objectSchema: upperOwner,
        objectName: upperObject,
        objectType: 'OBJECT PRIVILEGE',
        comment: `${upperPrivilege} granted to ${upperGrantee}`,
        returnCode: 0
      });
    }

    return result.success ? createSuccessResult() : result;
  }

  revokeObjectPrivilege(
    privilege: string,
    objectOwner: string,
    objectName: string,
    grantee: string,
    revokedBy?: string
  ): SQLResult {
    const upperPrivilege = privilege.toUpperCase();
    const upperOwner = objectOwner.toUpperCase();
    const upperObject = objectName.toUpperCase();
    const upperGrantee = grantee.toUpperCase();

    const result = this.executeSQL(
      `DELETE FROM OBJAUTH$ WHERE GRANTEE = '${upperGrantee}' AND OWNER = '${upperOwner}' ` +
      `AND TABLE_NAME = '${upperObject}' AND PRIVILEGE = '${upperPrivilege}'`
    );

    if (result.success) {
      this.auditAction('REVOKE', revokedBy || 'SYSTEM', {
        objectSchema: upperOwner,
        objectName: upperObject,
        objectType: 'OBJECT PRIVILEGE',
        comment: `${upperPrivilege} revoked from ${upperGrantee}`,
        returnCode: 0
      });
    }

    return result.success ? createSuccessResult() : result;
  }

  // ==========================================================================
  // Privilege Checking
  // ==========================================================================

  hasPrivilege(username: string, privilege: string): boolean {
    const upperUsername = username.toUpperCase();
    const upperPrivilege = privilege.toUpperCase();

    // SYS has all privileges
    if (upperUsername === 'SYS') {
      return true;
    }

    // Check for SYSDBA
    const sysdba = this.queryTable(
      `SELECT 1 FROM SYSAUTH$ WHERE GRANTEE = '${upperUsername}' AND PRIVILEGE = 'SYSDBA'`
    );
    if (sysdba.length > 0) {
      return true;
    }

    // Check direct privilege
    const directPriv = this.queryTable(
      `SELECT 1 FROM SYSAUTH$ WHERE GRANTEE = '${upperUsername}' AND PRIVILEGE = '${upperPrivilege}'`
    );
    if (directPriv.length > 0) {
      return true;
    }

    // Check privileges from roles (recursively)
    return this.hasPrivilegeFromRoles(upperUsername, upperPrivilege, new Set());
  }

  private hasPrivilegeFromRoles(grantee: string, privilege: string, visited: Set<string>): boolean {
    // Get all roles granted to this grantee
    const roles = this.queryTable(
      `SELECT GRANTED_ROLE FROM ROLEAUTH$ WHERE GRANTEE = '${grantee}'`
    );

    for (const row of roles) {
      const roleName = row.GRANTED_ROLE;
      if (visited.has(roleName)) continue;
      visited.add(roleName);

      // Check if role has the privilege
      const rolePriv = this.queryTable(
        `SELECT 1 FROM SYSAUTH$ WHERE GRANTEE = '${roleName}' AND PRIVILEGE = '${privilege}'`
      );
      if (rolePriv.length > 0) {
        return true;
      }

      // Check nested roles
      if (this.hasPrivilegeFromRoles(roleName, privilege, visited)) {
        return true;
      }
    }

    return false;
  }

  hasObjectPrivilege(
    username: string,
    privilege: string,
    objectOwner: string,
    objectName: string
  ): boolean {
    const upperUsername = username.toUpperCase();
    const upperPrivilege = privilege.toUpperCase();
    const upperOwner = objectOwner.toUpperCase();
    const upperObject = objectName.toUpperCase();

    // Owner has all privileges on their objects
    if (upperUsername === upperOwner) {
      return true;
    }

    // SYS has all privileges
    if (upperUsername === 'SYS') {
      return true;
    }

    // Check for ANY privilege
    const anyPrivilege = `${upperPrivilege} ANY TABLE`;
    if (this.hasPrivilege(upperUsername, anyPrivilege)) {
      return true;
    }

    // Check direct object privilege
    const directObjPriv = this.queryTable(
      `SELECT 1 FROM OBJAUTH$ WHERE GRANTEE = '${upperUsername}' AND OWNER = '${upperOwner}' ` +
      `AND TABLE_NAME = '${upperObject}' AND (PRIVILEGE = '${upperPrivilege}' OR PRIVILEGE = 'ALL')`
    );
    if (directObjPriv.length > 0) {
      return true;
    }

    // Check object privileges from roles
    return this.hasObjectPrivilegeFromRoles(upperUsername, upperPrivilege, upperOwner, upperObject, new Set());
  }

  private hasObjectPrivilegeFromRoles(
    grantee: string,
    privilege: string,
    objectOwner: string,
    objectName: string,
    visited: Set<string>
  ): boolean {
    const roles = this.queryTable(
      `SELECT GRANTED_ROLE FROM ROLEAUTH$ WHERE GRANTEE = '${grantee}'`
    );

    for (const row of roles) {
      const roleName = row.GRANTED_ROLE;
      if (visited.has(roleName)) continue;
      visited.add(roleName);

      // Check if role has the object privilege
      const roleObjPriv = this.queryTable(
        `SELECT 1 FROM OBJAUTH$ WHERE GRANTEE = '${roleName}' AND OWNER = '${objectOwner}' ` +
        `AND TABLE_NAME = '${objectName}' AND (PRIVILEGE = '${privilege}' OR PRIVILEGE = 'ALL')`
      );
      if (roleObjPriv.length > 0) {
        return true;
      }

      // Check nested roles
      if (this.hasObjectPrivilegeFromRoles(roleName, privilege, objectOwner, objectName, visited)) {
        return true;
      }
    }

    return false;
  }

  private wouldCreateCircularGrant(roleName: string, targetRole: string): boolean {
    if (roleName === targetRole) return true;

    const visited = new Set<string>();
    const queue = [roleName];

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current === targetRole) return true;
      if (visited.has(current)) continue;
      visited.add(current);

      const nestedRoles = this.queryTable(
        `SELECT GRANTED_ROLE FROM ROLEAUTH$ WHERE GRANTEE = '${current}'`
      );
      for (const row of nestedRoles) {
        queue.push(row.GRANTED_ROLE);
      }
    }

    return false;
  }

  getEffectivePrivileges(username: string): {
    systemPrivileges: string[];
    roles: string[];
  } {
    const upperUsername = username.toUpperCase();
    const allPrivileges = new Set<string>();
    const allRoles = new Set<string>();

    // Get direct privileges
    const directPrivs = this.queryTable(
      `SELECT PRIVILEGE FROM SYSAUTH$ WHERE GRANTEE = '${upperUsername}'`
    );
    for (const row of directPrivs) {
      allPrivileges.add(row.PRIVILEGE);
    }

    // Collect roles and their privileges
    this.collectRolesAndPrivileges(upperUsername, allPrivileges, allRoles, new Set());

    return {
      systemPrivileges: [...allPrivileges].sort(),
      roles: [...allRoles].sort()
    };
  }

  private collectRolesAndPrivileges(
    grantee: string,
    privileges: Set<string>,
    roles: Set<string>,
    visited: Set<string>
  ): void {
    const grantedRoles = this.queryTable(
      `SELECT GRANTED_ROLE FROM ROLEAUTH$ WHERE GRANTEE = '${grantee}'`
    );

    for (const row of grantedRoles) {
      const roleName = row.GRANTED_ROLE;
      if (visited.has(roleName)) continue;
      visited.add(roleName);

      roles.add(roleName);

      // Get privileges from this role
      const rolePrivs = this.queryTable(
        `SELECT PRIVILEGE FROM SYSAUTH$ WHERE GRANTEE = '${roleName}'`
      );
      for (const p of rolePrivs) {
        privileges.add(p.PRIVILEGE);
      }

      // Recurse
      this.collectRolesAndPrivileges(roleName, privileges, roles, visited);
    }
  }

  // ==========================================================================
  // Audit
  // ==========================================================================

  private auditAction(
    action: string,
    username: string,
    options?: {
      objectSchema?: string;
      objectName?: string;
      objectType?: string;
      sqlText?: string;
      returnCode?: number;
      sessionId?: number;
      comment?: string;
    }
  ): void {
    const auditId = this.auditSequence++;
    const now = new Date().toISOString();

    this.executeSQL(
      `INSERT INTO AUD$ (AUDIT_ID, SESSION_ID, EVENT_TIME, USERNAME, OS_USERNAME, TERMINAL, ACTION_NAME, OBJECT_SCHEMA, OBJECT_NAME, OBJECT_TYPE, SQL_TEXT, RETURN_CODE, COMMENT_TEXT) ` +
      `VALUES (${auditId}, ${options?.sessionId || 0}, '${now}', '${username}', 'unknown', 'SQLPLUS', '${action}', ${options?.objectSchema ? `'${options.objectSchema}'` : 'NULL'}, ${options?.objectName ? `'${options.objectName}'` : 'NULL'}, ${options?.objectType ? `'${options.objectType}'` : 'NULL'}, ${options?.sqlText ? `'${options.sqlText.replace(/'/g, "''")}'` : 'NULL'}, ${options?.returnCode || 0}, ${options?.comment ? `'${options.comment.replace(/'/g, "''")}'` : 'NULL'})`
    );
  }

  // ==========================================================================
  // Getters for Data Dictionary
  // ==========================================================================

  getUser(username: string): any | undefined {
    const rows = this.queryTable(`SELECT * FROM USER$ WHERE USERNAME = '${username.toUpperCase()}'`);
    return rows.length > 0 ? rows[0] : undefined;
  }

  getAllUsers(): any[] {
    return this.queryTable(`SELECT * FROM USER$ ORDER BY USERNAME`);
  }

  getRole(roleName: string): any | undefined {
    const rows = this.queryTable(`SELECT * FROM ROLE$ WHERE ROLE_NAME = '${roleName.toUpperCase()}'`);
    return rows.length > 0 ? rows[0] : undefined;
  }

  getAllRoles(): any[] {
    return this.queryTable(`SELECT * FROM ROLE$ ORDER BY ROLE_NAME`);
  }

  getProfile(profileName: string): any[] {
    return this.queryTable(`SELECT * FROM PROFILE$ WHERE PROFILE_NAME = '${profileName.toUpperCase()}'`);
  }

  getAllProfiles(): any[] {
    return this.queryTable(`SELECT DISTINCT PROFILE_NAME FROM PROFILE$ ORDER BY PROFILE_NAME`);
  }

  getAuditTrail(filter?: {
    username?: string;
    action?: string;
    startDate?: Date;
    endDate?: Date;
    objectName?: string;
  }): any[] {
    let sql = `SELECT * FROM AUD$ WHERE 1=1`;

    if (filter?.username) {
      sql += ` AND USERNAME = '${filter.username.toUpperCase()}'`;
    }
    if (filter?.action) {
      sql += ` AND ACTION_NAME = '${filter.action}'`;
    }
    if (filter?.objectName) {
      sql += ` AND OBJECT_NAME = '${filter.objectName.toUpperCase()}'`;
    }

    sql += ` ORDER BY EVENT_TIME DESC`;

    return this.queryTable(sql);
  }

  // ==========================================================================
  // Password Policy Methods
  // ==========================================================================

  /**
   * Get password verification function definition
   */
  getPasswordVerifyFunction(functionName: string): any | undefined {
    const rows = this.queryTable(
      `SELECT * FROM PASSWORD_VERIFY_FUNC$ WHERE FUNCTION_NAME = '${functionName.toUpperCase()}'`
    );
    return rows.length > 0 ? rows[0] : undefined;
  }

  /**
   * Get all password verification functions
   */
  getAllPasswordVerifyFunctions(): any[] {
    return this.queryTable(`SELECT * FROM PASSWORD_VERIFY_FUNC$ ORDER BY FUNCTION_NAME`);
  }

  /**
   * Create a new password verification function
   */
  createPasswordVerifyFunction(
    functionName: string,
    options?: {
      minLength?: number;
      maxLength?: number;
      requireUppercase?: boolean;
      requireLowercase?: boolean;
      requireDigit?: boolean;
      requireSpecial?: boolean;
      specialChars?: string;
      noUsername?: boolean;
      noReverseUsername?: boolean;
      noServerName?: boolean;
      differFromPrevious?: number;
    }
  ): SQLResult {
    const upperName = functionName.toUpperCase();

    // Check if function already exists
    const existing = this.getPasswordVerifyFunction(upperName);
    if (existing) {
      return createErrorResult('00955', 'ORA-00955: name is already used by an existing object');
    }

    const now = new Date().toISOString();
    this.executeSQL(
      `INSERT INTO PASSWORD_VERIFY_FUNC$ (FUNCTION_NAME, MIN_LENGTH, MAX_LENGTH, REQUIRE_UPPERCASE, REQUIRE_LOWERCASE, REQUIRE_DIGIT, REQUIRE_SPECIAL, SPECIAL_CHARS, NO_USERNAME, NO_REVERSE_USERNAME, NO_SERVER_NAME, DIFFER_FROM_PREVIOUS, CREATED) ` +
      `VALUES ('${upperName}', ${options?.minLength || 8}, ${options?.maxLength || 30}, '${options?.requireUppercase !== false ? 'Y' : 'N'}', '${options?.requireLowercase !== false ? 'Y' : 'N'}', '${options?.requireDigit !== false ? 'Y' : 'N'}', '${options?.requireSpecial ? 'Y' : 'N'}', '${options?.specialChars || '!@#$%^&*()_+-=[]{}|;:,.<>?'}', '${options?.noUsername !== false ? 'Y' : 'N'}', '${options?.noReverseUsername !== false ? 'Y' : 'N'}', '${options?.noServerName !== false ? 'Y' : 'N'}', ${options?.differFromPrevious || 3}, '${now}')`
    );

    return createSuccessResult([], `Password verify function ${upperName} created.`);
  }

  /**
   * Verify password against a password verification function
   */
  verifyPasswordComplexity(
    password: string,
    username: string,
    functionName?: string
  ): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    // If no function specified or NULL, password is valid
    if (!functionName || functionName === 'NULL') {
      return { valid: true, errors: [] };
    }

    const func = this.getPasswordVerifyFunction(functionName);
    if (!func) {
      return { valid: true, errors: [] }; // Function doesn't exist, allow password
    }

    // Check minimum length
    if (func.MIN_LENGTH && password.length < func.MIN_LENGTH) {
      errors.push(`ORA-28003: password verification for the specified password failed - password must be at least ${func.MIN_LENGTH} characters`);
    }

    // Check maximum length
    if (func.MAX_LENGTH && password.length > func.MAX_LENGTH) {
      errors.push(`ORA-28003: password verification failed - password must be at most ${func.MAX_LENGTH} characters`);
    }

    // Check uppercase requirement
    if (func.REQUIRE_UPPERCASE === 'Y' && !/[A-Z]/.test(password)) {
      errors.push(`ORA-28003: password verification failed - password must contain at least one uppercase letter`);
    }

    // Check lowercase requirement
    if (func.REQUIRE_LOWERCASE === 'Y' && !/[a-z]/.test(password)) {
      errors.push(`ORA-28003: password verification failed - password must contain at least one lowercase letter`);
    }

    // Check digit requirement
    if (func.REQUIRE_DIGIT === 'Y' && !/[0-9]/.test(password)) {
      errors.push(`ORA-28003: password verification failed - password must contain at least one digit`);
    }

    // Check special character requirement
    if (func.REQUIRE_SPECIAL === 'Y') {
      const specialChars = func.SPECIAL_CHARS || '!@#$%^&*()_+-=[]{}|;:,.<>?';
      const hasSpecial = [...password].some(char => specialChars.includes(char));
      if (!hasSpecial) {
        errors.push(`ORA-28003: password verification failed - password must contain at least one special character`);
      }
    }

    // Check if password contains username
    if (func.NO_USERNAME === 'Y' && password.toUpperCase().includes(username.toUpperCase())) {
      errors.push(`ORA-28003: password verification failed - password cannot contain the username`);
    }

    // Check if password contains reversed username
    if (func.NO_REVERSE_USERNAME === 'Y') {
      const reversedUsername = username.split('').reverse().join('');
      if (password.toUpperCase().includes(reversedUsername.toUpperCase())) {
        errors.push(`ORA-28003: password verification failed - password cannot contain the reversed username`);
      }
    }

    // Check if password contains server name
    if (func.NO_SERVER_NAME === 'Y') {
      const dbName = this.getParameter('db_name') || 'ORCL';
      if (password.toUpperCase().includes(dbName.toUpperCase())) {
        errors.push(`ORA-28003: password verification failed - password cannot contain the database name`);
      }
    }

    return { valid: errors.length === 0, errors };
  }

  /**
   * Get password verification function for a user's profile
   */
  getUserPasswordVerifyFunction(username: string): string | null {
    const user = this.getUser(username);
    if (!user) return null;

    const profile = user.USER_PROFILE || 'DEFAULT';
    const rows = this.queryTable(
      `SELECT LIMIT_VALUE FROM PROFILE$ WHERE PROFILE_NAME = '${profile}' AND RESOURCE_NAME = 'PASSWORD_VERIFY_FUNCTION'`
    );

    if (rows.length > 0 && rows[0].LIMIT_VALUE !== 'NULL') {
      return rows[0].LIMIT_VALUE;
    }
    return null;
  }

  // ==========================================================================
  // Password History Methods
  // ==========================================================================

  /**
   * Add password to history
   */
  addPasswordToHistory(userId: number, username: string, passwordHash: string): void {
    const now = new Date().toISOString();
    this.executeSQL(
      `INSERT INTO PASSWORD_HISTORY$ (USER_ID, USERNAME, PASSWORD_HASH, PASSWORD_DATE) ` +
      `VALUES (${userId}, '${username.toUpperCase()}', '${passwordHash}', '${now}')`
    );
  }

  /**
   * Get password history for a user
   */
  getPasswordHistory(username: string): any[] {
    return this.queryTable(
      `SELECT * FROM PASSWORD_HISTORY$ WHERE USERNAME = '${username.toUpperCase()}' ORDER BY PASSWORD_DATE DESC`
    );
  }

  /**
   * Check if password was used recently (based on profile settings)
   */
  isPasswordReused(username: string, newPasswordHash: string): { reused: boolean; reason?: string } {
    const user = this.getUser(username);
    if (!user) return { reused: false };

    const profile = user.USER_PROFILE || 'DEFAULT';

    // Get PASSWORD_REUSE_MAX setting
    const reuseMaxRows = this.queryTable(
      `SELECT LIMIT_VALUE FROM PROFILE$ WHERE PROFILE_NAME = '${profile}' AND RESOURCE_NAME = 'PASSWORD_REUSE_MAX'`
    );
    const reuseMax = reuseMaxRows.length > 0 ? reuseMaxRows[0].LIMIT_VALUE : 'UNLIMITED';

    // Get PASSWORD_REUSE_TIME setting
    const reuseTimeRows = this.queryTable(
      `SELECT LIMIT_VALUE FROM PROFILE$ WHERE PROFILE_NAME = '${profile}' AND RESOURCE_NAME = 'PASSWORD_REUSE_TIME'`
    );
    const reuseTime = reuseTimeRows.length > 0 ? reuseTimeRows[0].LIMIT_VALUE : 'UNLIMITED';

    // If both are UNLIMITED, no restriction
    if (reuseMax === 'UNLIMITED' && reuseTime === 'UNLIMITED') {
      return { reused: false };
    }

    const history = this.getPasswordHistory(username);

    // Check reuse count
    if (reuseMax !== 'UNLIMITED') {
      const maxCount = parseInt(reuseMax, 10);
      const recentPasswords = history.slice(0, maxCount);
      for (const entry of recentPasswords) {
        if (entry.PASSWORD_HASH === newPasswordHash) {
          return {
            reused: true,
            reason: `ORA-28007: the password cannot be reused - must change password ${maxCount} times before reuse`
          };
        }
      }
    }

    // Check reuse time
    if (reuseTime !== 'UNLIMITED') {
      const days = parseInt(reuseTime, 10);
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - days);

      for (const entry of history) {
        if (entry.PASSWORD_HASH === newPasswordHash) {
          const passwordDate = new Date(entry.PASSWORD_DATE);
          if (passwordDate > cutoffDate) {
            return {
              reused: true,
              reason: `ORA-28007: the password cannot be reused - must wait ${days} days before reusing this password`
            };
          }
        }
      }
    }

    return { reused: false };
  }

  /**
   * Check password similarity to previous passwords
   */
  checkPasswordDifference(
    username: string,
    newPassword: string,
    functionName?: string
  ): { valid: boolean; error?: string } {
    if (!functionName || functionName === 'NULL') {
      return { valid: true };
    }

    const func = this.getPasswordVerifyFunction(functionName);
    if (!func || !func.DIFFER_FROM_PREVIOUS) {
      return { valid: true };
    }

    const history = this.getPasswordHistory(username);
    if (history.length === 0) {
      return { valid: true };
    }

    // Get the most recent password (we can't directly compare hashes for difference,
    // but we can at least check it's not identical)
    const lastPassword = history[0];
    const newHash = hashPassword(newPassword);

    // Check if it's exactly the same
    if (verifyPassword(newPassword, lastPassword.PASSWORD_HASH)) {
      return {
        valid: false,
        error: `ORA-28003: password verification failed - new password must differ from the previous password by at least ${func.DIFFER_FROM_PREVIOUS} characters`
      };
    }

    return { valid: true };
  }

  // ==========================================================================
  // Fine-Grained Auditing (FGA) Methods
  // ==========================================================================

  /**
   * Add FGA policy
   */
  addFGAPolicy(
    objectSchema: string,
    objectName: string,
    policyName: string,
    options?: {
      auditColumn?: string;
      auditCondition?: string;
      statementTypes?: string;
      enable?: boolean;
    }
  ): SQLResult {
    const upperPolicyName = policyName.toUpperCase();

    // Check if policy already exists
    const existing = this.queryTable(
      `SELECT 1 FROM FGA_POLICY$ WHERE POLICY_NAME = '${upperPolicyName}'`
    );
    if (existing.length > 0) {
      return createErrorResult('28101', 'ORA-28101: policy already exists');
    }

    const now = new Date().toISOString();
    this.executeSQL(
      `INSERT INTO FGA_POLICY$ (POLICY_NAME, OBJECT_SCHEMA, OBJECT_NAME, POLICY_COLUMN, POLICY_CONDITION, ENABLED, STATEMENT_TYPES, CREATED) ` +
      `VALUES ('${upperPolicyName}', '${objectSchema.toUpperCase()}', '${objectName.toUpperCase()}', ${options?.auditColumn ? `'${options.auditColumn.toUpperCase()}'` : 'NULL'}, ${options?.auditCondition ? `'${options.auditCondition}'` : 'NULL'}, '${options?.enable !== false ? 'YES' : 'NO'}', '${options?.statementTypes || 'SELECT'}', '${now}')`
    );

    this.auditAction('CREATE_FGA_POLICY', 'SYS', {
      objectSchema,
      objectName,
      returnCode: 0,
      comment: `FGA policy ${upperPolicyName} created`
    });

    return createSuccessResult([], `FGA policy ${upperPolicyName} created.`);
  }

  /**
   * Drop FGA policy
   */
  dropFGAPolicy(objectSchema: string, objectName: string, policyName: string): SQLResult {
    const upperPolicyName = policyName.toUpperCase();

    const existing = this.queryTable(
      `SELECT 1 FROM FGA_POLICY$ WHERE POLICY_NAME = '${upperPolicyName}'`
    );
    if (existing.length === 0) {
      return createErrorResult('28102', 'ORA-28102: policy does not exist');
    }

    this.executeSQL(`DELETE FROM FGA_POLICY$ WHERE POLICY_NAME = '${upperPolicyName}'`);

    this.auditAction('DROP_FGA_POLICY', 'SYS', {
      objectSchema,
      objectName,
      returnCode: 0,
      comment: `FGA policy ${upperPolicyName} dropped`
    });

    return createSuccessResult([], `FGA policy ${upperPolicyName} dropped.`);
  }

  /**
   * Enable/Disable FGA policy
   */
  setFGAPolicyEnabled(policyName: string, enable: boolean): SQLResult {
    const upperPolicyName = policyName.toUpperCase();

    const existing = this.queryTable(
      `SELECT 1 FROM FGA_POLICY$ WHERE POLICY_NAME = '${upperPolicyName}'`
    );
    if (existing.length === 0) {
      return createErrorResult('28102', 'ORA-28102: policy does not exist');
    }

    this.executeSQL(
      `UPDATE FGA_POLICY$ SET ENABLED = '${enable ? 'YES' : 'NO'}' WHERE POLICY_NAME = '${upperPolicyName}'`
    );

    return createSuccessResult([], `FGA policy ${upperPolicyName} ${enable ? 'enabled' : 'disabled'}.`);
  }

  /**
   * Get FGA policies
   */
  getFGAPolicies(objectSchema?: string, objectName?: string): any[] {
    let sql = `SELECT * FROM FGA_POLICY$ WHERE 1=1`;
    if (objectSchema) {
      sql += ` AND OBJECT_SCHEMA = '${objectSchema.toUpperCase()}'`;
    }
    if (objectName) {
      sql += ` AND OBJECT_NAME = '${objectName.toUpperCase()}'`;
    }
    sql += ` ORDER BY POLICY_NAME`;
    return this.queryTable(sql);
  }

  /**
   * Log FGA event
   */
  logFGAEvent(
    policyName: string,
    objectSchema: string,
    objectName: string,
    sqlText: string,
    options?: {
      dbUser?: string;
      osUser?: string;
      clientId?: string;
      statementType?: string;
      sqlBind?: string;
      sessionId?: number;
    }
  ): void {
    const fgaId = this.fgaSequence++;
    const now = new Date().toISOString();

    this.executeSQL(
      `INSERT INTO FGA_LOG$ (FGA_ID, SESSION_ID, EVENT_TIMESTAMP, DB_USER, OS_USER, CLIENT_ID, POLICY_NAME, OBJECT_SCHEMA, OBJECT_NAME, SQL_TEXT, SQL_BIND, STATEMENT_TYPE, EXTENDED_TIMESTAMP) ` +
      `VALUES (${fgaId}, ${options?.sessionId || 0}, '${now}', ${options?.dbUser ? `'${options.dbUser}'` : 'NULL'}, ${options?.osUser ? `'${options.osUser}'` : 'NULL'}, ${options?.clientId ? `'${options.clientId}'` : 'NULL'}, '${policyName}', '${objectSchema}', '${objectName}', '${sqlText.replace(/'/g, "''")}', ${options?.sqlBind ? `'${options.sqlBind}'` : 'NULL'}, ${options?.statementType ? `'${options.statementType}'` : 'NULL'}, '${now}')`
    );
  }

  /**
   * Get FGA audit log
   */
  getFGAAuditTrail(filter?: {
    policyName?: string;
    objectSchema?: string;
    objectName?: string;
    dbUser?: string;
  }): any[] {
    let sql = `SELECT * FROM FGA_LOG$ WHERE 1=1`;

    if (filter?.policyName) {
      sql += ` AND POLICY_NAME = '${filter.policyName.toUpperCase()}'`;
    }
    if (filter?.objectSchema) {
      sql += ` AND OBJECT_SCHEMA = '${filter.objectSchema.toUpperCase()}'`;
    }
    if (filter?.objectName) {
      sql += ` AND OBJECT_NAME = '${filter.objectName.toUpperCase()}'`;
    }
    if (filter?.dbUser) {
      sql += ` AND DB_USER = '${filter.dbUser.toUpperCase()}'`;
    }

    sql += ` ORDER BY EVENT_TIMESTAMP DESC`;
    return this.queryTable(sql);
  }

  // ==========================================================================
  // Unified Audit Methods
  // ==========================================================================

  /**
   * Create unified audit policy
   */
  createUnifiedAuditPolicy(
    policyName: string,
    options: {
      auditOption?: string;
      auditOptionType?: string;
      objectSchema?: string;
      objectName?: string;
      objectType?: string;
      condition?: string;
    }
  ): SQLResult {
    const upperPolicyName = policyName.toUpperCase();

    const existing = this.queryTable(
      `SELECT 1 FROM UNIFIED_AUDIT_POLICY$ WHERE POLICY_NAME = '${upperPolicyName}'`
    );
    if (existing.length > 0) {
      return createErrorResult('46358', 'ORA-46358: audit policy already exists');
    }

    this.executeSQL(
      `INSERT INTO UNIFIED_AUDIT_POLICY$ (POLICY_NAME, AUDIT_CONDITION, AUDIT_OPTION, AUDIT_OPTION_TYPE, OBJECT_SCHEMA, OBJECT_NAME, OBJECT_TYPE, ENABLED) ` +
      `VALUES ('${upperPolicyName}', ${options.condition ? `'${options.condition}'` : 'NULL'}, ${options.auditOption ? `'${options.auditOption}'` : 'NULL'}, ${options.auditOptionType ? `'${options.auditOptionType}'` : 'NULL'}, ${options.objectSchema ? `'${options.objectSchema.toUpperCase()}'` : 'NULL'}, ${options.objectName ? `'${options.objectName.toUpperCase()}'` : 'NULL'}, ${options.objectType ? `'${options.objectType.toUpperCase()}'` : 'NULL'}, 'NO')`
    );

    return createSuccessResult([], `Unified audit policy ${upperPolicyName} created.`);
  }

  /**
   * Drop unified audit policy
   */
  dropUnifiedAuditPolicy(policyName: string): SQLResult {
    const upperPolicyName = policyName.toUpperCase();

    const existing = this.queryTable(
      `SELECT 1 FROM UNIFIED_AUDIT_POLICY$ WHERE POLICY_NAME = '${upperPolicyName}'`
    );
    if (existing.length === 0) {
      return createErrorResult('46355', 'ORA-46355: audit policy does not exist');
    }

    this.executeSQL(`DELETE FROM UNIFIED_AUDIT_POLICY$ WHERE POLICY_NAME = '${upperPolicyName}'`);

    return createSuccessResult([], `Unified audit policy ${upperPolicyName} dropped.`);
  }

  /**
   * Enable unified audit policy for user(s)
   */
  enableUnifiedAuditPolicy(policyName: string, enabledBy: string): SQLResult {
    const upperPolicyName = policyName.toUpperCase();
    const now = new Date().toISOString();

    const existing = this.queryTable(
      `SELECT 1 FROM UNIFIED_AUDIT_POLICY$ WHERE POLICY_NAME = '${upperPolicyName}'`
    );
    if (existing.length === 0) {
      return createErrorResult('46355', 'ORA-46355: audit policy does not exist');
    }

    this.executeSQL(
      `UPDATE UNIFIED_AUDIT_POLICY$ SET ENABLED = 'YES', ENABLED_BY = '${enabledBy.toUpperCase()}', ENABLED_DATE = '${now}' WHERE POLICY_NAME = '${upperPolicyName}'`
    );

    return createSuccessResult([], `Unified audit policy ${upperPolicyName} enabled.`);
  }

  /**
   * Disable unified audit policy
   */
  disableUnifiedAuditPolicy(policyName: string): SQLResult {
    const upperPolicyName = policyName.toUpperCase();

    const existing = this.queryTable(
      `SELECT 1 FROM UNIFIED_AUDIT_POLICY$ WHERE POLICY_NAME = '${upperPolicyName}'`
    );
    if (existing.length === 0) {
      return createErrorResult('46355', 'ORA-46355: audit policy does not exist');
    }

    this.executeSQL(
      `UPDATE UNIFIED_AUDIT_POLICY$ SET ENABLED = 'NO', ENABLED_BY = NULL, ENABLED_DATE = NULL WHERE POLICY_NAME = '${upperPolicyName}'`
    );

    return createSuccessResult([], `Unified audit policy ${upperPolicyName} disabled.`);
  }

  /**
   * Get unified audit policies
   */
  getUnifiedAuditPolicies(enabledOnly?: boolean): any[] {
    let sql = `SELECT * FROM UNIFIED_AUDIT_POLICY$`;
    if (enabledOnly) {
      sql += ` WHERE ENABLED = 'YES'`;
    }
    sql += ` ORDER BY POLICY_NAME`;
    return this.queryTable(sql);
  }

  /**
   * Log unified audit event
   */
  logUnifiedAuditEvent(
    action: string,
    options?: {
      policies?: string[];
      fgaPolicyName?: string;
      objectSchema?: string;
      objectName?: string;
      sqlText?: string;
      dbUsername?: string;
      osUsername?: string;
      clientProgram?: string;
      returnCode?: number;
      sessionId?: number;
      authType?: string;
      privilegeUsed?: string;
      targetUser?: string;
      roleName?: string;
    }
  ): void {
    const auditId = this.unifiedAuditSequence++;
    const now = new Date().toISOString();

    this.executeSQL(
      `INSERT INTO UNIFIED_AUDIT_TRAIL$ (AUDIT_ID, UNIFIED_AUDIT_POLICIES, FGA_POLICY_NAME, ACTION_NAME, OBJECT_SCHEMA, OBJECT_NAME, SQL_TEXT, DBUSERNAME, OS_USERNAME, CLIENT_PROGRAM_NAME, EVENT_TIMESTAMP, RETURN_CODE, SESSION_ID, AUTHENTICATION_TYPE, SYSTEM_PRIVILEGE_USED, TARGET_USER, ROLE_NAME) ` +
      `VALUES (${auditId}, ${options?.policies ? `'${options.policies.join(',')}'` : 'NULL'}, ${options?.fgaPolicyName ? `'${options.fgaPolicyName}'` : 'NULL'}, '${action}', ${options?.objectSchema ? `'${options.objectSchema}'` : 'NULL'}, ${options?.objectName ? `'${options.objectName}'` : 'NULL'}, ${options?.sqlText ? `'${options.sqlText.replace(/'/g, "''")}'` : 'NULL'}, ${options?.dbUsername ? `'${options.dbUsername}'` : 'NULL'}, ${options?.osUsername ? `'${options.osUsername}'` : 'NULL'}, ${options?.clientProgram ? `'${options.clientProgram}'` : 'NULL'}, '${now}', ${options?.returnCode || 0}, ${options?.sessionId || 0}, ${options?.authType ? `'${options.authType}'` : 'NULL'}, ${options?.privilegeUsed ? `'${options.privilegeUsed}'` : 'NULL'}, ${options?.targetUser ? `'${options.targetUser}'` : 'NULL'}, ${options?.roleName ? `'${options.roleName}'` : 'NULL'})`
    );
  }

  /**
   * Get unified audit trail
   */
  getUnifiedAuditTrail(filter?: {
    action?: string;
    dbUsername?: string;
    objectSchema?: string;
    objectName?: string;
    policyName?: string;
  }): any[] {
    let sql = `SELECT * FROM UNIFIED_AUDIT_TRAIL$ WHERE 1=1`;

    if (filter?.action) {
      sql += ` AND ACTION_NAME = '${filter.action}'`;
    }
    if (filter?.dbUsername) {
      sql += ` AND DBUSERNAME = '${filter.dbUsername.toUpperCase()}'`;
    }
    if (filter?.objectSchema) {
      sql += ` AND OBJECT_SCHEMA = '${filter.objectSchema.toUpperCase()}'`;
    }
    if (filter?.objectName) {
      sql += ` AND OBJECT_NAME = '${filter.objectName.toUpperCase()}'`;
    }
    if (filter?.policyName) {
      sql += ` AND UNIFIED_AUDIT_POLICIES LIKE '%${filter.policyName.toUpperCase()}%'`;
    }

    sql += ` ORDER BY EVENT_TIMESTAMP DESC`;
    return this.queryTable(sql);
  }

  /**
   * Get profile password settings
   */
  getProfilePasswordSettings(profileName: string): any {
    const rows = this.queryTable(
      `SELECT RESOURCE_NAME, LIMIT_VALUE FROM PROFILE$ WHERE PROFILE_NAME = '${profileName.toUpperCase()}' AND RESOURCE_TYPE = 'PASSWORD'`
    );

    const settings: Record<string, string> = {};
    for (const row of rows) {
      settings[row.RESOURCE_NAME] = row.LIMIT_VALUE;
    }
    return settings;
  }

  /**
   * Update profile password setting
   */
  alterProfilePasswordSetting(
    profileName: string,
    resourceName: string,
    value: string
  ): SQLResult {
    const upperProfile = profileName.toUpperCase();
    const upperResource = resourceName.toUpperCase();

    const existing = this.queryTable(
      `SELECT 1 FROM PROFILE$ WHERE PROFILE_NAME = '${upperProfile}' AND RESOURCE_NAME = '${upperResource}'`
    );

    if (existing.length === 0) {
      // Insert new setting
      this.executeSQL(
        `INSERT INTO PROFILE$ (PROFILE_NAME, RESOURCE_NAME, RESOURCE_TYPE, LIMIT_VALUE) ` +
        `VALUES ('${upperProfile}', '${upperResource}', 'PASSWORD', '${value}')`
      );
    } else {
      // Update existing setting
      this.executeSQL(
        `UPDATE PROFILE$ SET LIMIT_VALUE = '${value}' WHERE PROFILE_NAME = '${upperProfile}' AND RESOURCE_NAME = '${upperResource}'`
      );
    }

    this.auditAction('ALTER_PROFILE', 'SYS', {
      objectName: upperProfile,
      returnCode: 0,
      comment: `Set ${upperResource} = ${value}`
    });

    return createSuccessResult([], `Profile ${upperProfile} altered.`);
  }

  // ==========================================================================
  // Data Dictionary Methods (OBJ$, TAB$, COL$, etc.)
  // ==========================================================================

  /**
   * Register an object in the data dictionary
   */
  registerObject(
    owner: string,
    objectName: string,
    objectType: string,
    createdBy?: string
  ): number {
    const objId = this.objectSequence++;
    const now = new Date().toISOString();

    this.executeSQL(
      `INSERT INTO OBJ$ (OBJ_ID, OWNER, OBJECT_NAME, OBJECT_TYPE, CREATED, LAST_DDL_TIME, STATUS) ` +
      `VALUES (${objId}, '${owner.toUpperCase()}', '${objectName.toUpperCase()}', '${objectType.toUpperCase()}', '${now}', '${now}', 'VALID')`
    );

    this.auditAction('CREATE', createdBy || owner, {
      objectSchema: owner,
      objectName: objectName,
      objectType: objectType,
      returnCode: 0
    });

    return objId;
  }

  /**
   * Register a table in the data dictionary
   */
  registerTable(
    owner: string,
    tableName: string,
    columns: Array<{
      name: string;
      dataType: string;
      length?: number;
      precision?: number;
      scale?: number;
      nullable?: boolean;
      defaultValue?: string;
    }>,
    tablespace?: string
  ): number {
    const objId = this.registerObject(owner, tableName, 'TABLE');

    // Insert into TAB$
    this.executeSQL(
      `INSERT INTO TAB$ (OBJ_ID, OWNER, TABLE_NAME, TABLESPACE_NAME, NUM_ROWS, BLOCKS) ` +
      `VALUES (${objId}, '${owner.toUpperCase()}', '${tableName.toUpperCase()}', '${tablespace || 'USERS'}', 0, 0)`
    );

    // Insert columns into COL$
    let colId = 1;
    for (const col of columns) {
      this.executeSQL(
        `INSERT INTO COL$ (OBJ_ID, OWNER, TABLE_NAME, COLUMN_NAME, COLUMN_ID, DATA_TYPE, DATA_LENGTH, DATA_PRECISION, DATA_SCALE, NULLABLE, DEFAULT_VALUE) ` +
        `VALUES (${objId}, '${owner.toUpperCase()}', '${tableName.toUpperCase()}', '${col.name.toUpperCase()}', ${colId}, '${col.dataType}', ${col.length || 'NULL'}, ${col.precision || 'NULL'}, ${col.scale || 'NULL'}, '${col.nullable === false ? 'N' : 'Y'}', ${col.defaultValue ? `'${col.defaultValue}'` : 'NULL'})`
      );
      colId++;
    }

    return objId;
  }

  /**
   * Register an index in the data dictionary
   */
  registerIndex(
    owner: string,
    indexName: string,
    tableOwner: string,
    tableName: string,
    columns: string[],
    unique: boolean = false
  ): number {
    const objId = this.registerObject(owner, indexName, 'INDEX');

    this.executeSQL(
      `INSERT INTO IND$ (OBJ_ID, OWNER, INDEX_NAME, TABLE_OWNER, TABLE_NAME, INDEX_TYPE, UNIQUENESS, STATUS) ` +
      `VALUES (${objId}, '${owner.toUpperCase()}', '${indexName.toUpperCase()}', '${tableOwner.toUpperCase()}', '${tableName.toUpperCase()}', 'NORMAL', '${unique ? 'UNIQUE' : 'NONUNIQUE'}', 'VALID')`
    );

    // Insert index columns
    let pos = 1;
    for (const col of columns) {
      this.executeSQL(
        `INSERT INTO ICOL$ (INDEX_OBJ_ID, COLUMN_NAME, COLUMN_POSITION, DESCEND) ` +
        `VALUES (${objId}, '${col.toUpperCase()}', ${pos}, 'ASC')`
      );
      pos++;
    }

    return objId;
  }

  /**
   * Register a constraint in the data dictionary
   */
  registerConstraint(
    owner: string,
    constraintName: string,
    constraintType: string,
    tableName: string,
    columns: string[],
    searchCondition?: string,
    refOwner?: string,
    refConstraint?: string
  ): number {
    const conId = this.constraintSequence++;

    this.executeSQL(
      `INSERT INTO CON$ (CON_ID, OWNER, CONSTRAINT_NAME, CONSTRAINT_TYPE, TABLE_NAME, SEARCH_CONDITION, R_OWNER, R_CONSTRAINT_NAME, STATUS) ` +
      `VALUES (${conId}, '${owner.toUpperCase()}', '${constraintName.toUpperCase()}', '${constraintType}', '${tableName.toUpperCase()}', ${searchCondition ? `'${searchCondition}'` : 'NULL'}, ${refOwner ? `'${refOwner}'` : 'NULL'}, ${refConstraint ? `'${refConstraint}'` : 'NULL'}, 'ENABLED')`
    );

    // Insert constraint columns
    let pos = 1;
    for (const col of columns) {
      this.executeSQL(
        `INSERT INTO CCOL$ (CON_ID, COLUMN_NAME, POSITION) ` +
        `VALUES (${conId}, '${col.toUpperCase()}', ${pos})`
      );
      pos++;
    }

    return conId;
  }

  /**
   * Register a sequence in the data dictionary
   */
  registerSequence(
    owner: string,
    sequenceName: string,
    options?: {
      minValue?: number;
      maxValue?: number;
      incrementBy?: number;
      cycle?: boolean;
      cache?: number;
    }
  ): number {
    const objId = this.registerObject(owner, sequenceName, 'SEQUENCE');

    this.executeSQL(
      `INSERT INTO SEQ$ (OBJ_ID, SEQUENCE_OWNER, SEQUENCE_NAME, MIN_VALUE, MAX_VALUE, INCREMENT_BY, CYCLE_FLAG, CACHE_SIZE, LAST_NUMBER) ` +
      `VALUES (${objId}, '${owner.toUpperCase()}', '${sequenceName.toUpperCase()}', ${options?.minValue || 1}, ${options?.maxValue || 9999999999}, ${options?.incrementBy || 1}, '${options?.cycle ? 'Y' : 'N'}', ${options?.cache || 20}, ${options?.minValue || 1})`
    );

    return objId;
  }

  /**
   * Register a view in the data dictionary
   */
  registerView(
    owner: string,
    viewName: string,
    viewText: string
  ): number {
    const objId = this.registerObject(owner, viewName, 'VIEW');

    this.executeSQL(
      `INSERT INTO VIEW$ (OBJ_ID, OWNER, VIEW_NAME, TEXT_LENGTH, VIEW_TEXT, READ_ONLY) ` +
      `VALUES (${objId}, '${owner.toUpperCase()}', '${viewName.toUpperCase()}', ${viewText.length}, '${viewText.replace(/'/g, "''")}', 'NO')`
    );

    return objId;
  }

  /**
   * Register a synonym in the data dictionary
   */
  registerSynonym(
    owner: string,
    synonymName: string,
    tableOwner: string,
    tableName: string,
    dbLink?: string
  ): void {
    this.executeSQL(
      `INSERT INTO SYNONYM$ (OWNER, SYNONYM_NAME, TABLE_OWNER, TABLE_NAME, DB_LINK) ` +
      `VALUES ('${owner.toUpperCase()}', '${synonymName.toUpperCase()}', '${tableOwner.toUpperCase()}', '${tableName.toUpperCase()}', ${dbLink ? `'${dbLink}'` : 'NULL'})`
    );

    this.registerObject(owner, synonymName, 'SYNONYM');
  }

  /**
   * Drop an object from the data dictionary
   */
  dropObject(owner: string, objectName: string, objectType: string): void {
    const upperOwner = owner.toUpperCase();
    const upperName = objectName.toUpperCase();
    const upperType = objectType.toUpperCase();

    // Get object ID
    const objs = this.queryTable(
      `SELECT OBJ_ID FROM OBJ$ WHERE OWNER = '${upperOwner}' AND OBJECT_NAME = '${upperName}' AND OBJECT_TYPE = '${upperType}'`
    );

    if (objs.length > 0) {
      const objId = objs[0].OBJ_ID;

      // Delete from type-specific table
      switch (upperType) {
        case 'TABLE':
          this.executeSQL(`DELETE FROM COL$ WHERE OBJ_ID = ${objId}`);
          this.executeSQL(`DELETE FROM TAB$ WHERE OBJ_ID = ${objId}`);
          break;
        case 'INDEX':
          this.executeSQL(`DELETE FROM ICOL$ WHERE INDEX_OBJ_ID = ${objId}`);
          this.executeSQL(`DELETE FROM IND$ WHERE OBJ_ID = ${objId}`);
          break;
        case 'SEQUENCE':
          this.executeSQL(`DELETE FROM SEQ$ WHERE OBJ_ID = ${objId}`);
          break;
        case 'VIEW':
          this.executeSQL(`DELETE FROM VIEW$ WHERE OBJ_ID = ${objId}`);
          break;
        case 'SYNONYM':
          this.executeSQL(`DELETE FROM SYNONYM$ WHERE OWNER = '${upperOwner}' AND SYNONYM_NAME = '${upperName}'`);
          break;
      }

      // Delete from OBJ$
      this.executeSQL(`DELETE FROM OBJ$ WHERE OBJ_ID = ${objId}`);
    }
  }

  // ==========================================================================
  // Session Management (SESSION$ / V$SESSION)
  // ==========================================================================

  /**
   * Create a session entry
   */
  createSession(
    username: string,
    options?: {
      osuser?: string;
      machine?: string;
      terminal?: string;
      program?: string;
    }
  ): { sid: number; serial: number } {
    const sid = this.currentSessionId;
    const serial = Math.floor(Math.random() * 65535) + 1;
    const now = new Date().toISOString();

    this.executeSQL(
      `INSERT INTO SESSION$ (SID, SERIAL_NUM, USERNAME, STATUS, OSUSER, MACHINE, TERMINAL, PROGRAM, LOGON_TIME, SCHEMA_NAME) ` +
      `VALUES (${sid}, ${serial}, '${username.toUpperCase()}', 'ACTIVE', '${options?.osuser || 'unknown'}', '${options?.machine || 'localhost'}', '${options?.terminal || 'pts/0'}', '${options?.program || 'sqlplus'}', '${now}', '${username.toUpperCase()}')`
    );

    return { sid, serial };
  }

  /**
   * End a session
   */
  endSession(sid: number, serial: number): void {
    this.executeSQL(
      `DELETE FROM SESSION$ WHERE SID = ${sid} AND SERIAL_NUM = ${serial}`
    );
  }

  /**
   * Get active sessions
   */
  getActiveSessions(): any[] {
    return this.queryTable(`SELECT * FROM SESSION$ WHERE STATUS = 'ACTIVE' ORDER BY SID`);
  }

  // ==========================================================================
  // Tablespace and File Management
  // ==========================================================================

  /**
   * Get tablespaces
   */
  getTablespaces(): any[] {
    return this.queryTable(`SELECT * FROM TS$ ORDER BY TABLESPACE_NAME`);
  }

  /**
   * Get data files
   */
  getDataFiles(): any[] {
    return this.queryTable(`SELECT * FROM FILE$ ORDER BY FILE_ID`);
  }

  /**
   * Get database parameters
   */
  getParameters(): any[] {
    return this.queryTable(`SELECT * FROM PARAMETER$ ORDER BY PARAM_NUM`);
  }

  /**
   * Get a specific parameter value
   */
  getParameter(name: string): string | undefined {
    const rows = this.queryTable(
      `SELECT PARAM_VALUE FROM PARAMETER$ WHERE PARAM_NAME = '${name.toLowerCase()}'`
    );
    return rows.length > 0 ? rows[0].PARAM_VALUE : undefined;
  }

  // ==========================================================================
  // Data Dictionary Queries
  // ==========================================================================

  /**
   * Get all objects (DBA_OBJECTS equivalent)
   */
  getObjects(filter?: { owner?: string; objectType?: string; objectName?: string }): any[] {
    let sql = `SELECT * FROM OBJ$ WHERE 1=1`;
    if (filter?.owner) sql += ` AND OWNER = '${filter.owner.toUpperCase()}'`;
    if (filter?.objectType) sql += ` AND OBJECT_TYPE = '${filter.objectType.toUpperCase()}'`;
    if (filter?.objectName) sql += ` AND OBJECT_NAME = '${filter.objectName.toUpperCase()}'`;
    sql += ` ORDER BY OWNER, OBJECT_TYPE, OBJECT_NAME`;
    return this.queryTable(sql);
  }

  /**
   * Get tables (DBA_TABLES equivalent)
   */
  getTables(owner?: string): any[] {
    let sql = `SELECT * FROM TAB$`;
    if (owner) sql += ` WHERE OWNER = '${owner.toUpperCase()}'`;
    sql += ` ORDER BY OWNER, TABLE_NAME`;
    return this.queryTable(sql);
  }

  /**
   * Get columns for a table (DBA_TAB_COLUMNS equivalent)
   */
  getColumns(owner: string, tableName: string): any[] {
    return this.queryTable(
      `SELECT * FROM COL$ WHERE OWNER = '${owner.toUpperCase()}' AND TABLE_NAME = '${tableName.toUpperCase()}' ORDER BY COLUMN_ID`
    );
  }

  /**
   * Get indexes (DBA_INDEXES equivalent)
   */
  getIndexes(owner?: string, tableName?: string): any[] {
    let sql = `SELECT * FROM IND$`;
    const conditions: string[] = [];
    if (owner) conditions.push(`OWNER = '${owner.toUpperCase()}'`);
    if (tableName) conditions.push(`TABLE_NAME = '${tableName.toUpperCase()}'`);
    if (conditions.length > 0) sql += ` WHERE ${conditions.join(' AND ')}`;
    sql += ` ORDER BY OWNER, INDEX_NAME`;
    return this.queryTable(sql);
  }

  /**
   * Get constraints (DBA_CONSTRAINTS equivalent)
   */
  getConstraints(owner?: string, tableName?: string): any[] {
    let sql = `SELECT * FROM CON$`;
    const conditions: string[] = [];
    if (owner) conditions.push(`OWNER = '${owner.toUpperCase()}'`);
    if (tableName) conditions.push(`TABLE_NAME = '${tableName.toUpperCase()}'`);
    if (conditions.length > 0) sql += ` WHERE ${conditions.join(' AND ')}`;
    sql += ` ORDER BY OWNER, TABLE_NAME, CONSTRAINT_NAME`;
    return this.queryTable(sql);
  }

  /**
   * Get sequences (DBA_SEQUENCES equivalent)
   */
  getSequences(owner?: string): any[] {
    let sql = `SELECT * FROM SEQ$`;
    if (owner) sql += ` WHERE SEQUENCE_OWNER = '${owner.toUpperCase()}'`;
    sql += ` ORDER BY SEQUENCE_OWNER, SEQUENCE_NAME`;
    return this.queryTable(sql);
  }

  /**
   * Get views (DBA_VIEWS equivalent)
   */
  getViews(owner?: string): any[] {
    let sql = `SELECT * FROM VIEW$`;
    if (owner) sql += ` WHERE OWNER = '${owner.toUpperCase()}'`;
    sql += ` ORDER BY OWNER, VIEW_NAME`;
    return this.queryTable(sql);
  }

  /**
   * Get synonyms (DBA_SYNONYMS equivalent)
   */
  getSynonyms(owner?: string): any[] {
    let sql = `SELECT * FROM SYNONYM$`;
    if (owner) sql += ` WHERE OWNER = '${owner.toUpperCase()}'`;
    sql += ` ORDER BY OWNER, SYNONYM_NAME`;
    return this.queryTable(sql);
  }
}

// Note: Don't create singleton - each SQLPlus session creates its own with engine reference
