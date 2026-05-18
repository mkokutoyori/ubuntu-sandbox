/**
 * Debug — Journalisation Oracle.
 *
 * Alert log, redo logs, archive logs, log switch, supplemental logging,
 * trace files, undo, flashback logs, audit trail.
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

describe('debug — Oracle journalization', () => {
  it('parcourt alert log, redo, archive, supplemental, undo, flashback, trace', () => {
    const srv = new LinuxServer('linux-server', 'ora-journal', 100, 100);
    getOracleDatabase(srv.id);
    const runner = createSqlPlusRunner(srv);

    const lines: OracleDebugLine[] = [
      // ── 1. ALERT LOG ──────────────────────────────────────────────
      { section: 'alert log location', cmd: "SELECT value FROM v$diag_info WHERE name = 'Diag Trace';" },
      "SELECT value FROM v$diag_info WHERE name = 'Diag Alert';",
      "SELECT value FROM v$diag_info WHERE name = 'Default Trace File';",
      "SELECT * FROM v$diag_info;",
      "SELECT name, value FROM v$parameter WHERE name LIKE 'background_dump%' OR name LIKE 'user_dump%' OR name LIKE 'audit%dest%';",
      "SHOW PARAMETER background_dump_dest;",
      "SHOW PARAMETER user_dump_dest;",
      "SHOW PARAMETER core_dump_dest;",
      "SHOW PARAMETER diagnostic_dest;",
      "SELECT name, value, isdefault FROM v$parameter WHERE name = 'diagnostic_dest';",

      // ── 2. CONTENU DE L'ALERT LOG (via X$DBGALERTEXT) ────────────
      { section: 'alert.log content', cmd: 'SELECT originating_timestamp, message_text FROM x$dbgalertext ORDER BY originating_timestamp DESC FETCH FIRST 50 ROWS ONLY;' },
      'SELECT COUNT(*) FROM x$dbgalertext;',
      "SELECT message_text FROM x$dbgalertext WHERE message_text LIKE '%ORA-%' ORDER BY originating_timestamp DESC FETCH FIRST 20 ROWS ONLY;",
      "SELECT message_text FROM x$dbgalertext WHERE message_text LIKE '%checkpoint%' ORDER BY originating_timestamp DESC FETCH FIRST 20 ROWS ONLY;",
      "SELECT message_text FROM x$dbgalertext WHERE message_text LIKE '%switch%' ORDER BY originating_timestamp DESC FETCH FIRST 30 ROWS ONLY;",
      "SELECT problem_key, count, first_incident_time, last_incident_time FROM v$diag_problem;",
      'SELECT * FROM v$diag_incident ORDER BY create_time DESC FETCH FIRST 20 ROWS ONLY;',
      'SELECT * FROM v$diag_alert_ext ORDER BY originating_timestamp DESC FETCH FIRST 20 ROWS ONLY;',
      "SELECT count(*) FROM v$diag_incident WHERE status = 'READY';",

      // ── 3. REDO LOGS — config et état ────────────────────────────
      { section: 'redo logs config', cmd: 'SELECT * FROM v$log ORDER BY group#;' },
      'SELECT group#, thread#, sequence#, bytes/1024/1024 AS mb, members, status, archived FROM v$log;',
      'SELECT * FROM v$logfile ORDER BY group#, member;',
      "SELECT group#, member, status, type FROM v$logfile;",
      'SELECT COUNT(*) AS log_groups FROM v$log;',
      'SELECT COUNT(*) AS log_members FROM v$logfile;',
      "SELECT group#, COUNT(*) AS members_per_group FROM v$logfile GROUP BY group#;",
      'SELECT * FROM v$log_history ORDER BY sequence# DESC FETCH FIRST 30 ROWS ONLY;',
      "SELECT sequence#, first_change#, next_change#, first_time, archived FROM v$log_history ORDER BY sequence# DESC FETCH FIRST 50 ROWS ONLY;",
      "SELECT COUNT(*) FROM v$log_history;",

      // ── 4. LOG SWITCH operations ────────────────────────────────
      { section: 'log switches', cmd: 'ALTER SYSTEM SWITCH LOGFILE;' },
      'ALTER SYSTEM SWITCH LOGFILE;',
      'ALTER SYSTEM SWITCH LOGFILE;',
      'ALTER SYSTEM SWITCH LOGFILE;',
      'ALTER SYSTEM CHECKPOINT;',
      'ALTER SYSTEM CHECKPOINT GLOBAL;',
      'ALTER SYSTEM CHECKPOINT LOCAL;',
      'ALTER SYSTEM ARCHIVE LOG CURRENT;',
      'ALTER SYSTEM ARCHIVE LOG ALL;',
      'ALTER SYSTEM ARCHIVE LOG NEXT;',
      'ALTER SYSTEM ARCHIVE LOG STOP;',
      'ALTER SYSTEM ARCHIVE LOG START;',
      "SELECT log_mode FROM v$database;",
      "SELECT name, log_mode, controlfile_type FROM v$database;",
      "SELECT * FROM v$instance;",

      // ── 5. AJOUT / SUPPRESSION / DEPLACEMENT de redo logs ───────
      { section: 'manage redo log files', cmd: "ALTER DATABASE ADD LOGFILE GROUP 4 ('/u01/oradata/ORCL/redo04a.log','/u02/oradata/ORCL/redo04b.log') SIZE 200M REUSE;" },
      "ALTER DATABASE ADD LOGFILE GROUP 5 '/u01/oradata/ORCL/redo05.log' SIZE 200M REUSE;",
      "ALTER DATABASE ADD LOGFILE MEMBER '/u02/oradata/ORCL/redo01b.log' TO GROUP 1;",
      "ALTER DATABASE ADD LOGFILE MEMBER '/u02/oradata/ORCL/redo02b.log' TO GROUP 2;",
      "ALTER DATABASE ADD LOGFILE MEMBER '/u02/oradata/ORCL/redo03b.log' TO GROUP 3;",
      "ALTER DATABASE DROP LOGFILE MEMBER '/u02/oradata/ORCL/redo01b.log';",
      "ALTER DATABASE DROP LOGFILE GROUP 5;",
      "ALTER DATABASE RENAME FILE '/u01/oradata/ORCL/redo01a.log' TO '/u03/oradata/ORCL/redo01a.log';",
      "ALTER DATABASE CLEAR LOGFILE GROUP 4;",
      "ALTER DATABASE CLEAR UNARCHIVED LOGFILE GROUP 4;",

      // ── 6. ARCHIVELOG MODE ──────────────────────────────────────
      { section: 'archivelog mode', cmd: "SELECT log_mode FROM v$database;" },
      "ARCHIVE LOG LIST;",
      'SHUTDOWN IMMEDIATE;',
      'STARTUP MOUNT;',
      'ALTER DATABASE ARCHIVELOG;',
      'ALTER DATABASE OPEN;',
      'ARCHIVE LOG LIST;',
      "SELECT name FROM v$archived_log ORDER BY sequence# DESC FETCH FIRST 30 ROWS ONLY;",
      'SELECT COUNT(*) FROM v$archived_log;',
      "SELECT thread#, sequence#, first_change#, next_change#, first_time, archived FROM v$archived_log ORDER BY sequence# DESC FETCH FIRST 30 ROWS ONLY;",
      'SELECT * FROM v$archive_dest;',
      "SELECT dest_name, status, destination, archiver, schedule FROM v$archive_dest WHERE status = 'VALID';",
      "SELECT * FROM v$archive_processes;",
      "SHOW PARAMETER log_archive_dest;",
      "SHOW PARAMETER log_archive_dest_1;",
      "SHOW PARAMETER log_archive_format;",
      "SHOW PARAMETER log_archive_max_processes;",
      "ALTER SYSTEM SET log_archive_dest_1='LOCATION=/u01/archivelog/' SCOPE=BOTH;",
      "ALTER SYSTEM SET log_archive_format='arch_%t_%s_%r.arc' SCOPE=SPFILE;",
      "ALTER SYSTEM SET log_archive_max_processes=4 SCOPE=BOTH;",

      // ── 7. SUPPLEMENTAL LOGGING ─────────────────────────────────
      { section: 'supplemental logging', cmd: 'SELECT supplemental_log_data_min, supplemental_log_data_pk, supplemental_log_data_ui, supplemental_log_data_fk, supplemental_log_data_all FROM v$database;' },
      'ALTER DATABASE ADD SUPPLEMENTAL LOG DATA;',
      'ALTER DATABASE ADD SUPPLEMENTAL LOG DATA (PRIMARY KEY) COLUMNS;',
      'ALTER DATABASE ADD SUPPLEMENTAL LOG DATA (UNIQUE) COLUMNS;',
      'ALTER DATABASE ADD SUPPLEMENTAL LOG DATA (FOREIGN KEY) COLUMNS;',
      'ALTER DATABASE ADD SUPPLEMENTAL LOG DATA (ALL) COLUMNS;',
      'ALTER TABLE hr.employees ADD SUPPLEMENTAL LOG DATA (PRIMARY KEY) COLUMNS;',
      'ALTER TABLE hr.employees ADD SUPPLEMENTAL LOG GROUP emp_sg (employee_id, last_name) ALWAYS;',
      'ALTER DATABASE DROP SUPPLEMENTAL LOG DATA (ALL) COLUMNS;',
      'ALTER DATABASE DROP SUPPLEMENTAL LOG DATA (FOREIGN KEY) COLUMNS;',
      'ALTER TABLE hr.employees DROP SUPPLEMENTAL LOG GROUP emp_sg;',
      'SELECT * FROM dba_log_groups;',
      'SELECT * FROM dba_log_group_columns;',

      // ── 8. REDO STATISTICS ──────────────────────────────────────
      { section: 'redo statistics', cmd: "SELECT * FROM v$sysstat WHERE name LIKE 'redo%' ORDER BY name;" },
      "SELECT name, value FROM v$sysstat WHERE name = 'redo size';",
      "SELECT name, value FROM v$sysstat WHERE name = 'redo writes';",
      "SELECT name, value FROM v$sysstat WHERE name = 'redo log switches';",
      "SELECT name, value FROM v$sysstat WHERE name = 'redo blocks written';",
      "SELECT name, value FROM v$sysstat WHERE name = 'redo entries';",
      "SELECT name, value FROM v$sysstat WHERE name = 'redo synch writes';",
      "SELECT name, total_waits, time_waited FROM v$system_event WHERE event LIKE 'log file%' ORDER BY total_waits DESC FETCH FIRST 10 ROWS ONLY;",
      'SELECT * FROM v$logmnr_contents WHERE rownum < 30;',
      'SELECT * FROM v$logmnr_logs;',
      'SELECT * FROM v$logmnr_dictionary;',

      // ── 9. LogMiner ─────────────────────────────────────────────
      { section: 'LogMiner', cmd:
        "BEGIN DBMS_LOGMNR.ADD_LOGFILE(LogFileName=>'/u01/archivelog/arch_1_42_111.arc', Options=>DBMS_LOGMNR.NEW); END;" },
      "BEGIN DBMS_LOGMNR.START_LOGMNR(Options=>DBMS_LOGMNR.DICT_FROM_ONLINE_CATALOG); END;",
      "SELECT scn, timestamp, username, operation, table_name, sql_redo FROM v$logmnr_contents WHERE rownum < 50;",
      "BEGIN DBMS_LOGMNR.END_LOGMNR; END;",
      "BEGIN DBMS_LOGMNR.ADD_LOGFILE(LogFileName=>'/u01/archivelog/arch_1_43_111.arc'); END;",
      "BEGIN DBMS_LOGMNR.START_LOGMNR(StartTime=>SYSDATE-1, EndTime=>SYSDATE, Options=>DBMS_LOGMNR.DICT_FROM_ONLINE_CATALOG + DBMS_LOGMNR.COMMITTED_DATA_ONLY); END;",

      // ── 10. AUDIT LOG ─────────────────────────────────────────────
      { section: 'audit log', cmd: 'SHOW PARAMETER audit;' },
      'SHOW PARAMETER audit_trail;',
      'SHOW PARAMETER audit_file_dest;',
      'SHOW PARAMETER audit_sys_operations;',
      "SELECT * FROM dba_audit_trail ORDER BY timestamp DESC FETCH FIRST 50 ROWS ONLY;",
      'SELECT COUNT(*) FROM dba_audit_trail;',
      "SELECT * FROM dba_audit_session ORDER BY timestamp DESC FETCH FIRST 30 ROWS ONLY;",
      "SELECT * FROM dba_audit_object ORDER BY timestamp DESC FETCH FIRST 30 ROWS ONLY;",
      "SELECT * FROM dba_audit_statement ORDER BY timestamp DESC FETCH FIRST 30 ROWS ONLY;",
      "SELECT * FROM unified_audit_trail ORDER BY event_timestamp DESC FETCH FIRST 50 ROWS ONLY;",
      'SELECT COUNT(*) FROM unified_audit_trail;',
      "SELECT * FROM fga_log$ WHERE rownum < 30;",
      "SELECT * FROM dba_fga_audit_trail ORDER BY timestamp DESC FETCH FIRST 30 ROWS ONLY;",

      // ── 10b. AUDIT OPTIONS CONFIG (real, not stubbed) ─────────────
      { section: 'audit options config', cmd: 'CREATE TABLE hr.salaries (id NUMBER, amount NUMBER);' },
      'AUDIT SELECT, UPDATE ON hr.salaries;',
      'AUDIT DELETE ON hr.salaries BY SESSION;',
      'AUDIT INSERT ON hr.salaries WHENEVER NOT SUCCESSFUL;',
      'AUDIT CREATE ANY TABLE;',
      'AUDIT CREATE SESSION BY hr;',
      'AUDIT DROP ANY TABLE WHENEVER SUCCESSFUL;',
      "SELECT owner, object_name, object_type, sel, upd, ins, del FROM dba_obj_audit_opts ORDER BY object_name;",
      "SELECT user_name, privilege, success, failure FROM dba_priv_audit_opts ORDER BY privilege;",
      "SELECT user_name, audit_option, success, failure FROM dba_stmt_audit_opts ORDER BY audit_option;",
      'NOAUDIT SELECT ON hr.salaries;',
      'NOAUDIT CREATE ANY TABLE;',
      "SELECT object_name, sel, upd FROM dba_obj_audit_opts WHERE object_name = 'SALARIES';",
      "SELECT privilege FROM dba_priv_audit_opts ORDER BY privilege;",

      // ── 11. TRACE FILES ───────────────────────────────────────────
      { section: 'trace files', cmd: "SELECT * FROM v$diag_info WHERE name = 'Default Trace File';" },
      "ALTER SESSION SET SQL_TRACE=TRUE;",
      "ALTER SESSION SET SQL_TRACE=FALSE;",
      "ALTER SESSION SET EVENTS '10046 trace name context forever, level 12';",
      "ALTER SESSION SET EVENTS '10046 trace name context off';",
      "EXEC DBMS_MONITOR.SESSION_TRACE_ENABLE(session_id=>142, serial_num=>12345, waits=>TRUE, binds=>TRUE);",
      "EXEC DBMS_MONITOR.SESSION_TRACE_DISABLE(session_id=>142, serial_num=>12345);",
      "EXEC DBMS_MONITOR.DATABASE_TRACE_ENABLE(waits=>TRUE, binds=>FALSE);",
      "EXEC DBMS_MONITOR.DATABASE_TRACE_DISABLE;",
      "EXEC DBMS_MONITOR.CLIENT_ID_TRACE_ENABLE(client_id=>'app1', waits=>TRUE);",
      "EXEC DBMS_MONITOR.SERV_MOD_ACT_TRACE_ENABLE(service_name=>'ORCL', module_name=>'SQL*Plus');",
      "SELECT * FROM v$session WHERE sql_trace = 'ENABLED';",

      // ── 12. UNDO ─────────────────────────────────────────────────
      { section: 'undo tablespace', cmd: 'SHOW PARAMETER undo;' },
      'SHOW PARAMETER undo_tablespace;',
      'SHOW PARAMETER undo_management;',
      'SHOW PARAMETER undo_retention;',
      "SELECT * FROM dba_tablespaces WHERE contents = 'UNDO';",
      "SELECT tablespace_name, status FROM dba_tablespaces WHERE tablespace_name LIKE '%UNDO%';",
      'SELECT * FROM v$undostat ORDER BY end_time DESC FETCH FIRST 30 ROWS ONLY;',
      'SELECT * FROM v$rollstat;',
      'SELECT * FROM v$rollname;',
      "SELECT segment_name, tablespace_name, status FROM dba_rollback_segs;",
      "SELECT name, value FROM v$sysstat WHERE name LIKE '%undo%';",
      "ALTER SYSTEM SET undo_retention=3600 SCOPE=BOTH;",
      "ALTER SYSTEM SET undo_tablespace=UNDOTBS1 SCOPE=BOTH;",
      "CREATE UNDO TABLESPACE undotbs2 DATAFILE '/u01/oradata/ORCL/undotbs02.dbf' SIZE 200M AUTOEXTEND ON;",
      "ALTER SYSTEM SET undo_tablespace=UNDOTBS2 SCOPE=BOTH;",
      "DROP TABLESPACE undotbs2 INCLUDING CONTENTS AND DATAFILES;",

      // ── 13. FLASHBACK LOGS ───────────────────────────────────────
      { section: 'flashback', cmd: "SELECT flashback_on FROM v$database;" },
      'SHOW PARAMETER db_flashback_retention_target;',
      'SHOW PARAMETER db_recovery_file_dest;',
      'SHOW PARAMETER db_recovery_file_dest_size;',
      "SELECT * FROM v$flashback_database_log;",
      "SELECT * FROM v$flashback_database_logfile;",
      "SELECT * FROM v$flashback_database_stat;",
      'ALTER DATABASE FLASHBACK ON;',
      'ALTER DATABASE FLASHBACK OFF;',
      "SELECT oldest_flashback_scn, oldest_flashback_time FROM v$flashback_database_log;",
      "SELECT * FROM v$recovery_area_usage;",
      "SELECT * FROM v$flash_recovery_area_usage;",
      "FLASHBACK DATABASE TO TIMESTAMP SYSTIMESTAMP - INTERVAL '1' HOUR;",
      "FLASHBACK DATABASE TO SCN 1900000;",
      "FLASHBACK TABLE hr.employees TO TIMESTAMP SYSTIMESTAMP - INTERVAL '30' MINUTE;",
      "FLASHBACK TABLE hr.employees TO BEFORE DROP;",
      "SELECT * FROM dba_recyclebin ORDER BY droptime DESC;",
      "PURGE RECYCLEBIN;",
      "PURGE DBA_RECYCLEBIN;",

      // ── 14. CONTROL FILE info ────────────────────────────────────
      { section: 'control file', cmd: 'SELECT name FROM v$controlfile;' },
      'SELECT * FROM v$controlfile_record_section;',
      'SHOW PARAMETER control_files;',
      "ALTER DATABASE BACKUP CONTROLFILE TO TRACE;",
      "ALTER DATABASE BACKUP CONTROLFILE TO '/u01/backup/control.bkp';",
      "ALTER DATABASE BACKUP CONTROLFILE TO TRACE AS '/u01/backup/cf.trc' REUSE;",
      'SELECT * FROM v$database;',
      "SELECT name, dbid, open_mode, log_mode, flashback_on, force_logging FROM v$database;",
      "SELECT controlfile_type, controlfile_change#, controlfile_time, controlfile_sequence# FROM v$database;",

      // ── 15. FORCE LOGGING ────────────────────────────────────────
      { section: 'force logging', cmd: "SELECT force_logging FROM v$database;" },
      'ALTER DATABASE FORCE LOGGING;',
      'ALTER DATABASE NO FORCE LOGGING;',
      'ALTER TABLESPACE users FORCE LOGGING;',
      'ALTER TABLESPACE users NO FORCE LOGGING;',
      "SELECT tablespace_name, force_logging FROM dba_tablespaces;",
      'ALTER TABLE hr.employees LOGGING;',
      'ALTER TABLE hr.employees NOLOGGING;',
      'ALTER INDEX hr.emp_pk LOGGING;',

      // ── 16. STATSPACK / AWR snapshots ────────────────────────────
      { section: 'AWR', cmd: "EXEC DBMS_WORKLOAD_REPOSITORY.CREATE_SNAPSHOT;" },
      "EXEC DBMS_WORKLOAD_REPOSITORY.MODIFY_SNAPSHOT_SETTINGS(interval=>60, retention=>10080);",
      'SELECT * FROM dba_hist_snapshot ORDER BY snap_id DESC FETCH FIRST 10 ROWS ONLY;',
      "SELECT snap_id, begin_interval_time, end_interval_time FROM dba_hist_snapshot ORDER BY snap_id DESC FETCH FIRST 20 ROWS ONLY;",
      "SELECT * FROM dba_hist_wr_control;",
      "SELECT * FROM dba_hist_baseline;",
      "SELECT * FROM dba_hist_sysstat WHERE stat_name = 'redo size' ORDER BY snap_id DESC FETCH FIRST 50 ROWS ONLY;",
      "SELECT * FROM dba_hist_database_instance;",

      // ── 17. EVENTS / WAITS ────────────────────────────────────────
      { section: 'wait events', cmd: 'SELECT event, total_waits, time_waited FROM v$system_event ORDER BY time_waited DESC FETCH FIRST 30 ROWS ONLY;' },
      "SELECT event, total_waits, time_waited FROM v$system_event WHERE wait_class != 'Idle' ORDER BY time_waited DESC FETCH FIRST 30 ROWS ONLY;",
      "SELECT * FROM v$session_wait WHERE wait_class != 'Idle';",
      "SELECT * FROM v$session_event WHERE sid IN (SELECT sid FROM v$session WHERE username = 'SYS') ORDER BY time_waited DESC FETCH FIRST 20 ROWS ONLY;",
      'SELECT * FROM v$event_name WHERE name LIKE \'log%\';',
      "SELECT * FROM v$active_session_history ORDER BY sample_time DESC FETCH FIRST 30 ROWS ONLY;",
      "SELECT COUNT(*) FROM v$active_session_history;",

      // ── 18. STATS DE FICHIERS ────────────────────────────────────
      { section: 'file I/O stats', cmd: 'SELECT * FROM v$filestat;' },
      'SELECT * FROM v$datafile;',
      'SELECT * FROM v$tempfile;',
      'SELECT * FROM v$logfile;',
      "SELECT file_id, file_name, tablespace_name, bytes/1024/1024 AS mb FROM dba_data_files ORDER BY tablespace_name, file_id;",
      "SELECT * FROM v$iostat_file;",
      "SELECT * FROM v$iostat_function;",
      'SELECT * FROM v$filespace_usage;',

      // ── 19. RMAN-related (depuis SQL*Plus) ───────────────────────
      { section: 'RMAN catalog info via SQL', cmd: "SELECT name, log_mode, force_logging FROM v$database;" },
      "SELECT * FROM v$rman_status ORDER BY start_time DESC FETCH FIRST 20 ROWS ONLY;",
      'SELECT * FROM v$rman_output ORDER BY recid DESC FETCH FIRST 50 ROWS ONLY;',
      'SELECT * FROM v$rman_backup_job_details ORDER BY end_time DESC FETCH FIRST 20 ROWS ONLY;',
      'SELECT * FROM v$rman_backup_type;',
      'SELECT * FROM v$backup_set;',
      'SELECT * FROM v$backup_piece;',
      'SELECT * FROM v$backup_files;',
      'SELECT * FROM v$backup_redolog;',
      'SELECT * FROM v$backup_archivelog_details;',
      'SELECT * FROM v$backup_datafile;',

      // ── 20. INSPECTION DES PROCESSUS DE JOURNALISATION ──────────
      { section: 'LGWR / ARC processes', cmd: "SELECT * FROM v$bgprocess WHERE name IN ('LGWR','ARC0','ARC1','ARC2','ARC3','CKPT');" },
      "SELECT pname, status FROM v$process WHERE pname LIKE 'LGWR%' OR pname LIKE 'ARC%';",
      "SELECT * FROM v$archive_processes ORDER BY process;",
      "SELECT * FROM v$logwr;",
      "SELECT name, value FROM v$sysstat WHERE name LIKE '%log%write%';",

      // ── 21. cleanup / fin de session ─────────────────────────────
      { section: 'closing', cmd: 'SELECT instance_name, status FROM v$instance;' },
      'SELECT name, log_mode, force_logging, flashback_on FROM v$database;',
      'ARCHIVE LOG LIST;',
      ...monitoringSweep('journalization'),
      'EXIT;',
    ];

    runOracleDump('oracle-journalization',
      'LinuxServer ora-journal — Oracle ORCL OPEN', lines, runner);
    runner.dispose();
    removeOracleDatabase(srv.id);
  });
});
