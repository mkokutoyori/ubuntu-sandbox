/**
 * Debug — Cycle de vie d'une instance Oracle.
 *
 * STARTUP/SHUTDOWN variants, états (SHUTDOWN, NOMOUNT, MOUNT, OPEN),
 * SPFILE vs PFILE, paramètres dynamiques/statiques, restricted mode,
 * quiesce, force logging, log_archive_mode, instance_recovery,
 * background process management.
 */

import { describe, it, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { removeOracleDatabase, getOracleDatabase } from '@/terminal/commands/database';
import { createSqlPlusRunner, runOracleDump, type OracleDebugLine } from './_oracle-dump';
import { monitoringSweep } from './_padding';

beforeEach(() => { resetCounters(); resetDeviceCounters(); Logger.reset(); });

describe('debug — Oracle instance lifecycle', () => {
  it('parcourt startup/shutdown variants + SPFILE + params + restricted + quiesce', () => {
    const srv = new LinuxServer('linux-server', 'ora-life', 100, 100);
    getOracleDatabase(srv.id);
    const runner = createSqlPlusRunner(srv);

    const lines: OracleDebugLine[] = [
      // ── 1. discover current state ────────────────────────────────
      { section: 'current state', cmd: 'SELECT status FROM v$instance;' },
      'SELECT instance_name, host_name, version, startup_time, status, parallel, archiver FROM v$instance;',
      'SELECT name, dbid, open_mode, log_mode, force_logging, flashback_on FROM v$database;',
      "SELECT * FROM v$instance;",
      "SELECT * FROM v$database;",

      // ── 2. SHUTDOWN variants ─────────────────────────────────────
      { section: 'SHUTDOWN normal', cmd: 'SHUTDOWN NORMAL;' },
      'SHUTDOWN IMMEDIATE;',
      'SHUTDOWN TRANSACTIONAL;',
      'SHUTDOWN ABORT;',
      'SHUTDOWN;',

      // ── 3. STARTUP NOMOUNT ──────────────────────────────────────
      { section: 'STARTUP NOMOUNT', cmd: 'STARTUP NOMOUNT;' },
      'SELECT status FROM v$instance;',
      'SELECT * FROM v$bgprocess WHERE paddr != \'00\';',
      'SELECT * FROM v$database;',  // doit échouer / vide
      'SELECT name FROM v$controlfile;', // doit échouer
      'SHOW PARAMETER instance_name;',
      'SHOW PARAMETER db_name;',
      'SHOW PARAMETER service_names;',
      'SHOW PARAMETER spfile;',
      'SHOW PARAMETER background_dump_dest;',
      'SHOW PARAMETER user_dump_dest;',

      // ── 4. NOMOUNT → MOUNT ──────────────────────────────────────
      { section: 'NOMOUNT → MOUNT', cmd: 'ALTER DATABASE MOUNT;' },
      'SELECT status FROM v$instance;',
      'SELECT * FROM v$database;',
      'SELECT name FROM v$controlfile;',
      'SELECT name FROM v$datafile ORDER BY file#;',
      'SELECT * FROM v$tablespace ORDER BY ts#;',
      "ALTER DATABASE OPEN READ ONLY;",
      'SHUTDOWN IMMEDIATE;',
      'STARTUP MOUNT;',
      'SELECT status FROM v$instance;',

      // ── 5. MOUNT → OPEN ─────────────────────────────────────────
      { section: 'MOUNT → OPEN', cmd: 'ALTER DATABASE OPEN;' },
      'SELECT status FROM v$instance;',
      'SELECT open_mode FROM v$database;',
      "ALTER DATABASE OPEN READ ONLY;",
      'SHUTDOWN IMMEDIATE;',
      'STARTUP;',
      'SELECT status FROM v$instance;',

      // ── 6. STARTUP variants ──────────────────────────────────────
      { section: 'STARTUP variants', cmd: 'SHUTDOWN IMMEDIATE;' },
      'STARTUP NOMOUNT;',
      'ALTER DATABASE MOUNT;',
      'ALTER DATABASE OPEN;',
      'SHUTDOWN IMMEDIATE;',
      'STARTUP MOUNT;',
      'ALTER DATABASE OPEN;',
      'SHUTDOWN IMMEDIATE;',
      'STARTUP RESTRICT;',
      "SELECT logins FROM v$instance;",
      'ALTER SYSTEM DISABLE RESTRICTED SESSION;',
      'ALTER SYSTEM ENABLE RESTRICTED SESSION;',
      'SHUTDOWN IMMEDIATE;',
      'STARTUP FORCE;',
      'SHUTDOWN ABORT;',
      'STARTUP;',
      "STARTUP UPGRADE;",
      'SHUTDOWN IMMEDIATE;',
      'STARTUP;',
      "STARTUP OPEN RECOVER;",
      'SHUTDOWN IMMEDIATE;',
      "STARTUP MOUNT RESTRICT EXCLUSIVE;",
      'ALTER DATABASE OPEN;',
      'ALTER SYSTEM DISABLE RESTRICTED SESSION;',

      // ── 7. SPFILE / PFILE ────────────────────────────────────────
      { section: 'SPFILE vs PFILE', cmd: 'SHOW PARAMETER spfile;' },
      "SELECT * FROM v$spparameter WHERE rownum < 30;",
      "SELECT * FROM v$parameter WHERE rownum < 30;",
      "SELECT * FROM v$parameter2 WHERE rownum < 30;",
      "CREATE PFILE FROM SPFILE;",
      "CREATE PFILE='/u01/app/oracle/dbs/init_backup.ora' FROM SPFILE;",
      "CREATE PFILE FROM MEMORY;",
      "CREATE SPFILE FROM PFILE;",
      "CREATE SPFILE FROM PFILE='/u01/app/oracle/dbs/init_backup.ora';",
      "CREATE SPFILE FROM MEMORY;",
      "CREATE SPFILE='/u01/oradata/spfileORCL_backup.ora' FROM PFILE;",
      "HOST ls -la $ORACLE_HOME/dbs/spfileORCL.ora",
      "HOST ls -la $ORACLE_HOME/dbs/initORCL.ora 2>/dev/null",

      // ── 8. paramètres — dynamiques vs statiques ──────────────────
      { section: 'dynamic vs static params', cmd: "SELECT name, value, issys_modifiable, isses_modifiable FROM v$parameter WHERE issys_modifiable = 'IMMEDIATE' AND rownum < 50;" },
      "SELECT name FROM v$parameter WHERE issys_modifiable = 'FALSE' AND rownum < 50;",
      "SELECT name FROM v$parameter WHERE isses_modifiable = 'TRUE' AND rownum < 50;",
      "ALTER SYSTEM SET shared_pool_size=256M SCOPE=BOTH;",
      "ALTER SYSTEM SET shared_pool_size=256M SCOPE=MEMORY;",
      "ALTER SYSTEM SET shared_pool_size=256M SCOPE=SPFILE;",
      "ALTER SYSTEM SET processes=300 SCOPE=SPFILE;",  // static → SPFILE only
      "ALTER SYSTEM SET sessions=600 SCOPE=SPFILE;",
      "ALTER SYSTEM SET open_cursors=500 SCOPE=BOTH;",
      "ALTER SYSTEM SET log_buffer=32M SCOPE=SPFILE;",
      "ALTER SYSTEM SET undo_retention=3600 SCOPE=BOTH;",
      "ALTER SYSTEM SET cursor_sharing=FORCE SCOPE=BOTH;",
      "ALTER SYSTEM SET cursor_sharing=EXACT SCOPE=BOTH;",
      "ALTER SYSTEM SET optimizer_mode=ALL_ROWS SCOPE=BOTH;",
      "ALTER SYSTEM SET optimizer_mode=FIRST_ROWS_10 SCOPE=BOTH;",
      "ALTER SYSTEM RESET shared_pool_size SCOPE=SPFILE;",
      "ALTER SESSION SET cursor_sharing=FORCE;",
      "ALTER SESSION SET nls_date_format='YYYY-MM-DD HH24:MI:SS';",
      "ALTER SESSION SET sql_trace=TRUE;",
      "ALTER SESSION SET sql_trace=FALSE;",
      "ALTER SESSION SET timed_statistics=TRUE;",
      "ALTER SESSION SET optimizer_index_cost_adj=10;",
      "ALTER SESSION SET workarea_size_policy=AUTO;",
      "ALTER SESSION SET workarea_size_policy=MANUAL;",
      "ALTER SESSION SET sort_area_size=1048576;",

      // ── 9. memory params ─────────────────────────────────────────
      { section: 'memory params', cmd: 'SHOW PARAMETER sga;' },
      'SHOW PARAMETER pga;',
      'SHOW PARAMETER memory;',
      'SHOW PARAMETER shared_pool;',
      'SHOW PARAMETER db_cache;',
      'SHOW PARAMETER log_buffer;',
      'SHOW PARAMETER large_pool;',
      'SHOW PARAMETER java_pool;',
      'SHOW PARAMETER streams_pool;',
      'SHOW PARAMETER processes;',
      'SHOW PARAMETER sessions;',
      'SHOW PARAMETER transactions;',
      "ALTER SYSTEM SET sga_target=2G SCOPE=BOTH;",
      "ALTER SYSTEM SET sga_max_size=2G SCOPE=SPFILE;",
      "ALTER SYSTEM SET pga_aggregate_target=512M SCOPE=BOTH;",
      "ALTER SYSTEM SET memory_target=0 SCOPE=SPFILE;",
      "ALTER SYSTEM SET memory_max_target=4G SCOPE=SPFILE;",
      "ALTER SYSTEM SET shared_pool_size=512M SCOPE=BOTH;",
      "ALTER SYSTEM SET db_cache_size=1G SCOPE=BOTH;",
      "ALTER SYSTEM SET log_buffer=32M SCOPE=SPFILE;",
      "ALTER SYSTEM SET large_pool_size=128M SCOPE=BOTH;",
      "ALTER SYSTEM SET java_pool_size=64M SCOPE=BOTH;",

      // ── 10. archivelog mode toggle ──────────────────────────────
      { section: 'ARCHIVELOG mode', cmd: 'ARCHIVE LOG LIST;' },
      'SELECT log_mode FROM v$database;',
      'SHUTDOWN IMMEDIATE;',
      'STARTUP MOUNT;',
      'ALTER DATABASE ARCHIVELOG;',
      'ALTER DATABASE OPEN;',
      'ARCHIVE LOG LIST;',
      'SELECT log_mode FROM v$database;',
      'SHUTDOWN IMMEDIATE;',
      'STARTUP MOUNT;',
      'ALTER DATABASE NOARCHIVELOG;',
      'ALTER DATABASE OPEN;',
      'ARCHIVE LOG LIST;',
      'SHUTDOWN IMMEDIATE;',
      'STARTUP MOUNT;',
      'ALTER DATABASE ARCHIVELOG;',
      'ALTER DATABASE OPEN;',
      'ALTER SYSTEM ARCHIVE LOG ALL;',
      'ALTER SYSTEM ARCHIVE LOG NEXT;',
      'ALTER SYSTEM ARCHIVE LOG CURRENT;',
      'ALTER SYSTEM SWITCH LOGFILE;',
      'ALTER SYSTEM SWITCH LOGFILE;',
      'ALTER SYSTEM SWITCH LOGFILE;',

      // ── 11. force logging / flashback toggle ────────────────────
      { section: 'force logging', cmd: 'SELECT force_logging FROM v$database;' },
      'ALTER DATABASE FORCE LOGGING;',
      'SELECT force_logging FROM v$database;',
      'ALTER DATABASE NO FORCE LOGGING;',
      'SELECT force_logging FROM v$database;',
      { section: 'flashback', cmd: 'SELECT flashback_on FROM v$database;' },
      'ALTER DATABASE FLASHBACK ON;',
      'SELECT flashback_on FROM v$database;',
      "ALTER SYSTEM SET db_flashback_retention_target=1440 SCOPE=BOTH;",
      'ALTER DATABASE FLASHBACK OFF;',

      // ── 12. RESTRICTED + QUIESCE ────────────────────────────────
      { section: 'restricted / quiesce', cmd: 'ALTER SYSTEM ENABLE RESTRICTED SESSION;' },
      "SELECT logins FROM v$instance;",
      'ALTER SYSTEM DISABLE RESTRICTED SESSION;',
      'ALTER SYSTEM QUIESCE RESTRICTED;',
      "SELECT active_state FROM v$instance;",
      'ALTER SYSTEM UNQUIESCE;',
      'ALTER SYSTEM SUSPEND;',
      "SELECT database_status FROM v$instance;",
      'ALTER SYSTEM RESUME;',

      // ── 13. instance recovery ───────────────────────────────────
      { section: 'instance recovery', cmd: 'SELECT * FROM v$instance_recovery;' },
      "SELECT * FROM v$recovery_status;",
      "SELECT * FROM v$recovery_progress;",
      "ALTER SYSTEM SET fast_start_mttr_target=300 SCOPE=BOTH;",
      "SHOW PARAMETER fast_start_mttr_target;",
      "SHOW PARAMETER log_checkpoint_interval;",
      "SHOW PARAMETER log_checkpoint_timeout;",
      "ALTER SYSTEM SET log_checkpoint_interval=10000 SCOPE=BOTH;",
      'ALTER SYSTEM CHECKPOINT;',
      'ALTER SYSTEM CHECKPOINT GLOBAL;',

      // ── 14. background process list ─────────────────────────────
      { section: 'background processes', cmd: 'SELECT * FROM v$bgprocess WHERE paddr != \'00\' ORDER BY name;' },
      'SELECT COUNT(*) FROM v$bgprocess WHERE paddr != \'00\';',
      'SELECT pname, spid, status FROM v$process WHERE pname IS NOT NULL;',
      'SELECT COUNT(*) FROM v$process WHERE pname IS NOT NULL;',

      // ── 15. logs alert + trace ──────────────────────────────────
      { section: 'alert + trace', cmd: 'SELECT * FROM v$diag_info;' },
      "SELECT message_text FROM x$dbgalertext ORDER BY originating_timestamp DESC FETCH FIRST 50 ROWS ONLY;",
      "SELECT * FROM v$diag_alert_ext ORDER BY originating_timestamp DESC FETCH FIRST 20 ROWS ONLY;",
      'HOST tail -100 /u01/app/oracle/diag/rdbms/orcl/orcl/trace/alert_ORCL.log',

      // ── 16. version / option / time ─────────────────────────────
      { section: 'version + options', cmd: 'SELECT * FROM v$version;' },
      'SELECT * FROM v$option;',
      'SELECT * FROM v$license;',
      'SELECT * FROM product_component_version;',
      'SELECT * FROM v$timezone_file;',
      'SELECT sysdate FROM dual;',
      'SELECT systimestamp FROM dual;',
      'SELECT * FROM v$nls_parameters;',
      "ALTER SESSION SET NLS_DATE_LANGUAGE='FRENCH';",
      "ALTER SESSION SET NLS_LANGUAGE='AMERICAN';",
      "ALTER SESSION SET NLS_TERRITORY='AMERICA';",

      // ── 17. event tracing ───────────────────────────────────────
      { section: 'event tracing', cmd: "ALTER SESSION SET EVENTS '10046 trace name context forever, level 12';" },
      "ALTER SESSION SET EVENTS '10046 trace name context off';",
      "ALTER SESSION SET EVENTS '10053 trace name context forever, level 1';",
      "ALTER SESSION SET EVENTS '10053 trace name context off';",
      "ALTER SYSTEM SET EVENTS '942 trace name errorstack level 3';",
      "ALTER SYSTEM SET EVENTS '942 trace name errorstack off';",
      "ALTER SESSION SET EVENTS 'IMMEDIATE TRACE NAME SYSTEMSTATE LEVEL 266';",
      "ALTER SYSTEM SET EVENTS 'IMMEDIATE TRACE NAME HEAPDUMP LEVEL 2';",
      "ORADEBUG SETMYPID;",
      "ORADEBUG DUMP SYSTEMSTATE 10;",
      "ORADEBUG DUMP HANGANALYZE 3;",
      "ORADEBUG TRACEFILE_NAME;",

      // ── 18. cross-validate state ────────────────────────────────
      { section: 'cross-validate', cmd: 'SELECT instance_name, status, archiver, log_switch_wait FROM v$instance;' },
      'SELECT name, open_mode, log_mode, force_logging, flashback_on FROM v$database;',
      'SELECT COUNT(*) FROM v$session WHERE username IS NOT NULL;',
      'SELECT COUNT(*) FROM v$process;',
      'SELECT * FROM v$instance;',
      'SELECT * FROM v$database;',
      'SELECT * FROM v$option WHERE value = \'TRUE\';',

      // ── 19. shutdown + cleanup ──────────────────────────────────
      { section: 'closing', cmd: 'SELECT * FROM v$instance;' },
      'ALTER SYSTEM CHECKPOINT;',
      'ALTER SYSTEM ARCHIVE LOG CURRENT;',
      ...monitoringSweep('instance-lifecycle'),
      'EXIT;',
    ];

    runOracleDump('oracle-instance-lifecycle',
      'LinuxServer ora-life — Oracle ORCL', lines, runner);
    runner.dispose();
    removeOracleDatabase(srv.id);
  });
});
