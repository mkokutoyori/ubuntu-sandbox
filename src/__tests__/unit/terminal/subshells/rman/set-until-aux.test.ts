/**
 * SET UNTIL / CONNECT AUXILIARY / RESYNC CATALOG (§7 — extras).
 *
 *   SET UNTIL TIME '<date>'        (PITR precursor inside RUN blocks)
 *   SET UNTIL SCN  <n>
 *
 *   CONNECT AUXILIARY [target]    (no-op against an in-memory aux)
 *
 *   RESYNC CATALOG                (no-op for an in-memory catalog,
 *                                  returns ok with the canonical message)
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
    getInstanceState: () => 'MOUNT',
  } as unknown as IRmanOracleContext;
}

describe('SET UNTIL TIME / SCN inside a RUN block', () => {
  beforeEach(() => BackupKey._reset());

  it("SET UNTIL TIME '...' propagates into a subsequent RECOVER", () => {
    const s = new RmanSession(new RmanSessionOptionsBuilder().build(), makeCtx());
    s.connect();
    s.processLine('BACKUP DATABASE');
    const messages: string[] = [];
    s.events$.subscribe(e => {
      if (e.type === 'PROGRESS_UPDATED') messages.push((e as Extract<RmanEvent, { type: 'PROGRESS_UPDATED' }>).message);
    });
    const r = s.processLine(
      "RUN { SET UNTIL TIME '2025-12-31 23:59:00'; RESTORE DATABASE; RECOVER DATABASE; }",
    );
    expect(r.ok).toBe(true);
    expect(messages.some(m => /until time\s+2025-12-31/i.test(m))).toBe(true);
  });

  it('SET UNTIL SCN <n> propagates into a subsequent RECOVER', () => {
    const s = new RmanSession(new RmanSessionOptionsBuilder().build(), makeCtx());
    s.connect();
    s.processLine('BACKUP DATABASE');
    const recovered: number[] = [];
    s.events$.subscribe(e => {
      if (e.type === 'RECOVER_COMPLETED') recovered.push((e as Extract<RmanEvent, { type: 'RECOVER_COMPLETED' }>).toScn.value);
    });
    const r = s.processLine('RUN { SET UNTIL SCN 1900000; RESTORE DATABASE; RECOVER DATABASE; }');
    expect(r.ok).toBe(true);
    expect(recovered).toContain(1_900_000);
  });
});

describe('CONNECT AUXILIARY', () => {
  beforeEach(() => BackupKey._reset());

  it('is accepted as a no-op (in-memory aux is implicit)', () => {
    const s = new RmanSession(new RmanSessionOptionsBuilder().build(), makeCtx());
    s.connect();
    const r = s.processLine('CONNECT AUXILIARY /');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.join('\n')).toMatch(/auxiliary/i);
  });
});

describe('RESYNC CATALOG', () => {
  it('is accepted as a no-op against the in-memory catalog', () => {
    const s = new RmanSession(new RmanSessionOptionsBuilder().build(), makeCtx());
    s.connect();
    const r = s.processLine('RESYNC CATALOG');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.join('\n')).toMatch(/resync|full resync/i);
  });
});
