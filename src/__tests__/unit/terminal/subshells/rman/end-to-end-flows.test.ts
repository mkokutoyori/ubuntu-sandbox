/**
 * End-to-end canonical RMAN flows (§10).
 *
 * Drives ReactiveRmanSubShell through Oracle-style scripts and asserts
 * the canonical terminal-output lines documented in DESIGN-RMAN.md §10.
 *
 * These tests bind the sub-shell against a hand-built IRmanOracleContext
 * (no live OracleDatabase needed), so each flow is fully deterministic.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  ReactiveRmanSubShell, BackupKey, DbId, ok,
  type IRmanOracleContext,
} from '@/terminal/subshells/rman';

function joinOutput(out: string[]): string { return out.join('\n'); }

function makeOpenCtx(): IRmanOracleContext {
  return {
    dbId: DbId.DEFAULT, dbName: 'ORCL',
    vfs: {
      writeFile: () => ok(undefined), readFile: () => ok(new Uint8Array(0)),
      fileExists: () => true, deleteFile: () => ok(undefined), availableBytes: () => 1e10,
    },
    getDatafiles: () => [
      { fileNo: 1, path: '/u01/oradata/ORCL/system01.dbf', sizeBytes: 838_860_800, tablespace: 'SYSTEM' },
      { fileNo: 4, path: '/u01/oradata/ORCL/users01.dbf',  sizeBytes: 104_857_600, tablespace: 'USERS'  },
    ],
    getSpfileParam: () => undefined,
    getInstanceState: () => 'OPEN',
    getArchivelogPaths: () => [
      '/u01/backup/arch/arch_1_42.arc',
      '/u01/backup/arch/arch_1_43.arc',
    ],
  } as unknown as IRmanOracleContext;
}

function makeMountCtx(): IRmanOracleContext {
  return { ...makeOpenCtx(), getInstanceState: () => 'MOUNT' } as unknown as IRmanOracleContext;
}

describe('§10.1 Flux 1 — BACKUP DATABASE (full)', () => {
  beforeEach(() => BackupKey._reset());

  it('emits the canonical "Starting backup" / channel / piece / "Finished backup" lines', () => {
    const { subShell } = ReactiveRmanSubShell.fromContext(['target', '/'], makeOpenCtx());
    const res = subShell.processLine('BACKUP DATABASE');
    expect(res.exit).toBe(false);
    const txt = joinOutput(res.output);
    expect(txt).toMatch(/Starting backup at /);
    expect(txt).toMatch(/allocated channel: ORA_DISK/);
    expect(txt).toMatch(/channel ORA_DISK.*: SID=\d+ device type=DISK/);
    expect(txt).toMatch(/channel ORA_DISK.*: starting full datafile backup set/);
    expect(txt).toMatch(/channel ORA_DISK.*: specifying datafile\(s\) in backup set/);
    expect(txt).toMatch(/channel ORA_DISK.*: backing up database/);
    expect(txt).toMatch(/piece handle=.+tag=TAG/);
    expect(txt).toMatch(/channel ORA_DISK.*: backup set complete/);
    expect(txt).toMatch(/Finished backup at /);
    subShell.dispose();
  });
});

describe('§10.2 Flux 2 — RESTORE + RECOVER UNTIL SCN', () => {
  beforeEach(() => BackupKey._reset());

  it('runs RESTORE + RECOVER UNTIL SCN against a MOUNT instance', () => {
    const { subShell } = ReactiveRmanSubShell.fromContext(['target', '/'], makeMountCtx());
    // Seed a backup first.
    subShell.processLine('BACKUP DATABASE');

    const r1 = subShell.processLine('RESTORE DATABASE');
    const r2 = subShell.processLine('RECOVER DATABASE UNTIL SCN 1891000');
    const all = joinOutput([...r1.output, ...r2.output]);

    expect(all).toMatch(/restoring datafile 00001 to \/u01\/oradata\/ORCL\/system01\.dbf/);
    expect(all).toMatch(/restoring datafile 00004 to \/u01\/oradata\/ORCL\/users01\.dbf/);
    expect(all).toMatch(/starting media recovery/);
    expect(all).toMatch(/media recovery complete/);
    subShell.dispose();
  });
});

describe('§10.3 Flux 3 — RUN block with explicit ALLOCATE CHANNEL', () => {
  beforeEach(() => BackupKey._reset());

  it('runs ALLOCATE → BACKUP INCREMENTAL → BACKUP ARCHIVELOG → RELEASE end-to-end', () => {
    const { subShell } = ReactiveRmanSubShell.fromContext(['target', '/'], makeOpenCtx());
    const res = subShell.processLine(
      "RUN { " +
      "ALLOCATE CHANNEL c1 DEVICE TYPE DISK; " +
      "BACKUP INCREMENTAL LEVEL 0 DATABASE TAG 'WEEKLY_FULL'; " +
      "BACKUP ARCHIVELOG ALL DELETE INPUT; " +
      "RELEASE CHANNEL c1; " +
      "}",
    );
    const txt = joinOutput(res.output);
    expect(txt).toMatch(/allocated channel: c1/);
    expect(txt).toMatch(/starting incremental level 0/);
    expect(txt).toMatch(/TAG\d{8}|WEEKLY_FULL/i);
    expect(txt).toMatch(/starting archived log backup set/);
    expect(txt).toMatch(/specifying archived log\(s\)/);
    subShell.dispose();
  });
});

describe('§10.4 Flux 4 — CROSSCHECK + DELETE OBSOLETE', () => {
  beforeEach(() => BackupKey._reset());

  it('crosschecks the catalog then deletes obsolete sets per the active policy', () => {
    const { subShell } = ReactiveRmanSubShell.fromContext(['target', '/'], makeOpenCtx());
    subShell.processLine('BACKUP DATABASE');
    subShell.processLine('BACKUP DATABASE');
    subShell.processLine('CONFIGURE RETENTION POLICY TO REDUNDANCY 1');

    const r1 = subShell.processLine('CROSSCHECK BACKUP');
    const r2 = subShell.processLine('DELETE NOPROMPT OBSOLETE');
    const all = joinOutput([...r1.output, ...r2.output]);

    expect(all).toMatch(/Crosschecked\s+\d+ objects/);
    subShell.dispose();
  });
});

describe('§10.5 Flux 5 — CONFIGURE + SHOW ALL', () => {
  it('CONFIGURE updates persist into the subsequent SHOW ALL output', () => {
    const { subShell } = ReactiveRmanSubShell.fromContext(['target', '/'], makeOpenCtx());
    subShell.processLine('CONFIGURE RETENTION POLICY TO RECOVERY WINDOW OF 7 DAYS');
    subShell.processLine('CONFIGURE CONTROLFILE AUTOBACKUP ON');

    const res = subShell.processLine('SHOW ALL');
    const txt = joinOutput(res.output);
    expect(txt).toMatch(/CONFIGURE RETENTION POLICY TO RECOVERY WINDOW OF 7 DAYS/i);
    expect(txt).toMatch(/CONFIGURE CONTROLFILE AUTOBACKUP ON/i);
    subShell.dispose();
  });
});
