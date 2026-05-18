/**
 * Debug — Gestion des sessions Oracle.
 *
 * V$SESSION, V$PROCESS, V$LOCKED_OBJECT, V$TRANSACTION, KILL SESSION,
 * resource manager, dispatchers, SQL trace, ASH, blockages, deadlocks.
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

describe('debug — Oracle session management', () => {
  it('parcourt V$SESSION, locks, transactions, kill, blockages', () => {
    const srv = new LinuxServer('linux-server', 'ora-sess', 100, 100);
    getOracleDatabase(srv.id);
    const runner = createSqlPlusRunner(srv);

    const lines: OracleDebugLine[] = [
      // ── 1. session basics ────────────────────────────────────────
      { section: 'session basics', cmd: 'SELECT * FROM v$session WHERE username IS NOT NULL ORDER BY sid;' },
      'SELECT COUNT(*) FROM v$session;',
      'SELECT username, COUNT(*) FROM v$session WHERE username IS NOT NULL GROUP BY username ORDER BY COUNT(*) DESC;',
      "SELECT * FROM v$session WHERE status = 'ACTIVE';",
      "SELECT * FROM v$session WHERE status = 'INACTIVE';",
      "SELECT * FROM v$session WHERE status = 'KILLED';",
      "SELECT * FROM v$session WHERE type = 'BACKGROUND';",
      "SELECT * FROM v$session WHERE type = 'USER';",
      "SELECT sid, serial#, username, status, schemaname, program, machine, osuser, terminal, last_call_et FROM v$session WHERE username IS NOT NULL ORDER BY sid;",
      'SELECT * FROM v$session WHERE rownum < 30;',
      'SELECT * FROM v$session WHERE blocking_session IS NOT NULL;',
      "SELECT sid, serial#, sql_id, sql_child_number, sql_exec_start FROM v$session WHERE sql_id IS NOT NULL;",
      'SELECT * FROM v$session_longops WHERE rownum < 20;',
      'SELECT * FROM v$session_event WHERE rownum < 30;',
      'SELECT * FROM v$session_wait WHERE rownum < 30;',
      "SELECT sid, event, wait_class, seconds_in_wait FROM v$session_wait WHERE wait_class != 'Idle';",
      'SELECT * FROM v$session_wait_history WHERE rownum < 30;',
      'SELECT * FROM v$session_wait_class WHERE rownum < 30;',
      'SELECT * FROM v$session_blockers WHERE rownum < 30;',
      'SELECT * FROM v$session_connect_info WHERE rownum < 30;',
      'SELECT * FROM v$active_session_history ORDER BY sample_time DESC FETCH FIRST 30 ROWS ONLY;',
      'SELECT * FROM v$session_metric WHERE rownum < 30;',
      'SELECT * FROM v$session_metric_history WHERE rownum < 30;',
      'SELECT * FROM v$session_object_cache WHERE rownum < 30;',
      'SELECT * FROM v$session_cursor_cache WHERE rownum < 30;',

      // ── 2. context / environment ────────────────────────────────
      { section: 'session context', cmd: "SELECT sys_context('USERENV', 'SESSION_USER') FROM dual;" },
      "SELECT sys_context('USERENV', 'CURRENT_SCHEMA') FROM dual;",
      "SELECT sys_context('USERENV', 'CURRENT_USER') FROM dual;",
      "SELECT sys_context('USERENV', 'OS_USER') FROM dual;",
      "SELECT sys_context('USERENV', 'IP_ADDRESS') FROM dual;",
      "SELECT sys_context('USERENV', 'HOST') FROM dual;",
      "SELECT sys_context('USERENV', 'CLIENT_PROGRAM_NAME') FROM dual;",
      "SELECT sys_context('USERENV', 'INSTANCE_NAME') FROM dual;",
      "SELECT sys_context('USERENV', 'DB_NAME') FROM dual;",
      "SELECT sys_context('USERENV', 'SERVICE_NAME') FROM dual;",
      "SELECT sys_context('USERENV', 'SESSION_USERID') FROM dual;",
      "SELECT sys_context('USERENV', 'SESSIONID') FROM dual;",
      "SELECT sys_context('USERENV', 'SID') FROM dual;",
      "SELECT sys_context('USERENV', 'LANGUAGE') FROM dual;",
      "SELECT sys_context('USERENV', 'CLIENT_IDENTIFIER') FROM dual;",
      "SELECT sys_context('USERENV', 'MODULE') FROM dual;",
      "SELECT sys_context('USERENV', 'ACTION') FROM dual;",
      "BEGIN DBMS_SESSION.SET_IDENTIFIER('demo-client-1'); END;",
      "BEGIN DBMS_APPLICATION_INFO.SET_MODULE('my_app', 'fetch_data'); END;",
      "BEGIN DBMS_APPLICATION_INFO.SET_ACTION('list users'); END;",
      "BEGIN DBMS_APPLICATION_INFO.SET_CLIENT_INFO('client info text'); END;",

      // ── 3. ALTER SESSION ─────────────────────────────────────────
      { section: 'ALTER SESSION', cmd: "ALTER SESSION SET NLS_DATE_FORMAT='YYYY-MM-DD HH24:MI:SS';" },
      "ALTER SESSION SET NLS_TIMESTAMP_FORMAT='YYYY-MM-DD HH24:MI:SS.FF';",
      "ALTER SESSION SET NLS_NUMERIC_CHARACTERS=',.';",
      "ALTER SESSION SET NLS_LANGUAGE='AMERICAN';",
      "ALTER SESSION SET NLS_TERRITORY='AMERICA';",
      "ALTER SESSION SET TIME_ZONE='Europe/Paris';",
      "ALTER SESSION SET CURRENT_SCHEMA=HR;",
      "ALTER SESSION SET CURRENT_SCHEMA=SYS;",
      "ALTER SESSION SET CURSOR_SHARING=FORCE;",
      "ALTER SESSION SET CURSOR_SHARING=EXACT;",
      "ALTER SESSION SET OPTIMIZER_MODE=ALL_ROWS;",
      "ALTER SESSION SET OPTIMIZER_MODE=FIRST_ROWS_10;",
      "ALTER SESSION SET OPTIMIZER_INDEX_COST_ADJ=10;",
      "ALTER SESSION SET WORKAREA_SIZE_POLICY=AUTO;",
      "ALTER SESSION SET SORT_AREA_SIZE=1048576;",
      "ALTER SESSION SET HASH_AREA_SIZE=2097152;",
      "ALTER SESSION SET TIMED_STATISTICS=TRUE;",
      "ALTER SESSION SET STATISTICS_LEVEL=ALL;",
      "ALTER SESSION SET STATISTICS_LEVEL=TYPICAL;",
      "ALTER SESSION SET SQL_TRACE=TRUE;",
      "ALTER SESSION SET SQL_TRACE=FALSE;",
      "ALTER SESSION SET TRACEFILE_IDENTIFIER='my_session';",
      "ALTER SESSION ENABLE PARALLEL DML;",
      "ALTER SESSION DISABLE PARALLEL DML;",
      "ALTER SESSION ENABLE PARALLEL DDL;",
      "ALTER SESSION DISABLE PARALLEL DDL;",
      "ALTER SESSION FORCE PARALLEL DML PARALLEL 4;",
      "ALTER SESSION FORCE PARALLEL QUERY PARALLEL 4;",
      "ALTER SESSION SET CONTAINER=CDB$ROOT;",
      "ALTER SESSION SET PARALLEL_DEGREE_POLICY=AUTO;",

      // ── 4. KILL / DISCONNECT ─────────────────────────────────────
      { section: 'kill session', cmd: "ALTER SYSTEM KILL SESSION '142,12345';" },
      "ALTER SYSTEM KILL SESSION '142,12345' IMMEDIATE;",
      "ALTER SYSTEM KILL SESSION '142,12345,@1';",
      "ALTER SYSTEM DISCONNECT SESSION '142,12345';",
      "ALTER SYSTEM DISCONNECT SESSION '142,12345' IMMEDIATE;",
      "ALTER SYSTEM DISCONNECT SESSION '142,12345' POST_TRANSACTION;",
      "BEGIN DBMS_SERVICE.DISCONNECT_SESSION('orcl', DBMS_SERVICE.NOREPLAY); END;",

      // ── 5. LOCKS ─────────────────────────────────────────────────
      { section: 'locks', cmd: 'SELECT * FROM v$lock ORDER BY ctime DESC;' },
      "SELECT s.sid, s.username, l.type, l.lmode, l.request, l.id1, l.id2, l.block FROM v$lock l JOIN v$session s ON s.sid = l.sid WHERE s.username IS NOT NULL;",
      'SELECT * FROM v$lock WHERE block = 1;',
      'SELECT * FROM v$lock WHERE request > 0;',
      "SELECT type, COUNT(*) FROM v$lock GROUP BY type;",
      'SELECT * FROM v$locked_object;',
      "SELECT s.sid, s.username, o.object_name FROM v$locked_object lo JOIN v$session s ON lo.session_id = s.sid JOIN dba_objects o ON lo.object_id = o.object_id;",
      'SELECT * FROM dba_dml_locks;',
      'SELECT * FROM dba_ddl_locks;',
      'SELECT * FROM dba_lock;',
      'SELECT * FROM dba_lock_internal;',
      'SELECT * FROM v$transaction_enqueue;',
      'SELECT * FROM v$enqueue_lock ORDER BY ctime DESC FETCH FIRST 30 ROWS ONLY;',
      'SELECT * FROM v$enqueue_stat ORDER BY total_wait# DESC FETCH FIRST 30 ROWS ONLY;',
      'SELECT * FROM v$enqueue_statistics ORDER BY total_req# DESC FETCH FIRST 30 ROWS ONLY;',
      // wait chain
      'SELECT * FROM v$wait_chains ORDER BY chain_id, sess# FETCH FIRST 30 ROWS ONLY;',
      'SELECT * FROM dba_blockers;',
      'SELECT * FROM dba_waiters;',

      // ── 6. TRANSACTIONS ──────────────────────────────────────────
      { section: 'transactions', cmd: 'SELECT * FROM v$transaction;' },
      'SELECT COUNT(*) FROM v$transaction;',
      "SELECT s.sid, t.xidusn || '.' || t.xidslot || '.' || t.xidsqn AS xid, t.start_time, t.used_ublk, t.used_urec, t.status FROM v$transaction t JOIN v$session s ON t.ses_addr = s.saddr;",
      'SELECT * FROM v$transaction_enqueue;',
      'SELECT * FROM v$global_transaction;',
      'SELECT * FROM dba_2pc_pending;',
      'SELECT * FROM dba_2pc_neighbors;',
      'COMMIT;',
      'ROLLBACK;',
      'SAVEPOINT before_change;',
      'ROLLBACK TO SAVEPOINT before_change;',
      'SET TRANSACTION READ ONLY;',
      'COMMIT;',
      'SET TRANSACTION READ WRITE;',
      'SET TRANSACTION ISOLATION LEVEL SERIALIZABLE;',
      'SET TRANSACTION ISOLATION LEVEL READ COMMITTED;',
      'SET TRANSACTION USE ROLLBACK SEGMENT system;',
      "SET TRANSACTION NAME 'audit_demo';",

      // ── 7. SQL TRACE / monitoring ───────────────────────────────
      { section: 'SQL trace', cmd: "ALTER SESSION SET EVENTS '10046 trace name context forever, level 12';" },
      "ALTER SESSION SET EVENTS '10046 trace name context off';",
      "EXEC DBMS_MONITOR.SESSION_TRACE_ENABLE(session_id=>142, serial_num=>12345, waits=>TRUE, binds=>TRUE);",
      "EXEC DBMS_MONITOR.SESSION_TRACE_DISABLE(session_id=>142, serial_num=>12345);",
      "EXEC DBMS_MONITOR.CLIENT_ID_TRACE_ENABLE(client_id=>'demo-client-1', waits=>TRUE);",
      "EXEC DBMS_MONITOR.CLIENT_ID_TRACE_DISABLE(client_id=>'demo-client-1');",
      "EXEC DBMS_MONITOR.SERV_MOD_ACT_TRACE_ENABLE(service_name=>'orcl', module_name=>'my_app');",
      "EXEC DBMS_MONITOR.SERV_MOD_ACT_TRACE_DISABLE(service_name=>'orcl');",
      "EXEC DBMS_MONITOR.DATABASE_TRACE_ENABLE(waits=>TRUE, binds=>FALSE);",
      "EXEC DBMS_MONITOR.DATABASE_TRACE_DISABLE;",
      "SELECT * FROM dba_enabled_traces;",
      "SELECT sid, serial#, sql_trace FROM v$session WHERE sql_trace = 'ENABLED';",
      "ALTER SESSION SET TRACEFILE_IDENTIFIER='dbg_session';",

      // ── 8. Real-time SQL monitoring ──────────────────────────────
      { section: 'real-time SQL monitoring', cmd: 'SELECT * FROM v$sql_monitor WHERE rownum < 20;' },
      'SELECT * FROM v$sql_plan_monitor WHERE rownum < 20;',
      'SELECT * FROM v$sql_monitor_session_longops WHERE rownum < 20;',
      'SELECT * FROM v$sql_plan_monitor_statistics WHERE rownum < 20;',

      // ── 9. resource manager / consumer groups ────────────────────
      { section: 'resource manager', cmd: 'SELECT * FROM v$rsrc_consumer_group;' },
      'SELECT * FROM v$rsrc_consumer_group_cpu_mth;',
      'SELECT * FROM v$rsrc_plan;',
      'SELECT * FROM v$rsrc_session_info ORDER BY sid;',
      'SELECT * FROM dba_rsrc_consumer_groups;',
      'SELECT * FROM dba_rsrc_plans;',
      'SELECT * FROM dba_rsrc_plan_directives;',
      'SELECT * FROM dba_rsrc_consumer_group_privs;',
      'SELECT * FROM dba_rsrc_mappings;',
      'SELECT * FROM dba_rsrc_group_mappings;',
      'SHOW PARAMETER resource_manager_plan;',

      // ── 10. open cursors ─────────────────────────────────────────
      { section: 'open cursors', cmd: 'SELECT * FROM v$open_cursor WHERE rownum < 30;' },
      'SELECT COUNT(*) FROM v$open_cursor;',
      "SELECT sid, COUNT(*) FROM v$open_cursor GROUP BY sid ORDER BY COUNT(*) DESC FETCH FIRST 10 ROWS ONLY;",
      'SHOW PARAMETER open_cursors;',
      "ALTER SYSTEM SET open_cursors=600 SCOPE=BOTH;",
      'SELECT * FROM v$sesstat WHERE statistic# IN (SELECT statistic# FROM v$statname WHERE name = \'opened cursors current\') ORDER BY value DESC FETCH FIRST 20 ROWS ONLY;',
      'SELECT * FROM v$sesstat WHERE rownum < 20;',
      'SELECT * FROM v$mystat WHERE rownum < 30;',
      'SELECT * FROM v$statname WHERE rownum < 30;',

      // ── 11. SESSION-level stats ─────────────────────────────────
      { section: 'session-level stats', cmd: "SELECT * FROM v$sesstat WHERE sid = (SELECT sid FROM v$mystat WHERE rownum=1) AND value > 0 ORDER BY value DESC FETCH FIRST 30 ROWS ONLY;" },
      "SELECT n.name, ss.value FROM v$sesstat ss JOIN v$statname n ON ss.statistic# = n.statistic# WHERE ss.value > 0 AND ss.sid = (SELECT sid FROM v$mystat WHERE rownum=1) ORDER BY ss.value DESC FETCH FIRST 30 ROWS ONLY;",
      'SELECT * FROM v$sess_io WHERE rownum < 30;',
      'SELECT * FROM v$sess_time_model WHERE rownum < 30;',
      'SELECT * FROM v$session_event WHERE event LIKE \'%log%\' ORDER BY total_waits DESC FETCH FIRST 20 ROWS ONLY;',

      // ── 12. dispatchers / shared servers ─────────────────────────
      { section: 'dispatchers / shared servers', cmd: 'SELECT * FROM v$dispatcher;' },
      'SELECT * FROM v$shared_server;',
      'SELECT * FROM v$circuit;',
      'SELECT * FROM v$queue;',
      'SELECT * FROM v$dispatcher_rate;',
      'SELECT * FROM v$shared_server_monitor;',
      "SHOW PARAMETER dispatchers;",
      "SHOW PARAMETER shared_servers;",
      "SHOW PARAMETER max_dispatchers;",
      "SHOW PARAMETER max_shared_servers;",
      "ALTER SYSTEM REGISTER;",

      // ── 13. application context ──────────────────────────────────
      { section: 'application context', cmd: 'SELECT * FROM dba_context;' },
      'SELECT * FROM all_context;',
      'SELECT * FROM session_context;',
      "CREATE OR REPLACE CONTEXT my_ctx USING my_ctx_pkg;",
      "DROP CONTEXT my_ctx;",

      // ── 14. password / auth events ───────────────────────────────
      { section: 'failed logins', cmd: 'SELECT * FROM dba_audit_session WHERE returncode != 0 ORDER BY timestamp DESC FETCH FIRST 20 ROWS ONLY;' },
      "SELECT username, account_status, lock_date, lcount FROM dba_users WHERE lcount > 0;",
      'SELECT * FROM v$pwfile_users;',
      'SELECT * FROM dba_users WHERE password_versions IS NOT NULL;',
      'SELECT * FROM v$encryption_keys WHERE rownum < 10;',

      // ── 15. host-side process inspection ─────────────────────────
      { section: 'host-side processes', cmd: 'HOST ps -ef | grep oracle | head -30' },
      'HOST ps -ef | grep ora_',
      'HOST ps -ef | grep LOCAL=NO | head -20',
      'HOST netstat -tan | grep 1521 | head -20',
      'HOST ss -ltnp | head -20',

      // ── 16. summary ──────────────────────────────────────────────
      { section: 'summary', cmd: "SELECT COUNT(*) AS sessions FROM v$session WHERE username IS NOT NULL;" },
      "SELECT username, COUNT(*) FROM v$session GROUP BY username ORDER BY 2 DESC;",
      "SELECT COUNT(*) AS locks FROM v$lock;",
      "SELECT COUNT(*) AS txns FROM v$transaction;",
      "SELECT COUNT(*) AS open_cursors FROM v$open_cursor;",
      ...monitoringSweep('session-management'),
      'EXIT;',
    ];

    runOracleDump('oracle-session-management', 'LinuxServer ora-sess — Oracle ORCL OPEN', lines, runner);
    runner.dispose();
    removeOracleDatabase(srv.id);
  });
});
