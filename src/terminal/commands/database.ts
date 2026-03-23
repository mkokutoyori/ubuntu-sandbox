/**
 * Database command handlers — manages Oracle instances per device.
 *
 * Each device that runs `sqlplus` gets a singleton OracleDatabase
 * automatically started (OPEN state) with demo schemas installed.
 */

import { OracleDatabase } from '@/database/oracle/OracleDatabase';
import { SQLPlusSession } from '@/database/oracle/commands/SQLPlusSession';
import { installAllDemoSchemas } from '@/database/oracle/demo/DemoSchemas';
import { ORACLE_CONFIG } from './OracleConfig';

/** Per-device Oracle database instances. */
const oracleInstances: Map<string, OracleDatabase> = new Map();

/**
 * Get or create an Oracle database for a device.
 * Automatically starts the instance and installs demo schemas on first access.
 */
export function getOracleDatabase(deviceId: string): OracleDatabase {
  let db = oracleInstances.get(deviceId);
  if (!db) {
    db = new OracleDatabase();
    // Auto-start the instance to OPEN state
    db.instance.startup('OPEN');
    // Install demo schemas
    installAllDemoSchemas(db);
    oracleInstances.set(deviceId, db);
  }
  return db;
}

/**
 * Create a SQL*Plus session for a device.
 * Parses the sqlplus command arguments to extract credentials.
 */
export function createSQLPlusSession(
  deviceId: string,
  args: string[]
): { session: SQLPlusSession; banner: string[]; loginOutput: string[] } {
  const db = getOracleDatabase(deviceId);
  const session = new SQLPlusSession(db);

  const banner = session.getBanner();
  let loginOutput: string[] = [];

  // Parse sqlplus arguments:
  //   sqlplus user/pass
  //   sqlplus user/pass@tns
  //   sqlplus / as sysdba
  //   sqlplus -s user/pass  (silent mode)
  //   sqlplus (no args — interactive login prompt, not supported yet)

  let username = '';
  let password = '';
  let asSysdba = false;

  const filtered = args.filter(a => !a.startsWith('-'));

  const asSysdbaIdx = filtered.findIndex(a => a.toUpperCase() === 'AS');
  if (asSysdbaIdx !== -1 && filtered[asSysdbaIdx + 1]?.toUpperCase() === 'SYSDBA') {
    asSysdba = true;
  }

  const connArg = filtered[0];
  if (connArg) {
    if (connArg === '/' && asSysdba) {
      // sqlplus / as sysdba
    } else if (connArg.includes('/')) {
      [username, password] = connArg.split('/', 2);
      password = password.replace(/@.*$/, ''); // strip @tns_alias
    } else if (connArg !== 'AS') {
      username = connArg;
      // Would need password prompt — default to empty for now
    }
  }

  if (asSysdba || (connArg === '/' && asSysdba)) {
    loginOutput = session.login('SYS', '', true);
  } else if (username) {
    loginOutput = session.login(username, password);
  } else {
    // No credentials — just show banner, user can CONNECT later
    loginOutput = ['Not connected.'];
  }

  return { session, banner, loginOutput };
}

/**
 * Remove the Oracle database for a device (cleanup).
 */
export function removeOracleDatabase(deviceId: string): void {
  oracleInstances.delete(deviceId);
}

/**
 * Reset all Oracle instances and filesystem state.
 * Intended for test isolation — clears both the instance map
 * and the filesystem-initialized tracking set.
 */
export function resetAllOracleInstances(): void {
  oracleInstances.clear();
  oracleFilesystemInitialized.clear();
}

/**
 * Initialize Oracle filesystem tree and environment on a Linux device.
 * Creates /u01/app/oracle/... directory structure and config files.
 * Safe to call multiple times — skips if already initialized.
 */
const oracleFilesystemInitialized = new Set<string>();

