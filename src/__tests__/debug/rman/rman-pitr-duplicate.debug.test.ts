/**
 * Debug run — Point-in-Time Recovery + DUPLICATE DATABASE.
 *
 * Topology:
 *   ┌──────────────────────────────────────────┐
 *   │  LinuxServer (db-pitr)                   │
 *   │  10.20.0.5  Oracle 19c PITRDB            │
 *   │  Walked through OPEN → MOUNT → restore   │
 *   │  cycles to exercise the state guards.    │
 *   └──────────────────────────────────────────┘
 *
 * Each scenario drives the instance through Oracle's lifecycle
 * (SHUTDOWN → MOUNT → OPEN), seeds backups, simulates a failure,
 * and walks the canonical PITR / DUPLICATE recipe.
 *
 * Transcript → debug-output/rman/rman-pitr-duplicate_results_debug.txt
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

describe('debug — PITR + DUPLICATE on db-pitr', () => {
  it('walks SHUTDOWN/MOUNT/OPEN around restore + duplicate flows', () => {
    const srv = new LinuxServer('linux-server', 'db-pitr', 200, 200);
    const db  = getOracleDatabase(srv.id);
    const runner = createRmanRunner(srv);

    // Note: we *do not* dispose the runner between sections — the same
    // RMAN session sees the Oracle instance flip state via the
    // OracleInstanceWatcherActor, so the transcript shows how the
    // runtime actually behaves end-to-end.

    const lines: RmanDebugLine[] = [
      // ── Section 1: connect against OPEN ────────────────────────────
      { section: '1.1 baseline OPEN', cmd: 'CONNECT TARGET /' },
      'REPORT SCHEMA',
      'SHOW ALL',
      'BACKUP DATABASE',
      "BACKUP DATABASE TAG 'BL_OPEN_001'",
      'BACKUP ARCHIVELOG ALL',
      'BACKUP CURRENT CONTROLFILE',
      'LIST BACKUP SUMMARY',

      // ── Section 2: restore against OPEN should reject ──────────────
      { section: '1.2 RESTORE against OPEN (should fail)', cmd: 'RESTORE DATABASE' },
      'RESTORE TABLESPACE USERS',
      'RESTORE DATAFILE 1',
      'RESTORE DATAFILE 4',
      "RESTORE DATABASE FROM TAG 'BL_OPEN_001'",
      'RESTORE DATABASE PREVIEW',
      'RESTORE DATABASE VALIDATE',

      // ── Section 3: simulate failure → SHUTDOWN ────────────────────
      { section: '2.1 SHUTDOWN simulated', cmd: 'SHOW ALL' },
      'BACKUP DATABASE',  // last attempt before we tear it down externally
    ];

    // Replay phase 1 (sections 1-3) first.
    runRmanDump(
      'rman-pitr-duplicate-phase1',
      'LinuxServer db-pitr — Oracle PITRDB OPEN baseline',
      lines,
      runner,
    );

    // ── External state change: SHUTDOWN the live Oracle ─────────────
    db.instance.shutdown('IMMEDIATE');

    const phase2: RmanDebugLine[] = [
      { section: '2.2 after shutdown — every verb against SHUTDOWN', cmd: 'CONNECT TARGET /' },
      'SHOW ALL',
      'REPORT SCHEMA',
      'BACKUP DATABASE',
      'RESTORE DATABASE',
      'RECOVER DATABASE',
      'LIST BACKUP',
    ];

    runRmanDump(
      'rman-pitr-duplicate-phase2',
      'db-pitr — Oracle PITRDB SHUTDOWN (session should auto-dispose)',
      phase2,
      runner,
    );

    // Build a fresh runner now that the original was disposed by the
    // OracleInstanceWatcherActor.
    db.instance.startup('MOUNT');
    const runner3 = createRmanRunner(srv);

    const phase3: RmanDebugLine[] = [
      // ── Section 4: instance in MOUNT — restore + recover flow ──────
      { section: '3.1 MOUNT baseline', cmd: 'CONNECT TARGET /' },
      'SHOW ALL',
      'LIST BACKUP SUMMARY',
      'REPORT SCHEMA',

      // ── Section 5: restore variants ────────────────────────────────
      { section: '3.2 RESTORE — full', cmd: 'RESTORE DATABASE' },
      'RESTORE TABLESPACE USERS',
      'RESTORE TABLESPACE SYSTEM',
      'RESTORE TABLESPACE SYSAUX',
      'RESTORE TABLESPACE UNDOTBS1',
      'RESTORE DATAFILE 1',
      'RESTORE DATAFILE 2',
      'RESTORE DATAFILE 3',
      'RESTORE DATAFILE 4',
      "RESTORE DATABASE FROM TAG 'BL_OPEN_001'",
      "RESTORE DATABASE FROM TAG 'NON_EXISTENT'",
      'RESTORE DATABASE PREVIEW',
      'RESTORE DATABASE VALIDATE',
      'RESTORE TABLESPACE USERS PREVIEW',
      'RESTORE TABLESPACE USERS VALIDATE',
      'RESTORE DATAFILE 1 PREVIEW',
      'RESTORE DATAFILE 4 VALIDATE',

      // ── Section 6: recover variants ────────────────────────────────
      { section: '3.3 RECOVER — variants', cmd: 'RECOVER DATABASE' },
      'RECOVER DATABASE UNTIL SCN 1900000',
      'RECOVER DATABASE UNTIL SCN 1500000',
      "RECOVER DATABASE UNTIL TIME '2026-01-01 00:00:00'",
      "RECOVER DATABASE UNTIL TIME '2026-06-15 12:30:00'",
      'RECOVER DATABASE UNTIL CANCEL',
      'RECOVER TABLESPACE USERS',
      'RECOVER TABLESPACE SYSTEM',
      'RECOVER TABLESPACE SYSAUX',
      'RECOVER DATAFILE 1',
      'RECOVER DATAFILE 4',

      // ── Section 7: SET UNTIL + multi-step RUN ──────────────────────
      { section: '3.4 SET UNTIL inside RUN', cmd:
        "RUN { SET UNTIL TIME '2026-12-31 23:59:00'; RESTORE DATABASE; RECOVER DATABASE; }" },
      'RUN { SET UNTIL SCN 1800000; RESTORE DATABASE; RECOVER DATABASE; }',
      'RUN { SET UNTIL SCN 1900000; RESTORE DATABASE; RECOVER DATABASE; }',
      "RUN { SET UNTIL TIME '2025-06-01 00:00:00'; RESTORE DATABASE PREVIEW; RECOVER DATABASE; }",
      "RUN { SET UNTIL TIME '2025-06-01 00:00:00'; RESTORE TABLESPACE USERS; RECOVER TABLESPACE USERS; }",

      // ── Section 8: SET NEWNAME (datafile move) ─────────────────────
      { section: '3.5 SET NEWNAME', cmd:
        "RUN { SET NEWNAME FOR DATAFILE 1 TO '/u02/oradata/system01.dbf'; RESTORE DATABASE; }" },
      "RUN { SET NEWNAME FOR DATAFILE 1 TO '/u02/oradata/system01.dbf'; SET NEWNAME FOR DATAFILE 4 TO '/u02/oradata/users01.dbf'; RESTORE DATABASE; }",
      "RUN { SET NEWNAME FOR DATAFILE 4 TO '/u02/oradata/users01.dbf'; RESTORE TABLESPACE USERS; SWITCH DATAFILE ALL; }",
      "RUN { SET NEWNAME FOR DATAFILE 3 TO '/u02/oradata/undotbs01.dbf'; RESTORE TABLESPACE UNDOTBS1; SWITCH DATAFILE 3; }",

      // ── Section 9: BLOCKRECOVER ────────────────────────────────────
      { section: '3.6 BLOCKRECOVER', cmd: 'BLOCKRECOVER DATAFILE 1 BLOCK 1234' },
      'BLOCKRECOVER DATAFILE 4 BLOCK 5678',
      'BLOCKRECOVER CORRUPTION LIST',
      'RECOVER COPY OF DATABASE',
      'RECOVER COPY OF DATAFILE 1',

      // ── Section 10: CONNECT AUXILIARY + DUPLICATE ──────────────────
      { section: '4.1 DUPLICATE setup', cmd: 'CONNECT AUXILIARY /' },
      'CONNECT AUXILIARY sys/manager@DUP1',
      'CONNECT AUXILIARY sys/manager@//10.20.0.99:1521/DUP1',

      { section: '4.2 DUPLICATE — simple', cmd: 'DUPLICATE TARGET DATABASE TO DUP1' },
      'DUPLICATE DATABASE TO DUP1',
      'DUPLICATE TARGET DATABASE TO STBY',
      'DUPLICATE DATABASE TO STBY',
      "DUPLICATE TARGET DATABASE TO DUP2 UNTIL TIME '2026-01-01 00:00:00'",
      'DUPLICATE TARGET DATABASE TO DUP3 UNTIL SCN 1900000',

      // ── Section 11: DUPLICATE with options ─────────────────────────
      { section: '4.3 DUPLICATE — advanced', cmd:
        "DUPLICATE TARGET DATABASE TO DUP4 SPFILE PARAMETER_VALUE_CONVERT '/u01/','/u02/'" },
      "DUPLICATE TARGET DATABASE TO STBY FOR STANDBY FROM ACTIVE DATABASE",
      'DUPLICATE TARGET DATABASE TO STBY FOR STANDBY',
      "DUPLICATE TARGET DATABASE TO DUP5 NOFILENAMECHECK",
      'DUPLICATE TARGET DATABASE TO DUP6 SKIP READONLY',
      'DUPLICATE TARGET DATABASE TO DUP7 SKIP TABLESPACE TEMP',

      // ── Section 12: DUPLICATE RUN block ────────────────────────────
      { section: '4.4 DUPLICATE RUN', cmd:
        "RUN { ALLOCATE CHANNEL c1 DEVICE TYPE DISK; ALLOCATE AUXILIARY CHANNEL aux1 DEVICE TYPE DISK; DUPLICATE TARGET DATABASE TO DUP_RUN; RELEASE CHANNEL c1; RELEASE CHANNEL aux1; }" },

      // ── Section 13: post-restore — open RESETLOGS ──────────────────
      { section: '5.1 post-restore', cmd: 'ALTER DATABASE OPEN RESETLOGS' },
      'SQL "ALTER DATABASE OPEN RESETLOGS"',
      'LIST INCARNATION OF DATABASE',
      "RESET DATABASE TO INCARNATION 2",
      'LIST INCARNATION',

      // ── Section 14: post-restore — re-baseline ─────────────────────
      { section: '5.2 re-baseline', cmd: "BACKUP DATABASE TAG 'POST_RESET'" },
      "BACKUP INCREMENTAL LEVEL 0 DATABASE TAG 'POST_RESET_L0'",
      "BACKUP ARCHIVELOG ALL DELETE INPUT TAG 'POST_RESET_ARC'",
      'LIST INCARNATION OF DATABASE',
      'LIST BACKUP SUMMARY',
    ];

    runRmanDump(
      'rman-pitr-duplicate-phase3',
      'db-pitr — Oracle PITRDB MOUNT (PITR + DUPLICATE scenarios)',
      phase3,
      runner3,
    );

    // Restart in OPEN for the closing phase.
    runner3.dispose();
    db.instance.shutdown('IMMEDIATE');
    db.instance.startup();
    const runner4 = createRmanRunner(srv);

    const phase4: RmanDebugLine[] = [
      // ── Section 15: closing — back to OPEN ─────────────────────────
      { section: '6.1 OPEN — closing flow', cmd: 'CONNECT TARGET /' },
      'SHOW ALL',
      'LIST BACKUP SUMMARY',
      'LIST INCARNATION OF DATABASE',
      'REPORT SCHEMA',
      'REPORT OBSOLETE',
      'CROSSCHECK BACKUP',
      'CROSSCHECK ARCHIVELOG ALL',
      'DELETE NOPROMPT OBSOLETE',
      'DELETE NOPROMPT EXPIRED BACKUP',
      "BACKUP DATABASE TAG 'CLOSE_001'",
      "BACKUP DATABASE PLUS ARCHIVELOG DELETE INPUT TAG 'CLOSE_002'",
      "BACKUP INCREMENTAL LEVEL 0 DATABASE TAG 'CLOSE_L0'",
      "BACKUP INCREMENTAL LEVEL 1 DATABASE TAG 'CLOSE_L1'",
      'BACKUP VALIDATE DATABASE',
      'VALIDATE DATABASE',
      'VALIDATE BACKUPSET 1',
      'VALIDATE BACKUPSET 2',
      'VALIDATE BACKUPSET 3',
      'REPORT NEED BACKUP',
      'REPORT UNRECOVERABLE',

      // ── Section 16: final RUN combining everything ─────────────────
      { section: '6.2 master RUN', cmd:
        "RUN { ALLOCATE CHANNEL c1 DEVICE TYPE DISK; ALLOCATE CHANNEL c2 DEVICE TYPE DISK; BACKUP INCREMENTAL LEVEL 0 DATABASE TAG 'FINAL_L0'; BACKUP ARCHIVELOG ALL DELETE INPUT; BACKUP CURRENT CONTROLFILE; RELEASE CHANNEL c2; RELEASE CHANNEL c1; }" },
      "RUN { SET UNTIL TIME '2099-12-31 23:59:59'; RESTORE DATABASE PREVIEW; }",
      "RUN { SET NEWNAME FOR DATAFILE 4 TO '/u03/oradata/users01.dbf'; SET UNTIL SCN 2100000; RESTORE DATAFILE 4; RECOVER DATAFILE 4; SWITCH DATAFILE 4; }",
      "RUN { SET NEWNAME FOR DATAFILE 1 TO '/u03/system01.dbf'; SET NEWNAME FOR DATAFILE 2 TO '/u03/sysaux01.dbf'; SET NEWNAME FOR DATAFILE 3 TO '/u03/undotbs01.dbf'; SET NEWNAME FOR DATAFILE 4 TO '/u03/users01.dbf'; RESTORE DATABASE; SWITCH DATAFILE ALL; }",

      // ── Section 17: closing maintenance ────────────────────────────
      { section: '6.3 closing maintenance', cmd: 'CHANGE BACKUPSET 1 UNAVAILABLE' },
      'CHANGE BACKUPSET 2 UNAVAILABLE',
      'CHANGE BACKUPSET 1 AVAILABLE',
      'CHANGE BACKUPSET 2 AVAILABLE',
      "CHANGE BACKUP TAG 'CLOSE_001' DELETE",
      "CHANGE BACKUP TAG 'CLOSE_002' DELETE",
      "CHANGE BACKUP TAG 'CLOSE_L0' DELETE",
      "CHANGE BACKUP TAG 'CLOSE_L1' DELETE",
      "CHANGE BACKUP TAG 'POST_RESET' DELETE",
      "CHANGE BACKUP TAG 'POST_RESET_L0' DELETE",
      "CHANGE BACKUP TAG 'POST_RESET_ARC' DELETE",
      'LIST BACKUP SUMMARY',
      'REPORT SCHEMA',
      'REPORT NEED BACKUP',
      'REPORT OBSOLETE',
      'REPORT UNRECOVERABLE',
      'LIST INCARNATION OF DATABASE',
      'LIST ARCHIVELOG ALL',
      'LIST OBSOLETE',
      'LIST EXPIRED BACKUP',
      'LIST COPY',
      'SHOW ALL',

      // ── Section 18: stress — many short cycles ─────────────────────
      { section: '7.1 stress cycles', cmd: "BACKUP DATABASE TAG 'STRESS_01'" },
      "BACKUP DATABASE TAG 'STRESS_02'",
      "BACKUP DATABASE TAG 'STRESS_03'",
      "BACKUP DATABASE TAG 'STRESS_04'",
      "BACKUP DATABASE TAG 'STRESS_05'",
      "BACKUP DATABASE TAG 'STRESS_06'",
      "BACKUP DATABASE TAG 'STRESS_07'",
      "BACKUP DATABASE TAG 'STRESS_08'",
      "BACKUP DATABASE TAG 'STRESS_09'",
      "BACKUP DATABASE TAG 'STRESS_10'",
      'BACKUP ARCHIVELOG ALL',
      'BACKUP ARCHIVELOG ALL',
      'BACKUP ARCHIVELOG ALL',
      'BACKUP CURRENT CONTROLFILE',
      'BACKUP CURRENT CONTROLFILE',
      'BACKUP CURRENT CONTROLFILE',
      'BACKUP SPFILE',
      'BACKUP SPFILE',
      'BACKUP VALIDATE DATABASE',
      'VALIDATE DATABASE',
      'CROSSCHECK BACKUP',
      'CROSSCHECK ARCHIVELOG ALL',
      'LIST BACKUP SUMMARY',
      'REPORT NEED BACKUP',
      'REPORT OBSOLETE',
      'CONFIGURE RETENTION POLICY TO REDUNDANCY 1',
      'REPORT OBSOLETE',
      'LIST OBSOLETE',
      'DELETE NOPROMPT OBSOLETE',
      'LIST BACKUP SUMMARY',

      // ── Section 19: stress — RESTORE/RECOVER cycles in MOUNT-ish ──
      { section: '7.2 RESTORE/RECOVER cycles', cmd:
        "RUN { BACKUP DATABASE TAG 'PRE_R1'; RESTORE DATABASE PREVIEW; RECOVER DATABASE; }" },
      "RUN { BACKUP DATABASE TAG 'PRE_R2'; SET UNTIL SCN 2000000; RESTORE DATABASE PREVIEW; RECOVER DATABASE; }",
      "RUN { BACKUP DATABASE TAG 'PRE_R3'; SET UNTIL SCN 1850000; RESTORE DATABASE PREVIEW; RECOVER DATABASE; }",

      // ── Section 20: PITR tag/scn matrix ────────────────────────────
      { section: '7.3 PITR matrix', cmd: 'RUN { SET UNTIL SCN 1700000; RESTORE DATABASE PREVIEW; }' },
      'RUN { SET UNTIL SCN 1750000; RESTORE DATABASE PREVIEW; }',
      'RUN { SET UNTIL SCN 1800000; RESTORE DATABASE PREVIEW; }',
      'RUN { SET UNTIL SCN 1850000; RESTORE DATABASE PREVIEW; }',
      'RUN { SET UNTIL SCN 1900000; RESTORE DATABASE PREVIEW; }',
      'RUN { SET UNTIL SCN 1950000; RESTORE DATABASE PREVIEW; }',
      'RUN { SET UNTIL SCN 2000000; RESTORE DATABASE PREVIEW; }',
      "RUN { SET UNTIL TIME '2025-01-01 00:00:00'; RESTORE DATABASE PREVIEW; }",
      "RUN { SET UNTIL TIME '2025-06-01 00:00:00'; RESTORE DATABASE PREVIEW; }",
      "RUN { SET UNTIL TIME '2026-01-01 00:00:00'; RESTORE DATABASE PREVIEW; }",
      "RUN { SET UNTIL TIME '2026-06-01 00:00:00'; RESTORE DATABASE PREVIEW; }",
      "RUN { SET UNTIL TIME '2027-01-01 00:00:00'; RESTORE DATABASE PREVIEW; }",
      "RUN { SET UNTIL TIME '2027-06-01 00:00:00'; RESTORE DATABASE PREVIEW; }",
      'LIST INCARNATION OF DATABASE',
      'LIST BACKUP SUMMARY',
      'LIST OBSOLETE',
      'REPORT NEED BACKUP',
      'REPORT OBSOLETE',
      'REPORT UNRECOVERABLE',
      'CONFIGURE RETENTION POLICY TO RECOVERY WINDOW OF 60 DAYS',
      'CONFIGURE RETENTION POLICY TO RECOVERY WINDOW OF 90 DAYS',
      'CONFIGURE RETENTION POLICY TO RECOVERY WINDOW OF 1 DAYS',
      'CONFIGURE RETENTION POLICY TO REDUNDANCY 5',
      'CONFIGURE RETENTION POLICY TO REDUNDANCY 1',
      'CROSSCHECK BACKUP',
      'CROSSCHECK ARCHIVELOG ALL',
      'DELETE NOPROMPT OBSOLETE',
      'DELETE NOPROMPT EXPIRED BACKUP',
      'LIST BACKUP SUMMARY',
      'EXIT',
    ];

    runRmanDump(
      'rman-pitr-duplicate-phase4',
      'db-pitr — Oracle PITRDB OPEN closing flow',
      phase4,
      runner4,
    );

    runner4.dispose();
    removeOracleDatabase(srv.id);
  });
});
