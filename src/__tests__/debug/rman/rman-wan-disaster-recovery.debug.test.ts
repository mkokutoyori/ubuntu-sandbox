/**
 * Debug run — WAN disaster-recovery scenario across two data centres.
 *
 * Topology:
 *
 *   Site A — Primary (10.40.0.0/24)               Site B — DR (10.50.0.0/24)
 *   ┌──────────────────────────────┐              ┌──────────────────────────────┐
 *   │ db-A-prim     10.40.0.10     │              │ db-B-dr      10.50.0.10      │
 *   │ Oracle DC1DB  OPEN           │   ===WAN===  │ Oracle DC2DB  MOUNT (stby)   │
 *   │                              │              │                              │
 *   │ db-A-rcat     10.40.0.20     │              │ db-B-witness 10.50.0.20      │
 *   │ Oracle RCAT   OPEN  (catalog)│              │ Oracle WITDB  OPEN  (witness)│
 *   └──────────────────────────────┘              └──────────────────────────────┘
 *
 * Drives a realistic DR rehearsal:
 *   - Phase 1: A-prim takes a full + catalogs against the recovery
 *     catalog on A-rcat.
 *   - Phase 2: backups are mirrored to B-dr's archive area.
 *   - Phase 3: a "disaster" — A-prim shuts down. We failover by
 *     promoting B-dr through restore + recover.
 *   - Phase 4: catalog moves between sites, RESYNC CATALOG, role swap.
 *   - Phase 5: post-DR cleanup + comparison.
 *
 * Transcript → debug-output/rman/rman-wan-disaster-recovery_results_debug.txt
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

describe('debug — WAN disaster-recovery scenario', () => {
  it('runs primary + DR + catalog + witness through a full DR rehearsal', () => {
    const prim    = new LinuxServer('linux-server', 'db-A-prim',    100, 100);
    const rcat    = new LinuxServer('linux-server', 'db-A-rcat',    100, 200);
    const dr      = new LinuxServer('linux-server', 'db-B-dr',      500, 100);
    const witness = new LinuxServer('linux-server', 'db-B-witness', 500, 200);

    const dbPrim    = getOracleDatabase(prim.id);
    const dbRcat    = getOracleDatabase(rcat.id);
    const dbDr      = getOracleDatabase(dr.id);
    const dbWitness = getOracleDatabase(witness.id);
    void dbPrim; void dbRcat; void dbWitness;

    // DR site sits in MOUNT, like a real physical standby.
    dbDr.instance.shutdown('IMMEDIATE');
    dbDr.instance.startup('MOUNT');

    const runners = {
      prim:    createRmanRunner(prim),
      rcat:    createRmanRunner(rcat),
      dr:      createRmanRunner(dr),
      witness: createRmanRunner(witness),
    };

    const cmds: MultiLine[] = [
      // ── Phase 1: handshake + per-site configuration ────────────────
      { section: 'P1 — handshake', runner: 'prim', cmd: 'CONNECT TARGET /' },
      { runner: 'rcat',    cmd: 'CONNECT TARGET /' },
      { runner: 'dr',      cmd: 'CONNECT TARGET /' },
      { runner: 'witness', cmd: 'CONNECT TARGET /' },
      { runner: 'prim',    cmd: 'CONNECT CATALOG rman/rman@RCAT' },
      { runner: 'prim',    cmd: 'REGISTER DATABASE' },
      { runner: 'rcat',    cmd: 'CREATE CATALOG' },
      { runner: 'rcat',    cmd: "CREATE VIRTUAL CATALOG cdc1" },
      { runner: 'rcat',    cmd: "GRANT CATALOG FOR DATABASE DC1DB TO cdc1" },
      { runner: 'rcat',    cmd: 'LIST DB_UNIQUE_NAME OF DATABASE' },

      { section: 'P1 — per-site CONFIGURE', runner: 'prim',
        cmd: 'CONFIGURE RETENTION POLICY TO RECOVERY WINDOW OF 30 DAYS' },
      { runner: 'prim', cmd: 'CONFIGURE BACKUP OPTIMIZATION ON' },
      { runner: 'prim', cmd: 'CONFIGURE CONTROLFILE AUTOBACKUP ON' },
      { runner: 'prim', cmd: "CONFIGURE CONTROLFILE AUTOBACKUP FORMAT FOR DEVICE TYPE DISK TO '/u01/dc1/cf_%F.bkp'" },
      { runner: 'prim', cmd: 'CONFIGURE DEVICE TYPE DISK PARALLELISM 4 BACKUP TYPE TO BACKUPSET' },
      { runner: 'prim', cmd: "CONFIGURE CHANNEL DEVICE TYPE DISK FORMAT '/u01/dc1/%d_%T_%U.bkp'" },
      { runner: 'prim', cmd: "CONFIGURE ENCRYPTION FOR DATABASE ON" },
      { runner: 'prim', cmd: "CONFIGURE ENCRYPTION ALGORITHM 'AES256'" },
      { runner: 'prim', cmd: 'CONFIGURE ARCHIVELOG DELETION POLICY TO APPLIED ON ALL STANDBY' },
      { runner: 'prim', cmd: 'SHOW ALL' },

      { runner: 'dr', cmd: 'CONFIGURE RETENTION POLICY TO RECOVERY WINDOW OF 30 DAYS' },
      { runner: 'dr', cmd: 'CONFIGURE BACKUP OPTIMIZATION ON' },
      { runner: 'dr', cmd: 'CONFIGURE CONTROLFILE AUTOBACKUP ON' },
      { runner: 'dr', cmd: "CONFIGURE CONTROLFILE AUTOBACKUP FORMAT FOR DEVICE TYPE DISK TO '/u01/dc2/cf_%F.bkp'" },
      { runner: 'dr', cmd: 'CONFIGURE DEVICE TYPE DISK PARALLELISM 2 BACKUP TYPE TO BACKUPSET' },
      { runner: 'dr', cmd: "CONFIGURE CHANNEL DEVICE TYPE DISK FORMAT '/u01/dc2/%d_%T_%U.bkp'" },
      { runner: 'dr', cmd: 'SHOW ALL' },

      { runner: 'witness', cmd: 'CONFIGURE RETENTION POLICY TO REDUNDANCY 1' },
      { runner: 'witness', cmd: 'SHOW ALL' },

      // ── Phase 2: primary takes baseline + daily incremental ───────
      { section: 'P2 — primary daily cadence', runner: 'prim',
        cmd: "BACKUP INCREMENTAL LEVEL 0 DATABASE TAG 'DC1_BASE'" },
      { runner: 'prim', cmd: "BACKUP DATABASE TAG 'DC1_FULL_MON' PLUS ARCHIVELOG DELETE INPUT" },
      { runner: 'prim', cmd: 'BACKUP CURRENT CONTROLFILE' },
      { runner: 'prim', cmd: "BACKUP INCREMENTAL LEVEL 1 DATABASE TAG 'DC1_L1_TUE'" },
      { runner: 'prim', cmd: 'BACKUP ARCHIVELOG ALL DELETE INPUT' },
      { runner: 'prim', cmd: "BACKUP INCREMENTAL LEVEL 1 CUMULATIVE DATABASE TAG 'DC1_L1_CUM_WED'" },
      { runner: 'prim', cmd: 'BACKUP ARCHIVELOG ALL DELETE INPUT' },
      { runner: 'prim', cmd: "BACKUP INCREMENTAL LEVEL 1 DATABASE TAG 'DC1_L1_THU'" },
      { runner: 'prim', cmd: 'BACKUP ARCHIVELOG ALL DELETE INPUT' },
      { runner: 'prim', cmd: "BACKUP INCREMENTAL LEVEL 1 CUMULATIVE DATABASE TAG 'DC1_L1_CUM_FRI'" },
      { runner: 'prim', cmd: 'BACKUP ARCHIVELOG ALL DELETE INPUT' },
      { runner: 'prim', cmd: 'LIST BACKUP SUMMARY' },
      { runner: 'prim', cmd: 'REPORT NEED BACKUP' },
      { runner: 'prim', cmd: 'RESYNC CATALOG' },

      // ── Phase 2bis: primary auto-validate every backup ─────────────
      { section: 'P2 — VALIDATE sweep', runner: 'prim', cmd: 'VALIDATE DATABASE' },
      { runner: 'prim', cmd: 'VALIDATE TABLESPACE SYSTEM' },
      { runner: 'prim', cmd: 'VALIDATE TABLESPACE USERS' },
      { runner: 'prim', cmd: 'VALIDATE TABLESPACE SYSAUX' },
      { runner: 'prim', cmd: 'VALIDATE TABLESPACE UNDOTBS1' },
      { runner: 'prim', cmd: 'VALIDATE DATAFILE 1' },
      { runner: 'prim', cmd: 'VALIDATE DATAFILE 2' },
      { runner: 'prim', cmd: 'VALIDATE DATAFILE 3' },
      { runner: 'prim', cmd: 'VALIDATE DATAFILE 4' },
      { runner: 'prim', cmd: 'VALIDATE BACKUPSET 1' },
      { runner: 'prim', cmd: 'VALIDATE BACKUPSET 2' },
      { runner: 'prim', cmd: 'VALIDATE BACKUPSET 3' },
      { runner: 'prim', cmd: 'VALIDATE BACKUPSET 4' },
      { runner: 'prim', cmd: 'VALIDATE BACKUPSET 5' },

      // ── Phase 2ter: catalog node sees the new entries ─────────────
      { section: 'P2 — catalog reports', runner: 'rcat', cmd: 'LIST BACKUP SUMMARY' },
      { runner: 'rcat', cmd: 'LIST DB_UNIQUE_NAME OF DATABASE' },
      { runner: 'rcat', cmd: 'REPORT SCHEMA' },
      { runner: 'rcat', cmd: 'REPORT NEED BACKUP' },
      { runner: 'rcat', cmd: 'REPORT OBSOLETE' },

      // ── Phase 3: ship pieces to DR site (catalog-only) ────────────
      { section: 'P3 — mirror catalog to DR', runner: 'dr',
        cmd: "CATALOG DATAFILECOPY '/u01/dc2/mirror_system01.dbf'" },
      { runner: 'dr', cmd: "CATALOG DATAFILECOPY '/u01/dc2/mirror_users01.dbf'" },
      { runner: 'dr', cmd: "CATALOG DATAFILECOPY '/u01/dc2/mirror_sysaux01.dbf'" },
      { runner: 'dr', cmd: "CATALOG DATAFILECOPY '/u01/dc2/mirror_undotbs01.dbf'" },
      { runner: 'dr', cmd: "CATALOG BACKUPPIECE '/u01/dc2/mirror_base_001.bkp'" },
      { runner: 'dr', cmd: "CATALOG BACKUPPIECE '/u01/dc2/mirror_base_002.bkp'" },
      { runner: 'dr', cmd: "CATALOG BACKUPPIECE '/u01/dc2/mirror_l1_001.bkp'" },
      { runner: 'dr', cmd: "CATALOG BACKUPPIECE '/u01/dc2/mirror_l1_002.bkp'" },
      { runner: 'dr', cmd: "CATALOG BACKUPPIECE '/u01/dc2/mirror_l1_003.bkp'" },
      { runner: 'dr', cmd: "CATALOG BACKUPPIECE '/u01/dc2/mirror_arc_001.bkp'" },
      { runner: 'dr', cmd: "CATALOG BACKUPPIECE '/u01/dc2/mirror_arc_002.bkp'" },
      { runner: 'dr', cmd: "CATALOG BACKUPPIECE '/u01/dc2/mirror_arc_003.bkp'" },
      { runner: 'dr', cmd: "CATALOG BACKUPPIECE '/u01/dc2/mirror_arc_004.bkp'" },
      { runner: 'dr', cmd: 'LIST COPY' },
      { runner: 'dr', cmd: 'LIST BACKUP SUMMARY' },

      // ── Phase 3bis: DR baseline backup ────────────────────────────
      { section: 'P3 — DR own baseline', runner: 'dr', cmd: "BACKUP DATABASE TAG 'DC2_BASE'" },
      { runner: 'dr', cmd: 'BACKUP ARCHIVELOG ALL' },
      { runner: 'dr', cmd: 'BACKUP CURRENT CONTROLFILE' },
      { runner: 'dr', cmd: 'LIST BACKUP SUMMARY' },

      // ── Phase 4: simulate disaster on the primary ─────────────────
      { section: 'P4 — disaster!', runner: 'prim', cmd: "BACKUP DATABASE TAG 'DC1_FINAL_FAREWELL'" },
      { runner: 'prim', cmd: 'BACKUP ARCHIVELOG ALL DELETE INPUT' },
      { runner: 'prim', cmd: 'BACKUP CURRENT CONTROLFILE' },
      { runner: 'prim', cmd: 'LIST BACKUP SUMMARY' },
    ];

    // Phase 4 boundary: blow up the primary instance externally.
    // The OracleInstanceWatcherActor should auto-dispose db-A-prim's
    // session; subsequent commands route to the survivors.

    const cmdsAfterDisaster: MultiLine[] = [
      // ── Phase 4bis: post-disaster verbs against dead primary ──────
      { section: 'P4b — post-disaster primary', runner: 'prim', cmd: 'SHOW ALL' },
      { runner: 'prim', cmd: 'CONNECT TARGET /' },
      { runner: 'prim', cmd: 'BACKUP DATABASE' },
      { runner: 'prim', cmd: 'LIST BACKUP' },

      // ── Phase 5: DR takes over ────────────────────────────────────
      { section: 'P5 — failover on DR', runner: 'dr', cmd: 'CONNECT TARGET /' },
      { runner: 'dr', cmd: 'SHOW ALL' },
      { runner: 'dr', cmd: 'LIST BACKUP SUMMARY' },
      { runner: 'dr', cmd: 'CROSSCHECK BACKUP' },
      { runner: 'dr', cmd: 'CROSSCHECK ARCHIVELOG ALL' },
      { runner: 'dr', cmd: 'RESTORE DATABASE PREVIEW' },
      { runner: 'dr', cmd: 'RESTORE DATABASE VALIDATE' },
      { runner: 'dr', cmd: "RESTORE DATABASE FROM TAG 'DC1_BASE'" },
      { runner: 'dr', cmd: 'RESTORE DATABASE' },
      { runner: 'dr', cmd: 'RESTORE TABLESPACE USERS' },
      { runner: 'dr', cmd: 'RESTORE TABLESPACE SYSTEM' },
      { runner: 'dr', cmd: 'RESTORE TABLESPACE SYSAUX' },
      { runner: 'dr', cmd: 'RESTORE TABLESPACE UNDOTBS1' },
      { runner: 'dr', cmd: 'RESTORE DATAFILE 1' },
      { runner: 'dr', cmd: 'RESTORE DATAFILE 2' },
      { runner: 'dr', cmd: 'RESTORE DATAFILE 3' },
      { runner: 'dr', cmd: 'RESTORE DATAFILE 4' },

      // ── Phase 5bis: PITR recovery on DR ───────────────────────────
      { section: 'P5 — PITR on DR', runner: 'dr', cmd: 'RECOVER DATABASE' },
      { runner: 'dr', cmd: 'RECOVER DATABASE UNTIL SCN 1900000' },
      { runner: 'dr', cmd: "RECOVER DATABASE UNTIL TIME '2026-06-01 00:00:00'" },
      { runner: 'dr', cmd: 'RECOVER DATABASE UNTIL CANCEL' },
      { runner: 'dr', cmd: 'RECOVER TABLESPACE USERS' },
      { runner: 'dr', cmd: 'RECOVER TABLESPACE SYSTEM' },
      { runner: 'dr', cmd: 'RECOVER DATAFILE 1' },
      { runner: 'dr', cmd: 'RECOVER DATAFILE 4' },

      // ── Phase 5ter: SET UNTIL / SET NEWNAME drills on DR ──────────
      { section: 'P5 — SET-driven RUN', runner: 'dr', cmd:
        "RUN { SET UNTIL SCN 1900000; RESTORE DATABASE; RECOVER DATABASE; }" },
      { runner: 'dr', cmd:
        "RUN { SET UNTIL TIME '2026-05-31 23:59:00'; RESTORE DATABASE; RECOVER DATABASE; }" },
      { runner: 'dr', cmd:
        "RUN { SET NEWNAME FOR DATAFILE 1 TO '/u02/dc2/system01.dbf'; SET NEWNAME FOR DATAFILE 2 TO '/u02/dc2/sysaux01.dbf'; SET NEWNAME FOR DATAFILE 3 TO '/u02/dc2/undotbs01.dbf'; SET NEWNAME FOR DATAFILE 4 TO '/u02/dc2/users01.dbf'; RESTORE DATABASE; SWITCH DATAFILE ALL; RECOVER DATABASE; }" },
      { runner: 'dr', cmd:
        "RUN { ALLOCATE CHANNEL d1 DEVICE TYPE DISK; ALLOCATE CHANNEL d2 DEVICE TYPE DISK; RESTORE DATABASE; RECOVER DATABASE; RELEASE CHANNEL d1; RELEASE CHANNEL d2; }" },

      // ── Phase 5quater: ALTER DATABASE OPEN RESETLOGS + re-baseline ─
      { section: 'P5 — open + re-baseline', runner: 'dr', cmd: 'ALTER DATABASE OPEN RESETLOGS' },
      { runner: 'dr', cmd: 'LIST INCARNATION OF DATABASE' },
      { runner: 'dr', cmd: "BACKUP INCREMENTAL LEVEL 0 DATABASE TAG 'DC2_PROMOTED_L0'" },
      { runner: 'dr', cmd: "BACKUP DATABASE PLUS ARCHIVELOG DELETE INPUT TAG 'DC2_PROMOTED_FULL'" },
      { runner: 'dr', cmd: 'BACKUP CURRENT CONTROLFILE' },
      { runner: 'dr', cmd: 'LIST BACKUP SUMMARY' },
      { runner: 'dr', cmd: 'REPORT SCHEMA' },

      // ── Phase 6: catalog reports the new primary ──────────────────
      { section: 'P6 — catalog update', runner: 'rcat', cmd: 'RESYNC CATALOG' },
      { runner: 'rcat', cmd: 'LIST DB_UNIQUE_NAME OF DATABASE' },
      { runner: 'rcat', cmd: 'LIST INCARNATION OF DATABASE' },
      { runner: 'rcat', cmd: 'REPORT SCHEMA' },
      { runner: 'rcat', cmd: 'LIST BACKUP SUMMARY' },
      { runner: 'rcat', cmd: 'REPORT NEED BACKUP' },
      { runner: 'rcat', cmd: 'REPORT OBSOLETE' },

      // ── Phase 7: witness validates the new primary ────────────────
      { section: 'P7 — witness validates', runner: 'witness', cmd: 'CONNECT TARGET /' },
      { runner: 'witness', cmd: "BACKUP DATABASE TAG 'WIT_001'" },
      { runner: 'witness', cmd: 'BACKUP ARCHIVELOG ALL' },
      { runner: 'witness', cmd: 'LIST BACKUP SUMMARY' },
      { runner: 'witness', cmd: 'VALIDATE DATABASE' },
      { runner: 'witness', cmd: 'CROSSCHECK BACKUP' },
      { runner: 'witness', cmd: 'REPORT SCHEMA' },

      // ── Phase 8: DR-as-new-primary daily cadence ──────────────────
      { section: 'P8 — DR as new primary', runner: 'dr',
        cmd: "BACKUP INCREMENTAL LEVEL 1 DATABASE TAG 'DC2_DAY1_L1'" },
      { runner: 'dr', cmd: 'BACKUP ARCHIVELOG ALL DELETE INPUT' },
      { runner: 'dr', cmd: "BACKUP INCREMENTAL LEVEL 1 CUMULATIVE DATABASE TAG 'DC2_DAY2_L1_CUM'" },
      { runner: 'dr', cmd: 'BACKUP ARCHIVELOG ALL DELETE INPUT' },
      { runner: 'dr', cmd: "BACKUP INCREMENTAL LEVEL 1 DATABASE TAG 'DC2_DAY3_L1'" },
      { runner: 'dr', cmd: 'BACKUP ARCHIVELOG ALL DELETE INPUT' },
      { runner: 'dr', cmd: "BACKUP INCREMENTAL LEVEL 1 CUMULATIVE DATABASE TAG 'DC2_DAY4_L1_CUM'" },
      { runner: 'dr', cmd: 'BACKUP ARCHIVELOG ALL DELETE INPUT' },
      { runner: 'dr', cmd: "BACKUP INCREMENTAL LEVEL 1 DATABASE TAG 'DC2_DAY5_L1'" },
      { runner: 'dr', cmd: 'BACKUP ARCHIVELOG ALL DELETE INPUT' },
      { runner: 'dr', cmd: 'LIST BACKUP SUMMARY' },
      { runner: 'dr', cmd: 'CROSSCHECK BACKUP' },
      { runner: 'dr', cmd: 'REPORT OBSOLETE' },
      { runner: 'dr', cmd: 'DELETE NOPROMPT OBSOLETE' },
      { runner: 'dr', cmd: 'LIST BACKUP SUMMARY' },

      // ── Phase 9: cleanup obsolete data on every node ──────────────
      { section: 'P9 — global cleanup', runner: 'dr',      cmd: 'DELETE NOPROMPT EXPIRED BACKUP' },
      { runner: 'dr',      cmd: 'DELETE NOPROMPT ARCHIVELOG ALL' },
      { runner: 'rcat',    cmd: 'DELETE NOPROMPT OBSOLETE' },
      { runner: 'rcat',    cmd: 'DELETE NOPROMPT EXPIRED BACKUP' },
      { runner: 'witness', cmd: 'DELETE NOPROMPT OBSOLETE' },
      { runner: 'witness', cmd: 'DELETE NOPROMPT EXPIRED BACKUP' },

      // ── Phase 10: DUPLICATE for a third DR site ───────────────────
      { section: 'P10 — DUPLICATE for DC3', runner: 'dr', cmd: 'CONNECT AUXILIARY /' },
      { runner: 'dr', cmd: 'DUPLICATE TARGET DATABASE TO DC3DB' },
      { runner: 'dr', cmd: 'DUPLICATE DATABASE TO DC3DB FOR STANDBY' },
      { runner: 'dr', cmd: "DUPLICATE TARGET DATABASE TO DC3DB UNTIL TIME '2026-06-15 12:00:00'" },
      { runner: 'dr', cmd: 'DUPLICATE TARGET DATABASE TO DC3DB UNTIL SCN 2100000' },
      { runner: 'dr', cmd:
        "RUN { ALLOCATE CHANNEL c1 DEVICE TYPE DISK; ALLOCATE AUXILIARY CHANNEL aux1 DEVICE TYPE DISK; DUPLICATE TARGET DATABASE TO DC3DB SKIP TABLESPACE TEMP; RELEASE CHANNEL aux1; RELEASE CHANNEL c1; }" },

      // ── Phase 11: per-node final state ────────────────────────────
      { section: 'P11 — final state', runner: 'dr',      cmd: 'SHOW ALL' },
      { runner: 'dr',      cmd: 'SHOW CHANNEL' },
      { runner: 'dr',      cmd: 'SHOW RETENTION POLICY' },
      { runner: 'dr',      cmd: 'LIST BACKUP SUMMARY' },
      { runner: 'dr',      cmd: 'LIST ARCHIVELOG ALL' },
      { runner: 'dr',      cmd: 'LIST OBSOLETE' },
      { runner: 'dr',      cmd: 'LIST EXPIRED BACKUP' },
      { runner: 'dr',      cmd: 'LIST COPY' },
      { runner: 'dr',      cmd: 'LIST INCARNATION OF DATABASE' },
      { runner: 'dr',      cmd: 'REPORT SCHEMA' },
      { runner: 'dr',      cmd: 'REPORT NEED BACKUP' },
      { runner: 'dr',      cmd: 'REPORT OBSOLETE' },
      { runner: 'dr',      cmd: 'REPORT UNRECOVERABLE' },
      { runner: 'rcat',    cmd: 'SHOW ALL' },
      { runner: 'rcat',    cmd: 'LIST BACKUP SUMMARY' },
      { runner: 'rcat',    cmd: 'LIST DB_UNIQUE_NAME OF DATABASE' },
      { runner: 'rcat',    cmd: 'UNREGISTER DATABASE DC1DB' },
      { runner: 'witness', cmd: 'SHOW ALL' },
      { runner: 'witness', cmd: 'LIST BACKUP SUMMARY' },
      { runner: 'witness', cmd: 'REPORT NEED BACKUP' },

      // ── Phase 11bis: every node CROSSCHECK + LIST sweep ───────────
      { section: 'P11b — sweep', runner: 'dr',      cmd: 'CROSSCHECK BACKUP' },
      { runner: 'dr',      cmd: 'CROSSCHECK ARCHIVELOG ALL' },
      { runner: 'rcat',    cmd: 'CROSSCHECK BACKUP' },
      { runner: 'rcat',    cmd: 'CROSSCHECK ARCHIVELOG ALL' },
      { runner: 'witness', cmd: 'CROSSCHECK BACKUP' },
      { runner: 'witness', cmd: 'CROSSCHECK ARCHIVELOG ALL' },
      { runner: 'dr',      cmd: 'LIST BACKUP SUMMARY' },
      { runner: 'rcat',    cmd: 'LIST BACKUP SUMMARY' },
      { runner: 'witness', cmd: 'LIST BACKUP SUMMARY' },
      { runner: 'dr',      cmd: 'DELETE NOPROMPT OBSOLETE' },
      { runner: 'rcat',    cmd: 'DELETE NOPROMPT OBSOLETE' },
      { runner: 'witness', cmd: 'DELETE NOPROMPT OBSOLETE' },

      // ── Phase 12: exit everywhere ─────────────────────────────────
      { section: 'P12 — exit', runner: 'dr',      cmd: 'EXIT' },
      { runner: 'rcat',    cmd: 'EXIT' },
      { runner: 'witness', cmd: 'EXIT' },
    ];

    // Replay phase 1 → phase 4 first.
    runRmanMultiDump(
      'rman-wan-disaster-recovery-pre',
      'WAN — A-prim/A-rcat (10.40.0.0/24) ↔ B-dr/B-witness (10.50.0.0/24) — pre-disaster',
      cmds,
      runners,
    );

    // Disaster: shut down the primary instance.
    dbPrim.instance.shutdown('IMMEDIATE');

    // Replay phase 4bis → phase 12 after the disaster.
    runRmanMultiDump(
      'rman-wan-disaster-recovery',
      'WAN — A-prim DEAD; failover to B-dr; new primary + witness',
      cmdsAfterDisaster,
      runners,
    );

    for (const r of Object.values(runners)) r.dispose();
    removeOracleDatabase(prim.id);
    removeOracleDatabase(rcat.id);
    removeOracleDatabase(dr.id);
    removeOracleDatabase(witness.id);
  });
});
