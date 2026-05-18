/**
 * Built-in dictionary view catalog — the static list of every view
 * that Oracle exposes out of the box and that our simulator implements.
 *
 * `DBA_VIEWS`, `ALL_VIEWS`, and `USER_VIEWS` use this list to report
 * every catalog view as a SYS-owned view (matching real Oracle 19c
 * behaviour, where `DBA_TABLES`, `V$SESSION`, etc. all show up there).
 *
 * `DESC` also consults this list so that `DESC ALL_VIEWS` succeeds even
 * when no user-defined views exist.
 *
 * The list is the *single source of truth*: when adding a new dictionary
 * view, register it here too so it surfaces in the data dictionary.
 */

export interface BuiltinViewEntry {
  /** Canonical Oracle name, e.g. `V$SESSION`, `DBA_USERS`. */
  readonly name: string;
  /** Synthetic SELECT used as the TEXT column of *_VIEWS rows. */
  readonly text: string;
  /** Optional short comment for DICTIONARY / DICT views. */
  readonly comment?: string;
}

/**
 * Generate a synthetic CREATE VIEW text for a fixed view. Real Oracle
 * stores actual SQL behind these — we surface a faithful placeholder.
 */
function fixed(name: string, underlying: string): string {
  return `select * from ${underlying} /* fixed view */`;
}