export function initOracleFilesystem(device: import('@/network').Equipment): void {
  const deviceId = device.id || 'default';
  if (oracleFilesystemInitialized.has(deviceId)) return;
  oracleFilesystemInitialized.add(deviceId);

  const oracleHome = ORACLE_CONFIG.HOME;
  const oracleBase = ORACLE_CONFIG.BASE;
  const sid = ORACLE_CONFIG.SID;
  const oradata = `${oracleBase}/oradata/${sid}`;

  // ── Configuration files ───────────────────────────────────────

  const files: Record<string, string> = {
    // tnsnames.ora — with both CDB and PDB entries
    [`${oracleHome}/network/admin/tnsnames.ora`]:
`ORCL =
  (DESCRIPTION =
    (ADDRESS = (PROTOCOL = TCP)(HOST = localhost)(PORT = 1521))
    (CONNECT_DATA =
      (SERVER = DEDICATED)
      (SERVICE_NAME = ORCL)
    )
  )

ORCLPDB =
  (DESCRIPTION =
    (ADDRESS = (PROTOCOL = TCP)(HOST = localhost)(PORT = 1521))
    (CONNECT_DATA =
      (SERVER = DEDICATED)
      (SERVICE_NAME = ORCLPDB)
    )
  )
`,
    // listener.ora
    [`${oracleHome}/network/admin/listener.ora`]:
`LISTENER =
  (DESCRIPTION_LIST =
    (DESCRIPTION =
      (ADDRESS = (PROTOCOL = TCP)(HOST = 0.0.0.0)(PORT = 1521))
    )
  )

SID_LIST_LISTENER =
  (SID_LIST =
    (SID_DESC =
      (GLOBAL_DBNAME = ORCL)
      (ORACLE_HOME = ${oracleHome})
      (SID_NAME = ORCL)
    )
  )

ADR_BASE_LISTENER = ${oracleBase}
`,
    // sqlnet.ora
    [`${oracleHome}/network/admin/sqlnet.ora`]:
`NAMES.DIRECTORY_PATH = (TNSNAMES, LDAP)
SQLNET.AUTHENTICATION_SERVICES = (NTS)
SQLNET.EXPIRE_TIME = 10
`,
    // init.ora — full parameter set matching BRD 4.1
    [`${oracleHome}/dbs/init${sid}.ora`]:
`db_name                  = ${sid}
db_domain                = localdomain
db_block_size            = 8192
db_cache_size            = 128M
shared_pool_size         = 256M
pga_aggregate_target     = 128M
sga_target               = 512M
sga_max_size             = 1G
processes                = 300
sessions                 = 472
open_cursors             = 300
undo_management          = AUTO
undo_tablespace          = UNDOTBS1
undo_retention           = 900
log_archive_dest_1       = 'LOCATION=${oracleBase}/archivelog'
log_archive_format       = 'arch_%t_%s_%r.arc'
db_recovery_file_dest    = '${oracleBase}/fast_recovery_area'
db_recovery_file_dest_size = 4G
audit_file_dest          = '${oracleBase}/admin/${sid}/adump'
audit_trail              = DB
diagnostic_dest          = ${oracleBase}
control_files            = ('${oradata}/control01.ctl',
                            '${oradata}/control02.ctl')
compatible               = 19.0.0
remote_login_passwordfile = EXCLUSIVE
`,
    // spfile — binary-format server parameter file (simulated text representation)
    [`${oracleHome}/dbs/spfile${sid}.ora`]:
`*.db_name='${sid}'
*.db_domain='localdomain'
*.db_block_size=8192
*.db_cache_size=128M
*.shared_pool_size=256M
*.pga_aggregate_target=128M
*.sga_target=512M
*.sga_max_size=1G
*.processes=300
*.sessions=472
*.open_cursors=300
*.undo_management='AUTO'
*.undo_tablespace='UNDOTBS1'
*.undo_retention=900
*.log_archive_dest_1='LOCATION=${oracleBase}/archivelog'
*.log_archive_format='arch_%t_%s_%r.arc'
*.db_recovery_file_dest='${oracleBase}/fast_recovery_area'
*.db_recovery_file_dest_size=4G
*.audit_file_dest='${oracleBase}/admin/${sid}/adump'
*.audit_trail='DB'
*.diagnostic_dest='${oracleBase}'
*.control_files='${oradata}/control01.ctl','${oradata}/control02.ctl'
*.compatible='19.0.0'
*.remote_login_passwordfile='EXCLUSIVE'
`,
    // orapwd — password file (stub binary)
    [`${oracleHome}/dbs/orapw${sid}`]:
`# Oracle password file (binary format simulated)
# Format: Oracle proprietary
# Users:   SYS (SYSDBA, SYSOPER)
# Created: ${new Date().toISOString().slice(0, 19)}
`,

    // ── /etc config ─────────────────────────────────────────────
    [`/etc/oratab`]: `${sid}:${oracleHome}:Y\n`,
    [`/etc/profile.d/oracle.sh`]:
`export ORACLE_HOME=${oracleHome}
export ORACLE_SID=${sid}
export ORACLE_BASE=${oracleBase}
export PATH=\$ORACLE_HOME/bin:\$PATH
export LD_LIBRARY_PATH=\$ORACLE_HOME/lib
export TNS_ADMIN=\$ORACLE_HOME/network/admin
`,

    // ── Stub binaries ($ORACLE_HOME/bin/) ─────────────────────
    [`${oracleHome}/bin/sqlplus`]: '#!/bin/bash\nexec $ORACLE_HOME/bin/.sqlplus "$@"\n',
    [`${oracleHome}/bin/lsnrctl`]: '#!/bin/bash\nexec $ORACLE_HOME/bin/.lsnrctl "$@"\n',
    [`${oracleHome}/bin/tnsping`]: '#!/bin/bash\nexec $ORACLE_HOME/bin/.tnsping "$@"\n',
    [`${oracleHome}/bin/dbca`]: '#!/bin/bash\nexec $ORACLE_HOME/bin/.dbca "$@"\n',
    [`${oracleHome}/bin/orapwd`]: '#!/bin/bash\nexec $ORACLE_HOME/bin/.orapwd "$@"\n',
    [`${oracleHome}/bin/rman`]: '#!/bin/bash\nexec $ORACLE_HOME/bin/.rman "$@"\n',
    [`${oracleHome}/bin/expdp`]: '#!/bin/bash\nexec $ORACLE_HOME/bin/.expdp "$@"\n',
    [`${oracleHome}/bin/impdp`]: '#!/bin/bash\nexec $ORACLE_HOME/bin/.impdp "$@"\n',
    [`${oracleHome}/bin/adrci`]: '#!/bin/bash\nexec $ORACLE_HOME/bin/.adrci "$@"\n',
    [`${oracleHome}/bin/srvctl`]: '#!/bin/bash\nexec $ORACLE_HOME/bin/.srvctl "$@"\n',
    [`${oracleHome}/bin/emctl`]: '#!/bin/bash\nexec $ORACLE_HOME/bin/.emctl "$@"\n',

    // ── Libraries ($ORACLE_HOME/lib/) ─────────────────────────
    [`${oracleHome}/lib/libclntsh.so`]: '# Oracle Client Shared Library (stub)\n',
    [`${oracleHome}/lib/libsqlplus.so`]: '# SQL*Plus Library (stub)\n',
    [`${oracleHome}/lib/libnnz19.so`]: '# Oracle Security Library (stub)\n',
    [`${oracleHome}/lib/libocci.so`]: '# Oracle C++ Call Interface Library (stub)\n',

    // ── Admin scripts ($ORACLE_HOME/rdbms/admin/) ─────────────
    [`${oracleHome}/rdbms/admin/catalog.sql`]:
`REM catalog.sql
REM Copyright (c) 1982, 2024, Oracle. All rights reserved.
REM
REM NAME
REM   catalog.sql - CATalog views
REM
REM DESCRIPTION
REM   Creates the data dictionary views.
REM   Must be run while connected AS SYSDBA.
REM
REM NOTES
REM   This is a simulated catalog script.

-- Data dictionary views would be created here
-- In this simulator, they are built-in to OracleCatalog.ts

SELECT 'Catalog creation complete.' FROM DUAL;
`,
    [`${oracleHome}/rdbms/admin/catproc.sql`]:
`REM catproc.sql
REM Copyright (c) 1992, 2024, Oracle. All rights reserved.
REM
REM NAME
REM   catproc.sql - CATalog PROCedural objects
REM
REM DESCRIPTION
REM   Creates the PL/SQL packages (DBMS_OUTPUT, DBMS_LOCK, UTL_FILE, etc.).
REM   Must be run while connected AS SYSDBA.
REM
REM NOTES
REM   This is a simulated catproc script.

-- PL/SQL packages would be created here
-- In this simulator, they are built-in to OracleDatabase.ts

SELECT 'Procedural option installation complete.' FROM DUAL;
`,
    [`${oracleHome}/rdbms/admin/utlrp.sql`]:
`REM utlrp.sql
REM Copyright (c) 2002, 2024, Oracle. All rights reserved.
REM
REM NAME
REM   utlrp.sql - UTiLity Recompile invalid objects
REM
REM DESCRIPTION
REM   Recompiles all invalid PL/SQL objects.

-- Recompilation logic simulated
SELECT 'All objects recompiled successfully.' FROM DUAL;
`,

    // ── Datafiles ($ORACLE_BASE/oradata/ORCL/) ────────────────
    [`${oradata}/system01.dbf`]: '[ORACLE DATAFILE - SYSTEM tablespace - 800M]',
    [`${oradata}/sysaux01.dbf`]: '[ORACLE DATAFILE - SYSAUX tablespace - 550M]',
    [`${oradata}/undotbs01.dbf`]: '[ORACLE DATAFILE - UNDO tablespace - 200M]',
    [`${oradata}/users01.dbf`]: '[ORACLE DATAFILE - USERS tablespace - 100M]',
    [`${oradata}/temp01.dbf`]: '[ORACLE TEMPFILE - TEMP tablespace - 100M]',
    [`${oradata}/redo01.log`]: '[ORACLE REDO LOG - Group 1 - 50M]',
    [`${oradata}/redo02.log`]: '[ORACLE REDO LOG - Group 2 - 50M]',
    [`${oradata}/redo03.log`]: '[ORACLE REDO LOG - Group 3 - 50M]',
    [`${oradata}/control01.ctl`]: '[ORACLE CONTROL FILE 1]',
    [`${oradata}/control02.ctl`]: '[ORACLE CONTROL FILE 2]',

    // ── Admin dump dirs ($ORACLE_BASE/admin/ORCL/) ────────────
    [`${oracleBase}/admin/${sid}/adump/.keep`]: '',
    [`${oracleBase}/admin/${sid}/bdump/.keep`]: '',
    [`${oracleBase}/admin/${sid}/cdump/.keep`]: '',
    [`${oracleBase}/admin/${sid}/udump/.keep`]: '',

    // ── Diagnostic trace dir ──────────────────────────────────
    [`${oracleBase}/diag/rdbms/orcl/${sid}/trace/alert_${sid}.log`]:
`${new Date().toISOString().replace('T', ' ').slice(0, 19)}
Starting ORACLE instance (normal)
LICENSE_MAX_SESSION = 0
LICENSE_SESSIONS_WARNING = 0
Shared memory segment for instance monitoring created
Picked latch-free SCN scheme 3
Using LOG_ARCHIVE_DEST_1 parameter default value as ${oracleBase}/archivelog
Thread 1 opened at log sequence 1
  Current log# 1 seq# 1 mem# 0: ${oradata}/redo01.log
Successful open of redo thread 1
MTTR advisory is disabled because FAST_START_MTTR_TARGET is not set
SMON: enabling cache recovery
Successfully onlined Undo Tablespace 2.
Verifying file header compatibility for 11g tablespace encryption..
Verifying 11g file header compatibility for tablespace encryption completed
SMON: enabling tx recovery
Database Characterset is AL32UTF8
No Resource Manager plan active
replication_dependency_tracking turned off (no async multimaster replication found)
Starting background process MMON
Starting background process MMNL
${new Date().toISOString().replace('T', ' ').slice(0, 19)}
Database ${sid} opened.
Completed: ALTER DATABASE OPEN
`,
    // ── Diagnostic incident dir ───────────────────────────────
    [`${oracleBase}/diag/rdbms/orcl/${sid}/incident/.keep`]: '',

    // ── Archived redo logs dir ────────────────────────────────
    [`${oracleBase}/archivelog/.keep`]: '',

    // ── Fast Recovery Area ────────────────────────────────────
    [`${oracleBase}/fast_recovery_area/.keep`]: '',
  };

  for (const [path, content] of Object.entries(files)) {
    device.writeFileFromEditor(path, content);
  }
}

/**
 * Write updated spfile content to the VFS after ALTER SYSTEM SET ... SCOPE=SPFILE|BOTH.
 */
export function updateSpfileOnDevice(device: import('@/network').Equipment, parameters: Map<string, string>): void {
  const oracleHome = ORACLE_CONFIG.HOME;
  const sid = ORACLE_CONFIG.SID;
  const lines: string[] = [];
  for (const [name, value] of parameters) {
    const needsQuote = /[a-zA-Z]/.test(value) && !value.startsWith("'");
    lines.push(`*.${name}=${needsQuote ? `'${value}'` : value}`);
  }
  device.writeFileFromEditor(`${oracleHome}/dbs/spfile${sid}.ora`, lines.join('\n') + '\n');
}

/**
 * Write updated alert log to the VFS.
 */
export function syncAlertLogToDevice(device: import('@/network').Equipment, alertLogEntries: string[]): void {
  const oracleBase = ORACLE_CONFIG.BASE;
  const sid = ORACLE_CONFIG.SID;
  const path = `${oracleBase}/diag/rdbms/orcl/${sid}/trace/alert_${sid}.log`;
  device.writeFileFromEditor(path, alertLogEntries.join('\n') + '\n');
}
