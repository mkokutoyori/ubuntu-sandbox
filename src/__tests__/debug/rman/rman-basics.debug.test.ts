/**
 * Debug run — RMAN basics on a single Oracle Linux server.
 *
 * Topology:
 *   ┌──────────────────────────────────────┐
 *   │  LinuxServer (oracle-srv-A)          │
 *   │  10.0.0.10  Oracle 19c DB ORCL OPEN  │
 *   └──────────────────────────────────────┘
 *
 * No network — just a workstation with Oracle installed. The script
 * walks every "entry-level" RMAN verb: CONNECT, SHOW, CONFIGURE,
 * BACKUP variants, LIST, REPORT, CROSSCHECK, DELETE, RESTORE, RECOVER,
 * the RUN block, EXIT.
 *
 * Transcript → debug-output/rman/rman-basics_results_debug.txt
 */

import { describe, it, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { getOracleDatabase, removeOracleDatabase } from '@/terminal/commands/database';
import { createRmanRunner, runRmanDump, type RmanDebugLine } from './_rman-dump';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

describe('debug — rman basics on a single Oracle Linux server', () => {
  it('walks every entry-level RMAN verb on oracle-srv-A', () => {
    const srv = new LinuxServer('linux-server', 'oracle-srv-A', 200, 200);
    // Boot Oracle to OPEN so CONNECT/BACKUP/RESTORE all succeed.
    getOracleDatabase(srv.id);
    const runner = createRmanRunner(srv);

    const lines: RmanDebugLine[] = [
      // ── Section 1: connection + banner ─────────────────────────────
      { section: 'connection + banner', cmd: 'SHOW ALL' },
      'CONNECT TARGET /',
      'SHOW RETENTION POLICY',
      'SHOW DEFAULT DEVICE TYPE',
      'SHOW CONTROLFILE AUTOBACKUP',
      'SHOW CHANNEL',
      'SHOW CHANNEL FOR DEVICE TYPE DISK',
      'HELP',
      'REPORT SCHEMA',
      'LIST BACKUP',
      'LIST BACKUP SUMMARY',
      'LIST ARCHIVELOG ALL',
      'LIST EXPIRED BACKUP',
      'LIST OBSOLETE',
      'LIST COPY',
      'LIST INCARNATION OF DATABASE',

      // ── Section 2: configure persistent settings ───────────────────
      { section: 'CONFIGURE', cmd: 'CONFIGURE RETENTION POLICY TO REDUNDANCY 2' },
      'CONFIGURE RETENTION POLICY TO REDUNDANCY 3',
      'CONFIGURE RETENTION POLICY TO RECOVERY WINDOW OF 7 DAYS',
      'CONFIGURE RETENTION POLICY TO RECOVERY WINDOW OF 14 DAYS',
      'CONFIGURE RETENTION POLICY TO NONE',
      'CONFIGURE RETENTION POLICY TO REDUNDANCY 1',
      'CONFIGURE BACKUP OPTIMIZATION ON',
      'CONFIGURE BACKUP OPTIMIZATION OFF',
      'CONFIGURE DEFAULT DEVICE TYPE TO DISK',
      'CONFIGURE DEFAULT DEVICE TYPE TO SBT',
      'CONFIGURE DEFAULT DEVICE TYPE TO DISK',
      'CONFIGURE CONTROLFILE AUTOBACKUP ON',
      'CONFIGURE CONTROLFILE AUTOBACKUP OFF',
      'CONFIGURE CONTROLFILE AUTOBACKUP ON',
      "CONFIGURE CONTROLFILE AUTOBACKUP FORMAT FOR DEVICE TYPE DISK TO '/u01/backup/cf_%F.bkp'",
      'CONFIGURE DEVICE TYPE DISK PARALLELISM 1 BACKUP TYPE TO BACKUPSET',
      'CONFIGURE DEVICE TYPE DISK PARALLELISM 4 BACKUP TYPE TO BACKUPSET',
      'CONFIGURE DEVICE TYPE DISK PARALLELISM 2 BACKUP TYPE TO BACKUPSET',
      'CONFIGURE DATAFILE BACKUP COPIES FOR DEVICE TYPE DISK TO 1',
      'CONFIGURE DATAFILE BACKUP COPIES FOR DEVICE TYPE DISK TO 2',
      'CONFIGURE ARCHIVELOG BACKUP COPIES FOR DEVICE TYPE DISK TO 1',
      'CONFIGURE MAXSETSIZE TO UNLIMITED',
      'CONFIGURE MAXSETSIZE TO 4G',
      'CONFIGURE ENCRYPTION FOR DATABASE OFF',
      'CONFIGURE ENCRYPTION FOR DATABASE ON',
      "CONFIGURE ENCRYPTION ALGORITHM 'AES256'",
      "CONFIGURE COMPRESSION ALGORITHM 'BASIC'",
      "CONFIGURE COMPRESSION ALGORITHM 'MEDIUM'",
      'CONFIGURE ARCHIVELOG DELETION POLICY TO NONE',
      'CONFIGURE ARCHIVELOG DELETION POLICY TO APPLIED ON ALL STANDBY',
      'SHOW ALL',

      // ── Section 3: full database backup ────────────────────────────
      { section: 'BACKUP DATABASE — full', cmd: 'BACKUP DATABASE' },
      "BACKUP DATABASE TAG 'FULL_001'",
      "BACKUP DATABASE TAG 'FULL_002' FORMAT '/u01/backup/full_%U.bkp'",
      'BACKUP DATABASE COMPRESSED BACKUPSET',
      'BACKUP COMPRESSED BACKUPSET DATABASE',
      'BACKUP DATABASE ENCRYPTED',
      "BACKUP DATABASE KEEP FOREVER",
      "BACKUP DATABASE KEEP UNTIL TIME '2027-01-01'",
      'BACKUP DATABASE MAXPIECESIZE 200M',
      'BACKUP DATABASE MAXPIECESIZE 1G',
      'BACKUP DATABASE PLUS ARCHIVELOG',
      'BACKUP DATABASE PLUS ARCHIVELOG DELETE INPUT',
      "BACKUP DATABASE TAG 'WEEKLY' FORMAT '/u01/backup/%d_%T_%U.bkp' COMPRESSED",
      'BACKUP NOT BACKED UP 1 TIMES DATABASE',
      'BACKUP NOT BACKED UP 10 TIMES DATABASE',
      'LIST BACKUP',
      'LIST BACKUP SUMMARY',

      // ── Section 4: tablespace + datafile + spfile + controlfile ────
      { section: 'BACKUP scoped variants', cmd: 'BACKUP TABLESPACE SYSTEM' },
      'BACKUP TABLESPACE USERS',
      'BACKUP TABLESPACE SYSAUX',
      'BACKUP TABLESPACE UNDOTBS1',
      "BACKUP TABLESPACE USERS TAG 'USERS_HOT'",
      'BACKUP DATAFILE 1',
      'BACKUP DATAFILE 2',
      'BACKUP DATAFILE 3',
      'BACKUP DATAFILE 4',
      "BACKUP DATAFILE 4 TAG 'DF4_AD_HOC'",
      'BACKUP SPFILE',
      "BACKUP SPFILE TAG 'SPFILE_SAVE'",
      'BACKUP CURRENT CONTROLFILE',
      "BACKUP CURRENT CONTROLFILE TAG 'CF_MANUAL'",
      'LIST BACKUP',

      // ── Section 5: incremental + cumulative ────────────────────────
      { section: 'BACKUP incremental', cmd: 'BACKUP INCREMENTAL LEVEL 0 DATABASE' },
      "BACKUP INCREMENTAL LEVEL 0 DATABASE TAG 'L0_BASE'",
      'BACKUP INCREMENTAL LEVEL 1 DATABASE',
      "BACKUP INCREMENTAL LEVEL 1 DATABASE TAG 'DAILY_L1'",
      'BACKUP INCREMENTAL LEVEL 1 CUMULATIVE DATABASE',
      "BACKUP INCREMENTAL LEVEL 1 CUMULATIVE DATABASE TAG 'CUM_L1'",
      "BACKUP INCREMENTAL LEVEL 0 DATABASE TAG 'L0_002'",
      "BACKUP INCREMENTAL LEVEL 1 DATABASE TAG 'L1_002'",
      "BACKUP INCREMENTAL LEVEL 1 DATABASE TAG 'L1_003'",
      'LIST BACKUP SUMMARY',

      // ── Section 6: archivelog backups ──────────────────────────────
      { section: 'BACKUP ARCHIVELOG', cmd: 'BACKUP ARCHIVELOG ALL' },
      'BACKUP ARCHIVELOG ALL DELETE INPUT',
      'BACKUP ARCHIVELOG FROM SCN 1000000',
      'BACKUP ARCHIVELOG FROM SCN 1500000 DELETE INPUT',
      "BACKUP ARCHIVELOG ALL TAG 'ARC_DAILY'",
      'LIST ARCHIVELOG ALL',

      // ── Section 7: validate + crosscheck ───────────────────────────
      { section: 'VALIDATE / CROSSCHECK', cmd: 'BACKUP VALIDATE DATABASE' },
      'VALIDATE DATABASE',
      'VALIDATE TABLESPACE SYSTEM',
      'VALIDATE TABLESPACE USERS',
      'VALIDATE DATAFILE 1',
      'VALIDATE DATAFILE 4',
      'VALIDATE BACKUPSET 1',
      'VALIDATE BACKUPSET 999',
      'CROSSCHECK BACKUP',
      'CROSSCHECK ARCHIVELOG ALL',

      // ── Section 8: catalog (manual registration) ───────────────────
      { section: 'CATALOG', cmd: "CATALOG DATAFILECOPY '/u01/backup/copy_users01.dbf'" },
      "CATALOG DATAFILECOPY '/u01/backup/copy_system01.dbf'",
      "CATALOG BACKUPPIECE '/u01/backup/external_piece_1.bkp'",
      "CATALOG BACKUPPIECE '/u01/backup/external_piece_2.bkp'",
      'LIST COPY',
      'LIST BACKUP',

      // ── Section 9: change / availability ───────────────────────────
      { section: 'CHANGE', cmd: 'CHANGE BACKUPSET 1 UNAVAILABLE' },
      'CHANGE BACKUPSET 2 UNAVAILABLE',
      'CHANGE BACKUPSET 1 AVAILABLE',
      "CHANGE BACKUP TAG 'L1_002' DELETE",
      "CHANGE BACKUP TAG 'NON_EXISTENT' DELETE",
      'LIST BACKUP',

      // ── Section 10: report ─────────────────────────────────────────
      { section: 'REPORT', cmd: 'REPORT SCHEMA' },
      'REPORT NEED BACKUP',
      'REPORT NEED BACKUP REDUNDANCY 2',
      'REPORT NEED BACKUP RECOVERY WINDOW OF 7 DAYS',
      'REPORT OBSOLETE',
      'REPORT OBSOLETE REDUNDANCY 1',
      'REPORT OBSOLETE RECOVERY WINDOW OF 3 DAYS',
      'REPORT UNRECOVERABLE',

      // ── Section 11: delete ─────────────────────────────────────────
      { section: 'DELETE', cmd: 'DELETE NOPROMPT EXPIRED BACKUP' },
      'DELETE NOPROMPT OBSOLETE',
      'DELETE NOPROMPT OBSOLETE REDUNDANCY 1',
      'DELETE NOPROMPT OBSOLETE RECOVERY WINDOW OF 1 DAYS',
      "DELETE NOPROMPT BACKUP TAG 'L0_002'",
      'DELETE NOPROMPT BACKUPSET 3',
      'DELETE NOPROMPT BACKUPSET 999',
      'DELETE NOPROMPT ARCHIVELOG ALL',
      'LIST BACKUP',

      // ── Section 12: RUN blocks (inline) ────────────────────────────
      { section: 'RUN — inline', cmd: 'RUN { BACKUP DATABASE; }' },
      "RUN { BACKUP DATABASE TAG 'RUN_INLINE'; LIST BACKUP SUMMARY; }",
      "RUN { ALLOCATE CHANNEL c1 DEVICE TYPE DISK; BACKUP DATABASE; RELEASE CHANNEL c1; }",
      "RUN { ALLOCATE CHANNEL c1 DEVICE TYPE DISK; ALLOCATE CHANNEL c2 DEVICE TYPE DISK; BACKUP DATABASE; RELEASE CHANNEL c1; RELEASE CHANNEL c2; }",

      // ── Section 13: RUN blocks (multi-line) ────────────────────────
      { section: 'RUN — multi-line', cmd: 'RUN' },
      '{',
      'ALLOCATE CHANNEL c1 DEVICE TYPE DISK;',
      "BACKUP INCREMENTAL LEVEL 0 DATABASE TAG 'WEEKLY_FULL';",
      'BACKUP ARCHIVELOG ALL DELETE INPUT;',
      'RELEASE CHANNEL c1;',
      '}',
      'RUN',
      '{',
      'ALLOCATE CHANNEL c1 DEVICE TYPE DISK;',
      'ALLOCATE CHANNEL c2 DEVICE TYPE DISK;',
      "BACKUP DATABASE TAG 'PARALLEL_2';",
      'RELEASE CHANNEL c1;',
      'RELEASE CHANNEL c2;',
      '}',

      // ── Section 14: explicit channels outside RUN ──────────────────
      { section: 'channel sanity', cmd: 'ALLOCATE CHANNEL c1 DEVICE TYPE DISK' },
      'RELEASE CHANNEL c1',
      'ALLOCATE CHANNEL sbt1 DEVICE TYPE SBT',
      'RELEASE CHANNEL sbt1',
      'ALLOCATE CHANNEL nope DEVICE TYPE TAPE', // expected: syntax error
      'RELEASE CHANNEL nonexistent',

      // ── Section 15: restore (against OPEN — should reject) ─────────
      { section: 'RESTORE — wrong state', cmd: 'RESTORE DATABASE' },
      'RESTORE TABLESPACE USERS',
      'RESTORE DATAFILE 4',
      "RESTORE DATABASE FROM TAG 'FULL_002'",
      'RESTORE DATABASE PREVIEW',
      'RESTORE DATABASE VALIDATE',

      // ── Section 16: recover (OPEN is fine) ─────────────────────────
      { section: 'RECOVER', cmd: 'RECOVER DATABASE' },
      'RECOVER DATABASE UNTIL SCN 2000000',
      "RECOVER DATABASE UNTIL TIME '2026-01-01 00:00:00'",
      'RECOVER DATABASE UNTIL CANCEL',
      'RECOVER TABLESPACE USERS',
      'RECOVER DATAFILE 4',

      // ── Section 17: SET / PITR precursors in RUN ───────────────────
      { section: 'SET UNTIL inside RUN', cmd:
        "RUN { SET UNTIL TIME '2026-06-01 00:00:00'; RESTORE DATABASE PREVIEW; RECOVER DATABASE; }" },
      'RUN { SET UNTIL SCN 1900000; RESTORE DATABASE PREVIEW; RECOVER DATABASE; }',
      "RUN { SET NEWNAME FOR DATAFILE 1 TO '/u01/new/system01.dbf'; RESTORE DATABASE; }",
      "RUN { SET NEWNAME FOR DATAFILE 4 TO '/u01/new/users01.dbf'; RESTORE TABLESPACE USERS; }",

      // ── Section 18: duplicate ──────────────────────────────────────
      { section: 'DUPLICATE', cmd: 'CONNECT AUXILIARY /' },
      'DUPLICATE TARGET DATABASE TO DUP1',
      'DUPLICATE DATABASE TO DUP2',
      'DUPLICATE TARGET DATABASE TO STBYDR',

      // ── Section 19: misc / auxiliary verbs ─────────────────────────
      { section: 'misc / auxiliary verbs', cmd: 'RESYNC CATALOG' },
      'SQL "ALTER SYSTEM SWITCH LOGFILE"',
      'SQL "ALTER DATABASE OPEN RESETLOGS"',
      'PRINT SCRIPT my_script',
      "EXECUTE SCRIPT 'daily_backup'",
      'CREATE SCRIPT daily_backup { BACKUP DATABASE; }',
      'DELETE SCRIPT daily_backup',
      'LIST SCRIPT NAMES',
      'CONFIGURE CHANNEL 1 DEVICE TYPE DISK MAXOPENFILES 16',
      'SHOW CHANNEL',

      // ── Section 20: errors + edge cases ────────────────────────────
      { section: 'edge cases', cmd: 'INVALID COMMAND' },
      'BACKUP',
      'BACKUP TABLESPACE',
      'BACKUP DATAFILE',
      'BACKUP DATAFILE abc',
      'RESTORE',
      'RECOVER UNTIL',
      'CHANGE',
      'CHANGE BACKUPSET',
      'CHANGE BACKUPSET abc UNAVAILABLE',
      'CATALOG',
      "CATALOG DATAFILECOPY",
      "CATALOG BACKUPPIECE '/missing/file.bkp'",  // expected: RMAN-06004
      'SET NEWNAME',
      'SET NEWNAME FOR DATAFILE',
      'SET UNTIL',
      'SET UNTIL TIME',
      'DUPLICATE',
      'DUPLICATE TARGET DATABASE TO',
      'CONFIGURE',
      'CONFIGURE RETENTION POLICY TO REDUNDANCY zero',
      'SHOW INVALID',
      'LIST INVALID',
      'REPORT INVALID',
      'DELETE INVALID',

      // ── Section 21: full lifecycle replay ──────────────────────────
      { section: 'lifecycle replay', cmd: 'SHOW ALL' },
      'LIST BACKUP SUMMARY',
      'LIST OBSOLETE',
      'CROSSCHECK BACKUP',
      'DELETE NOPROMPT OBSOLETE',
      'LIST BACKUP SUMMARY',
      "BACKUP INCREMENTAL LEVEL 1 DATABASE TAG 'CLOSING_L1'",
      'LIST BACKUP SUMMARY',
      'REPORT SCHEMA',
      'REPORT NEED BACKUP',
      'REPORT OBSOLETE',
      'EXIT',
    ];

    runRmanDump(
      'rman-basics',
      'Single LinuxServer oracle-srv-A (10.0.0.10/24) — Oracle ORCL OPEN',
      lines,
      runner,
    );

    runner.dispose();
    removeOracleDatabase(srv.id);
  });
});