export const BUILTIN_VIEWS: readonly BuiltinViewEntry[] = Object.freeze([
  // ── V$ dynamic performance views ────────────────────────────────
  { name: 'V$VERSION',              text: fixed('V$VERSION', 'X$VERSION'),         comment: 'Oracle version information' },
  { name: 'V$INSTANCE',             text: fixed('V$INSTANCE', 'X$KSUSGIF'),        comment: 'Instance information' },
  { name: 'V$DATABASE',             text: fixed('V$DATABASE', 'X$KCCDI'),          comment: 'Database information' },
  { name: 'V$SESSION',              text: fixed('V$SESSION', 'X$KSUSE'),           comment: 'Active sessions' },
  { name: 'V$PARAMETER',            text: fixed('V$PARAMETER', 'X$KSPPI'),         comment: 'System parameters' },
  { name: 'V$SPPARAMETER',          text: fixed('V$SPPARAMETER', 'X$KSPSPFILE'),   comment: 'SPFILE parameters' },
  { name: 'V$SYSTEM_PARAMETER',     text: fixed('V$SYSTEM_PARAMETER', 'X$KSPPI'),  comment: 'System-scope parameters' },
  { name: 'V$SGA',                  text: fixed('V$SGA', 'X$KSMSGA'),              comment: 'SGA memory areas' },
  { name: 'V$SGASTAT',              text: fixed('V$SGASTAT', 'X$KSMSS'),           comment: 'SGA detailed statistics' },
  { name: 'V$TABLESPACE',           text: fixed('V$TABLESPACE', 'X$KCCTS'),        comment: 'Tablespace information' },
  { name: 'V$DATAFILE',             text: fixed('V$DATAFILE', 'X$KCCFE'),          comment: 'Data file information' },
  { name: 'V$TEMPFILE',             text: fixed('V$TEMPFILE', 'X$KCCTF'),          comment: 'Temporary files' },
  { name: 'V$LOG',                  text: fixed('V$LOG', 'X$KCCLE'),               comment: 'Online redo log groups' },
  { name: 'V$LOGFILE',              text: fixed('V$LOGFILE', 'X$KCCLF'),           comment: 'Redo log members' },
  { name: 'V$LOG_HISTORY',          text: fixed('V$LOG_HISTORY', 'X$KCCLH'),       comment: 'Historical redo log sequences' },
  { name: 'V$ARCHIVED_LOG',         text: fixed('V$ARCHIVED_LOG', 'X$KCCAL'),      comment: 'Archived log information' },
  { name: 'V$PROCESS',              text: fixed('V$PROCESS', 'X$KSUPR'),           comment: 'Background and server processes' },
  { name: 'V$CONTROLFILE',          text: fixed('V$CONTROLFILE', 'X$KCCCF'),       comment: 'Control files' },
  { name: 'V$DIAG_INFO',            text: fixed('V$DIAG_INFO', 'X$DBGALERTEXT'),   comment: 'Diagnostic repository info' },
  { name: 'V$LOCK',                 text: fixed('V$LOCK', 'X$KSQRS'),              comment: 'Active locks' },
  { name: 'V$LOCKED_OBJECT',        text: fixed('V$LOCKED_OBJECT', 'X$KGLLK'),     comment: 'Locked objects' },
  { name: 'V$TRANSACTION',          text: fixed('V$TRANSACTION', 'X$KTCXB'),       comment: 'Active transactions' },
  { name: 'V$SQL',                  text: fixed('V$SQL', 'X$KGLCURSOR_CHILD'),     comment: 'SQL statements in cache' },
  { name: 'V$SQLAREA',              text: fixed('V$SQLAREA', 'X$KGLCURSOR'),       comment: 'Shared SQL area' },
  { name: 'V$SQL_PLAN',             text: fixed('V$SQL_PLAN', 'X$KQLFXPL'),        comment: 'SQL execution plans' },
  { name: 'V$SYSSTAT',              text: fixed('V$SYSSTAT', 'X$KSUSGSTA'),        comment: 'System statistics' },
  { name: 'V$SESSTAT',              text: fixed('V$SESSTAT', 'X$KSUSESTA'),        comment: 'Session statistics' },
  { name: 'V$OPEN_CURSOR',          text: fixed('V$OPEN_CURSOR', 'X$KGLOB'),       comment: 'Open cursors' },
  { name: 'V$OPTION',               text: fixed('V$OPTION', 'X$OPTION'),           comment: 'Database options' },
  { name: 'V$NLS_PARAMETERS',       text: fixed('V$NLS_PARAMETERS', 'X$NLS_PARAMETERS'), comment: 'NLS parameters' },
  { name: 'V$TIMEZONE_NAMES',       text: fixed('V$TIMEZONE_NAMES', 'X$TIMEZONE_NAMES'), comment: 'Time zone names' },
  { name: 'V$PGA_TARGET_ADVICE',    text: fixed('V$PGA_TARGET_ADVICE', 'X$QESMMAPGA'), comment: 'PGA target advice' },
  { name: 'V$RESOURCE_LIMIT',       text: fixed('V$RESOURCE_LIMIT', 'X$KSURLMT'),  comment: 'Resource limits' },
  { name: 'V$RECOVER_FILE',         text: fixed('V$RECOVER_FILE', 'X$KCRMF'),      comment: 'Files needing recovery' },
  { name: 'V$BACKUP',               text: fixed('V$BACKUP', 'X$KCCBF'),            comment: 'Online backup status' },
  { name: 'V$ASM_DISKGROUP',        text: fixed('V$ASM_DISKGROUP', 'X$KFGRP'),     comment: 'ASM disk groups' },
  { name: 'V$SESSION_CONNECT_INFO', text: fixed('V$SESSION_CONNECT_INFO', 'X$KSUSE'), comment: 'Session connect info' },
  { name: 'V$SESSION_WAIT',         text: fixed('V$SESSION_WAIT', 'X$KSUSECST'),   comment: 'Sessions currently waiting' },
  { name: 'V$SESSION_EVENT',        text: fixed('V$SESSION_EVENT', 'X$KSLES'),     comment: 'Per-session wait events' },
  { name: 'V$SYSTEM_EVENT',         text: fixed('V$SYSTEM_EVENT', 'X$KSLED'),      comment: 'System-wide wait events' },
  { name: 'V$LATCH',                text: fixed('V$LATCH', 'X$KSLLT'),             comment: 'Latch statistics' },
  { name: 'V$LATCHHOLDER',          text: fixed('V$LATCHHOLDER', 'X$KSUPRLAT'),    comment: 'Current latch holders' },
  { name: 'V$LICENSE',              text: fixed('V$LICENSE', 'X$KSULL'),           comment: 'License limits' },
  { name: 'V$MYSTAT',               text: fixed('V$MYSTAT', 'X$KSUMYSTA'),         comment: "Caller's session statistics" },
  { name: 'V$LISTENER_NETWORK',     text: fixed('V$LISTENER_NETWORK', 'X$KMMLNI'), comment: 'Listener network endpoints' },
  { name: 'V$LIBRARYCACHE',         text: fixed('V$LIBRARYCACHE', 'X$KGLST'),      comment: 'Library cache stats' },

  // ── DBA_ dictionary views ───────────────────────────────────────
  { name: 'DBA_USERS',              text: fixed('DBA_USERS', 'SYS.USER$'),         comment: 'Database users' },
  { name: 'DBA_ROLES',              text: fixed('DBA_ROLES', 'SYS.ROLE_PRIVS'),    comment: 'Database roles' },
  { name: 'DBA_ROLE_PRIVS',         text: fixed('DBA_ROLE_PRIVS', 'SYS.DBA_ROLE_PRIVS'), comment: 'Role privileges' },
  { name: 'DBA_SYS_PRIVS',          text: fixed('DBA_SYS_PRIVS', 'SYS.SYSAUTH$'),  comment: 'System privileges' },
  { name: 'DBA_TAB_PRIVS',          text: fixed('DBA_TAB_PRIVS', 'SYS.OBJAUTH$'),  comment: 'Object privileges' },
  { name: 'DBA_TABLES',             text: fixed('DBA_TABLES', 'SYS.TAB$'),         comment: 'Database tables' },
  { name: 'DBA_TAB_COLUMNS',        text: fixed('DBA_TAB_COLUMNS', 'SYS.COL$'),    comment: 'Table columns' },
  { name: 'DBA_OBJECTS',            text: fixed('DBA_OBJECTS', 'SYS.OBJ$'),        comment: 'Database objects' },
  { name: 'DBA_TABLESPACES',        text: fixed('DBA_TABLESPACES', 'SYS.TS$'),     comment: 'Tablespaces' },
  { name: 'DBA_DATA_FILES',         text: fixed('DBA_DATA_FILES', 'SYS.FILE$'),    comment: 'Data files' },
  { name: 'DBA_TEMP_FILES',         text: fixed('DBA_TEMP_FILES', 'SYS.FILE$'),    comment: 'Temporary data files' },
  { name: 'DBA_FREE_SPACE',         text: fixed('DBA_FREE_SPACE', 'SYS.FET$'),     comment: 'Free extents' },
  { name: 'DBA_INDEXES',            text: fixed('DBA_INDEXES', 'SYS.IND$'),        comment: 'Indexes' },
  { name: 'DBA_IND_COLUMNS',        text: fixed('DBA_IND_COLUMNS', 'SYS.ICOL$'),   comment: 'Index columns' },
  { name: 'DBA_CONSTRAINTS',        text: fixed('DBA_CONSTRAINTS', 'SYS.CDEF$'),   comment: 'Constraints' },
  { name: 'DBA_CONS_COLUMNS',       text: fixed('DBA_CONS_COLUMNS', 'SYS.CCOL$'),  comment: 'Constraint columns' },
  { name: 'DBA_SEQUENCES',          text: fixed('DBA_SEQUENCES', 'SYS.SEQ$'),      comment: 'Sequences' },
  { name: 'DBA_VIEWS',              text: fixed('DBA_VIEWS', 'SYS.VIEW$'),         comment: 'Views' },
  { name: 'DBA_SOURCE',             text: fixed('DBA_SOURCE', 'SYS.SOURCE$'),      comment: 'PL/SQL source code' },
  { name: 'DBA_PROCEDURES',         text: fixed('DBA_PROCEDURES', 'SYS.PROCEDUREJAVA$'), comment: 'Stored procedures and functions' },
  { name: 'DBA_TRIGGERS',           text: fixed('DBA_TRIGGERS', 'SYS.TRIGGER$'),   comment: 'Database triggers' },
  { name: 'DBA_SEGMENTS',           text: fixed('DBA_SEGMENTS', 'SYS.SEG$'),       comment: 'Storage segments' },
  { name: 'DBA_EXTENTS',            text: fixed('DBA_EXTENTS', 'SYS.EXT$'),        comment: 'Data extents' },
  { name: 'DBA_AUDIT_TRAIL',        text: fixed('DBA_AUDIT_TRAIL', 'SYS.AUD$'),    comment: 'Audit trail entries' },
  { name: 'DBA_AUDIT_SESSION',      text: fixed('DBA_AUDIT_SESSION', 'SYS.AUD$'),  comment: 'Session-level audit trail' },
  { name: 'DBA_AUDIT_OBJECT',       text: fixed('DBA_AUDIT_OBJECT', 'SYS.AUD$'),   comment: 'Object-level audit trail' },
  { name: 'DBA_AUDIT_STATEMENT',    text: fixed('DBA_AUDIT_STATEMENT', 'SYS.AUD$'),comment: 'Statement-level audit trail' },
  { name: 'DBA_STMT_AUDIT_OPTS',    text: fixed('DBA_STMT_AUDIT_OPTS', 'SYS.STMT_AUDIT_OPTION_MAP'), comment: 'Statement audit options' },
  { name: 'DBA_PRIV_AUDIT_OPTS',    text: fixed('DBA_PRIV_AUDIT_OPTS', 'SYS.SYSTEM_PRIVILEGE_MAP'), comment: 'Privilege audit options' },
  { name: 'DBA_OBJ_AUDIT_OPTS',     text: fixed('DBA_OBJ_AUDIT_OPTS', 'SYS.OBJ$'), comment: 'Object audit options' },
  { name: 'DBA_AUDIT_POLICIES',     text: fixed('DBA_AUDIT_POLICIES', 'SYS.FGA_LOG$'), comment: 'Fine-grained audit policies' },
  { name: 'DBA_FGA_AUDIT_TRAIL',    text: fixed('DBA_FGA_AUDIT_TRAIL', 'SYS.FGA_LOG$'), comment: 'Fine-grained audit trail' },
  { name: 'UNIFIED_AUDIT_TRAIL',    text: fixed('UNIFIED_AUDIT_TRAIL', 'SYS.UNIFIED_AUDIT_TRAIL'), comment: 'Unified audit trail (12c+)' },
  { name: 'DBA_PROFILES',           text: fixed('DBA_PROFILES', 'SYS.PROFILE$'),   comment: 'Resource limit profiles' },
  { name: 'DBA_TS_QUOTAS',          text: fixed('DBA_TS_QUOTAS', 'SYS.TSQ$'),      comment: 'Tablespace quotas' },
  { name: 'DBA_TAB_STATISTICS',     text: fixed('DBA_TAB_STATISTICS', 'SYS.TAB_STATS$'), comment: 'Table statistics' },
  { name: 'DBA_DIRECTORIES',        text: fixed('DBA_DIRECTORIES', 'SYS.DIR$'),    comment: 'Directory objects' },
  { name: 'DBA_DB_LINKS',           text: fixed('DBA_DB_LINKS', 'SYS.LINK$'),      comment: 'Database links' },
  { name: 'DBA_JOBS',               text: fixed('DBA_JOBS', 'SYS.JOB$'),           comment: 'DBMS_JOB scheduled jobs' },
  { name: 'DBA_SCHEDULER_JOBS',     text: fixed('DBA_SCHEDULER_JOBS', 'SYS.SCHEDULER$_JOB'), comment: 'DBMS_SCHEDULER jobs' },
  { name: 'DBA_SYNONYMS',           text: fixed('DBA_SYNONYMS', 'SYS.SYN$'),       comment: 'Synonyms' },

  // ── NLS / catalog metadata ──────────────────────────────────────
  { name: 'NLS_DATABASE_PARAMETERS', text: fixed('NLS_DATABASE_PARAMETERS', 'SYS.PROPS$'),  comment: 'Database NLS parameters' },
  { name: 'NLS_INSTANCE_PARAMETERS', text: fixed('NLS_INSTANCE_PARAMETERS', 'SYS.PROPS$'),  comment: 'Instance NLS parameters' },
  { name: 'NLS_SESSION_PARAMETERS',  text: fixed('NLS_SESSION_PARAMETERS', 'SYS.PROPS$'),   comment: 'Session NLS parameters' },
  { name: 'PRODUCT_COMPONENT_VERSION', text: fixed('PRODUCT_COMPONENT_VERSION', 'SYS.REGISTRY$'), comment: 'Installed components and versions' },
  { name: 'DICT_COLUMNS',           text: fixed('DICT_COLUMNS', 'SYS.OBJ$'),       comment: 'Dictionary column metadata' },

  // ── Other catalog views the registry exposes ────────────────────
  { name: 'DBA_TAB_COMMENTS',       text: fixed('DBA_TAB_COMMENTS', 'SYS.COM$'),   comment: 'Table comments' },
  { name: 'DBA_COL_COMMENTS',       text: fixed('DBA_COL_COMMENTS', 'SYS.COM$'),   comment: 'Column comments' },
  { name: 'DBA_COL_PRIVS',          text: fixed('DBA_COL_PRIVS', 'SYS.COLAUTH$'),  comment: 'Column privileges' },
  { name: 'DBA_DEPENDENCIES',       text: fixed('DBA_DEPENDENCIES', 'SYS.DEPENDENCY$'), comment: 'Object dependencies' },
  { name: 'DBA_ERRORS',             text: fixed('DBA_ERRORS', 'SYS.ERROR$'),       comment: 'Compilation errors' },
  { name: 'DBA_ARGUMENTS',          text: fixed('DBA_ARGUMENTS', 'SYS.ARGUMENT$'), comment: 'Stored unit arguments' },
  { name: 'DBA_RECYCLEBIN',         text: fixed('DBA_RECYCLEBIN', 'SYS.RECYCLEBIN$'), comment: 'Recycle bin contents' },
  { name: 'DBA_MVIEWS',             text: fixed('DBA_MVIEWS', 'SYS.SUMMARY$'),     comment: 'Materialized views' },
  { name: 'DBA_MVIEW_LOGS',         text: fixed('DBA_MVIEW_LOGS', 'SYS.MLOG$'),    comment: 'Materialized view logs' },
]);

/** Quick lookup map by uppercase name. */
export const BUILTIN_VIEW_BY_NAME: ReadonlyMap<string, BuiltinViewEntry> =
  new Map(BUILTIN_VIEWS.map(v => [v.name.toUpperCase(), v]));

/** Names of every built-in view, uppercased. */
export const BUILTIN_VIEW_NAMES: readonly string[] = BUILTIN_VIEWS.map(v => v.name);
