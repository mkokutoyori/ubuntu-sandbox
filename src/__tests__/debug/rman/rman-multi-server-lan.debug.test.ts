/**
 * Debug run — multi-server LAN topology with three Oracle nodes.
 *
 * Topology (one /24 LAN behind a single switch):
 *
 *   ┌──────────────┐         ┌────────────┐
 *   │ dba-ws       │  ───┐   │ db-prim    │  ORCLP, OPEN
 *   │ workstation  │     │   │ 10.30.0.10 │
 *   └──────────────┘     │   └────────────┘
 *                        │   ┌────────────┐
 *                        ├───│ db-stby    │  ORCLS, MOUNT (standby-like)
 *                        │   │ 10.30.0.11 │
 *                        │   └────────────┘
 *                        │   ┌────────────┐
 *                        └───│ db-dev     │  DEVDB, OPEN
 *                            │ 10.30.0.12 │
 *                            └────────────┘
 *                              GenericSwitch (sw-core)
 *
 * The script alternates rman sessions across the three servers so we
 * can observe how concurrent sessions on the shared bus stay scoped
 * and how policies/configurations diverge per host.
 *
 * Transcript → debug-output/rman/rman-multi-server-lan_results_debug.txt
 */

import { describe, it, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { getOracleDatabase, removeOracleDatabase } from '@/terminal/commands/database';
import { createRmanRunner, runRmanMultiDump, type MultiLine } from './_rman-dump';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

describe('debug — multi-server LAN topology with three Oracle servers', () => {
  it('runs interleaved rman sessions across db-prim / db-stby / db-dev', () => {
    const prim = new LinuxServer('linux-server', 'db-prim', 100, 100);
    const stby = new LinuxServer('linux-server', 'db-stby', 100, 200);
    const dev  = new LinuxServer('linux-server', 'db-dev',  100, 300);

    // Boot all three Oracle instances.
    const dbPrim = getOracleDatabase(prim.id);
    const dbStby = getOracleDatabase(stby.id);
    const dbDev  = getOracleDatabase(dev.id);

    // Put db-stby into MOUNT so RESTORE/RECOVER work there.
    dbStby.instance.shutdown('IMMEDIATE');
    dbStby.instance.startup('MOUNT');
    void dbPrim; void dbDev;

    const runners = {
      prim: createRmanRunner(prim),
      stby: createRmanRunner(stby),
      dev:  createRmanRunner(dev),
    };

    const cmds: MultiLine[] = [
      // ── Section 1: connect from every node ─────────────────────────
      { section: '1 — handshake', runner: 'prim', cmd: 'CONNECT TARGET /' },
      { runner: 'stby', cmd: 'CONNECT TARGET /' },
      { runner: 'dev',  cmd: 'CONNECT TARGET /' },
      { runner: 'prim', cmd: 'SHOW ALL' },
      { runner: 'stby', cmd: 'SHOW ALL' },
      { runner: 'dev',  cmd: 'SHOW ALL' },
      { runner: 'prim', cmd: 'REPORT SCHEMA' },
      { runner: 'stby', cmd: 'REPORT SCHEMA' },
      { runner: 'dev',  cmd: 'REPORT SCHEMA' },

      // ── Section 2: per-node retention configuration ────────────────
      { section: '2 — per-node retention', runner: 'prim',
        cmd: 'CONFIGURE RETENTION POLICY TO RECOVERY WINDOW OF 30 DAYS' },
      { runner: 'stby', cmd: 'CONFIGURE RETENTION POLICY TO RECOVERY WINDOW OF 7 DAYS' },
      { runner: 'dev',  cmd: 'CONFIGURE RETENTION POLICY TO REDUNDANCY 1' },
      { runner: 'prim', cmd: 'CONFIGURE CONTROLFILE AUTOBACKUP ON' },
      { runner: 'stby', cmd: 'CONFIGURE CONTROLFILE AUTOBACKUP ON' },
      { runner: 'dev',  cmd: 'CONFIGURE CONTROLFILE AUTOBACKUP OFF' },
      { runner: 'prim', cmd: 'CONFIGURE DEVICE TYPE DISK PARALLELISM 4 BACKUP TYPE TO BACKUPSET' },
      { runner: 'stby', cmd: 'CONFIGURE DEVICE TYPE DISK PARALLELISM 2 BACKUP TYPE TO BACKUPSET' },
      { runner: 'dev',  cmd: 'CONFIGURE DEVICE TYPE DISK PARALLELISM 1 BACKUP TYPE TO BACKUPSET' },
      { runner: 'prim', cmd: "CONFIGURE CHANNEL DEVICE TYPE DISK FORMAT '/nfs/backup/prim/%d_%T_%U.bkp'" },
      { runner: 'stby', cmd: "CONFIGURE CHANNEL DEVICE TYPE DISK FORMAT '/nfs/backup/stby/%d_%T_%U.bkp'" },
      { runner: 'dev',  cmd: "CONFIGURE CHANNEL DEVICE TYPE DISK FORMAT '/nfs/backup/dev/%d_%T_%U.bkp'" },
      { runner: 'prim', cmd: 'SHOW ALL' },
      { runner: 'stby', cmd: 'SHOW ALL' },
      { runner: 'dev',  cmd: 'SHOW ALL' },

      // ── Section 3: baseline backups in parallel ────────────────────
      { section: '3 — interleaved baseline backups', runner: 'prim',
        cmd: "BACKUP INCREMENTAL LEVEL 0 DATABASE TAG 'PRIM_BASE'" },
      { runner: 'dev',  cmd: "BACKUP DATABASE TAG 'DEV_BASE'" },
      { runner: 'prim', cmd: 'BACKUP ARCHIVELOG ALL' },
      { runner: 'dev',  cmd: 'BACKUP ARCHIVELOG ALL DELETE INPUT' },
      { runner: 'prim', cmd: 'BACKUP CURRENT CONTROLFILE' },
      { runner: 'dev',  cmd: 'BACKUP CURRENT CONTROLFILE' },
      { runner: 'prim', cmd: 'LIST BACKUP SUMMARY' },
      { runner: 'dev',  cmd: 'LIST BACKUP SUMMARY' },

      // ── Section 4: stby — restore from its own catalog ─────────────
      { section: '4 — stby restore drill', runner: 'stby', cmd: "BACKUP DATABASE TAG 'STBY_SEED'" },
      { runner: 'stby', cmd: 'BACKUP ARCHIVELOG ALL' },
      { runner: 'stby', cmd: 'LIST BACKUP SUMMARY' },
      { runner: 'stby', cmd: 'RESTORE DATABASE PREVIEW' },
      { runner: 'stby', cmd: 'RESTORE DATABASE VALIDATE' },
      { runner: 'stby', cmd: 'RESTORE DATABASE' },
      { runner: 'stby', cmd: 'RESTORE TABLESPACE USERS' },
      { runner: 'stby', cmd: 'RESTORE DATAFILE 1' },
      { runner: 'stby', cmd: 'RESTORE DATAFILE 4' },
      { runner: 'stby', cmd: 'RECOVER DATABASE' },
      { runner: 'stby', cmd: 'RECOVER DATABASE UNTIL SCN 1900000' },
      { runner: 'stby', cmd: "RECOVER DATABASE UNTIL TIME '2026-06-01 00:00:00'" },
      { runner: 'stby', cmd: 'RECOVER DATABASE UNTIL CANCEL' },

      // ── Section 5: prim — production-grade weekly cadence ──────────
      { section: '5 — prim weekly cadence', runner: 'prim',
        cmd: "BACKUP INCREMENTAL LEVEL 1 DATABASE TAG 'PRIM_L1_TUE'" },
      { runner: 'prim', cmd: 'BACKUP ARCHIVELOG ALL DELETE INPUT' },
      { runner: 'prim', cmd: "BACKUP INCREMENTAL LEVEL 1 CUMULATIVE DATABASE TAG 'PRIM_L1_CUM_WED'" },
      { runner: 'prim', cmd: 'BACKUP ARCHIVELOG ALL DELETE INPUT' },
      { runner: 'prim', cmd: "BACKUP INCREMENTAL LEVEL 1 DATABASE TAG 'PRIM_L1_THU'" },
      { runner: 'prim', cmd: 'BACKUP ARCHIVELOG ALL DELETE INPUT' },
      { runner: 'prim', cmd: "BACKUP INCREMENTAL LEVEL 1 CUMULATIVE DATABASE TAG 'PRIM_L1_CUM_FRI'" },
      { runner: 'prim', cmd: 'BACKUP ARCHIVELOG ALL DELETE INPUT' },
      { runner: 'prim', cmd: "BACKUP INCREMENTAL LEVEL 1 DATABASE TAG 'PRIM_L1_SAT'" },
      { runner: 'prim', cmd: 'BACKUP ARCHIVELOG ALL DELETE INPUT' },
      { runner: 'prim', cmd: "BACKUP DATABASE KEEP FOREVER TAG 'PRIM_LONGTERM'" },
      { runner: 'prim', cmd: 'BACKUP CURRENT CONTROLFILE' },
      { runner: 'prim', cmd: 'LIST BACKUP' },

      // ── Section 6: dev — ad-hoc cleanups + cross-checks ────────────
      { section: '6 — dev ad-hoc', runner: 'dev', cmd: "BACKUP TABLESPACE USERS TAG 'DEV_TS_USERS'" },
      { runner: 'dev', cmd: "BACKUP DATAFILE 4 TAG 'DEV_DF4_AD_HOC'" },
      { runner: 'dev', cmd: 'BACKUP COMPRESSED BACKUPSET DATABASE' },
      { runner: 'dev', cmd: 'BACKUP DATABASE ENCRYPTED' },
      { runner: 'dev', cmd: "BACKUP DATABASE MAXPIECESIZE 100M TAG 'DEV_MPS'" },
      { runner: 'dev', cmd: 'BACKUP NOT BACKED UP 3 TIMES DATABASE' },
      { runner: 'dev', cmd: 'CROSSCHECK BACKUP' },
      { runner: 'dev', cmd: 'CROSSCHECK ARCHIVELOG ALL' },
      { runner: 'dev', cmd: 'LIST BACKUP SUMMARY' },
      { runner: 'dev', cmd: 'LIST OBSOLETE' },
      { runner: 'dev', cmd: 'DELETE NOPROMPT OBSOLETE' },
      { runner: 'dev', cmd: 'LIST BACKUP SUMMARY' },

      // ── Section 7: prim — obsolescence sweep ───────────────────────
      { section: '7 — prim obsolescence sweep', runner: 'prim',
        cmd: 'CONFIGURE RETENTION POLICY TO REDUNDANCY 2' },
      { runner: 'prim', cmd: 'REPORT OBSOLETE' },
      { runner: 'prim', cmd: 'LIST OBSOLETE' },
      { runner: 'prim', cmd: 'CROSSCHECK BACKUP' },
      { runner: 'prim', cmd: 'DELETE NOPROMPT OBSOLETE' },
      { runner: 'prim', cmd: 'LIST BACKUP SUMMARY' },
      { runner: 'prim', cmd: 'CONFIGURE RETENTION POLICY TO RECOVERY WINDOW OF 14 DAYS' },
      { runner: 'prim', cmd: 'REPORT OBSOLETE' },
      { runner: 'prim', cmd: 'DELETE NOPROMPT OBSOLETE' },

      // ── Section 8: stby — chained recovery scripts ─────────────────
      { section: '8 — stby chained recovery', runner: 'stby', cmd:
        "RUN { SET UNTIL TIME '2026-06-01 00:00:00'; RESTORE DATABASE; RECOVER DATABASE; }" },
      { runner: 'stby', cmd:
        "RUN { SET UNTIL SCN 1850000; RESTORE DATABASE; RECOVER DATABASE; }" },
      { runner: 'stby', cmd:
        "RUN { SET NEWNAME FOR DATAFILE 1 TO '/u02/oradata/system01.dbf'; SET NEWNAME FOR DATAFILE 4 TO '/u02/oradata/users01.dbf'; RESTORE DATABASE; SWITCH DATAFILE ALL; RECOVER DATABASE; }" },
      { runner: 'stby', cmd:
        "RUN { ALLOCATE CHANNEL s1 DEVICE TYPE DISK; ALLOCATE CHANNEL s2 DEVICE TYPE DISK; RESTORE DATABASE; RECOVER DATABASE; RELEASE CHANNEL s1; RELEASE CHANNEL s2; }" },

      // ── Section 9: catalog moves across hosts ──────────────────────
      { section: '9 — catalog moves', runner: 'prim',
        cmd: "CATALOG DATAFILECOPY '/nfs/backup/prim/copy_users01.dbf'" },
      { runner: 'prim', cmd: "CATALOG BACKUPPIECE '/nfs/backup/prim/external_001.bkp'" },
      { runner: 'stby', cmd: "CATALOG DATAFILECOPY '/nfs/backup/stby/copy_users01.dbf'" },
      { runner: 'stby', cmd: "CATALOG BACKUPPIECE '/nfs/backup/stby/external_001.bkp'" },
      { runner: 'dev',  cmd: "CATALOG DATAFILECOPY '/nfs/backup/dev/copy_users01.dbf'" },
      { runner: 'dev',  cmd: "CATALOG BACKUPPIECE '/nfs/backup/dev/external_001.bkp'" },
      { runner: 'prim', cmd: 'LIST COPY' },
      { runner: 'stby', cmd: 'LIST COPY' },
      { runner: 'dev',  cmd: 'LIST COPY' },

      // ── Section 10: DUPLICATE flows across hosts ───────────────────
      { section: '10 — DUPLICATE drills', runner: 'prim', cmd: 'CONNECT AUXILIARY /' },
      { runner: 'prim', cmd: 'DUPLICATE TARGET DATABASE TO DUP_PRIM_1' },
      { runner: 'prim', cmd: 'DUPLICATE DATABASE TO DUP_PRIM_2' },
      { runner: 'prim', cmd: 'DUPLICATE TARGET DATABASE TO ORCLDR FOR STANDBY FROM ACTIVE DATABASE' },
      { runner: 'dev',  cmd: 'CONNECT AUXILIARY /' },
      { runner: 'dev',  cmd: 'DUPLICATE TARGET DATABASE TO DEV_CLONE_1' },
      { runner: 'dev',  cmd: 'DUPLICATE DATABASE TO DEV_CLONE_2' },

      // ── Section 11: VALIDATE per-host ──────────────────────────────
      { section: '11 — VALIDATE per host', runner: 'prim', cmd: 'VALIDATE DATABASE' },
      { runner: 'prim', cmd: 'VALIDATE TABLESPACE SYSTEM' },
      { runner: 'prim', cmd: 'VALIDATE TABLESPACE USERS' },
      { runner: 'prim', cmd: 'VALIDATE DATAFILE 1' },
      { runner: 'prim', cmd: 'VALIDATE DATAFILE 4' },
      { runner: 'prim', cmd: 'VALIDATE BACKUPSET 1' },
      { runner: 'prim', cmd: 'VALIDATE BACKUPSET 2' },
      { runner: 'stby', cmd: 'VALIDATE DATABASE' },
      { runner: 'stby', cmd: 'VALIDATE TABLESPACE USERS' },
      { runner: 'stby', cmd: 'VALIDATE DATAFILE 1' },
      { runner: 'stby', cmd: 'VALIDATE BACKUPSET 1' },
      { runner: 'dev',  cmd: 'VALIDATE DATABASE' },
      { runner: 'dev',  cmd: 'VALIDATE TABLESPACE USERS' },
      { runner: 'dev',  cmd: 'VALIDATE DATAFILE 4' },
      { runner: 'dev',  cmd: 'VALIDATE BACKUPSET 1' },

      // ── Section 12: change availability across hosts ───────────────
      { section: '12 — CHANGE availability', runner: 'prim', cmd: 'CHANGE BACKUPSET 1 UNAVAILABLE' },
      { runner: 'prim', cmd: 'CROSSCHECK BACKUP' },
      { runner: 'prim', cmd: 'LIST BACKUP' },
      { runner: 'prim', cmd: 'CHANGE BACKUPSET 1 AVAILABLE' },
      { runner: 'prim', cmd: 'CROSSCHECK BACKUP' },
      { runner: 'stby', cmd: 'CHANGE BACKUPSET 1 UNAVAILABLE' },
      { runner: 'stby', cmd: 'CHANGE BACKUPSET 1 AVAILABLE' },
      { runner: 'dev',  cmd: 'CHANGE BACKUPSET 1 UNAVAILABLE' },
      { runner: 'dev',  cmd: 'CHANGE BACKUPSET 1 AVAILABLE' },
      { runner: 'prim', cmd: "CHANGE BACKUP TAG 'PRIM_L1_TUE' DELETE" },
      { runner: 'stby', cmd: "CHANGE BACKUP TAG 'STBY_SEED' DELETE" },
      { runner: 'dev',  cmd: "CHANGE BACKUP TAG 'DEV_BASE' DELETE" },

      // ── Section 13: REPORT family per-host ─────────────────────────
      { section: '13 — REPORT per host', runner: 'prim', cmd: 'REPORT NEED BACKUP' },
      { runner: 'prim', cmd: 'REPORT NEED BACKUP REDUNDANCY 2' },
      { runner: 'prim', cmd: 'REPORT OBSOLETE' },
      { runner: 'prim', cmd: 'REPORT UNRECOVERABLE' },
      { runner: 'stby', cmd: 'REPORT NEED BACKUP' },
      { runner: 'stby', cmd: 'REPORT OBSOLETE' },
      { runner: 'stby', cmd: 'REPORT UNRECOVERABLE' },
      { runner: 'dev',  cmd: 'REPORT NEED BACKUP' },
      { runner: 'dev',  cmd: 'REPORT OBSOLETE' },
      { runner: 'dev',  cmd: 'REPORT UNRECOVERABLE' },

      // ── Section 14: LIST INCARNATION + RESET DATABASE ─────────────
      { section: '14 — LIST INCARNATION', runner: 'prim', cmd: 'LIST INCARNATION OF DATABASE' },
      { runner: 'stby', cmd: 'LIST INCARNATION OF DATABASE' },
      { runner: 'dev',  cmd: 'LIST INCARNATION OF DATABASE' },
      { runner: 'prim', cmd: 'RESET DATABASE TO INCARNATION 2' },
      { runner: 'stby', cmd: 'RESET DATABASE TO INCARNATION 2' },
      { runner: 'dev',  cmd: 'RESET DATABASE TO INCARNATION 2' },

      // ── Section 15: long RUN scripts per host ──────────────────────
      { section: '15 — long RUN scripts', runner: 'prim', cmd:
        "RUN { ALLOCATE CHANNEL p1 DEVICE TYPE DISK; ALLOCATE CHANNEL p2 DEVICE TYPE DISK; BACKUP INCREMENTAL LEVEL 0 DATABASE TAG 'PRIM_WEEKLY'; BACKUP ARCHIVELOG ALL DELETE INPUT; BACKUP CURRENT CONTROLFILE; CROSSCHECK BACKUP; DELETE NOPROMPT OBSOLETE; RELEASE CHANNEL p2; RELEASE CHANNEL p1; }" },
      { runner: 'stby', cmd:
        "RUN { SET UNTIL SCN 1950000; RESTORE DATABASE PREVIEW; RECOVER DATABASE; }" },
      { runner: 'dev',  cmd:
        "RUN { BACKUP COMPRESSED BACKUPSET DATABASE TAG 'DEV_COMP'; BACKUP ARCHIVELOG ALL DELETE INPUT; CROSSCHECK BACKUP; DELETE NOPROMPT OBSOLETE; }" },

      // ── Section 16: final state per host ───────────────────────────
      { section: '16 — final state', runner: 'prim', cmd: 'LIST BACKUP SUMMARY' },
      { runner: 'prim', cmd: 'LIST ARCHIVELOG ALL' },
      { runner: 'prim', cmd: 'LIST OBSOLETE' },
      { runner: 'prim', cmd: 'LIST EXPIRED BACKUP' },
      { runner: 'prim', cmd: 'LIST COPY' },
      { runner: 'prim', cmd: 'LIST INCARNATION OF DATABASE' },
      { runner: 'prim', cmd: 'SHOW ALL' },
      { runner: 'prim', cmd: 'SHOW CHANNEL' },
      { runner: 'stby', cmd: 'LIST BACKUP SUMMARY' },
      { runner: 'stby', cmd: 'LIST ARCHIVELOG ALL' },
      { runner: 'stby', cmd: 'SHOW ALL' },
      { runner: 'stby', cmd: 'SHOW CHANNEL' },
      { runner: 'dev',  cmd: 'LIST BACKUP SUMMARY' },
      { runner: 'dev',  cmd: 'LIST OBSOLETE' },
      { runner: 'dev',  cmd: 'SHOW ALL' },
      { runner: 'dev',  cmd: 'SHOW CHANNEL' },

      // ── Section 17: stress — burst backups per host ────────────────
      { section: '17 — stress burst', runner: 'prim', cmd: "BACKUP DATABASE TAG 'PRIM_B1'" },
      { runner: 'stby', cmd: "BACKUP DATABASE TAG 'STBY_B1'" },
      { runner: 'dev',  cmd: "BACKUP DATABASE TAG 'DEV_B1'" },
      { runner: 'prim', cmd: "BACKUP DATABASE TAG 'PRIM_B2'" },
      { runner: 'stby', cmd: "BACKUP DATABASE TAG 'STBY_B2'" },
      { runner: 'dev',  cmd: "BACKUP DATABASE TAG 'DEV_B2'" },
      { runner: 'prim', cmd: "BACKUP DATABASE TAG 'PRIM_B3'" },
      { runner: 'stby', cmd: "BACKUP DATABASE TAG 'STBY_B3'" },
      { runner: 'dev',  cmd: "BACKUP DATABASE TAG 'DEV_B3'" },
      { runner: 'prim', cmd: 'BACKUP ARCHIVELOG ALL' },
      { runner: 'stby', cmd: 'BACKUP ARCHIVELOG ALL' },
      { runner: 'dev',  cmd: 'BACKUP ARCHIVELOG ALL' },
      { runner: 'prim', cmd: 'CROSSCHECK BACKUP' },
      { runner: 'stby', cmd: 'CROSSCHECK BACKUP' },
      { runner: 'dev',  cmd: 'CROSSCHECK BACKUP' },
      { runner: 'prim', cmd: 'REPORT OBSOLETE' },
      { runner: 'stby', cmd: 'REPORT OBSOLETE' },
      { runner: 'dev',  cmd: 'REPORT OBSOLETE' },
      { runner: 'prim', cmd: 'DELETE NOPROMPT OBSOLETE' },
      { runner: 'stby', cmd: 'DELETE NOPROMPT OBSOLETE' },
      { runner: 'dev',  cmd: 'DELETE NOPROMPT OBSOLETE' },
      { runner: 'prim', cmd: 'LIST BACKUP SUMMARY' },
      { runner: 'stby', cmd: 'LIST BACKUP SUMMARY' },
      { runner: 'dev',  cmd: 'LIST BACKUP SUMMARY' },

      // ── Section 18: cross-host policy diff ─────────────────────────
      { section: '18 — policy diff', runner: 'prim', cmd: 'SHOW RETENTION POLICY' },
      { runner: 'stby', cmd: 'SHOW RETENTION POLICY' },
      { runner: 'dev',  cmd: 'SHOW RETENTION POLICY' },
      { runner: 'prim', cmd: 'SHOW DEFAULT DEVICE TYPE' },
      { runner: 'stby', cmd: 'SHOW DEFAULT DEVICE TYPE' },
      { runner: 'dev',  cmd: 'SHOW DEFAULT DEVICE TYPE' },
      { runner: 'prim', cmd: 'SHOW CONTROLFILE AUTOBACKUP' },
      { runner: 'stby', cmd: 'SHOW CONTROLFILE AUTOBACKUP' },
      { runner: 'dev',  cmd: 'SHOW CONTROLFILE AUTOBACKUP' },

      // ── Section 19: closing CROSSCHECK + REPORT triangle ───────────
      { section: '19 — closing triangle', runner: 'prim', cmd: 'CROSSCHECK ARCHIVELOG ALL' },
      { runner: 'stby', cmd: 'CROSSCHECK ARCHIVELOG ALL' },
      { runner: 'dev',  cmd: 'CROSSCHECK ARCHIVELOG ALL' },
      { runner: 'prim', cmd: 'DELETE NOPROMPT EXPIRED BACKUP' },
      { runner: 'stby', cmd: 'DELETE NOPROMPT EXPIRED BACKUP' },
      { runner: 'dev',  cmd: 'DELETE NOPROMPT EXPIRED BACKUP' },
      { runner: 'prim', cmd: 'REPORT NEED BACKUP RECOVERY WINDOW OF 30 DAYS' },
      { runner: 'stby', cmd: 'REPORT NEED BACKUP RECOVERY WINDOW OF 7 DAYS' },
      { runner: 'dev',  cmd: 'REPORT NEED BACKUP REDUNDANCY 1' },

      // ── Section 20: per-host EXIT ──────────────────────────────────
      { section: '20 — exit', runner: 'prim', cmd: 'EXIT' },
      { runner: 'stby', cmd: 'EXIT' },
      { runner: 'dev',  cmd: 'EXIT' },
    ];

    runRmanMultiDump(
      'rman-multi-server-lan',
      'LAN /24 — db-prim(10.30.0.10) db-stby(10.30.0.11, MOUNT) db-dev(10.30.0.12)',
      cmds,
      runners,
    );

    for (const r of Object.values(runners)) r.dispose();
    removeOracleDatabase(prim.id);
    removeOracleDatabase(stby.id);
    removeOracleDatabase(dev.id);
  });
});
