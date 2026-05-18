/**
 * Debug — Cas end-to-end DBA Oracle.
 *
 * Workflows complets : création d'application, audit, maintenance,
 * performance tuning, troubleshooting, monitoring.
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

describe('debug — Oracle end-to-end DBA workflows', () => {
  it('parcourt setup application + monitoring + tuning + troubleshooting', () => {
    const srv = new LinuxServer('linux-server', 'ora-e2e', 100, 100);
    getOracleDatabase(srv.id);
    const runner = createSqlPlusRunner(srv);

    const lines: OracleDebugLine[] = [
      // ── 1. setup full application schema ──────────────────────────
      { section: '1. provision application schema', cmd: 'CREATE USER app_owner IDENTIFIED BY "App1#" QUOTA UNLIMITED ON users;' },
      'GRANT CONNECT, RESOURCE, CREATE VIEW, CREATE SEQUENCE, CREATE PROCEDURE, CREATE TRIGGER, CREATE TYPE TO app_owner;',
      'CREATE USER app_user IDENTIFIED BY "AppUser1#";',
      'GRANT CREATE SESSION TO app_user;',
      'CREATE USER app_readonly IDENTIFIED BY "Ro1#";',
      'GRANT CREATE SESSION TO app_readonly;',
      'CREATE ROLE app_role;',
      'CREATE ROLE app_readonly_role;',
      'GRANT app_role TO app_user;',
      'GRANT app_readonly_role TO app_readonly;',
      'ALTER SESSION SET CURRENT_SCHEMA = app_owner;',
      "CREATE TABLE customers (id NUMBER GENERATED ALWAYS AS IDENTITY PRIMARY KEY, name VARCHAR2(100) NOT NULL, email VARCHAR2(200) UNIQUE, created DATE DEFAULT SYSDATE);",
      "CREATE TABLE products (id NUMBER GENERATED ALWAYS AS IDENTITY PRIMARY KEY, sku VARCHAR2(20) UNIQUE NOT NULL, name VARCHAR2(200), price NUMBER(10,2) CHECK (price >= 0));",
      "CREATE TABLE orders (id NUMBER GENERATED ALWAYS AS IDENTITY PRIMARY KEY, customer_id NUMBER NOT NULL, order_date DATE DEFAULT SYSDATE, status VARCHAR2(20) DEFAULT 'PENDING', CONSTRAINT fk_orders_cust FOREIGN KEY (customer_id) REFERENCES customers(id));",
      "CREATE TABLE order_lines (order_id NUMBER, line_no NUMBER, product_id NUMBER, qty NUMBER, unit_price NUMBER(10,2), CONSTRAINT pk_ol PRIMARY KEY (order_id, line_no), CONSTRAINT fk_ol_ord FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE, CONSTRAINT fk_ol_prod FOREIGN KEY (product_id) REFERENCES products(id));",
      'CREATE INDEX idx_orders_cust ON orders (customer_id);',
      'CREATE INDEX idx_orders_date ON orders (order_date);',
      'CREATE INDEX idx_ol_prod ON order_lines (product_id);',
      "GRANT SELECT, INSERT, UPDATE, DELETE ON customers TO app_role;",
      "GRANT SELECT, INSERT, UPDATE, DELETE ON products TO app_role;",
      "GRANT SELECT, INSERT, UPDATE, DELETE ON orders TO app_role;",
      "GRANT SELECT, INSERT, UPDATE, DELETE ON order_lines TO app_role;",
      "GRANT SELECT ON customers TO app_readonly_role;",
      "GRANT SELECT ON products TO app_readonly_role;",
      "GRANT SELECT ON orders TO app_readonly_role;",
      "GRANT SELECT ON order_lines TO app_readonly_role;",
      // dataset
      "INSERT INTO customers (name, email) SELECT 'Customer_' || level, 'cust' || level || '@ex.com' FROM dual CONNECT BY level <= 50;",
      "INSERT INTO products (sku, name, price) SELECT 'SKU-' || LPAD(level,4,'0'), 'Product ' || level, level * 5.99 FROM dual CONNECT BY level <= 100;",
      "INSERT INTO orders (customer_id, status) SELECT MOD(level, 50) + 1, CASE MOD(level,3) WHEN 0 THEN 'PAID' WHEN 1 THEN 'SHIPPED' ELSE 'PENDING' END FROM dual CONNECT BY level <= 200;",
      "INSERT INTO order_lines (order_id, line_no, product_id, qty, unit_price) SELECT MOD(level, 200) + 1, MOD(level, 5) + 1, MOD(level, 100) + 1, MOD(level, 10) + 1, MOD(level, 50) + 1 FROM dual CONNECT BY level <= 1000;",
      'COMMIT;',
      'SELECT COUNT(*) FROM customers;',
      'SELECT COUNT(*) FROM products;',
      'SELECT COUNT(*) FROM orders;',
      'SELECT COUNT(*) FROM order_lines;',

      // ── 2. gather stats + verify ─────────────────────────────────
      { section: '2. gather statistics', cmd: "EXEC DBMS_STATS.GATHER_SCHEMA_STATS('APP_OWNER');" },
      "EXEC DBMS_STATS.GATHER_TABLE_STATS('APP_OWNER','CUSTOMERS', cascade=>TRUE);",
      "EXEC DBMS_STATS.GATHER_TABLE_STATS('APP_OWNER','PRODUCTS', cascade=>TRUE);",
      "EXEC DBMS_STATS.GATHER_TABLE_STATS('APP_OWNER','ORDERS', cascade=>TRUE);",
      "EXEC DBMS_STATS.GATHER_TABLE_STATS('APP_OWNER','ORDER_LINES', cascade=>TRUE);",
      "EXEC DBMS_STATS.GATHER_INDEX_STATS('APP_OWNER','IDX_ORDERS_CUST');",
      "SELECT table_name, num_rows, blocks, last_analyzed FROM user_tables;",
      "SELECT index_name, distinct_keys, leaf_blocks, last_analyzed FROM user_indexes;",
      "SELECT * FROM user_tab_statistics WHERE rownum < 10;",
      "SELECT * FROM user_tab_histograms WHERE rownum < 20;",

      // ── 3. PERFORMANCE — explain plan ────────────────────────────
      { section: '3. plan analysis', cmd: 'EXPLAIN PLAN FOR SELECT * FROM orders WHERE customer_id = 1;' },
      "SELECT * FROM TABLE(DBMS_XPLAN.DISPLAY);",
      "EXPLAIN PLAN FOR SELECT c.name, o.id, ol.qty * ol.unit_price FROM customers c JOIN orders o ON c.id = o.customer_id JOIN order_lines ol ON o.id = ol.order_id WHERE c.id < 10;",
      "SELECT * FROM TABLE(DBMS_XPLAN.DISPLAY);",
      "EXPLAIN PLAN FOR SELECT COUNT(*) FROM orders WHERE status = 'PAID';",
      "SELECT * FROM TABLE(DBMS_XPLAN.DISPLAY(NULL, NULL, 'ALL'));",
      "SELECT * FROM TABLE(DBMS_XPLAN.DISPLAY_CURSOR);",
      "SELECT * FROM TABLE(DBMS_XPLAN.DISPLAY_AWR('abcdefghij'));",
      'SET AUTOTRACE ON EXPLAIN;',
      "SELECT * FROM orders WHERE customer_id = 5;",
      'SET AUTOTRACE OFF;',
      'SET AUTOTRACE ON STATISTICS;',
      "SELECT COUNT(*) FROM orders;",
      'SET AUTOTRACE OFF;',
      'SET TIMING ON;',
      "SELECT COUNT(*) FROM order_lines;",
      'SET TIMING OFF;',

      // ── 4. HINTS / tuning ────────────────────────────────────────
      { section: '4. hints + tuning', cmd: "SELECT /*+ INDEX(orders idx_orders_cust) */ * FROM orders WHERE customer_id = 1;" },
      "SELECT /*+ FULL(o) */ * FROM orders o WHERE rownum < 20;",
      "SELECT /*+ PARALLEL(o, 4) */ COUNT(*) FROM orders o;",
      "SELECT /*+ ORDERED */ c.name FROM customers c, orders o WHERE c.id = o.customer_id AND rownum < 10;",
      "SELECT /*+ USE_HASH(o c) */ c.name, o.id FROM customers c, orders o WHERE c.id = o.customer_id AND rownum < 10;",
      "SELECT /*+ USE_NL(c o) */ c.name, o.id FROM customers c, orders o WHERE c.id = o.customer_id AND rownum < 10;",
      "SELECT /*+ FIRST_ROWS(10) */ * FROM orders ORDER BY order_date DESC;",
      "SELECT /*+ ALL_ROWS */ * FROM orders;",
      "SELECT /*+ RESULT_CACHE */ COUNT(*) FROM customers;",
      "SELECT /*+ NO_RESULT_CACHE */ COUNT(*) FROM customers;",
      "SELECT /*+ APPEND */ * FROM products WHERE rownum < 5;",
      "SELECT /*+ NO_PARALLEL */ * FROM orders WHERE rownum < 5;",
      // tuning advisor
      "DECLARE v_task VARCHAR2(50); BEGIN v_task := DBMS_SQLTUNE.CREATE_TUNING_TASK(sql_text=>'SELECT * FROM orders WHERE customer_id = 1'); DBMS_OUTPUT.PUT_LINE(v_task); END;",
      "EXEC DBMS_SQLTUNE.EXECUTE_TUNING_TASK(task_name=>'my_task');",
      "SELECT DBMS_SQLTUNE.REPORT_TUNING_TASK('my_task') FROM dual;",
      "EXEC DBMS_SQLTUNE.DROP_TUNING_TASK('my_task');",
      "SELECT * FROM dba_advisor_findings WHERE rownum < 30;",
      "SELECT * FROM dba_advisor_recommendations WHERE rownum < 30;",
      "SELECT * FROM dba_advisor_actions WHERE rownum < 30;",

      // ── 5. MONITORING — AWR / ASH / ADDM ─────────────────────────
      { section: '5. AWR / ASH / ADDM', cmd: "EXEC DBMS_WORKLOAD_REPOSITORY.CREATE_SNAPSHOT;" },
      "SELECT * FROM dba_hist_snapshot ORDER BY snap_id DESC FETCH FIRST 10 ROWS ONLY;",
      "SELECT * FROM dba_hist_sysstat WHERE stat_name = 'redo size' ORDER BY snap_id DESC FETCH FIRST 20 ROWS ONLY;",
      "SELECT * FROM dba_hist_sqlstat ORDER BY snap_id DESC FETCH FIRST 30 ROWS ONLY;",
      "SELECT * FROM dba_hist_sysmetric_history ORDER BY begin_time DESC FETCH FIRST 30 ROWS ONLY;",
      "SELECT * FROM dba_hist_active_sess_history ORDER BY sample_time DESC FETCH FIRST 30 ROWS ONLY;",
      "SELECT * FROM v$active_session_history ORDER BY sample_time DESC FETCH FIRST 30 ROWS ONLY;",
      "SELECT * FROM dba_addm_findings;",
      "SELECT * FROM dba_addm_instances;",
      "SELECT * FROM dba_addm_fdg_breakdown;",
      "SELECT * FROM dba_advisor_tasks WHERE rownum < 20;",
      // create baseline
      "EXEC DBMS_WORKLOAD_REPOSITORY.CREATE_BASELINE(start_snap_id=>1, end_snap_id=>10, baseline_name=>'baseline1');",
      "EXEC DBMS_WORKLOAD_REPOSITORY.DROP_BASELINE('baseline1');",

      // ── 6. ALERT LOG + trace ─────────────────────────────────────
      { section: '6. alert log + trace', cmd: 'SELECT * FROM v$diag_info;' },
      "SELECT message_text FROM x$dbgalertext ORDER BY originating_timestamp DESC FETCH FIRST 30 ROWS ONLY;",
      "SELECT * FROM v$diag_problem ORDER BY problem_key;",
      "SELECT * FROM v$diag_incident ORDER BY create_time DESC FETCH FIRST 20 ROWS ONLY;",
      "SELECT * FROM v$diag_alert_ext WHERE rownum < 20;",
      "EXEC DBMS_MONITOR.SESSION_TRACE_ENABLE(waits=>TRUE, binds=>TRUE);",
      "EXEC DBMS_MONITOR.SESSION_TRACE_DISABLE;",
      "ALTER SESSION SET TRACEFILE_IDENTIFIER='dbg_e2e';",

      // ── 7. AUDIT ────────────────────────────────────────────────
      { section: '7. audit setup', cmd: 'AUDIT SELECT TABLE BY app_user BY ACCESS;' },
      'AUDIT INSERT, UPDATE, DELETE ON app_owner.customers;',
      'AUDIT ALL ON app_owner.orders BY ACCESS;',
      'AUDIT CREATE TABLE BY app_owner;',
      'AUDIT DROP ANY TABLE;',
      "SELECT * FROM dba_audit_trail ORDER BY timestamp DESC FETCH FIRST 30 ROWS ONLY;",
      "SELECT * FROM dba_obj_audit_opts WHERE owner = 'APP_OWNER';",
      "SELECT * FROM dba_stmt_audit_opts WHERE rownum < 30;",
      "SELECT * FROM dba_priv_audit_opts WHERE rownum < 30;",
      "CREATE AUDIT POLICY ord_changes ACTIONS UPDATE, DELETE ON app_owner.orders;",
      "AUDIT POLICY ord_changes;",
      "SELECT * FROM audit_unified_policies WHERE rownum < 30;",
      "SELECT * FROM unified_audit_trail WHERE rownum < 30;",
      "NOAUDIT POLICY ord_changes;",
      "DROP AUDIT POLICY ord_changes;",

      // ── 8. MAINTENANCE — index/table maintenance ─────────────────
      { section: '8. maintenance', cmd: 'ALTER TABLE orders SHRINK SPACE COMPACT;' },
      'ALTER TABLE orders ENABLE ROW MOVEMENT;',
      'ALTER TABLE orders SHRINK SPACE CASCADE;',
      'ALTER TABLE orders DISABLE ROW MOVEMENT;',
      'ALTER INDEX idx_orders_cust REBUILD ONLINE;',
      'ALTER INDEX idx_orders_date COALESCE;',
      'ALTER INDEX idx_ol_prod REBUILD COMPRESS;',
      'ALTER TABLE products MOVE COMPRESS FOR QUERY HIGH;',
      'ALTER TABLE products MOVE NOCOMPRESS;',
      // reorg
      'ALTER TABLE orders MOVE ONLINE;',
      'ALTER INDEX idx_orders_cust REBUILD;',
      // recompile
      "EXEC DBMS_UTILITY.COMPILE_SCHEMA('APP_OWNER');",
      "ALTER PACKAGE bank COMPILE;",
      "SELECT object_name, object_type, status FROM dba_objects WHERE owner='APP_OWNER' AND status='INVALID';",

      // ── 9. flashback usage ───────────────────────────────────────
      { section: '9. flashback', cmd: "SELECT * FROM v$flashback_database_log;" },
      'ALTER DATABASE FLASHBACK ON;',
      "FLASHBACK TABLE customers TO TIMESTAMP SYSTIMESTAMP - INTERVAL '5' MINUTE;",
      "FLASHBACK TABLE customers TO BEFORE DROP;",
      "SELECT * FROM dba_recyclebin WHERE owner = 'APP_OWNER';",
      "PURGE TABLE customers;",
      "PURGE USER_RECYCLEBIN;",
      "ALTER DATABASE FLASHBACK OFF;",

      // ── 10. troubleshooting — find slow queries ─────────────────
      { section: '10. find slow queries', cmd:
        "SELECT sql_id, executions, ROUND(elapsed_time/1000000, 2) AS elapsed_sec, ROUND(cpu_time/1000000, 2) AS cpu_sec, buffer_gets, ROUND(buffer_gets / NULLIF(executions, 0)) AS gets_per_exec FROM v$sqlarea WHERE executions > 0 ORDER BY elapsed_time DESC FETCH FIRST 20 ROWS ONLY;" },
      "SELECT sql_id, parsing_schema_name, sql_text FROM v$sqlarea WHERE rownum < 20 ORDER BY elapsed_time DESC;",
      "SELECT * FROM v$sql_plan WHERE rownum < 30;",
      "SELECT * FROM v$session_longops ORDER BY start_time DESC FETCH FIRST 20 ROWS ONLY;",
      "SELECT * FROM v$active_session_history WHERE wait_class != 'Idle' ORDER BY sample_time DESC FETCH FIRST 30 ROWS ONLY;",
      // blockers
      "SELECT s.sid, s.username, s.blocking_session, s.event, s.seconds_in_wait FROM v$session s WHERE s.blocking_session IS NOT NULL;",
      "SELECT * FROM v$wait_chains;",
      // top consumers
      "SELECT s.sid, s.username, m.cpu, m.io_requests FROM v$session_metric m JOIN v$session s ON s.sid = m.session_id ORDER BY m.cpu DESC FETCH FIRST 10 ROWS ONLY;",
      "SELECT username, SUM(value) AS cpu_used FROM v$sesstat ss JOIN v$session s ON s.sid = ss.sid JOIN v$statname n ON n.statistic# = ss.statistic# WHERE n.name = 'CPU used by this session' AND s.username IS NOT NULL GROUP BY username ORDER BY cpu_used DESC;",

      // ── 11. capacity planning ────────────────────────────────────
      { section: '11. capacity', cmd:
        "SELECT tablespace_name, ROUND(SUM(bytes)/1024/1024,2) AS mb_used FROM dba_segments GROUP BY tablespace_name ORDER BY mb_used DESC;" },
      "SELECT tablespace_name, ROUND(SUM(bytes)/1024/1024,2) AS mb_free FROM dba_free_space GROUP BY tablespace_name;",
      "SELECT df.tablespace_name, ROUND(SUM(df.bytes)/1024/1024,2) AS total_mb, ROUND(NVL(fs.mb_free,0),2) AS free_mb FROM dba_data_files df LEFT JOIN (SELECT tablespace_name, SUM(bytes)/1024/1024 mb_free FROM dba_free_space GROUP BY tablespace_name) fs ON fs.tablespace_name = df.tablespace_name GROUP BY df.tablespace_name, NVL(fs.mb_free, 0);",
      "SELECT segment_name, segment_type, bytes/1024/1024 mb FROM dba_segments WHERE owner = 'APP_OWNER' ORDER BY bytes DESC;",
      "SELECT * FROM dba_hist_tbspc_space_usage ORDER BY snap_id DESC FETCH FIRST 30 ROWS ONLY;",

      // ── 12. backup verify (RMAN-related) ─────────────────────────
      { section: '12. RMAN-related', cmd: 'SELECT * FROM v$rman_status ORDER BY start_time DESC FETCH FIRST 10 ROWS ONLY;' },
      'SELECT * FROM v$rman_backup_job_details ORDER BY end_time DESC FETCH FIRST 10 ROWS ONLY;',
      'SELECT * FROM v$backup_set WHERE rownum < 10;',
      'SELECT * FROM v$backup_piece WHERE rownum < 10;',
      'SELECT * FROM v$datafile WHERE rownum < 10;',
      'SELECT * FROM v$datafile WHERE status = \'OFFLINE\';',

      // ── 13. log monitoring ───────────────────────────────────────
      { section: '13. log monitoring', cmd: 'ARCHIVE LOG LIST;' },
      'SELECT * FROM v$log;',
      'SELECT * FROM v$logfile;',
      'SELECT * FROM v$archived_log ORDER BY sequence# DESC FETCH FIRST 20 ROWS ONLY;',
      'ALTER SYSTEM SWITCH LOGFILE;',
      'ALTER SYSTEM ARCHIVE LOG CURRENT;',
      'ALTER SYSTEM CHECKPOINT;',
      'SELECT * FROM v$log_history ORDER BY sequence# DESC FETCH FIRST 20 ROWS ONLY;',

      // ── 14. service / scheduler ─────────────────────────────────
      { section: '14. service / scheduler', cmd:
        "BEGIN DBMS_SCHEDULER.CREATE_JOB(job_name=>'app_daily_report', job_type=>'PLSQL_BLOCK', job_action=>'BEGIN NULL; END;', start_date=>SYSTIMESTAMP, repeat_interval=>'FREQ=DAILY; BYHOUR=2'); END;" },
      "EXEC DBMS_SCHEDULER.ENABLE('app_daily_report');",
      "EXEC DBMS_SCHEDULER.RUN_JOB('app_daily_report');",
      "SELECT * FROM dba_scheduler_jobs WHERE job_name = 'APP_DAILY_REPORT';",
      "SELECT * FROM dba_scheduler_job_log WHERE job_name = 'APP_DAILY_REPORT' ORDER BY log_date DESC FETCH FIRST 10 ROWS ONLY;",
      "EXEC DBMS_SCHEDULER.DISABLE('app_daily_report');",
      "EXEC DBMS_SCHEDULER.DROP_JOB('app_daily_report');",

      // ── 15. healthcheck ──────────────────────────────────────────
      { section: '15. healthcheck', cmd: "SELECT 'instance=' || instance_name || ', status=' || status || ', uptime=' || ROUND((SYSDATE - startup_time)*24*60, 1) || ' min' FROM v$instance;" },
      "SELECT 'db=' || name || ', log_mode=' || log_mode || ', flashback=' || flashback_on || ', force_logging=' || force_logging FROM v$database;",
      "SELECT 'sessions=' || COUNT(*) FROM v$session WHERE username IS NOT NULL;",
      "SELECT 'transactions=' || COUNT(*) FROM v$transaction;",
      "SELECT 'locks=' || COUNT(*) FROM v$lock;",
      "SELECT 'invalid_objects=' || COUNT(*) FROM dba_objects WHERE status = 'INVALID';",
      "SELECT 'open_cursors_current=' || (SELECT value FROM v$sysstat WHERE name = 'opened cursors current') FROM dual;",
      "SELECT name, value FROM v$sysstat WHERE name IN ('user commits','user rollbacks','session logical reads','physical reads') ORDER BY name;",
      "SELECT * FROM v$dataguard_status WHERE rownum < 20;",
      "SELECT * FROM dba_outstanding_alerts;",
      "SELECT * FROM dba_alert_history ORDER BY creation_time DESC FETCH FIRST 20 ROWS ONLY;",

      // ── 16. cleanup ─────────────────────────────────────────────
      { section: '16. cleanup', cmd: 'ALTER SESSION SET CURRENT_SCHEMA = SYS;' },
      'DROP USER app_owner CASCADE;',
      'DROP USER app_user CASCADE;',
      'DROP USER app_readonly CASCADE;',
      'DROP ROLE app_role;',
      'DROP ROLE app_readonly_role;',
      'NOAUDIT SELECT TABLE BY app_user;',
      'NOAUDIT INSERT, UPDATE, DELETE ON app_owner.customers;',
      'PURGE RECYCLEBIN;',
      'PURGE DBA_RECYCLEBIN;',
      'SELECT COUNT(*) FROM dba_users WHERE username LIKE \'APP_%\';',
      ...monitoringSweep('end-to-end-dba'),
      'EXIT;',
    ];

    runOracleDump('oracle-end-to-end-dba', 'LinuxServer ora-e2e — Oracle ORCL OPEN', lines, runner);
    runner.dispose();
    removeOracleDatabase(srv.id);
  });
});
