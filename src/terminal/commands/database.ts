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
 * Initialize Oracle filesystem tree and environment on a Linux device.
 * Creates /u01/app/oracle/... directory structure and config files.
 * Safe to call multiple times — skips if already initialized.
 */
const oracleFilesystemInitialized = new Set<string>();

export function initOracleFilesystem(device: import('@/network').Equipment): void {
  const deviceId = device.id || 'default';
  if (oracleFilesystemInitialized.has(deviceId)) return;
  oracleFilesystemInitialized.add(deviceId);

  // Create Oracle directory structure via writeFileFromEditor
  // (writes create parent directories automatically in our VFS)
  const oracleHome = ORACLE_CONFIG.HOME;
  const oracleBase = ORACLE_CONFIG.BASE;
  const sid = ORACLE_CONFIG.SID;

  // Create config files
  const files: Record<string, string> = {
    [`${oracleHome}/network/admin/tnsnames.ora`]:
`ORCL =
  (DESCRIPTION =
    (ADDRESS = (PROTOCOL = TCP)(HOST = localhost)(PORT = 1521))
    (CONNECT_DATA =
      (SERVER = DEDICATED)
      (SERVICE_NAME = ORCL)
    )
  )
`,
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
    [`${oracleHome}/network/admin/sqlnet.ora`]:
`NAMES.DIRECTORY_PATH = (TNSNAMES, LDAP)
SQLNET.AUTHENTICATION_SERVICES = (NTS)
SQLNET.EXPIRE_TIME = 10
`,
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
compatible               = 19.0.0
remote_login_passwordfile = EXCLUSIVE
control_files            = ('${oracleBase}/oradata/${sid}/control01.ctl',
                            '${oracleBase}/oradata/${sid}/control02.ctl')
audit_file_dest          = '${oracleBase}/admin/${sid}/adump'
audit_trail              = DB
diagnostic_dest          = ${oracleBase}
`,
    [`/etc/oratab`]: `${sid}:${oracleHome}:Y\n`,
    [`/etc/profile.d/oracle.sh`]:
`export ORACLE_HOME=${oracleHome}
export ORACLE_SID=${sid}
export ORACLE_BASE=${oracleBase}
export PATH=\$ORACLE_HOME/bin:\$PATH
export LD_LIBRARY_PATH=\$ORACLE_HOME/lib
export TNS_ADMIN=\$ORACLE_HOME/network/admin
`,
    // Stub binaries (existence marker files)
    [`${oracleHome}/bin/sqlplus`]: '#!/bin/bash\n# Oracle SQL*Plus\n',
    [`${oracleHome}/bin/lsnrctl`]: '#!/bin/bash\n# Oracle Listener Control\n',
    [`${oracleHome}/bin/tnsping`]: '#!/bin/bash\n# Oracle TNS Ping Utility\n',
    [`${oracleHome}/bin/dbca`]: '#!/bin/bash\n# Oracle Database Configuration Assistant\n',
    [`${oracleHome}/bin/orapwd`]: '#!/bin/bash\n# Oracle Password File Utility\n',
    [`${oracleHome}/bin/rman`]: '#!/bin/bash\n# Oracle Recovery Manager\n',
    // Stub data files
    [`${oracleBase}/oradata/${sid}/system01.dbf`]: '[ORACLE DATAFILE - SYSTEM tablespace]',
    [`${oracleBase}/oradata/${sid}/sysaux01.dbf`]: '[ORACLE DATAFILE - SYSAUX tablespace]',
    [`${oracleBase}/oradata/${sid}/undotbs01.dbf`]: '[ORACLE DATAFILE - UNDO tablespace]',
    [`${oracleBase}/oradata/${sid}/users01.dbf`]: '[ORACLE DATAFILE - USERS tablespace]',
    [`${oracleBase}/oradata/${sid}/temp01.dbf`]: '[ORACLE DATAFILE - TEMP tablespace]',
    [`${oracleBase}/oradata/${sid}/redo01.log`]: '[ORACLE REDO LOG - Group 1]',
    [`${oracleBase}/oradata/${sid}/redo02.log`]: '[ORACLE REDO LOG - Group 2]',
    [`${oracleBase}/oradata/${sid}/redo03.log`]: '[ORACLE REDO LOG - Group 3]',
    [`${oracleBase}/oradata/${sid}/control01.ctl`]: '[ORACLE CONTROL FILE 1]',
    [`${oracleBase}/oradata/${sid}/control02.ctl`]: '[ORACLE CONTROL FILE 2]',
    // Alert log
    [`${oracleBase}/diag/rdbms/orcl/${sid}/trace/alert_${sid}.log`]:
`${new Date().toISOString()} Thread 1 opened at log sequence 1
  Current log# 1 seq# 1 mem# 0: ${oracleBase}/oradata/${sid}/redo01.log
Successful open of redo thread 1
MTTR advisory is disabled because FAST_START_MTTR_TARGET is not set
${new Date().toISOString()} SMON: enabling cache recovery
Successfully onlined Undo Tablespace 2.
${new Date().toISOString()} Database Characterset is AL32UTF8
`,
  };

  for (const [path, content] of Object.entries(files)) {
    device.writeFileFromEditor(path, content);
  }
}
