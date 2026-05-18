/**
 * Debug — Cohérence du système de fichiers Oracle.
 *
 * Datafiles, tempfiles, control files, redo logs, FRA, ORADATA layout,
 * tailles allouées/utilisées, autoextend, RENAME, DROP CASCADE.
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

describe('debug — Oracle filesystem coherence', () => {
  it('parcourt datafiles, tempfiles, redo, controlfile, FRA, oradata', () => {
    const srv = new LinuxServer('linux-server', 'ora-fs', 100, 100);
    getOracleDatabase(srv.id);
    const runner = createSqlPlusRunner(srv);

    const lines: OracleDebugLine[] = [
      // ── 1. discover Oracle file hierarchy ─────────────────────────
      { section: 'oracle base / home', cmd: "SELECT value FROM v$parameter WHERE name = 'db_create_file_dest';" },
      "SELECT value FROM v$parameter WHERE name = 'db_create_online_log_dest_1';",
      "SELECT value FROM v$parameter WHERE name = 'db_recovery_file_dest';",
      "SELECT value FROM v$parameter WHERE name = 'db_recovery_file_dest_size';",
      "SHOW PARAMETER db_create;",
      "SHOW PARAMETER db_recovery;",
      "SHOW PARAMETER control_files;",
      "SHOW PARAMETER spfile;",
      "SHOW PARAMETER db_file_name_convert;",
      "SHOW PARAMETER log_file_name_convert;",
      "SHOW PARAMETER db_block_size;",
      "SHOW PARAMETER db_block_buffers;",
      "SELECT name FROM v$controlfile;",
      "SELECT name FROM v$datafile ORDER BY file#;",
      "SELECT name FROM v$tempfile;",
      "SELECT member FROM v$logfile ORDER BY group#;",

      // ── 2. datafiles overview ─────────────────────────────────────
      { section: 'datafiles overview', cmd: 'SELECT * FROM v$datafile ORDER BY file#;' },
      'SELECT file#, name, status, enabled, bytes/1024/1024 AS mb FROM v$datafile;',
      "SELECT file_id, file_name, tablespace_name, bytes/1024/1024 AS mb, status, autoextensible, maxbytes/1024/1024 AS max_mb FROM dba_data_files ORDER BY tablespace_name, file_id;",
      'SELECT COUNT(*) FROM dba_data_files;',
      'SELECT tablespace_name, COUNT(*) AS files, SUM(bytes)/1024/1024 AS total_mb FROM dba_data_files GROUP BY tablespace_name ORDER BY tablespace_name;',
      "SELECT * FROM v$datafile_header;",
      "SELECT file#, name, status, error, creation_time, checkpoint_change#, checkpoint_time FROM v$datafile_header;",
      "SELECT * FROM v$datafile_copy;",
      "SELECT * FROM v$datafile WHERE status = 'OFFLINE';",
      "SELECT * FROM v$datafile WHERE status = 'SYSOFF';",

      // ── 3. tablespaces inventory ──────────────────────────────────
      { section: 'tablespaces', cmd: 'SELECT * FROM dba_tablespaces ORDER BY tablespace_name;' },
      "SELECT tablespace_name, status, contents, logging, extent_management, segment_space_management, allocation_type FROM dba_tablespaces;",
      "SELECT tablespace_name, block_size, initial_extent, next_extent FROM dba_tablespaces;",
      "SELECT tablespace_name, contents FROM dba_tablespaces;",
      "SELECT tablespace_name FROM dba_tablespaces WHERE contents = 'PERMANENT';",
      "SELECT tablespace_name FROM dba_tablespaces WHERE contents = 'TEMPORARY';",
      "SELECT tablespace_name FROM dba_tablespaces WHERE contents = 'UNDO';",
      'SELECT * FROM v$tablespace;',
      'SELECT ts#, name, included_in_database_backup FROM v$tablespace ORDER BY ts#;',
      "SELECT tablespace_name FROM dba_tablespaces WHERE status = 'READ ONLY';",
      "SELECT tablespace_name FROM dba_tablespaces WHERE status = 'OFFLINE';",
      'SELECT COUNT(*) FROM dba_tablespaces;',

      // ── 4. usage / free space ────────────────────────────────────
      { section: 'space usage', cmd: "SELECT tablespace_name, ROUND(SUM(bytes)/1024/1024, 2) AS mb_used FROM dba_segments GROUP BY tablespace_name ORDER BY mb_used DESC;" },
      "SELECT tablespace_name, ROUND(SUM(bytes)/1024/1024, 2) AS free_mb FROM dba_free_space GROUP BY tablespace_name ORDER BY free_mb DESC;",
      "SELECT tablespace_name, COUNT(*) AS free_extents, MAX(bytes)/1024/1024 AS max_free_mb FROM dba_free_space GROUP BY tablespace_name;",
      "SELECT a.tablespace_name, ROUND(a.bytes_used/1024/1024, 2) AS mb_used, ROUND(b.bytes_free/1024/1024, 2) AS mb_free FROM (SELECT tablespace_name, SUM(bytes) bytes_used FROM dba_segments GROUP BY tablespace_name) a JOIN (SELECT tablespace_name, SUM(bytes) bytes_free FROM dba_free_space GROUP BY tablespace_name) b ON a.tablespace_name = b.tablespace_name;",
      "SELECT * FROM dba_data_files ORDER BY tablespace_name;",
      "SELECT * FROM dba_temp_files;",
      'SELECT * FROM v$temp_extent_map;',
      'SELECT * FROM v$temp_extent_pool;',
      'SELECT * FROM v$tempseg_usage;',
      'SELECT * FROM v$sort_segment;',

      // ── 5. extents et segments ────────────────────────────────────
      { section: 'extents + segments', cmd: 'SELECT * FROM dba_extents WHERE rownum < 30;' },
      "SELECT owner, segment_name, segment_type, tablespace_name, bytes/1024/1024 AS mb, blocks, extents FROM dba_segments WHERE owner = 'HR' ORDER BY bytes DESC;",
      "SELECT segment_type, COUNT(*) AS count, ROUND(SUM(bytes)/1024/1024, 2) AS total_mb FROM dba_segments GROUP BY segment_type ORDER BY total_mb DESC;",
      'SELECT * FROM dba_segments ORDER BY bytes DESC FETCH FIRST 30 ROWS ONLY;',
      "SELECT owner, segment_name, partition_name, segment_type, tablespace_name FROM dba_segments WHERE partition_name IS NOT NULL;",
      "SELECT * FROM dba_extents WHERE owner = 'HR' AND segment_name = 'EMPLOYEES';",

      // ── 6. ORADATA layout ─────────────────────────────────────────
      { section: 'ORADATA layout', cmd: "HOST ls -la /u01/app/oracle/oradata/ORCL/" },
      "HOST ls -la /u01/app/oracle/oradata/ORCL/system01.dbf",
      "HOST du -sh /u01/app/oracle/oradata/ORCL/",
      "HOST df -h /u01/",
      "HOST mount | grep oracle",
      "HOST find /u01/app/oracle -name '*.dbf' -type f 2>/dev/null",
      "HOST find /u01/app/oracle -name '*.ctl' -type f 2>/dev/null",
      "HOST find /u01/app/oracle -name '*.log' -type f 2>/dev/null",
      "HOST find /u01/app/oracle -name '*.arc' -type f 2>/dev/null",
      "HOST ls /u01/app/oracle/admin/ORCL/",
      "HOST ls /u01/app/oracle/admin/ORCL/adump/",
      "HOST ls /u01/app/oracle/diag/rdbms/orcl/orcl/trace/",
      "HOST ls /u01/app/oracle/diag/rdbms/orcl/orcl/alert/",
      "HOST cat /u01/app/oracle/diag/rdbms/orcl/orcl/trace/alert_ORCL.log | tail -50",

      // ── 7. CREATE TABLESPACE — variantes ─────────────────────────
      { section: 'CREATE TABLESPACE', cmd:
        "CREATE TABLESPACE app_data DATAFILE '/u01/oradata/ORCL/app_data01.dbf' SIZE 100M AUTOEXTEND ON NEXT 50M MAXSIZE 1G EXTENT MANAGEMENT LOCAL SEGMENT SPACE MANAGEMENT AUTO;" },
      "CREATE TABLESPACE app_idx DATAFILE '/u01/oradata/ORCL/app_idx01.dbf' SIZE 200M AUTOEXTEND OFF;",
      "CREATE TABLESPACE archive_data DATAFILE '/u01/oradata/ORCL/archive01.dbf' SIZE 500M REUSE;",
      "CREATE TABLESPACE staging DATAFILE SIZE 50M;",
      "CREATE TABLESPACE multi_df DATAFILE '/u01/oradata/ORCL/multi01.dbf' SIZE 100M, '/u01/oradata/ORCL/multi02.dbf' SIZE 100M;",
      "CREATE BIGFILE TABLESPACE big_ts DATAFILE '/u01/oradata/ORCL/big01.dbf' SIZE 1G AUTOEXTEND ON MAXSIZE 32G;",
      "CREATE TEMPORARY TABLESPACE temp_data TEMPFILE '/u01/oradata/ORCL/temp_data01.dbf' SIZE 100M EXTENT MANAGEMENT LOCAL UNIFORM SIZE 1M;",
      "CREATE TEMPORARY TABLESPACE tgroup1 TEMPFILE '/u01/oradata/ORCL/tgroup1.dbf' SIZE 50M;",
      "CREATE UNDO TABLESPACE undotbs3 DATAFILE '/u01/oradata/ORCL/undotbs03.dbf' SIZE 100M;",
      "CREATE TABLESPACE encrypted_ts DATAFILE '/u01/oradata/ORCL/enc01.dbf' SIZE 100M ENCRYPTION USING 'AES256' DEFAULT STORAGE (ENCRYPT);",

      // ── 8. ALTER TABLESPACE ──────────────────────────────────────
      { section: 'ALTER TABLESPACE', cmd:
        "ALTER TABLESPACE app_data ADD DATAFILE '/u01/oradata/ORCL/app_data02.dbf' SIZE 100M;" },
      "ALTER TABLESPACE app_data ADD DATAFILE '/u01/oradata/ORCL/app_data03.dbf' SIZE 100M AUTOEXTEND ON;",
      "ALTER DATABASE DATAFILE '/u01/oradata/ORCL/app_data01.dbf' AUTOEXTEND ON NEXT 50M MAXSIZE UNLIMITED;",
      "ALTER DATABASE DATAFILE '/u01/oradata/ORCL/app_data01.dbf' RESIZE 200M;",
      "ALTER TABLESPACE app_data OFFLINE NORMAL;",
      "ALTER TABLESPACE app_data ONLINE;",
      "ALTER TABLESPACE app_data OFFLINE TEMPORARY;",
      "ALTER TABLESPACE app_data OFFLINE IMMEDIATE;",
      "ALTER TABLESPACE app_data ONLINE;",
      "ALTER TABLESPACE app_data READ ONLY;",
      "ALTER TABLESPACE app_data READ WRITE;",
      "ALTER TABLESPACE app_data RENAME TO app_data_v2;",
      "ALTER TABLESPACE app_data_v2 RENAME TO app_data;",
      "ALTER TABLESPACE app_data BEGIN BACKUP;",
      "ALTER TABLESPACE app_data END BACKUP;",
      "ALTER DATABASE BEGIN BACKUP;",
      "ALTER DATABASE END BACKUP;",
      "ALTER TABLESPACE app_data SHRINK SPACE;",
      "ALTER TABLESPACE app_data COALESCE;",
      "ALTER TABLESPACE app_data FLASHBACK OFF;",
      "ALTER TABLESPACE app_data FLASHBACK ON;",
      "ALTER TABLESPACE app_data LOGGING;",
      "ALTER TABLESPACE app_data NOLOGGING;",
      "ALTER TABLESPACE app_data FORCE LOGGING;",
      "ALTER TABLESPACE app_data NO FORCE LOGGING;",
      "ALTER DATABASE DEFAULT TABLESPACE users;",
      "ALTER DATABASE DEFAULT TEMPORARY TABLESPACE temp;",

      // ── 9. RENAME / déplacement de datafiles ─────────────────────
      { section: 'rename datafiles', cmd:
        "ALTER DATABASE RENAME FILE '/u01/oradata/ORCL/app_data01.dbf' TO '/u02/oradata/ORCL/app_data01.dbf';" },
      "ALTER DATABASE MOVE DATAFILE '/u01/oradata/ORCL/app_idx01.dbf' TO '/u02/oradata/ORCL/app_idx01.dbf';",
      "ALTER DATABASE MOVE DATAFILE '/u01/oradata/ORCL/users01.dbf' KEEP;",
      "ALTER DATABASE MOVE DATAFILE '/u01/oradata/ORCL/users01.dbf' REUSE;",
      "ALTER TABLESPACE app_data RENAME DATAFILE '/u02/oradata/ORCL/app_data01.dbf' TO '/u01/oradata/ORCL/app_data01.dbf';",

      // ── 10. DROP TABLESPACE ───────────────────────────────────────
      { section: 'DROP TABLESPACE', cmd: 'DROP TABLESPACE staging;' },
      'DROP TABLESPACE app_idx INCLUDING CONTENTS;',
      'DROP TABLESPACE archive_data INCLUDING CONTENTS AND DATAFILES;',
      'DROP TABLESPACE multi_df INCLUDING CONTENTS AND DATAFILES CASCADE CONSTRAINTS;',
      'DROP TABLESPACE undotbs3 INCLUDING CONTENTS AND DATAFILES;',
      'DROP TABLESPACE temp_data INCLUDING CONTENTS AND DATAFILES;',
      'DROP TABLESPACE big_ts INCLUDING CONTENTS AND DATAFILES;',
      'DROP TABLESPACE encrypted_ts INCLUDING CONTENTS AND DATAFILES;',
      'DROP TABLESPACE tgroup1 INCLUDING CONTENTS AND DATAFILES;',

      // ── 11. ASM diskgroups (if applicable) ───────────────────────
      { section: 'ASM', cmd: 'SELECT * FROM v$asm_diskgroup;' },
      'SELECT * FROM v$asm_disk;',
      'SELECT * FROM v$asm_file;',
      'SELECT * FROM v$asm_client;',
      'SELECT * FROM v$asm_template;',
      'SELECT * FROM v$asm_alias;',
      "SELECT name, type, total_mb, free_mb FROM v$asm_diskgroup;",
      "ALTER DISKGROUP DATA ADD DISK '/dev/oracleasm/disks/DISK1';",
      "ALTER DISKGROUP DATA REBALANCE POWER 5;",

      // ── 12. flash recovery area ─────────────────────────────────
      { section: 'flash recovery area', cmd: 'SELECT * FROM v$recovery_file_dest;' },
      'SELECT * FROM v$recovery_area_usage;',
      'SELECT * FROM v$flash_recovery_area_usage;',
      "ALTER SYSTEM SET db_recovery_file_dest_size=4G SCOPE=BOTH;",
      "ALTER SYSTEM SET db_recovery_file_dest='/u01/app/oracle/flash_recovery_area' SCOPE=BOTH;",
      "SHOW PARAMETER db_recovery;",

      // ── 13. file integrity checks ────────────────────────────────
      { section: 'integrity checks', cmd: 'SELECT * FROM v$database_block_corruption;' },
      'SELECT * FROM v$datafile_header WHERE error IS NOT NULL;',
      'SELECT * FROM v$copy_corruption;',
      'SELECT * FROM v$backup_corruption;',
      'SELECT * FROM v$nonlogged_block;',
      'SELECT * FROM v$datafile WHERE name LIKE \'%MISSING%\';',
      "SELECT * FROM v$tablespace_thread WHERE rownum < 30;",

      // ── 14. block usage / fragmentation ──────────────────────────
      { section: 'block usage', cmd: 'SELECT * FROM dba_segments WHERE tablespace_name = \'USERS\' ORDER BY bytes DESC FETCH FIRST 10 ROWS ONLY;' },
      "SELECT * FROM dba_extents WHERE tablespace_name = 'USERS' AND rownum < 30;",
      "SELECT * FROM dba_free_space WHERE tablespace_name = 'USERS';",
      "SELECT owner, table_name, num_rows, blocks, empty_blocks, avg_space FROM dba_tables WHERE owner = 'HR' AND num_rows IS NOT NULL;",
      "SELECT owner, segment_name, blocks - empty_blocks AS used_blocks, blocks AS total_blocks FROM dba_segments WHERE owner = 'HR' AND segment_type = 'TABLE' AND rownum < 20;",

      // ── 15. file I/O statistics ─────────────────────────────────
      { section: 'file I/O statistics', cmd: 'SELECT * FROM v$filestat ORDER BY phyrds DESC;' },
      "SELECT df.name, fs.phyrds, fs.phywrts, fs.readtim, fs.writetim FROM v$filestat fs JOIN v$datafile df ON df.file# = fs.file# ORDER BY fs.phyrds DESC;",
      "SELECT * FROM v$tempstat;",
      "SELECT * FROM v$filespace_usage;",
      "SELECT * FROM v$iostat_file ORDER BY total_io DESC FETCH FIRST 30 ROWS ONLY;",
      "SELECT * FROM v$iostat_function;",
      "SELECT * FROM v$iostat_consumer_group;",
      "SELECT * FROM v$iostat_network;",
      "SELECT name, value FROM v$sysstat WHERE name LIKE 'physical%' ORDER BY name;",

      // ── 16. cross-validation ────────────────────────────────────
      { section: 'cross-validate', cmd:
        "SELECT df.file_id, df.file_name, df.tablespace_name, ts.contents FROM dba_data_files df JOIN dba_tablespaces ts ON df.tablespace_name = ts.tablespace_name ORDER BY df.file_id;" },
      "SELECT 'datafiles=' || (SELECT COUNT(*) FROM dba_data_files) || ', v$datafile=' || (SELECT COUNT(*) FROM v$datafile) AS comparison FROM dual;",
      "SELECT 'tempfiles=' || (SELECT COUNT(*) FROM dba_temp_files) || ', v$tempfile=' || (SELECT COUNT(*) FROM v$tempfile) AS comparison FROM dual;",
      "SELECT 'redo=' || (SELECT COUNT(*) FROM v$logfile) || ', v$log=' || (SELECT COUNT(*) FROM v$log) AS comparison FROM dual;",
      "SELECT 'controlfiles=' || (SELECT COUNT(*) FROM v$controlfile) FROM dual;",

      // ── 17. host filesystem snapshot ────────────────────────────
      { section: 'host filesystem snapshot', cmd: 'HOST df -h' },
      'HOST df -h /u01/app/oracle/',
      'HOST df -h /u01/app/oracle/oradata/',
      'HOST df -h /u01/app/oracle/flash_recovery_area/',
      'HOST df -i /u01/',
      "HOST find /u01 -size +100M -type f 2>/dev/null | head -20",
      "HOST find /u01 -mtime -1 -type f 2>/dev/null | head -20",
      "HOST stat /u01/app/oracle/oradata/ORCL/system01.dbf 2>/dev/null",
      "HOST ls -lh /u01/app/oracle/oradata/ORCL/",
      "HOST ls -lh /u01/app/oracle/flash_recovery_area/ORCL/",

      // ── 18. parameter / spfile coherence ────────────────────────
      { section: 'spfile coherence', cmd: 'SELECT * FROM v$parameter ORDER BY name FETCH FIRST 50 ROWS ONLY;' },
      "SELECT name, value, isdefault, ismodified FROM v$parameter WHERE ismodified != 'FALSE' ORDER BY name;",
      "SELECT * FROM v$spparameter ORDER BY name FETCH FIRST 50 ROWS ONLY;",
      "SELECT name, value FROM v$parameter WHERE value LIKE '%/u01/%' OR value LIKE '%/u02/%';",
      "SELECT * FROM v$pwfile_users;",
      "CREATE PFILE FROM SPFILE;",
      "CREATE PFILE='/tmp/pfile.ora' FROM SPFILE;",
      "CREATE SPFILE FROM PFILE='/tmp/pfile.ora';",
      "CREATE SPFILE FROM MEMORY;",

      // ── 19. summary ─────────────────────────────────────────────
      { section: 'summary', cmd: 'SELECT instance_name, host_name, version, status FROM v$instance;' },
      'SELECT name, dbid, open_mode, log_mode FROM v$database;',
      "SELECT 'datafiles=' || (SELECT COUNT(*) FROM dba_data_files) || ', tempfiles=' || (SELECT COUNT(*) FROM dba_temp_files) || ', tablespaces=' || (SELECT COUNT(*) FROM dba_tablespaces) AS summary FROM dual;",
      ...monitoringSweep('filesystem-coherence'),
      'EXIT;',
    ];

    runOracleDump('oracle-filesystem-coherence',
      'LinuxServer ora-fs — Oracle ORCL OPEN', lines, runner);
    runner.dispose();
    removeOracleDatabase(srv.id);
  });
});
