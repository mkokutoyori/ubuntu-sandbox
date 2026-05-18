/**
 * Debug — Espaces de stockage Oracle.
 *
 * Tablespaces (PERMANENT, TEMP, UNDO, BIGFILE), datafiles autoextend,
 * segments, extents, free space, fragmentation, ASM diskgroups,
 * online segment shrink, MOVE, compress.
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

describe('debug — Oracle storage spaces', () => {
  it('parcourt tablespaces, datafiles, segments, extents, ASM, compression', () => {
    const srv = new LinuxServer('linux-server', 'ora-stor', 100, 100);
    getOracleDatabase(srv.id);
    const runner = createSqlPlusRunner(srv);

    const lines: OracleDebugLine[] = [
      // ── 1. inventory ─────────────────────────────────────────────
      { section: 'tablespaces inventory', cmd: 'SELECT * FROM dba_tablespaces ORDER BY tablespace_name;' },
      'SELECT COUNT(*) FROM dba_tablespaces;',
      "SELECT contents, COUNT(*) FROM dba_tablespaces GROUP BY contents;",
      'SELECT tablespace_name, block_size, allocation_type, extent_management, segment_space_management FROM dba_tablespaces;',
      "SELECT tablespace_name FROM dba_tablespaces WHERE bigfile = 'YES';",
      "SELECT tablespace_name FROM dba_tablespaces WHERE encrypted = 'YES';",
      "SELECT tablespace_name FROM dba_tablespaces WHERE def_tab_compression = 'ENABLED';",
      "SELECT tablespace_name FROM dba_tablespaces WHERE retention = 'GUARANTEE';",
      "SELECT tablespace_name FROM dba_tablespaces WHERE force_logging = 'YES';",
      "SELECT tablespace_name FROM dba_tablespaces WHERE status != 'ONLINE';",

      // ── 2. usage / free space ────────────────────────────────────
      { section: 'space usage', cmd:
        "SELECT a.tablespace_name, ROUND(NVL(a.used_mb,0),2) AS used_mb, ROUND(NVL(f.free_mb,0),2) AS free_mb, ROUND(NVL(a.used_mb,0)/NULLIF(NVL(a.used_mb,0)+NVL(f.free_mb,0),0)*100,2) AS pct_used FROM (SELECT tablespace_name, SUM(bytes)/1024/1024 used_mb FROM dba_segments GROUP BY tablespace_name) a FULL OUTER JOIN (SELECT tablespace_name, SUM(bytes)/1024/1024 free_mb FROM dba_free_space GROUP BY tablespace_name) f ON a.tablespace_name = f.tablespace_name ORDER BY pct_used DESC;" },
      "SELECT tablespace_name, SUM(bytes)/1024/1024 mb_used FROM dba_segments GROUP BY tablespace_name ORDER BY 2 DESC;",
      "SELECT tablespace_name, SUM(bytes)/1024/1024 mb_free, MAX(bytes)/1024/1024 max_chunk FROM dba_free_space GROUP BY tablespace_name;",
      'SELECT * FROM dba_free_space ORDER BY tablespace_name, file_id, block_id FETCH FIRST 30 ROWS ONLY;',
      'SELECT * FROM dba_free_space_coalesced;',
      'SELECT * FROM v$datafile;',
      'SELECT * FROM v$tempfile;',
      'SELECT * FROM v$filestat ORDER BY phyrds DESC FETCH FIRST 10 ROWS ONLY;',
      'SELECT * FROM v$tempstat;',
      "SELECT * FROM dba_data_files ORDER BY tablespace_name, file_id;",
      "SELECT * FROM dba_temp_files ORDER BY tablespace_name, file_id;",
      "SELECT file_id, file_name, tablespace_name, bytes/1024/1024 mb, autoextensible, increment_by, maxbytes/1024/1024 max_mb FROM dba_data_files;",

      // ── 3. CREATE tablespace — every variant ─────────────────────
      { section: 'CREATE tablespace', cmd:
        "CREATE TABLESPACE ts_smallfile DATAFILE '/u01/oradata/ORCL/ts_smallfile01.dbf' SIZE 100M AUTOEXTEND ON NEXT 50M MAXSIZE 1G EXTENT MANAGEMENT LOCAL AUTOALLOCATE SEGMENT SPACE MANAGEMENT AUTO;" },
      "CREATE TABLESPACE ts_uniform DATAFILE '/u01/oradata/ORCL/ts_uniform01.dbf' SIZE 50M EXTENT MANAGEMENT LOCAL UNIFORM SIZE 1M;",
      "CREATE TABLESPACE ts_manual DATAFILE '/u01/oradata/ORCL/ts_manual01.dbf' SIZE 50M SEGMENT SPACE MANAGEMENT MANUAL;",
      "CREATE BIGFILE TABLESPACE ts_big DATAFILE '/u01/oradata/ORCL/ts_big01.dbf' SIZE 1G AUTOEXTEND ON MAXSIZE 32G;",
      "CREATE TABLESPACE ts_multi DATAFILE '/u01/oradata/ORCL/ts_multi01.dbf' SIZE 50M, '/u01/oradata/ORCL/ts_multi02.dbf' SIZE 50M, '/u01/oradata/ORCL/ts_multi03.dbf' SIZE 50M;",
      "CREATE TABLESPACE ts_offline DATAFILE '/u01/oradata/ORCL/ts_offline01.dbf' SIZE 50M OFFLINE;",
      "CREATE TABLESPACE ts_readonly DATAFILE '/u01/oradata/ORCL/ts_ro01.dbf' SIZE 50M;",
      "CREATE TABLESPACE ts_nologging DATAFILE '/u01/oradata/ORCL/ts_nologging01.dbf' SIZE 50M NOLOGGING;",
      "CREATE TABLESPACE ts_compressed DATAFILE '/u01/oradata/ORCL/ts_comp01.dbf' SIZE 50M DEFAULT TABLE COMPRESS FOR OLTP;",
      "CREATE TABLESPACE ts_encrypted DATAFILE '/u01/oradata/ORCL/ts_enc01.dbf' SIZE 50M ENCRYPTION USING 'AES256' DEFAULT STORAGE (ENCRYPT);",
      "CREATE TEMPORARY TABLESPACE temp2 TEMPFILE '/u01/oradata/ORCL/temp02.dbf' SIZE 100M EXTENT MANAGEMENT LOCAL UNIFORM SIZE 1M;",
      "CREATE BIGFILE TEMPORARY TABLESPACE temp_big TEMPFILE '/u01/oradata/ORCL/temp_big.dbf' SIZE 500M AUTOEXTEND ON MAXSIZE 8G;",
      "CREATE UNDO TABLESPACE undotbs_new DATAFILE '/u01/oradata/ORCL/undotbs_new01.dbf' SIZE 200M;",
      "CREATE TEMPORARY TABLESPACE GROUP_tg TEMPFILE '/u01/oradata/ORCL/tg01.dbf' SIZE 50M TABLESPACE GROUP tg;",
      "ALTER TABLESPACE temp TABLESPACE GROUP tg;",
      "ALTER TABLESPACE temp TABLESPACE GROUP '';",

      // ── 4. ALTER tablespace ──────────────────────────────────────
      { section: 'ALTER tablespace', cmd:
        "ALTER TABLESPACE ts_smallfile ADD DATAFILE '/u01/oradata/ORCL/ts_smallfile02.dbf' SIZE 100M;" },
      "ALTER TABLESPACE ts_smallfile ADD DATAFILE '/u01/oradata/ORCL/ts_smallfile03.dbf' SIZE 100M AUTOEXTEND ON NEXT 50M MAXSIZE 1G;",
      "ALTER DATABASE DATAFILE '/u01/oradata/ORCL/ts_smallfile01.dbf' RESIZE 200M;",
      "ALTER DATABASE DATAFILE '/u01/oradata/ORCL/ts_smallfile01.dbf' AUTOEXTEND OFF;",
      "ALTER DATABASE DATAFILE '/u01/oradata/ORCL/ts_smallfile01.dbf' AUTOEXTEND ON NEXT 100M MAXSIZE 2G;",
      "ALTER DATABASE DATAFILE '/u01/oradata/ORCL/ts_smallfile02.dbf' OFFLINE;",
      "ALTER DATABASE DATAFILE '/u01/oradata/ORCL/ts_smallfile02.dbf' ONLINE;",
      "ALTER DATABASE DATAFILE '/u01/oradata/ORCL/ts_smallfile02.dbf' END BACKUP;",
      "ALTER TABLESPACE ts_offline ONLINE;",
      "ALTER TABLESPACE ts_offline OFFLINE NORMAL;",
      "ALTER TABLESPACE ts_offline OFFLINE TEMPORARY;",
      "ALTER TABLESPACE ts_offline OFFLINE IMMEDIATE;",
      "ALTER TABLESPACE ts_offline ONLINE;",
      "ALTER TABLESPACE ts_readonly READ ONLY;",
      "ALTER TABLESPACE ts_readonly READ WRITE;",
      "ALTER TABLESPACE ts_smallfile BEGIN BACKUP;",
      "ALTER TABLESPACE ts_smallfile END BACKUP;",
      "ALTER DATABASE BEGIN BACKUP;",
      "ALTER DATABASE END BACKUP;",
      "ALTER TABLESPACE ts_smallfile RENAME TO ts_renamed;",
      "ALTER TABLESPACE ts_renamed RENAME TO ts_smallfile;",
      "ALTER TABLESPACE ts_smallfile RENAME DATAFILE '/u01/oradata/ORCL/ts_smallfile02.dbf' TO '/u02/oradata/ORCL/ts_smallfile02.dbf';",
      "ALTER TABLESPACE ts_smallfile DROP DATAFILE '/u01/oradata/ORCL/ts_smallfile03.dbf';",
      "ALTER TABLESPACE ts_smallfile COALESCE;",
      "ALTER TABLESPACE ts_smallfile SHRINK SPACE;",
      "ALTER TABLESPACE ts_smallfile FLASHBACK ON;",
      "ALTER TABLESPACE ts_smallfile FLASHBACK OFF;",
      "ALTER TABLESPACE ts_smallfile LOGGING;",
      "ALTER TABLESPACE ts_smallfile NOLOGGING;",
      "ALTER TABLESPACE ts_smallfile FORCE LOGGING;",
      "ALTER TABLESPACE ts_smallfile NO FORCE LOGGING;",
      "ALTER TABLESPACE ts_smallfile DEFAULT COMPRESS FOR OLTP;",
      "ALTER TABLESPACE ts_smallfile DEFAULT NOCOMPRESS;",
      "ALTER TABLESPACE ts_smallfile RETENTION GUARANTEE;",
      "ALTER TABLESPACE ts_smallfile RETENTION NOGUARANTEE;",
      "ALTER DATABASE DEFAULT TABLESPACE ts_smallfile;",
      "ALTER DATABASE DEFAULT TEMPORARY TABLESPACE temp2;",
      "ALTER DATABASE DEFAULT TABLESPACE users;",

      // ── 5. segments / extents ───────────────────────────────────
      { section: 'segments', cmd: 'SELECT * FROM dba_segments WHERE rownum < 30 ORDER BY bytes DESC;' },
      "SELECT segment_type, COUNT(*) AS cnt, ROUND(SUM(bytes)/1024/1024, 2) AS total_mb FROM dba_segments GROUP BY segment_type ORDER BY total_mb DESC;",
      "SELECT owner, COUNT(*) AS segs, ROUND(SUM(bytes)/1024/1024,2) AS mb FROM dba_segments WHERE owner NOT IN ('SYS','SYSTEM','XDB','OUTLN','DBSNMP') GROUP BY owner ORDER BY mb DESC;",
      "SELECT * FROM dba_extents WHERE rownum < 30;",
      "SELECT owner, segment_name, COUNT(*) AS extents FROM dba_extents GROUP BY owner, segment_name ORDER BY COUNT(*) DESC FETCH FIRST 30 ROWS ONLY;",
      "SELECT * FROM dba_segments WHERE segment_type LIKE 'TABLE%' AND rownum < 30;",
      "SELECT * FROM dba_segments WHERE segment_type LIKE 'INDEX%' AND rownum < 30;",
      "SELECT * FROM dba_segments WHERE segment_type = 'LOBSEGMENT';",
      "SELECT * FROM dba_segments WHERE segment_type = 'LOBINDEX';",
      "SELECT * FROM dba_segments WHERE partition_name IS NOT NULL AND rownum < 30;",
      "SELECT * FROM dba_segments WHERE buffer_pool != 'DEFAULT' AND rownum < 30;",

      // ── 6. shrink / move / compress ──────────────────────────────
      { section: 'shrink + move + compress', cmd: "CREATE TABLE hr.tmp_for_shrink (id NUMBER PRIMARY KEY, payload VARCHAR2(4000)) TABLESPACE ts_smallfile;" },
      "INSERT INTO hr.tmp_for_shrink SELECT level, LPAD('x', 200, 'x') FROM dual CONNECT BY level <= 100;",
      "COMMIT;",
      "DELETE FROM hr.tmp_for_shrink WHERE MOD(id, 2) = 0;",
      "COMMIT;",
      "ALTER TABLE hr.tmp_for_shrink ENABLE ROW MOVEMENT;",
      "ALTER TABLE hr.tmp_for_shrink SHRINK SPACE COMPACT;",
      "ALTER TABLE hr.tmp_for_shrink SHRINK SPACE;",
      "ALTER TABLE hr.tmp_for_shrink SHRINK SPACE CASCADE;",
      "ALTER TABLE hr.tmp_for_shrink DISABLE ROW MOVEMENT;",
      "ALTER TABLE hr.tmp_for_shrink MOVE TABLESPACE users;",
      "ALTER TABLE hr.tmp_for_shrink MOVE COMPRESS FOR QUERY HIGH;",
      "ALTER TABLE hr.tmp_for_shrink MOVE NOCOMPRESS;",
      "ALTER TABLE hr.tmp_for_shrink MOVE ONLINE;",
      "ALTER TABLE hr.tmp_for_shrink ROW STORE COMPRESS ADVANCED;",
      "ALTER TABLE hr.tmp_for_shrink NOCOMPRESS;",
      "ALTER INDEX hr.sys_c_tmp REBUILD ONLINE;",
      "DROP TABLE hr.tmp_for_shrink PURGE;",

      // ── 7. quotas ────────────────────────────────────────────────
      { section: 'quotas', cmd: 'SELECT * FROM dba_ts_quotas ORDER BY tablespace_name, username;' },
      "SELECT * FROM dba_ts_quotas WHERE tablespace_name = 'USERS';",
      "SELECT username, tablespace_name, bytes, max_bytes FROM dba_ts_quotas;",
      "ALTER USER hr QUOTA UNLIMITED ON users;",
      "ALTER USER hr QUOTA 500M ON ts_smallfile;",
      "ALTER USER hr QUOTA 0 ON ts_smallfile;",

      // ── 8. fragmentation ────────────────────────────────────────
      { section: 'fragmentation', cmd:
        "SELECT tablespace_name, COUNT(*) AS chunks, MAX(bytes)/1024/1024 max_chunk_mb FROM dba_free_space GROUP BY tablespace_name ORDER BY chunks DESC;" },
      "SELECT * FROM v$tablespace_thread;",
      "SELECT * FROM dba_segments ORDER BY extents DESC FETCH FIRST 10 ROWS ONLY;",

      // ── 9. ASM ───────────────────────────────────────────────────
      { section: 'ASM', cmd: 'SELECT * FROM v$asm_diskgroup;' },
      'SELECT * FROM v$asm_disk;',
      'SELECT * FROM v$asm_disk_iostat;',
      'SELECT * FROM v$asm_file;',
      'SELECT * FROM v$asm_alias;',
      'SELECT * FROM v$asm_template;',
      'SELECT * FROM v$asm_client;',
      'SELECT * FROM v$asm_attribute;',
      "ALTER DISKGROUP DATA ADD DISK '/dev/oracleasm/disks/DISK5';",
      "ALTER DISKGROUP DATA DROP DISK 'DISK5';",
      "ALTER DISKGROUP DATA REBALANCE POWER 5;",
      "ALTER DISKGROUP DATA CHECK ALL REPAIR;",
      "CREATE DISKGROUP RECO EXTERNAL REDUNDANCY DISK '/dev/oracleasm/disks/RECO1' SIZE 10G ATTRIBUTE 'au_size'='1M';",
      "DROP DISKGROUP RECO INCLUDING CONTENTS;",

      // ── 10. flash recovery area ─────────────────────────────────
      { section: 'flash recovery area', cmd: 'SELECT * FROM v$recovery_file_dest;' },
      'SELECT * FROM v$recovery_area_usage;',
      'SELECT * FROM v$flash_recovery_area_usage;',
      "ALTER SYSTEM SET db_recovery_file_dest_size=4G SCOPE=BOTH;",
      "ALTER SYSTEM SET db_recovery_file_dest='/u01/app/oracle/flash_recovery_area' SCOPE=BOTH;",

      // ── 11. block / row chaining ────────────────────────────────
      { section: 'block / row chaining', cmd: "SELECT table_name, chain_cnt FROM dba_tables WHERE owner = 'HR' AND chain_cnt > 0;" },
      "SELECT table_name, num_rows, blocks, empty_blocks, avg_space, avg_row_len, chain_cnt FROM dba_tables WHERE owner = 'HR';",
      "EXEC DBMS_STATS.GATHER_TABLE_STATS('HR','EMPLOYEES');",
      'ANALYZE TABLE hr.employees COMPUTE STATISTICS;',
      'ANALYZE TABLE hr.employees ESTIMATE STATISTICS;',
      'ANALYZE TABLE hr.employees VALIDATE STRUCTURE;',
      'ANALYZE TABLE hr.employees VALIDATE STRUCTURE CASCADE;',
      'ANALYZE TABLE hr.employees LIST CHAINED ROWS INTO chained_rows;',

      // ── 12. partitioning ────────────────────────────────────────
      { section: 'partitioning', cmd:
        "CREATE TABLE hr.sales_part (id NUMBER, sale_date DATE, region VARCHAR2(50), amount NUMBER) PARTITION BY RANGE (sale_date) INTERVAL (NUMTOYMINTERVAL(1,'MONTH')) (PARTITION p0 VALUES LESS THAN (DATE '2023-01-01'));" },
      "INSERT INTO hr.sales_part VALUES (1, DATE '2024-05-15', 'EU', 100);",
      "INSERT INTO hr.sales_part VALUES (2, DATE '2024-06-20', 'US', 200);",
      "INSERT INTO hr.sales_part VALUES (3, DATE '2025-01-10', 'APAC', 300);",
      'COMMIT;',
      "SELECT * FROM dba_tab_partitions WHERE table_name = 'SALES_PART';",
      "SELECT * FROM dba_part_tables WHERE table_name = 'SALES_PART';",
      "SELECT * FROM dba_part_key_columns WHERE name = 'SALES_PART';",
      "ALTER TABLE hr.sales_part MODIFY PARTITION p0 SHRINK SPACE;",
      "ALTER TABLE hr.sales_part MOVE PARTITION FOR (DATE '2024-05-15') TABLESPACE users;",
      "ALTER TABLE hr.sales_part TRUNCATE PARTITION FOR (DATE '2024-05-15');",
      "ALTER TABLE hr.sales_part SPLIT PARTITION p0 AT (DATE '2022-01-01') INTO (PARTITION p_old, PARTITION p_new);",
      "ALTER TABLE hr.sales_part MERGE PARTITIONS p_old, p_new INTO PARTITION p0;",
      "ALTER TABLE hr.sales_part DROP PARTITION p0;",
      "DROP TABLE hr.sales_part PURGE;",

      // ── 13. LOB ─────────────────────────────────────────────────
      { section: 'LOB', cmd:
        "CREATE TABLE hr.with_lob (id NUMBER PRIMARY KEY, payload CLOB, photo BLOB) LOB(payload) STORE AS SECUREFILE (TABLESPACE users COMPRESS HIGH DEDUPLICATE CACHE) LOB(photo) STORE AS BASICFILE (TABLESPACE users);" },
      "INSERT INTO hr.with_lob VALUES (1, 'long text here', NULL);",
      'COMMIT;',
      "SELECT * FROM dba_lobs WHERE owner = 'HR' AND table_name = 'WITH_LOB';",
      "SELECT * FROM dba_lob_partitions;",
      "SELECT * FROM dba_lob_subpartitions;",
      "ALTER TABLE hr.with_lob MODIFY LOB (payload) (RETENTION);",
      "ALTER TABLE hr.with_lob MOVE LOB (payload) STORE AS SECUREFILE (TABLESPACE users);",
      "DROP TABLE hr.with_lob PURGE;",

      // ── 14. cleanup ─────────────────────────────────────────────
      { section: 'cleanup', cmd: 'DROP TABLESPACE ts_smallfile INCLUDING CONTENTS AND DATAFILES;' },
      'DROP TABLESPACE ts_uniform INCLUDING CONTENTS AND DATAFILES;',
      'DROP TABLESPACE ts_manual INCLUDING CONTENTS AND DATAFILES;',
      'DROP TABLESPACE ts_big INCLUDING CONTENTS AND DATAFILES;',
      'DROP TABLESPACE ts_multi INCLUDING CONTENTS AND DATAFILES;',
      'DROP TABLESPACE ts_offline INCLUDING CONTENTS AND DATAFILES;',
      'DROP TABLESPACE ts_readonly INCLUDING CONTENTS AND DATAFILES;',
      'DROP TABLESPACE ts_nologging INCLUDING CONTENTS AND DATAFILES;',
      'DROP TABLESPACE ts_compressed INCLUDING CONTENTS AND DATAFILES;',
      'DROP TABLESPACE ts_encrypted INCLUDING CONTENTS AND DATAFILES;',
      'DROP TABLESPACE temp2 INCLUDING CONTENTS AND DATAFILES;',
      'DROP TABLESPACE temp_big INCLUDING CONTENTS AND DATAFILES;',
      'DROP TABLESPACE undotbs_new INCLUDING CONTENTS AND DATAFILES;',
      'DROP TABLESPACE GROUP_tg INCLUDING CONTENTS AND DATAFILES;',
      'SELECT COUNT(*) FROM dba_tablespaces;',
      ...monitoringSweep('storage-spaces'),
      'EXIT;',
    ];

    runOracleDump('oracle-storage-spaces', 'LinuxServer ora-stor — Oracle ORCL OPEN', lines, runner);
    runner.dispose();
    removeOracleDatabase(srv.id);
  });
});
