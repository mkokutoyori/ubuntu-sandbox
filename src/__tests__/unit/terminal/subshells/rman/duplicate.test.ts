/**
 * DUPLICATE DATABASE (DEF-RMAN-17).
 *
 *   DUPLICATE TARGET DATABASE TO <newdb>;
 *   DUPLICATE DATABASE TO <newdb>;
 *
 * Behaviour:
 *   - Requires a prior backup in the catalog (otherwise RMAN-06023).
 *   - Allocates a channel, emits JOB_STARTED → progress → JOB_COMPLETED.
 *   - Emits one RESTORE_DATAFILE_* per datafile (renamed onto the
 *     auxiliary dbname).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  RmanSession, RmanSessionOptionsBuilder, BackupKey, DbId, ok,
  type IRmanOracleContext, type RmanEvent,
} from '@/terminal/subshells/rman';

function makeCtx(): IRmanOracleContext {
  return {
    dbId: DbId.DEFAULT, dbName: 'ORCL',
    vfs: {
      writeFile: () => ok(undefined),
      readFile:  () => ok(new Uint8Array(0)),
      fileExists: () => true,
      deleteFile: () => ok(undefined),
      availableBytes: () => 1e10,
    },
    getDatafiles: () => [
      { fileNo: 1, path: '/u01/oradata/ORCL/system01.dbf',  sizeBytes: 1_000, tablespace: 'SYSTEM' },
      { fileNo: 4, path: '/u01/oradata/ORCL/users01.dbf',   sizeBytes: 1_000, tablespace: 'USERS'  },
    ],
    getSpfileParam: () => undefined,
  } as unknown as IRmanOracleContext;
}

describe('DUPLICATE DATABASE — DEF-RMAN-17', () => {
  beforeEach(() => BackupKey._reset());

  it('fails when no backup exists', () => {
    const s = new RmanSession(new RmanSessionOptionsBuilder().build(), makeCtx());
    s.connect();
    const types: string[] = [];
    s.events$.subscribe(e => types.push(e.type));
    s.processLine('DUPLICATE TARGET DATABASE TO DUP1');
    expect(types).toContain('JOB_FAILED');
  });

  it('clones once a backup is present, emitting JOB_COMPLETED + restored datafiles', () => {
    const s = new RmanSession(new RmanSessionOptionsBuilder().build(), makeCtx());
    s.connect();
    s.processLine('BACKUP DATABASE');

    const events: RmanEvent[] = [];
    s.events$.subscribe(e => events.push(e));

    s.processLine('DUPLICATE TARGET DATABASE TO DUP1');

    expect(events.map(e => e.type)).toContain('JOB_COMPLETED');
    const restored = events.filter(e => e.type === 'RESTORE_DATAFILE_COMPLETED');
    expect(restored.length).toBe(2);

    // Renamed to the auxiliary dbname (DUP1) in the destination paths.
    const started = events.filter(e => e.type === 'RESTORE_DATAFILE_STARTED') as Array<
      Extract<RmanEvent, { type: 'RESTORE_DATAFILE_STARTED' }>
    >;
    expect(started.every(e => e.to.includes('DUP1'))).toBe(true);
  });

  it('"DUPLICATE DATABASE TO <name>" is also accepted (no TARGET keyword)', () => {
    const s = new RmanSession(new RmanSessionOptionsBuilder().build(), makeCtx());
    s.connect();
    s.processLine('BACKUP DATABASE');
    const types: string[] = [];
    s.events$.subscribe(e => types.push(e.type));
    s.processLine('DUPLICATE DATABASE TO DUP2');
    expect(types).toContain('JOB_COMPLETED');
  });
});
