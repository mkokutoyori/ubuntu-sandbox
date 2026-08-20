/**
 * RECOVER after RESTORE must fail without archivelogs to bridge the gap
 * (audit rapport 10, constat MAJEUR "RECOVER DATABASE réussit toujours,
 * même sans archivelog disponible").
 *
 * A RECOVER invoked on its own (no preceding RESTORE this session) still
 * succeeds trivially — there is no known SCN gap to bridge, matching the
 * routine "recover a still-current datafile" call sites tested elsewhere.
 *
 * RESTORE/RECOVER run through the async job engine, whose Result is
 * always ok() at the RmanSession level — failures surface only as a
 * JOB_FAILED event rendered into the sub-shell's text output (same
 * pattern as oracle-rman-backup-piece-coherence.test.ts), hence driving
 * this through ReactiveRmanSubShell rather than raw RmanSession.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  ReactiveRmanSubShell, DbId, BackupKey, ok,
  type IRmanOracleContext,
} from '@/terminal/subshells/rman';

function ctx(archivelogPaths: string[]): IRmanOracleContext {
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
    getArchivelogPaths: () => archivelogPaths,
  } as unknown as IRmanOracleContext;
}

describe('RECOVER after RESTORE requires archivelogs', () => {
  beforeEach(() => BackupKey._reset());

  it('fails with RMAN-06054 when RESTORE left a gap and no archivelog is available', () => {
    const { subShell } = ReactiveRmanSubShell.fromContext(['target', '/'], ctx([]));
    subShell.processLine('BACKUP DATABASE');
    subShell.processLine('RESTORE DATABASE');

    const out = subShell.processLine('RECOVER DATABASE').output.join('\n');
    expect(out).toMatch(/RMAN-06054/);
    expect(out).toMatch(/archived log/i);
    subShell.dispose();
  });

  it('succeeds when RESTORE left a gap but archivelogs are available to bridge it', () => {
    const { subShell } = ReactiveRmanSubShell.fromContext(
      ['target', '/'], ctx(['/u01/backup/arch/arch_1_42.arc']),
    );
    subShell.processLine('BACKUP DATABASE');
    subShell.processLine('RESTORE DATABASE');

    const out = subShell.processLine('RECOVER DATABASE').output.join('\n');
    expect(out).not.toMatch(/RMAN-06054/);
    expect(out).toMatch(/media recovery complete/i);
    subShell.dispose();
  });

  it('a standalone RECOVER with no preceding RESTORE still succeeds without archivelogs', () => {
    const { subShell } = ReactiveRmanSubShell.fromContext(['target', '/'], ctx([]));
    const out = subShell.processLine('RECOVER DATABASE').output.join('\n');
    expect(out).not.toMatch(/RMAN-06054/);
    expect(out).toMatch(/media recovery complete/i);
    subShell.dispose();
  });

  it('a second RECOVER after a successful one no longer requires archivelogs', () => {
    const { subShell } = ReactiveRmanSubShell.fromContext(
      ['target', '/'], ctx(['/u01/backup/arch/arch_1_42.arc']),
    );
    subShell.processLine('BACKUP DATABASE');
    subShell.processLine('RESTORE DATABASE');
    expect(subShell.processLine('RECOVER DATABASE').output.join('\n')).not.toMatch(/RMAN-06054/);
    // The gap was already closed by the first RECOVER — re-running it
    // (e.g. an idempotent retry) shouldn't demand archivelogs again.
    expect(subShell.processLine('RECOVER DATABASE').output.join('\n')).not.toMatch(/RMAN-06054/);
    subShell.dispose();
  });
});
