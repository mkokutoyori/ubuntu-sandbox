/**
 * Debug — Cohérence des processus et services Oracle.
 *
 * Background processes (PMON, SMON, DBW0..n, LGWR, CKPT, ARC0..n, MMON,
 * MMNL, RECO, CJQ0, etc.), listener, services TNS, jobs scheduler,
 * resource manager, parallel execution servers.
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

describe('debug — Oracle processes & services', () => {
  it('parcourt background processes, listener, scheduler, jobs, resource manager', () => {
    const srv = new LinuxServer('linux-server', 'ora-proc', 100, 100);
    getOracleDatabase(srv.id);
    const runner = createSqlPlusRunner(srv);

    const lines: OracleDebugLine[] = [
      // ── 1. background processes inventory ────────────────────────
      { section: 'background processes', cmd: "SELECT name, description, error FROM v$bgprocess WHERE paddr <> '00' ORDER BY name;" },
      'SELECT * FROM v$bgprocess ORDER BY name;',
      "SELECT name FROM v$bgprocess WHERE paddr != '00';",
      "SELECT COUNT(*) AS active_bg FROM v$bgprocess WHERE paddr != '00';",
      "SELECT COUNT(*) AS configured_bg FROM v$bgprocess;",
      "SELECT * FROM v$process ORDER BY pid;",
      'SELECT pid, spid, pname, username, program, machine FROM v$process WHERE pname IS NOT NULL ORDER BY pname;',
      'SELECT COUNT(*) FROM v$process;',
      "SELECT pname, COUNT(*) FROM v$process WHERE pname IS NOT NULL GROUP BY pname ORDER BY pname;",
      "SELECT * FROM v$process WHERE pname = 'PMON';",
      "SELECT * FROM v$process WHERE pname = 'SMON';",
      "SELECT * FROM v$process WHERE pname = 'DBW0';",
      "SELECT * FROM v$process WHERE pname = 'LGWR';",
      "SELECT * FROM v$process WHERE pname = 'CKPT';",
      "SELECT * FROM v$process WHERE pname LIKE 'ARC%';",
      "SELECT * FROM v$process WHERE pname LIKE 'DBW%';",
      "SELECT * FROM v$process WHERE pname LIKE 'MMON%';",
      "SELECT * FROM v$process WHERE pname = 'RECO';",
      "SELECT * FROM v$process WHERE pname = 'CJQ0';",
      "SELECT * FROM v$process WHERE pname LIKE 'J%';",

      // ── 2. each major background process ─────────────────────────
      { section: 'PMON', cmd: "SELECT * FROM v$bgprocess WHERE name = 'PMON';" },
      "SELECT * FROM v$bgprocess WHERE name = 'SMON';",
      "SELECT * FROM v$bgprocess WHERE name LIKE 'DBW%';",
      "SELECT * FROM v$bgprocess WHERE name = 'LGWR';",
      "SELECT * FROM v$bgprocess WHERE name = 'CKPT';",
      "SELECT * FROM v$bgprocess WHERE name LIKE 'ARC%';",
      "SELECT * FROM v$bgprocess WHERE name = 'MMON';",
      "SELECT * FROM v$bgprocess WHERE name = 'MMNL';",
      "SELECT * FROM v$bgprocess WHERE name = 'RECO';",
      "SELECT * FROM v$bgprocess WHERE name = 'CJQ0';",
      "SELECT * FROM v$bgprocess WHERE name = 'DIAG';",
      "SELECT * FROM v$bgprocess WHERE name = 'PSP0';",
      "SELECT * FROM v$bgprocess WHERE name = 'VKTM';",
      "SELECT * FROM v$bgprocess WHERE name = 'GEN0';",
      "SELECT * FROM v$bgprocess WHERE name = 'DIA0';",
      "SELECT * FROM v$bgprocess WHERE name = 'DIA1';",
      "SELECT * FROM v$bgprocess WHERE name LIKE 'Q%';",

      // ── 3. process / session relationship ───────────────────────
      { section: 'processes ↔ sessions', cmd:
        "SELECT s.sid, s.serial#, s.username, p.spid, p.pname FROM v$session s JOIN v$process p ON s.paddr = p.addr WHERE s.username IS NOT NULL ORDER BY s.sid;" },
      "SELECT COUNT(*) FROM v$session WHERE username IS NOT NULL;",
      "SELECT username, COUNT(*) FROM v$session WHERE username IS NOT NULL GROUP BY username;",
      "SELECT * FROM v$session WHERE type = 'USER' AND status = 'ACTIVE';",
      "SELECT * FROM v$session WHERE type = 'BACKGROUND';",
      "SELECT status, COUNT(*) FROM v$session GROUP BY status;",

      // ── 4. listener ─────────────────────────────────────────────
      { section: 'listener', cmd: 'SHOW PARAMETER listener;' },
      "SHOW PARAMETER local_listener;",
      "SHOW PARAMETER remote_listener;",
      "SHOW PARAMETER service_names;",
      "SHOW PARAMETER db_domain;",
      "SHOW PARAMETER instance_name;",
      "SHOW PARAMETER dispatchers;",
      "SHOW PARAMETER shared_servers;",
      "SHOW PARAMETER max_shared_servers;",
      "SHOW PARAMETER max_dispatchers;",
      'SELECT * FROM v$listener_network;',
      'SELECT * FROM v$dispatcher;',
      'SELECT * FROM v$dispatcher_config;',
      'SELECT * FROM v$shared_server;',
      'SELECT * FROM v$shared_server_monitor;',
      'SELECT * FROM v$circuit;',
      'SELECT * FROM v$queue;',
      'HOST lsnrctl status',
      'HOST lsnrctl services',
      'HOST lsnrctl version',
      'HOST cat /u01/app/oracle/product/19c/network/admin/listener.ora',
      'HOST cat /u01/app/oracle/product/19c/network/admin/tnsnames.ora',
      'HOST cat /u01/app/oracle/product/19c/network/admin/sqlnet.ora',
      "EXEC DBMS_SERVICE.CREATE_SERVICE(service_name=>'app_service', network_name=>'app_service.world');",
      "EXEC DBMS_SERVICE.START_SERVICE(service_name=>'app_service');",
      "EXEC DBMS_SERVICE.STOP_SERVICE(service_name=>'app_service');",
      "EXEC DBMS_SERVICE.DELETE_SERVICE(service_name=>'app_service');",
      "SELECT * FROM dba_services;",
      "SELECT * FROM v$services;",
      "SELECT * FROM v$active_services;",

      // ── 5. instance & DB info ────────────────────────────────────
      { section: 'instance info', cmd: 'SELECT * FROM v$instance;' },
      "SELECT instance_name, host_name, version, startup_time, status, parallel, thread#, archiver, log_switch_wait FROM v$instance;",
      "SELECT * FROM v$instance_recovery;",
      "SELECT * FROM v$instance_cache_transfer;",
      "SELECT * FROM v$database;",
      "SELECT * FROM v$version;",
      "SELECT * FROM product_component_version;",
      'SELECT banner FROM v$version;',
      'SELECT * FROM v$option;',
      'SELECT parameter, value FROM v$option WHERE value = \'TRUE\';',
      "SELECT * FROM v$license;",
      "SELECT * FROM v$nls_parameters;",
      "SELECT * FROM v$nls_valid_values WHERE rownum < 50;",
      'SELECT * FROM nls_database_parameters;',
      'SELECT * FROM nls_instance_parameters;',
      'SELECT * FROM nls_session_parameters;',

      // ── 6. memory pools ─────────────────────────────────────────
      { section: 'memory pools', cmd: 'SELECT * FROM v$sgastat ORDER BY bytes DESC FETCH FIRST 30 ROWS ONLY;' },
      'SELECT * FROM v$sgainfo;',
      'SELECT * FROM v$sga;',
      'SELECT * FROM v$sga_dynamic_components;',
      'SELECT * FROM v$sga_resize_ops;',
      'SELECT * FROM v$sga_current_resize_ops;',
      'SELECT * FROM v$sga_target_advice;',
      'SELECT * FROM v$pga_target_advice;',
      'SELECT * FROM v$pgastat;',
      'SELECT * FROM v$process_memory;',
      'SELECT * FROM v$process_memory_detail;',
      "SHOW PARAMETER sga_target;",
      "SHOW PARAMETER sga_max_size;",
      "SHOW PARAMETER pga_aggregate_target;",
      "SHOW PARAMETER pga_aggregate_limit;",
      "SHOW PARAMETER memory_target;",
      "SHOW PARAMETER memory_max_target;",
      "SHOW PARAMETER shared_pool_size;",
      "SHOW PARAMETER db_cache_size;",
      "SHOW PARAMETER log_buffer;",
      "SHOW PARAMETER java_pool_size;",
      "SHOW PARAMETER large_pool_size;",
      "SHOW PARAMETER streams_pool_size;",

      // ── 7. resource manager ─────────────────────────────────────
      { section: 'resource manager', cmd: "SELECT * FROM dba_rsrc_consumer_groups;" },
      'SELECT * FROM dba_rsrc_plans;',
      'SELECT * FROM dba_rsrc_plan_directives;',
      'SELECT * FROM v$rsrc_consumer_group;',
      'SELECT * FROM v$rsrc_plan;',
      "SHOW PARAMETER resource_manager_plan;",
      "ALTER SYSTEM SET resource_manager_plan='DEFAULT_PLAN';",
      "ALTER SYSTEM SET resource_manager_plan='';",
      "EXEC DBMS_RESOURCE_MANAGER.CLEAR_PENDING_AREA;",
      "EXEC DBMS_RESOURCE_MANAGER.CREATE_PENDING_AREA;",
      "EXEC DBMS_RESOURCE_MANAGER.CREATE_PLAN(plan=>'app_plan', comment=>'App plan');",
      "EXEC DBMS_RESOURCE_MANAGER.SUBMIT_PENDING_AREA;",

      // ── 8. jobs / scheduler ──────────────────────────────────────
      { section: 'scheduler', cmd: 'SELECT * FROM dba_scheduler_jobs ORDER BY job_name;' },
      "SELECT job_name, state, enabled, run_count, failure_count, last_start_date, next_run_date FROM dba_scheduler_jobs;",
      'SELECT * FROM dba_scheduler_programs;',
      'SELECT * FROM dba_scheduler_schedules;',
      'SELECT * FROM dba_scheduler_chains;',
      'SELECT * FROM dba_scheduler_chain_steps;',
      'SELECT * FROM dba_scheduler_credentials;',
      'SELECT * FROM dba_scheduler_destinations;',
      'SELECT * FROM dba_scheduler_files;',
      'SELECT * FROM dba_scheduler_job_classes;',
      'SELECT * FROM dba_scheduler_windows;',
      'SELECT * FROM dba_scheduler_window_groups;',
      'SELECT * FROM dba_scheduler_global_attribute;',
      'SELECT * FROM dba_scheduler_job_log ORDER BY log_date DESC FETCH FIRST 30 ROWS ONLY;',
      'SELECT * FROM dba_scheduler_job_run_details ORDER BY log_date DESC FETCH FIRST 30 ROWS ONLY;',
      "EXEC DBMS_SCHEDULER.CREATE_JOB(job_name=>'cleanup_job', job_type=>'PLSQL_BLOCK', job_action=>'BEGIN DELETE FROM logs WHERE log_date < SYSDATE - 30; COMMIT; END;', start_date=>SYSTIMESTAMP, repeat_interval=>'FREQ=DAILY; BYHOUR=2');",
      "EXEC DBMS_SCHEDULER.ENABLE('cleanup_job');",
      "EXEC DBMS_SCHEDULER.RUN_JOB('cleanup_job');",
      "EXEC DBMS_SCHEDULER.DISABLE('cleanup_job');",
      "EXEC DBMS_SCHEDULER.DROP_JOB('cleanup_job');",
      'SELECT * FROM dba_jobs;',
      'SELECT * FROM dba_jobs_running;',
      'SELECT * FROM user_jobs;',

      // ── 9. parallel execution ────────────────────────────────────
      { section: 'parallel execution', cmd: "SHOW PARAMETER parallel_max_servers;" },
      "SHOW PARAMETER parallel_min_servers;",
      "SHOW PARAMETER parallel_threads_per_cpu;",
      "SHOW PARAMETER parallel_degree_policy;",
      "SHOW PARAMETER parallel_degree_limit;",
      "SHOW PARAMETER parallel_force_local;",
      'SELECT * FROM v$px_session;',
      'SELECT * FROM v$px_sesstat ORDER BY value DESC FETCH FIRST 30 ROWS ONLY;',
      'SELECT * FROM v$px_process;',
      'SELECT * FROM v$pq_slave;',
      'SELECT * FROM v$pq_sesstat WHERE statistic LIKE \'%Buffer%\';',
      'SELECT * FROM v$pq_sysstat;',
      'SELECT * FROM v$pq_tqstat;',

      // ── 10. locks / latches ─────────────────────────────────────
      { section: 'locks + latches', cmd: 'SELECT * FROM v$lock ORDER BY block DESC;' },
      "SELECT s.sid, s.serial#, s.username, l.type, l.lmode, l.request, l.id1, l.id2 FROM v$lock l JOIN v$session s ON s.sid = l.sid WHERE s.username IS NOT NULL;",
      "SELECT * FROM v$lock WHERE block = 1;",
      "SELECT * FROM v$locked_object;",
      'SELECT * FROM dba_dml_locks;',
      'SELECT * FROM dba_ddl_locks;',
      "SELECT type, COUNT(*) FROM v$lock GROUP BY type ORDER BY COUNT(*) DESC;",
      'SELECT * FROM v$latch ORDER BY misses DESC FETCH FIRST 20 ROWS ONLY;',
      'SELECT * FROM v$latchholder;',
      'SELECT * FROM v$latch_parent ORDER BY misses DESC FETCH FIRST 20 ROWS ONLY;',
      'SELECT * FROM v$latch_children ORDER BY misses DESC FETCH FIRST 20 ROWS ONLY;',
      'SELECT * FROM v$latchname WHERE rownum < 30;',
      'SELECT * FROM v$mutex_sleep ORDER BY sleeps DESC FETCH FIRST 20 ROWS ONLY;',
      'SELECT * FROM v$enqueue_lock ORDER BY ctime DESC FETCH FIRST 20 ROWS ONLY;',
      'SELECT * FROM v$enqueue_stat ORDER BY total_wait# DESC FETCH FIRST 20 ROWS ONLY;',
      'SELECT * FROM v$enqueue_statistics ORDER BY total_req# DESC FETCH FIRST 20 ROWS ONLY;',

      // ── 11. resumable transactions ──────────────────────────────
      { section: 'resumable transactions', cmd: 'SELECT * FROM dba_resumable;' },
      "ALTER SYSTEM SET resumable_timeout=300 SCOPE=BOTH;",
      "ALTER SESSION ENABLE RESUMABLE TIMEOUT 600 NAME 'my_session';",
      "ALTER SESSION DISABLE RESUMABLE;",
      'SELECT * FROM user_resumable;',

      // ── 12. transactions ────────────────────────────────────────
      { section: 'transactions', cmd: 'SELECT * FROM v$transaction;' },
      'SELECT * FROM v$lock WHERE type IN (\'TX\',\'TM\');',
      "SELECT addr, xidusn, xidslot, xidsqn, status, start_time, used_ublk, used_urec FROM v$transaction;",
      "SELECT COUNT(*) FROM v$transaction;",
      'SELECT * FROM v$global_transaction;',
      'SELECT * FROM dba_2pc_pending;',
      'SELECT * FROM dba_2pc_neighbors;',
      'COMMIT;',
      'ROLLBACK;',
      'SAVEPOINT sp1;',
      'ROLLBACK TO sp1;',
      'SET TRANSACTION READ ONLY;',
      'SET TRANSACTION READ WRITE;',
      "SET TRANSACTION NAME 'my_txn';",
      'SET TRANSACTION ISOLATION LEVEL SERIALIZABLE;',
      'SET TRANSACTION ISOLATION LEVEL READ COMMITTED;',

      // ── 13. database services / instances ────────────────────────
      { section: 'instances + services', cmd: 'SELECT * FROM v$instance;' },
      'SELECT * FROM gv$instance;',
      'SELECT * FROM v$active_instances;',
      'SELECT * FROM v$cluster_instance;',
      'SELECT * FROM v$nodes;',
      'SELECT * FROM v$rac_global_view;',
      'SELECT * FROM dba_services;',
      'SELECT * FROM v$services;',
      'SELECT * FROM v$active_services;',
      "EXEC DBMS_SERVICE.START_SERVICE('orcl');",
      "EXEC DBMS_SERVICE.STOP_SERVICE('orcl');",
      "EXEC DBMS_SERVICE.MODIFY_SERVICE('orcl', goal=>DBMS_SERVICE.GOAL_SERVICE_TIME);",
      "EXEC DBMS_SERVICE.DISCONNECT_SESSION('orcl', DBMS_SERVICE.NOREPLAY);",

      // ── 14. recovery instance state ─────────────────────────────
      { section: 'instance state', cmd: "SELECT instance_name, status FROM v$instance;" },
      'SELECT * FROM v$instance_recovery;',
      'SELECT * FROM v$recovery_status;',
      'SELECT * FROM v$recovery_progress;',
      'SELECT * FROM v$recovery_file_status;',
      'SELECT * FROM v$recovery_log;',
      'SELECT * FROM v$datafile WHERE recover = \'YES\';',

      // ── 15. dispatcher / shared server ──────────────────────────
      { section: 'dispatcher / shared server', cmd: 'SELECT * FROM v$dispatcher;' },
      'SELECT * FROM v$shared_server;',
      'SELECT * FROM v$queue;',
      'SELECT * FROM v$circuit;',
      'SELECT * FROM v$dispatcher_rate;',
      'SELECT * FROM v$shared_server_monitor;',
      "ALTER SYSTEM REGISTER;",

      // ── 16. database links ──────────────────────────────────────
      { section: 'database links', cmd: 'SELECT * FROM dba_db_links;' },
      'SELECT * FROM all_db_links;',
      'SELECT * FROM user_db_links;',
      "CREATE DATABASE LINK remote_db CONNECT TO scott IDENTIFIED BY tiger USING 'REMOTE_TNS';",
      "DROP DATABASE LINK remote_db;",
      "CREATE PUBLIC DATABASE LINK pub_remote CONNECT TO scott IDENTIFIED BY tiger USING 'REMOTE_TNS';",
      "DROP PUBLIC DATABASE LINK pub_remote;",
      'SELECT * FROM v$dblink;',

      // ── 17. timezone / date utilities ───────────────────────────
      { section: 'time zone', cmd: 'SELECT DBTIMEZONE FROM dual;' },
      'SELECT SESSIONTIMEZONE FROM dual;',
      'SELECT SYSDATE FROM dual;',
      'SELECT SYSTIMESTAMP FROM dual;',
      'SELECT CURRENT_DATE FROM dual;',
      'SELECT CURRENT_TIMESTAMP FROM dual;',
      'SELECT LOCALTIMESTAMP FROM dual;',
      "ALTER SESSION SET TIME_ZONE = '-05:00';",
      "ALTER SESSION SET TIME_ZONE = 'Europe/Paris';",
      "ALTER DATABASE SET TIME_ZONE = 'UTC';",
      'SELECT * FROM v$timezone_names WHERE rownum < 30;',
      'SELECT * FROM v$timezone_file;',

      // ── 18. host inspection ─────────────────────────────────────
      { section: 'host inspection', cmd: 'HOST ps -ef | grep oracle' },
      'HOST ps -ef | grep ora_',
      'HOST ps -ef | grep LOCAL=NO',
      "HOST ps -ef | grep -i listener",
      "HOST ps -ef | grep -i tnslsnr",
      'HOST top -bn1 | head -30',
      'HOST free -m',
      'HOST df -h',
      'HOST netstat -an | grep 1521',
      'HOST netstat -nlp | head -20',
      'HOST ss -ltnp | head -20',
      'HOST cat /etc/oratab',
      'HOST cat /var/opt/oracle/oratab 2>/dev/null',
      'HOST id oracle',
      'HOST groups oracle',
      'HOST cat /etc/oraInst.loc',

      // ── 19. summary ─────────────────────────────────────────────
      { section: 'summary', cmd: 'SELECT instance_name, status, host_name, database_status FROM v$instance;' },
      "SELECT COUNT(*) AS bg_processes FROM v$process WHERE pname IS NOT NULL;",
      "SELECT COUNT(*) AS user_sessions FROM v$session WHERE username IS NOT NULL;",
      ...monitoringSweep('processes-services'),
      'EXIT;',
    ];

    runOracleDump('oracle-processes-services',
      'LinuxServer ora-proc — Oracle ORCL OPEN', lines, runner);
    runner.dispose();
    removeOracleDatabase(srv.id);
  });
});
