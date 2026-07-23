/**
 * RESTORE honours SET UNTIL SCN/TIME (PITR backup-set selection).
 *
 * Audit rapport 10, constat MAJEUR "RESTORE ignore SET UNTIL SCN/TIME —
 * pas de vraie sélection PITR du backup set": RestoreCommand read
 * cmdCtx.setUntil but never passed it to the job engine, so every
 * RUN { SET UNTIL ...; RESTORE DATABASE; } picked the same backup sets
 * regardless of the target SCN/time.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  ReactiveRmanSubShell, DbId, BackupKey, ok,
  type IRmanOracleContext,
} from '@/terminal/subshells/rman';

function ctx(): IRmanOracleContext {
  return {
    dbId: DbId.DEFAULT, dbName: 'ORCL',
    vfs: {
      writeFile: () => ok(undefined), readFile: () => ok(new Uint8Array(0)),
      fileExists: () => true, deleteFile: () => ok(undefined), availableBytes: () => 1e10,
    },
    getDatafiles: () => [
      { fileNo: 1, path: '/u01/oradata/ORCL/system01.dbf', sizeBytes: 1_000, tablespace: 'SYSTEM' },
    ],
    getSpfileParam: () => undefined,
    getInstanceState: () => 'MOUNT',
    getArchivelogPaths: () => ['/u01/backup/arch/arch_1_1.arc'],
  } as unknown as IRmanOracleContext;
}

describe('RESTORE + SET UNTIL SCN', () => {
  beforeEach(() => BackupKey._reset());

  it('fails when no backup set is checkpointed at or before the requested SCN', () => {
    const { subShell } = ReactiveRmanSubShell.fromContext(['target', '/'], ctx());
    subShell.processLine('BACKUP DATABASE');

    // The simulator's SCN space starts at 1_800_000 — SCN 1 always
    // precedes every backup ever taken, so no set can satisfy it.
    const out = subShell.processLine('RUN { SET UNTIL SCN 1; RESTORE DATABASE; }').output.join('\n');
    expect(out).toMatch(/RMAN-06026/);
    subShell.dispose();
  });

  it('succeeds when the target SCN is at or after an existing backup set', () => {
    const { subShell } = ReactiveRmanSubShell.fromContext(['target', '/'], ctx());
    subShell.processLine('BACKUP DATABASE');

    // The simulator's SCN space is 1_800_000..1_900_000 — a bound above
    // that range is guaranteed to include every backup ever taken.
    const out = subShell.processLine('RUN { SET UNTIL SCN 2000000; RESTORE DATABASE; }').output.join('\n');
    expect(out).not.toMatch(/RMAN-06026/);
    expect(out).toMatch(/restoring datafile/i);
    subShell.dispose();
  });

  it('an UNTIL bound below the whole SCN space fails even though backups exist', () => {
    const { subShell } = ReactiveRmanSubShell.fromContext(['target', '/'], ctx());
    subShell.processLine('BACKUP DATABASE');
    subShell.processLine('BACKUP DATABASE');
    const listing = subShell.processLine('LIST BACKUP SUMMARY').output.join('\n');
    expect(listing).toMatch(/FULL|B\s+F/i);

    // Proves RESTORE actually discriminates by SCN rather than restoring
    // "whatever is available" regardless of the requested point in time.
    const failed = subShell.processLine('RUN { SET UNTIL SCN 1; RESTORE DATABASE; }').output.join('\n');
    expect(failed).toMatch(/RMAN-06026/);
    subShell.dispose();
  });
});

describe('RESTORE + SET UNTIL TIME', () => {
  beforeEach(() => BackupKey._reset());

  it('fails when no backup set completed at or before the requested time', () => {
    const { subShell } = ReactiveRmanSubShell.fromContext(['target', '/'], ctx());
    subShell.processLine('BACKUP DATABASE');

    const out = subShell.processLine(
      "RUN { SET UNTIL TIME '01-JAN-2000 00:00:00'; RESTORE DATABASE; }",
    ).output.join('\n');
    expect(out).toMatch(/RMAN-06026/);
    subShell.dispose();
  });

  it('succeeds when the target time is after the backup completed', () => {
    const { subShell } = ReactiveRmanSubShell.fromContext(['target', '/'], ctx());
    subShell.processLine('BACKUP DATABASE');

    const out = subShell.processLine(
      "RUN { SET UNTIL TIME '01-JAN-2099 00:00:00'; RESTORE DATABASE; }",
    ).output.join('\n');
    expect(out).not.toMatch(/RMAN-06026/);
    expect(out).toMatch(/restoring datafile/i);
    subShell.dispose();
  });
});
