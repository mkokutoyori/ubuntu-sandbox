/**
 * Final command-catalog polish (§7.4).
 *
 *   BACKUP NOT BACKED UP n TIMES DATABASE  (backup optimization)
 *   SHOW CHANNEL                           (lists configured/allocated)
 *   HELP                                   (full command catalogue)
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
      writeFile: () => ok(undefined), readFile: () => ok(new Uint8Array(0)),
      fileExists: () => true, deleteFile: () => ok(undefined), availableBytes: () => 1e10,
    },
    getDatafiles: () => [
      { fileNo: 1, path: '/u01/oradata/ORCL/system01.dbf', sizeBytes: 1_000, tablespace: 'SYSTEM' },
    ],
    getSpfileParam: () => undefined,
    getInstanceState: () => 'OPEN',
  } as unknown as IRmanOracleContext;
}

describe('BACKUP NOT BACKED UP n TIMES', () => {
  beforeEach(() => BackupKey._reset());

  it('skips datafiles already backed up n times', () => {
    const s = new RmanSession(new RmanSessionOptionsBuilder().build(), makeCtx());
    s.connect();
    s.processLine('BACKUP DATABASE');           // count = 1
    s.processLine('BACKUP DATABASE');           // count = 2

    const types: string[] = [];
    s.events$.subscribe(e => types.push(e.type));
    // Threshold ≥ 2 → every file is already covered → emits BACKUP_VALIDATED
    // (no piece written) and JOB_COMPLETED.
    s.processLine('BACKUP NOT BACKED UP 2 TIMES DATABASE');
    expect(types).toContain('JOB_COMPLETED');
    expect(types).not.toContain('BACKUP_PIECE_CREATED');
  });

  it('runs a normal backup when the threshold is not met', () => {
    const s = new RmanSession(new RmanSessionOptionsBuilder().build(), makeCtx());
    s.connect();
    s.processLine('BACKUP DATABASE');  // count = 1
    const created: number = (() => {
      const types: string[] = [];
      s.events$.subscribe(e => types.push(e.type));
      s.processLine('BACKUP NOT BACKED UP 5 TIMES DATABASE');
      return types.filter(t => t === 'BACKUP_PIECE_CREATED').length;
    })();
    expect(created).toBeGreaterThan(0);
  });
});

describe('SHOW CHANNEL', () => {
  it('reports the default DISK channels when none are explicitly configured', () => {
    const s = new RmanSession(new RmanSessionOptionsBuilder().build(), makeCtx());
    s.connect();
    const r = s.processLine('SHOW CHANNEL');
    expect(r.ok).toBe(true);
    if (r.ok) {
      const txt = r.value.join('\n');
      expect(txt).toMatch(/CHANNEL.*DEVICE TYPE.*DISK/i);
    }
  });

  it('reports each explicit channel allocated in a RUN block', () => {
    const s = new RmanSession(new RmanSessionOptionsBuilder().build(), makeCtx());
    s.connect();
    s.processLine('RUN { ALLOCATE CHANNEL c1 DEVICE TYPE DISK; }');
    const r = s.processLine('SHOW CHANNEL');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.join('\n')).toContain('c1');
    void ({} as RmanEvent);
  });
});

describe('HELP — full command catalogue', () => {
  it('lists every top-level RMAN verb supported by the dispatcher', () => {
    const s = new RmanSession(new RmanSessionOptionsBuilder().build(), makeCtx());
    s.connect();
    const r = s.processLine('HELP');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const txt = r.value.join('\n');
    for (const verb of [
      'ALLOCATE', 'BACKUP', 'CATALOG', 'CHANGE', 'CONFIGURE', 'CONNECT',
      'CROSSCHECK', 'DELETE', 'DUPLICATE', 'EXIT', 'HELP', 'LIST',
      'RECOVER', 'RELEASE', 'REPORT', 'RESTORE', 'RUN', 'SET',
      'SHOW', 'QUIT',
    ]) {
      expect(txt).toContain(verb);
    }
  });
});
