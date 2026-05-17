/**
 * Debug run — incremental backup strategy + retention policy lifecycle.
 *
 * Topology:
 *   ┌──────────────────────────────────────┐
 *   │  LinuxServer (db-prod)               │
 *   │  10.10.0.5  Oracle 19c PRODDB OPEN   │
 *   └──────────────────────────────────────┘
 *
 * Walks a realistic week-long incremental cadence:
 *   - Monday  L0 baseline
 *   - Tue–Sun cumulative + differential L1
 *   - daily archivelog rolloff
 *   - weekly retention sweep
 *   - obsolescence reporting under three policies
 *
 * Transcript → debug-output/rman/rman-incremental-policy_results_debug.txt
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

describe('debug — incremental strategy + retention policy on db-prod', () => {
  it('week-long incremental cadence + policy-driven obsolescence', () => {
    const srv = new LinuxServer('linux-server', 'db-prod', 100, 100);
    getOracleDatabase(srv.id);
    const runner = createRmanRunner(srv);

    const lines: RmanDebugLine[] = [
      // ── Section 1: baseline configuration ──────────────────────────
      { section: 'baseline', cmd: 'CONNECT TARGET /' },
      'SHOW ALL',
      'REPORT SCHEMA',
      'CONFIGURE RETENTION POLICY TO REDUNDANCY 2',
      'CONFIGURE DEFAULT DEVICE TYPE TO DISK',
      'CONFIGURE DEVICE TYPE DISK PARALLELISM 2 BACKUP TYPE TO BACKUPSET',
      'CONFIGURE CONTROLFILE AUTOBACKUP ON',
      'CONFIGURE BACKUP OPTIMIZATION ON',
      "CONFIGURE CHANNEL DEVICE TYPE DISK FORMAT '/u01/backup/%d_%T_%s_%p.bkp'",
      'SHOW ALL',

      // ── Section 2: Monday — L0 baseline ────────────────────────────
      { section: 'Monday — L0 baseline', cmd: 'BACKUP VALIDATE DATABASE' },
      "BACKUP INCREMENTAL LEVEL 0 DATABASE TAG 'MON_L0' FORMAT '/u01/backup/L0_%U.bkp'",
      'LIST BACKUP SUMMARY',
      'LIST BACKUP',
      'BACKUP ARCHIVELOG ALL DELETE INPUT',
      'BACKUP CURRENT CONTROLFILE',
      'REPORT SCHEMA',
      'REPORT NEED BACKUP',

      // ── Section 3: Tuesday — differential L1 ───────────────────────
      { section: 'Tuesday — differential L1', cmd: 'VALIDATE DATABASE' },
      "BACKUP INCREMENTAL LEVEL 1 DATABASE TAG 'TUE_L1_DIFF' FORMAT '/u01/backup/L1_%U.bkp'",
      'BACKUP ARCHIVELOG ALL DELETE INPUT',
      'LIST BACKUP SUMMARY',
      'CROSSCHECK BACKUP',
      'REPORT NEED BACKUP',

      // ── Section 4: Wednesday — cumulative L1 ───────────────────────
      { section: 'Wednesday — cumulative L1', cmd: 'VALIDATE DATABASE' },
      "BACKUP INCREMENTAL LEVEL 1 CUMULATIVE DATABASE TAG 'WED_L1_CUM'",
      'BACKUP ARCHIVELOG ALL DELETE INPUT',
      'LIST BACKUP SUMMARY',
      'REPORT NEED BACKUP',

      // ── Section 5: Thursday — differential L1 + per-tablespace ─────
      { section: 'Thursday — differential L1 + scoped', cmd: 'BACKUP TABLESPACE USERS' },
      "BACKUP TABLESPACE USERS TAG 'TS_USERS_HOT'",
      'BACKUP TABLESPACE SYSAUX',
      "BACKUP INCREMENTAL LEVEL 1 DATABASE TAG 'THU_L1_DIFF'",
      'BACKUP ARCHIVELOG ALL DELETE INPUT',
      'LIST BACKUP SUMMARY',

      // ── Section 6: Friday — cumulative L1 + spfile/cf ──────────────
      { section: 'Friday — cumulative + system files', cmd: 'BACKUP SPFILE' },
      'BACKUP CURRENT CONTROLFILE',
      "BACKUP INCREMENTAL LEVEL 1 CUMULATIVE DATABASE TAG 'FRI_L1_CUM'",
      'BACKUP ARCHIVELOG ALL DELETE INPUT',
      'CROSSCHECK BACKUP',
      'CROSSCHECK ARCHIVELOG ALL',
      'LIST BACKUP SUMMARY',

      // ── Section 7: Saturday — datafile-level + compressed ──────────
      { section: 'Saturday — datafile granularity', cmd: 'BACKUP DATAFILE 1' },
      'BACKUP DATAFILE 2',
      'BACKUP DATAFILE 3',
      'BACKUP DATAFILE 4',
      "BACKUP DATAFILE 4 TAG 'SAT_DF4_HOT'",
      "BACKUP INCREMENTAL LEVEL 1 DATABASE COMPRESSED TAG 'SAT_L1_COMP'",
      'BACKUP COMPRESSED BACKUPSET DATABASE',
      'BACKUP ARCHIVELOG ALL DELETE INPUT',

      // ── Section 8: Sunday — long-term keep + maintenance ───────────
      { section: 'Sunday — KEEP + maintenance', cmd: "BACKUP DATABASE KEEP FOREVER TAG 'SUN_KEEP_FOREVER'" },
      "BACKUP DATABASE KEEP UNTIL TIME '2030-01-01' TAG 'SUN_KEEP_2030'",
      "BACKUP INCREMENTAL LEVEL 1 DATABASE TAG 'SUN_L1_DIFF'",
      'BACKUP ARCHIVELOG ALL DELETE INPUT',
      'LIST BACKUP',
      'LIST BACKUP SUMMARY',

      // ── Section 9: optimisation — NOT BACKED UP n TIMES ────────────
      { section: 'BACKUP NOT BACKED UP', cmd: 'BACKUP NOT BACKED UP 1 TIMES DATABASE' },
      'BACKUP NOT BACKED UP 2 TIMES DATABASE',
      'BACKUP NOT BACKED UP 3 TIMES DATABASE',
      'BACKUP NOT BACKED UP 5 TIMES DATABASE',
      'BACKUP NOT BACKED UP 50 TIMES DATABASE',
      'BACKUP NOT BACKED UP 100 TIMES DATABASE',

      // ── Section 10: retention policy A — REDUNDANCY 1 ─────────────
      { section: 'policy A — REDUNDANCY 1', cmd: 'CONFIGURE RETENTION POLICY TO REDUNDANCY 1' },
      'SHOW RETENTION POLICY',
      'REPORT OBSOLETE',
      'LIST OBSOLETE',
      'CROSSCHECK BACKUP',
      'DELETE NOPROMPT OBSOLETE',
      'LIST BACKUP SUMMARY',
      'REPORT OBSOLETE',

      // ── Section 11: retention policy B — RECOVERY WINDOW 7 DAYS ────
      { section: 'policy B — recovery window 7 days', cmd: 'CONFIGURE RETENTION POLICY TO RECOVERY WINDOW OF 7 DAYS' },
      'SHOW RETENTION POLICY',
      'REPORT OBSOLETE',
      'REPORT OBSOLETE RECOVERY WINDOW OF 7 DAYS',
      'LIST OBSOLETE',
      'DELETE NOPROMPT OBSOLETE',
      'LIST BACKUP SUMMARY',

      // ── Section 12: retention policy C — RECOVERY WINDOW 14 DAYS ──
      { section: 'policy C — recovery window 14 days', cmd: 'CONFIGURE RETENTION POLICY TO RECOVERY WINDOW OF 14 DAYS' },
      'REPORT OBSOLETE',
      'REPORT OBSOLETE RECOVERY WINDOW OF 14 DAYS',
      'LIST OBSOLETE',
      'DELETE NOPROMPT OBSOLETE',
      'LIST BACKUP SUMMARY',

      // ── Section 13: retention policy D — REDUNDANCY 3 ──────────────
      { section: 'policy D — REDUNDANCY 3', cmd: 'CONFIGURE RETENTION POLICY TO REDUNDANCY 3' },
      "BACKUP DATABASE TAG 'EXTRA_1'",
      "BACKUP DATABASE TAG 'EXTRA_2'",
      "BACKUP DATABASE TAG 'EXTRA_3'",
      "BACKUP DATABASE TAG 'EXTRA_4'",
      'REPORT OBSOLETE',
      'REPORT OBSOLETE REDUNDANCY 3',
      'LIST OBSOLETE',
      'DELETE NOPROMPT OBSOLETE',
      'LIST BACKUP SUMMARY',

      // ── Section 14: retention policy E — NONE ──────────────────────
      { section: 'policy E — NONE', cmd: 'CONFIGURE RETENTION POLICY TO NONE' },
      'SHOW RETENTION POLICY',
      'REPORT OBSOLETE',
      'LIST OBSOLETE',
      'DELETE NOPROMPT OBSOLETE',
      'LIST BACKUP SUMMARY',

      // ── Section 15: tag-scoped cleanup ─────────────────────────────
      { section: 'tag-scoped cleanup', cmd: "DELETE NOPROMPT BACKUP TAG 'EXTRA_1'" },
      "DELETE NOPROMPT BACKUP TAG 'EXTRA_2'",
      "DELETE NOPROMPT BACKUP TAG 'EXTRA_3'",
      "DELETE NOPROMPT BACKUP TAG 'EXTRA_4'",
      "DELETE NOPROMPT BACKUP TAG 'MON_L0'",
      "DELETE NOPROMPT BACKUP TAG 'TUE_L1_DIFF'",
      "DELETE NOPROMPT BACKUP TAG 'WED_L1_CUM'",
      "DELETE NOPROMPT BACKUP TAG 'THU_L1_DIFF'",
      "DELETE NOPROMPT BACKUP TAG 'FRI_L1_CUM'",
      "DELETE NOPROMPT BACKUP TAG 'SAT_L1_COMP'",
      "DELETE NOPROMPT BACKUP TAG 'SUN_L1_DIFF'",
      'LIST BACKUP SUMMARY',

      // ── Section 16: bsKey-scoped cleanup ───────────────────────────
      { section: 'bsKey-scoped cleanup', cmd: 'DELETE NOPROMPT BACKUPSET 1' },
      'DELETE NOPROMPT BACKUPSET 2',
      'DELETE NOPROMPT BACKUPSET 3',
      'DELETE NOPROMPT BACKUPSET 4',
      'DELETE NOPROMPT BACKUPSET 5',
      'DELETE NOPROMPT BACKUPSET 99',
      'LIST BACKUP SUMMARY',

      // ── Section 17: re-seed for restore stress ─────────────────────
      { section: 're-seed catalog', cmd: "BACKUP INCREMENTAL LEVEL 0 DATABASE TAG 'RESEED_L0'" },
      "BACKUP INCREMENTAL LEVEL 1 DATABASE TAG 'RESEED_L1_A'",
      "BACKUP INCREMENTAL LEVEL 1 CUMULATIVE DATABASE TAG 'RESEED_L1_CUM'",
      "BACKUP INCREMENTAL LEVEL 1 DATABASE TAG 'RESEED_L1_B'",
      'BACKUP ARCHIVELOG ALL',
      'LIST BACKUP SUMMARY',

      // ── Section 18: change availability + crosscheck loop ──────────
      { section: 'availability sweeps', cmd: 'CHANGE BACKUPSET 1 UNAVAILABLE' },
      'CHANGE BACKUPSET 2 UNAVAILABLE',
      'CHANGE BACKUPSET 3 UNAVAILABLE',
      'CROSSCHECK BACKUP',
      'LIST BACKUP',
      'CHANGE BACKUPSET 1 AVAILABLE',
      'CHANGE BACKUPSET 2 AVAILABLE',
      'CHANGE BACKUPSET 3 AVAILABLE',
      'CROSSCHECK BACKUP',
      'LIST BACKUP',

      // ── Section 19: catalog (external) ─────────────────────────────
      { section: 'catalog external copies', cmd: "CATALOG DATAFILECOPY '/u01/external/system01.dbf'" },
      "CATALOG DATAFILECOPY '/u01/external/users01.dbf'",
      "CATALOG DATAFILECOPY '/u01/external/sysaux01.dbf'",
      "CATALOG DATAFILECOPY '/u01/external/undotbs01.dbf'",
      "CATALOG BACKUPPIECE '/u01/external/bsp_001.bkp'",
      "CATALOG BACKUPPIECE '/u01/external/bsp_002.bkp'",
      "CATALOG BACKUPPIECE '/u01/external/bsp_003.bkp'",
      'LIST COPY',
      'LIST COPY OF DATABASE',
      'LIST COPY OF TABLESPACE USERS',
      'LIST BACKUP SUMMARY',

      // ── Section 20: parallelism stress (RUN blocks) ────────────────
      { section: 'parallelism stress', cmd:
        "RUN { ALLOCATE CHANNEL d1 DEVICE TYPE DISK; ALLOCATE CHANNEL d2 DEVICE TYPE DISK; BACKUP DATABASE TAG 'PAR_2'; RELEASE CHANNEL d1; RELEASE CHANNEL d2; }" },
      "RUN { ALLOCATE CHANNEL d1 DEVICE TYPE DISK; ALLOCATE CHANNEL d2 DEVICE TYPE DISK; ALLOCATE CHANNEL d3 DEVICE TYPE DISK; ALLOCATE CHANNEL d4 DEVICE TYPE DISK; BACKUP DATABASE TAG 'PAR_4'; RELEASE CHANNEL d4; RELEASE CHANNEL d3; RELEASE CHANNEL d2; RELEASE CHANNEL d1; }",
      "RUN { ALLOCATE CHANNEL t1 DEVICE TYPE SBT; BACKUP DATABASE TAG 'TAPE_1'; RELEASE CHANNEL t1; }",
      'CONFIGURE DEVICE TYPE DISK PARALLELISM 4 BACKUP TYPE TO BACKUPSET',
      'SHOW CHANNEL',
      'CONFIGURE DEVICE TYPE DISK PARALLELISM 1 BACKUP TYPE TO BACKUPSET',

      // ── Section 21: maxPieceSize sweep ─────────────────────────────
      { section: 'MAXPIECESIZE sweep', cmd: 'BACKUP DATABASE MAXPIECESIZE 100M' },
      'BACKUP DATABASE MAXPIECESIZE 200M',
      'BACKUP DATABASE MAXPIECESIZE 500M',
      'BACKUP DATABASE MAXPIECESIZE 1G',
      'BACKUP DATABASE MAXPIECESIZE 2G',
      "BACKUP DATABASE MAXPIECESIZE 50M TAG 'MPS_50'",
      "BACKUP DATABASE MAXPIECESIZE 10M TAG 'MPS_SMALL'",
      'LIST BACKUP SUMMARY',

      // ── Section 22: encryption + keep + format combos ──────────────
      { section: 'combo flags', cmd: "BACKUP DATABASE ENCRYPTED TAG 'ENC_1'" },
      "BACKUP DATABASE ENCRYPTED COMPRESSED TAG 'ENC_COMP'",
      "BACKUP DATABASE ENCRYPTED KEEP FOREVER TAG 'ENC_KEEP'",
      "BACKUP COMPRESSED BACKUPSET DATABASE KEEP UNTIL TIME '2030-12-31'",
      "BACKUP DATABASE FORMAT '/u01/secure/%d_%T_%s.enc' ENCRYPTED COMPRESSED MAXPIECESIZE 100M",
      'LIST BACKUP',

      // ── Section 23: archivelog targeted ────────────────────────────
      { section: 'archivelog targeted', cmd: 'BACKUP ARCHIVELOG FROM SCN 100000' },
      'BACKUP ARCHIVELOG FROM SCN 500000',
      'BACKUP ARCHIVELOG FROM SCN 1000000 DELETE INPUT',
      'BACKUP ARCHIVELOG FROM SCN 2000000',
      "BACKUP ARCHIVELOG ALL FORMAT '/u01/arc/%T_%s.arc'",
      "BACKUP ARCHIVELOG ALL DELETE INPUT TAG 'ARC_PURGE'",

      // ── Section 24: final reporting ────────────────────────────────
      { section: 'final reporting', cmd: 'LIST BACKUP' },
      'LIST BACKUP SUMMARY',
      'LIST ARCHIVELOG ALL',
      'LIST EXPIRED BACKUP',
      'LIST OBSOLETE',
      'REPORT SCHEMA',
      'REPORT NEED BACKUP',
      'REPORT NEED BACKUP REDUNDANCY 1',
      'REPORT NEED BACKUP REDUNDANCY 2',
      'REPORT NEED BACKUP REDUNDANCY 3',
      'REPORT NEED BACKUP RECOVERY WINDOW OF 1 DAYS',
      'REPORT NEED BACKUP RECOVERY WINDOW OF 7 DAYS',
      'REPORT NEED BACKUP RECOVERY WINDOW OF 30 DAYS',
      'REPORT OBSOLETE',
      'REPORT OBSOLETE REDUNDANCY 1',
      'REPORT OBSOLETE REDUNDANCY 3',
      'REPORT OBSOLETE RECOVERY WINDOW OF 1 DAYS',
      'REPORT OBSOLETE RECOVERY WINDOW OF 7 DAYS',
      'REPORT UNRECOVERABLE',

      // ── Section 25: closing maintenance burst ──────────────────────
      { section: 'closing maintenance', cmd: 'CROSSCHECK BACKUP' },
      'CROSSCHECK ARCHIVELOG ALL',
      'DELETE NOPROMPT EXPIRED BACKUP',
      'DELETE NOPROMPT OBSOLETE',
      "DELETE NOPROMPT BACKUP TAG 'PAR_2'",
      "DELETE NOPROMPT BACKUP TAG 'PAR_4'",
      "DELETE NOPROMPT BACKUP TAG 'TAPE_1'",
      "DELETE NOPROMPT BACKUP TAG 'ENC_1'",
      "DELETE NOPROMPT BACKUP TAG 'ENC_COMP'",
      "DELETE NOPROMPT BACKUP TAG 'ENC_KEEP'",
      "DELETE NOPROMPT BACKUP TAG 'MPS_50'",
      "DELETE NOPROMPT BACKUP TAG 'MPS_SMALL'",
      'LIST BACKUP SUMMARY',
      'EXIT',
    ];

    runRmanDump(
      'rman-incremental-policy',
      'Single LinuxServer db-prod (10.10.0.5/24) — Oracle PRODDB OPEN',
      lines,
      runner,
    );

    runner.dispose();
    removeOracleDatabase(srv.id);
  });
});
