/**
 * Debug — Vues du dictionnaire de données Oracle.
 *
 * V$, DBA_, ALL_, USER_, DICT, GV$. On parcourt les vues les plus
 * importantes par famille — tables, indexes, vues, séquences, synonymes,
 * contraintes, dépendances, types, opérateurs.
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

describe('debug — Oracle data dictionary', () => {
  it('parcourt DICT, DBA_*, ALL_*, USER_*, V$, GV$ — vues clés', () => {
    const srv = new LinuxServer('linux-server', 'ora-dict', 100, 100);
    getOracleDatabase(srv.id);
    const runner = createSqlPlusRunner(srv);

    const lines: OracleDebugLine[] = [
      // ── 1. DICTIONARY meta-meta ──────────────────────────────────
      { section: 'DICT', cmd: 'SELECT COUNT(*) AS dict_views FROM dict;' },
      'SELECT * FROM dict WHERE rownum < 50 ORDER BY table_name;',
      "SELECT table_name FROM dict WHERE table_name LIKE 'DBA_%' AND rownum < 50;",
      "SELECT table_name FROM dict WHERE table_name LIKE 'V_$%' AND rownum < 50;",
      "SELECT table_name FROM dict WHERE table_name LIKE 'USER_%' AND rownum < 50;",
      "SELECT table_name FROM dict WHERE comments LIKE '%table%' AND rownum < 30;",
      'SELECT * FROM dict_columns WHERE table_name = \'DBA_TABLES\' ORDER BY column_name;',
      'SELECT * FROM dictionary WHERE rownum < 30;',
      "SELECT * FROM v$fixed_table WHERE rownum < 50;",
      "SELECT * FROM v$fixed_view_definition WHERE rownum < 10;",
      "SELECT COUNT(*) FROM v$fixed_table;",
      "SELECT COUNT(*) FROM v$fixed_view_definition;",

      // ── 2. TABLES ────────────────────────────────────────────────
      { section: 'tables', cmd: 'SELECT owner, table_name, tablespace_name, num_rows FROM dba_tables WHERE owner = \'HR\';' },
      "SELECT owner, table_name FROM dba_tables WHERE owner = 'SCOTT';",
      'SELECT COUNT(*) FROM dba_tables;',
      "SELECT owner, COUNT(*) FROM dba_tables WHERE owner NOT IN ('SYS','SYSTEM','XDB','OUTLN') GROUP BY owner ORDER BY COUNT(*) DESC;",
      'SELECT * FROM all_tables WHERE rownum < 20;',
      'SELECT table_name FROM user_tables ORDER BY table_name;',
      'SELECT COUNT(*) FROM user_tables;',
      'SELECT * FROM dba_tables WHERE temporary = \'Y\';',
      'SELECT * FROM dba_tables WHERE partitioned = \'YES\' AND rownum < 20;',
      'SELECT * FROM dba_tables WHERE cluster_name IS NOT NULL;',
      "SELECT * FROM dba_tables WHERE iot_type = 'IOT';",
      "SELECT * FROM dba_tables WHERE logging = 'NO';",
      'SELECT * FROM dba_tables WHERE compression = \'ENABLED\';',
      'SELECT * FROM dba_external_tables;',
      'SELECT * FROM dba_external_locations;',
      'SELECT * FROM dba_tab_partitions WHERE rownum < 30;',
      'SELECT * FROM dba_tab_subpartitions WHERE rownum < 30;',
      'SELECT * FROM dba_part_tables WHERE rownum < 30;',
      'SELECT * FROM dba_subpart_key_columns WHERE rownum < 30;',

      // ── 3. COLUMNS ───────────────────────────────────────────────
      { section: 'columns', cmd: 'SELECT * FROM dba_tab_columns WHERE owner = \'HR\' AND table_name = \'EMPLOYEES\' ORDER BY column_id;' },
      "SELECT * FROM all_tab_columns WHERE owner = 'HR' AND table_name = 'DEPARTMENTS';",
      'SELECT COUNT(*) FROM dba_tab_columns;',
      "SELECT data_type, COUNT(*) FROM dba_tab_columns GROUP BY data_type ORDER BY COUNT(*) DESC FETCH FIRST 20 ROWS ONLY;",
      "SELECT column_name, data_type, nullable, data_default FROM user_tab_columns WHERE table_name = 'EMPLOYEES';",
      "SELECT * FROM dba_tab_columns WHERE data_type = 'CLOB' AND rownum < 30;",
      "SELECT * FROM dba_tab_columns WHERE data_type LIKE 'TIMESTAMP%' AND rownum < 30;",
      "SELECT * FROM dba_tab_columns WHERE virtual_column = 'YES' AND rownum < 30;",
      'SELECT * FROM dba_tab_identity_cols;',
      'SELECT * FROM dba_tab_cols WHERE owner = \'HR\' AND table_name = \'EMPLOYEES\';',
      'SELECT * FROM dba_unused_col_tabs;',
      'SELECT * FROM dba_tab_comments WHERE owner = \'HR\';',
      'SELECT * FROM dba_col_comments WHERE owner = \'HR\' AND table_name = \'EMPLOYEES\';',

      // ── 4. INDEXES ───────────────────────────────────────────────
      { section: 'indexes', cmd: 'SELECT owner, index_name, table_name, index_type, uniqueness FROM dba_indexes WHERE owner = \'HR\';' },
      'SELECT COUNT(*) FROM dba_indexes;',
      "SELECT index_type, COUNT(*) FROM dba_indexes GROUP BY index_type;",
      "SELECT * FROM dba_ind_columns WHERE index_owner = 'HR' ORDER BY index_name, column_position;",
      'SELECT * FROM dba_ind_expressions WHERE rownum < 30;',
      'SELECT * FROM dba_ind_partitions WHERE rownum < 30;',
      'SELECT * FROM dba_ind_subpartitions WHERE rownum < 30;',
      "SELECT * FROM dba_indexes WHERE uniqueness = 'UNIQUE' AND owner = 'HR';",
      "SELECT * FROM dba_indexes WHERE index_type = 'BITMAP' AND rownum < 30;",
      "SELECT * FROM dba_indexes WHERE index_type LIKE '%FUNCTION-BASED%' AND rownum < 30;",
      "SELECT * FROM dba_indexes WHERE status = 'UNUSABLE';",
      "SELECT * FROM dba_indexes WHERE visibility = 'INVISIBLE';",
      'SELECT * FROM dba_lob_partitions WHERE rownum < 30;',
      'SELECT * FROM dba_lobs WHERE owner = \'HR\';',
      'SELECT * FROM dba_xml_tables WHERE rownum < 30;',

      // ── 5. CONSTRAINTS ───────────────────────────────────────────
      { section: 'constraints', cmd: "SELECT owner, constraint_name, constraint_type, table_name, status, validated FROM dba_constraints WHERE owner = 'HR' ORDER BY table_name;" },
      "SELECT constraint_type, COUNT(*) FROM dba_constraints GROUP BY constraint_type;",
      "SELECT * FROM dba_cons_columns WHERE owner = 'HR' AND table_name = 'EMPLOYEES' ORDER BY constraint_name, position;",
      "SELECT * FROM dba_constraints WHERE constraint_type = 'P' AND rownum < 30;",
      "SELECT * FROM dba_constraints WHERE constraint_type = 'R' AND rownum < 30;",
      "SELECT * FROM dba_constraints WHERE constraint_type = 'U' AND rownum < 30;",
      "SELECT * FROM dba_constraints WHERE constraint_type = 'C' AND rownum < 30;",
      "SELECT * FROM dba_constraints WHERE status = 'DISABLED' AND rownum < 30;",
      "SELECT * FROM dba_constraints WHERE validated = 'NOT VALIDATED' AND rownum < 30;",
      "SELECT * FROM dba_constraints WHERE deferrable = 'DEFERRABLE' AND rownum < 30;",
      "SELECT * FROM dba_constraints WHERE r_owner IS NOT NULL AND rownum < 30;",

      // ── 6. VIEWS / MATERIALIZED VIEWS ───────────────────────────
      { section: 'views', cmd: "SELECT owner, view_name FROM dba_views WHERE owner = 'HR';" },
      'SELECT COUNT(*) FROM dba_views;',
      "SELECT * FROM dba_views WHERE owner = 'SYS' AND view_name LIKE 'DBA_%' AND rownum < 30;",
      'SELECT * FROM dba_updatable_columns WHERE rownum < 30;',
      'SELECT * FROM dba_mviews WHERE rownum < 30;',
      "SELECT * FROM dba_mview_logs WHERE rownum < 30;",
      'SELECT * FROM dba_mview_refresh_times;',
      'SELECT * FROM dba_mview_keys;',
      'SELECT * FROM dba_mview_aggregates;',
      'SELECT * FROM dba_mview_joins;',
      'SELECT * FROM dba_refresh;',
      'SELECT * FROM dba_refresh_children;',
      'SELECT * FROM dba_advisor_recommendations WHERE rownum < 30;',

      // ── 7. SEQUENCES / SYNONYMS / TYPES ─────────────────────────
      { section: 'sequences', cmd: 'SELECT * FROM dba_sequences WHERE rownum < 30;' },
      "SELECT * FROM dba_sequences WHERE sequence_owner = 'HR';",
      "SELECT sequence_name, min_value, max_value, increment_by, cycle_flag, order_flag, cache_size, last_number FROM user_sequences;",
      { section: 'synonyms', cmd: 'SELECT * FROM dba_synonyms WHERE owner = \'PUBLIC\' AND rownum < 50;' },
      "SELECT * FROM dba_synonyms WHERE owner = 'HR' AND rownum < 30;",
      'SELECT COUNT(*) FROM dba_synonyms;',
      { section: 'types', cmd: 'SELECT * FROM dba_types WHERE rownum < 30;' },
      'SELECT * FROM dba_type_attrs WHERE rownum < 30;',
      'SELECT * FROM dba_type_methods WHERE rownum < 30;',
      'SELECT * FROM dba_method_params WHERE rownum < 30;',
      'SELECT * FROM dba_method_results WHERE rownum < 30;',

      // ── 8. STORED PROGRAMS (PL/SQL) ─────────────────────────────
      { section: 'PL/SQL stored programs', cmd: "SELECT owner, object_name, object_type, status FROM dba_objects WHERE object_type IN ('PROCEDURE','FUNCTION','PACKAGE','PACKAGE BODY','TRIGGER','TYPE','TYPE BODY') AND rownum < 50;" },
      "SELECT * FROM dba_procedures WHERE rownum < 30;",
      "SELECT * FROM dba_procedures WHERE owner = 'HR';",
      "SELECT * FROM dba_arguments WHERE rownum < 30;",
      "SELECT * FROM dba_source WHERE owner = 'HR' AND rownum < 50 ORDER BY name, line;",
      "SELECT name, type, line, text FROM dba_source WHERE owner = 'HR' AND type = 'PROCEDURE' AND rownum < 50;",
      'SELECT * FROM dba_dependencies WHERE rownum < 30;',
      "SELECT * FROM dba_dependencies WHERE referenced_owner = 'HR' AND rownum < 30;",
      'SELECT * FROM dba_errors WHERE rownum < 30;',
      "SELECT * FROM dba_errors WHERE owner = 'HR';",
      'SELECT * FROM dba_plsql_object_settings WHERE rownum < 30;',
      'SELECT * FROM dba_warnings WHERE rownum < 30;',
      'SELECT * FROM dba_triggers WHERE rownum < 30;',
      'SELECT * FROM dba_trigger_cols WHERE rownum < 30;',
      'SELECT * FROM dba_jobs WHERE rownum < 30;',

      // ── 9. OBJECTS — toutes catégories ──────────────────────────
      { section: 'all objects', cmd: 'SELECT object_type, COUNT(*) FROM dba_objects GROUP BY object_type ORDER BY COUNT(*) DESC;' },
      "SELECT * FROM dba_objects WHERE owner = 'HR' ORDER BY object_type, object_name;",
      'SELECT COUNT(*) FROM dba_objects;',
      "SELECT status, COUNT(*) FROM dba_objects GROUP BY status;",
      "SELECT * FROM dba_objects WHERE status = 'INVALID' AND rownum < 30;",
      "SELECT * FROM dba_objects WHERE temporary = 'Y' AND rownum < 30;",
      'SELECT * FROM all_objects WHERE rownum < 30;',
      'SELECT * FROM user_objects WHERE rownum < 30;',
      "SELECT * FROM dba_recyclebin WHERE rownum < 30;",

      // ── 10. PRIVILEGES (recap) ───────────────────────────────────
      { section: 'system + object privileges', cmd: 'SELECT COUNT(*) AS sys_privs FROM dba_sys_privs;' },
      'SELECT COUNT(*) AS tab_privs FROM dba_tab_privs;',
      'SELECT COUNT(*) AS col_privs FROM dba_col_privs;',
      'SELECT COUNT(*) AS role_privs FROM dba_role_privs;',
      "SELECT * FROM dba_sys_privs WHERE grantee = 'HR';",
      "SELECT * FROM dba_tab_privs WHERE owner = 'HR' AND rownum < 30;",
      'SELECT * FROM all_tab_privs WHERE rownum < 30;',
      'SELECT * FROM session_privs;',
      'SELECT * FROM session_roles;',

      // ── 11. SCHEMAS — récap ─────────────────────────────────────
      { section: 'schemas summary', cmd: "SELECT username, account_status, default_tablespace, temporary_tablespace FROM dba_users WHERE username NOT IN ('SYS','SYSTEM','XDB','OUTLN','DBSNMP','GSMADMIN_INTERNAL','GSMCATUSER','APPQOSSYS','DBSFWUSER','REMOTE_SCHEDULER_AGENT','SYSBACKUP','SYSDG','SYSKM','SYSRAC','AUDSYS','OJVMSYS','LBACSYS','MDSYS','CTXSYS','OLAPSYS','WMSYS','ANONYMOUS','DIP','ORACLE_OCM','XS$NULL') ORDER BY username;" },
      'SELECT username FROM dba_users ORDER BY username;',
      "SELECT owner, COUNT(*) AS objects FROM dba_objects WHERE owner NOT IN ('SYS','SYSTEM','XDB','OUTLN','DBSNMP') GROUP BY owner ORDER BY COUNT(*) DESC;",
      "SELECT * FROM dba_users WHERE default_tablespace = 'USERS';",

      // ── 12. STATS / hist — sample ───────────────────────────────
      { section: 'statistics', cmd: 'SELECT * FROM dba_tab_statistics WHERE owner = \'HR\';' },
      'SELECT * FROM dba_ind_statistics WHERE owner = \'HR\';',
      'SELECT * FROM dba_col_statistics WHERE owner = \'HR\' AND rownum < 30;',
      'SELECT * FROM dba_tab_histograms WHERE rownum < 30;',
      'SELECT * FROM dba_tab_modifications WHERE rownum < 30;',
      'SELECT * FROM dba_optstat_operations WHERE rownum < 30;',
      'SELECT * FROM dba_optstat_operation_tasks WHERE rownum < 30;',
      "EXEC DBMS_STATS.GATHER_TABLE_STATS('HR','EMPLOYEES');",
      "EXEC DBMS_STATS.GATHER_SCHEMA_STATS('HR');",
      "EXEC DBMS_STATS.GATHER_DATABASE_STATS;",
      "EXEC DBMS_STATS.DELETE_TABLE_STATS('HR','EMPLOYEES');",
      "EXEC DBMS_STATS.LOCK_TABLE_STATS('HR','EMPLOYEES');",
      "EXEC DBMS_STATS.UNLOCK_TABLE_STATS('HR','EMPLOYEES');",

      // ── 13. WAIT / system stats ─────────────────────────────────
      { section: 'system stats / waits', cmd: 'SELECT * FROM v$sysstat WHERE rownum < 50 ORDER BY value DESC;' },
      'SELECT * FROM v$sysstat WHERE class = 1;',
      'SELECT * FROM v$system_event ORDER BY total_waits DESC FETCH FIRST 30 ROWS ONLY;',
      'SELECT * FROM v$system_wait_class;',
      'SELECT * FROM v$session_event WHERE total_waits > 0 ORDER BY total_waits DESC FETCH FIRST 30 ROWS ONLY;',
      'SELECT * FROM v$session_wait WHERE wait_class != \'Idle\' AND rownum < 20;',
      'SELECT * FROM v$session_wait_class WHERE rownum < 30;',
      'SELECT * FROM v$session_wait_history WHERE rownum < 30;',
      'SELECT * FROM v$active_session_history ORDER BY sample_time DESC FETCH FIRST 30 ROWS ONLY;',
      'SELECT * FROM v$enqueue_stat ORDER BY total_wait# DESC FETCH FIRST 20 ROWS ONLY;',

      // ── 14. SQL stats / cursor ──────────────────────────────────
      { section: 'SQL stats', cmd: 'SELECT sql_id, executions, parse_calls, elapsed_time, cpu_time, buffer_gets FROM v$sqlarea ORDER BY elapsed_time DESC FETCH FIRST 20 ROWS ONLY;' },
      'SELECT * FROM v$sql WHERE rownum < 30 ORDER BY elapsed_time DESC;',
      'SELECT * FROM v$sql_plan WHERE rownum < 30;',
      'SELECT * FROM v$sql_plan_statistics WHERE rownum < 30;',
      'SELECT * FROM v$sqlstats WHERE rownum < 30 ORDER BY elapsed_time DESC;',
      'SELECT * FROM v$sqlfn_arg_metadata WHERE rownum < 30;',
      'SELECT * FROM v$sqlfn_metadata WHERE rownum < 30;',
      'SELECT * FROM v$sql_workarea WHERE rownum < 30;',
      'SELECT * FROM v$sql_workarea_histogram WHERE rownum < 30;',
      'SELECT * FROM v$sql_workarea_active WHERE rownum < 30;',

      // ── 15. LIBRARY CACHE / SHARED POOL ─────────────────────────
      { section: 'library cache', cmd: 'SELECT * FROM v$librarycache;' },
      'SELECT * FROM v$librarycache_memory WHERE rownum < 30;',
      'SELECT * FROM v$libraryobj WHERE rownum < 30;',
      'SELECT * FROM v$libcache_locks WHERE rownum < 30;',
      'SELECT * FROM v$db_object_cache WHERE rownum < 30;',
      'SELECT * FROM v$open_cursor WHERE rownum < 30;',
      'SELECT * FROM v$rowcache;',
      'SELECT * FROM v$rowcache_subordinate;',
      'SELECT * FROM v$shared_pool_advice;',
      'SELECT * FROM v$shared_pool_reserved;',

      // ── 16. BUFFER CACHE ─────────────────────────────────────────
      { section: 'buffer cache', cmd: 'SELECT * FROM v$bh WHERE rownum < 30;' },
      'SELECT * FROM v$buffer_pool;',
      'SELECT * FROM v$buffer_pool_statistics;',
      'SELECT * FROM v$db_cache_advice;',
      'SELECT * FROM v$cache_stats;',

      // ── 17. CLUSTER / RAC ────────────────────────────────────────
      { section: 'cluster / RAC', cmd: 'SELECT * FROM v$cluster_instance;' },
      'SELECT * FROM v$rac_global_view;',
      'SELECT * FROM gv$instance;',
      'SELECT * FROM gv$session;',
      'SELECT * FROM gv$process;',
      'SELECT * FROM gv$sqlarea WHERE rownum < 20;',
      'SELECT * FROM v$active_instances;',

      // ── 18. SECURITY ──────────────────────────────────────────────
      { section: 'security', cmd: 'SELECT * FROM dba_policies;' },
      'SELECT * FROM dba_audit_policies;',
      'SELECT * FROM dba_priv_audit_opts;',
      'SELECT * FROM dba_stmt_audit_opts;',
      'SELECT * FROM dba_obj_audit_opts;',
      'SELECT * FROM dba_audit_trail WHERE rownum < 30;',
      'SELECT * FROM unified_audit_trail WHERE rownum < 30;',
      'SELECT * FROM v$pwfile_users;',
      'SELECT * FROM dba_role_privs WHERE granted_role = \'DBA\';',
      "SELECT * FROM v$encryption_keys WHERE rownum < 10;",

      // ── 19. PARAMETER + version ─────────────────────────────────
      { section: 'parameters', cmd: 'SELECT * FROM v$parameter ORDER BY name FETCH FIRST 50 ROWS ONLY;' },
      "SELECT name, value FROM v$parameter WHERE ismodified = 'MODIFIED';",
      "SELECT name, value FROM v$parameter WHERE isdefault = 'FALSE' ORDER BY name;",
      "SELECT * FROM v$spparameter ORDER BY name FETCH FIRST 50 ROWS ONLY;",
      "SELECT * FROM v$parameter2 WHERE rownum < 30;",
      "SELECT * FROM v$obsolete_parameter WHERE rownum < 30;",
      "SELECT * FROM v$version;",
      "SELECT * FROM product_component_version;",
      "SELECT * FROM v$option;",
      "SELECT * FROM v$license;",

      // ── 20. closing ─────────────────────────────────────────────
      { section: 'closing', cmd: 'SELECT * FROM v$database;' },
      'SELECT * FROM v$instance;',
      'SELECT user, sys_context(\'USERENV\',\'SESSION_USER\'), sys_context(\'USERENV\',\'SESSIONID\') FROM dual;',
      ...monitoringSweep('data-dictionary'),
      'EXIT;',
    ];

    runOracleDump('oracle-data-dictionary',
      'LinuxServer ora-dict — Oracle ORCL OPEN', lines, runner);
    runner.dispose();
    removeOracleDatabase(srv.id);
  });
});
