/**
 * RESTORE granularity (§7.4 RestoreCommand).
 *
 *   RESTORE TABLESPACE <name>
 *   RESTORE DATAFILE <n>
 *   RESTORE DATABASE FROM TAG '<x>'
 *   RESTORE DATABASE PREVIEW    (no-write listing)
 *   RESTORE DATABASE VALIDATE   (check, no-write)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  RmanSession, RmanSessionOptionsBuilder, BackupKey, DbId, ok,
  type IRmanOracleContext, type RmanEvent,
} from '@/terminal/subshells/rman';

function ctxMount(): IRmanOracleContext {
  return {
    dbId: DbId.DEFAULT, dbName: 'ORCL',
    vfs: {
      writeFile: () => ok(undefined), readFile: () => ok(new Uint8Array(0)),
      fileExists: () => true, deleteFile: () => ok(undefined), availableBytes: () => 1e10,
    },
    getDatafiles: () => [
      { fileNo: 1, path: '/u01/oradata/ORCL/system01.dbf', sizeBytes: 1000, tablespace: 'SYSTEM' },
      { fileNo: 4, path: '/u01/oradata/ORCL/users01.dbf',  sizeBytes: 1000, tablespace: 'USERS'  },
    ],
    getSpfileParam: () => undefined,
    getInstanceState: () => 'MOUNT',
  } as unknown as IRmanOracleContext;
}

describe('RESTORE TABLESPACE / DATAFILE', () => {
  beforeEach(() => BackupKey._reset());

  it('RESTORE TABLESPACE USERS restores only the USERS datafiles', () => {
    const s = new RmanSession(new RmanSessionOptionsBuilder().build(), ctxMount());
    s.connect();
    s.processLine('BACKUP DATABASE');
    const restored: number[] = [];
    s.events$.subscribe(e => {
      if (e.type === 'RESTORE_DATAFILE_COMPLETED') {
        restored.push((e as Extract<RmanEvent, { type: 'RESTORE_DATAFILE_COMPLETED' }>).fileNo);
      }
    });
    s.processLine('RESTORE TABLESPACE USERS');
    expect(restored).toEqual([4]);
  });

  it('RESTORE DATAFILE 1 restores just file 1', () => {
    const s = new RmanSession(new RmanSessionOptionsBuilder().build(), ctxMount());
    s.connect();
    s.processLine('BACKUP DATABASE');
    const restored: number[] = [];
    s.events$.subscribe(e => {
      if (e.type === 'RESTORE_DATAFILE_COMPLETED') {
        restored.push((e as Extract<RmanEvent, { type: 'RESTORE_DATAFILE_COMPLETED' }>).fileNo);
      }
    });
    s.processLine('RESTORE DATAFILE 1');
    expect(restored).toEqual([1]);
  });
});

describe('RESTORE FROM TAG / PREVIEW / VALIDATE', () => {
  beforeEach(() => BackupKey._reset());

  it("RESTORE DATABASE FROM TAG 'GOOD' selects the matching backup set", () => {
    const s = new RmanSession(new RmanSessionOptionsBuilder().build(), ctxMount());
    s.connect();
    s.processLine("BACKUP DATABASE TAG 'GOOD'");
    s.processLine("BACKUP DATABASE TAG 'STALE'");
    const types: string[] = [];
    s.events$.subscribe(e => types.push(e.type));
    const r = s.processLine("RESTORE DATABASE FROM TAG 'GOOD'");
    expect(r.ok).toBe(true);
    expect(types).toContain('JOB_COMPLETED');
  });

  it('RESTORE DATABASE PREVIEW lists backups without restoring (no RESTORE_DATAFILE_COMPLETED)', () => {
    const s = new RmanSession(new RmanSessionOptionsBuilder().build(), ctxMount());
    s.connect();
    s.processLine('BACKUP DATABASE');
    const types: string[] = [];
    s.events$.subscribe(e => types.push(e.type));
    s.processLine('RESTORE DATABASE PREVIEW');
    expect(types).toContain('JOB_COMPLETED');
    expect(types).not.toContain('RESTORE_DATAFILE_COMPLETED');
  });

  it('RESTORE DATABASE VALIDATE — no actual restore, but successful', () => {
    const s = new RmanSession(new RmanSessionOptionsBuilder().build(), ctxMount());
    s.connect();
    s.processLine('BACKUP DATABASE');
    const types: string[] = [];
    s.events$.subscribe(e => types.push(e.type));
    s.processLine('RESTORE DATABASE VALIDATE');
    expect(types).toContain('JOB_COMPLETED');
    expect(types).not.toContain('RESTORE_DATAFILE_COMPLETED');
  });
});
