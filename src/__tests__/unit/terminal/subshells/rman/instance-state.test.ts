/**
 * Instance state validation (DEF-RMAN-09, DEF-RMAN-19).
 *
 *   - CONNECT TARGET against a SHUTDOWN instance SUCCEEDS. Real RMAN
 *     answers "connected to target database (not started)" — that is the
 *     precondition of `STARTUP`, which is RMAN's job. The two cases below
 *     used to assert a refusal; that premise made RMAN's own STARTUP
 *     unreachable and was corrected with the instance-control lot.
 *   - RESTORE DATABASE requires MOUNT or NOMOUNT — running it against
 *     an instance still OPEN raises RMAN-06403.
 *   - RECOVER DATABASE requires MOUNT or OPEN.
 *   - BACKUP is allowed in OPEN.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  RmanSession, RmanSessionOptionsBuilder, DbId, BackupKey, ok,
  type IRmanOracleContext,
} from '@/terminal/subshells/rman';

type Instance = 'SHUTDOWN' | 'NOMOUNT' | 'MOUNT' | 'OPEN';

function ctxAt(state: Instance): IRmanOracleContext {
  return {
    dbId: DbId.DEFAULT, dbName: 'ORCL',
    vfs: {
      writeFile: () => ok(undefined), readFile: () => ok(new Uint8Array(0)),
      fileExists: () => true, deleteFile: () => ok(undefined), availableBytes: () => 1e10,
    },
    getDatafiles: () => [],
    getSpfileParam: () => undefined,
    getInstanceState: () => state,
  } as unknown as IRmanOracleContext;
}

describe('CONNECT TARGET — DEF-RMAN-19', () => {
  beforeEach(() => BackupKey._reset());

  it('against a SHUTDOWN instance, CONNECT succeeds so STARTUP can follow', () => {
    const s = new RmanSession(new RmanSessionOptionsBuilder().build(), ctxAt('SHUTDOWN'));
    expect(s.processLine('CONNECT TARGET /').ok).toBe(true);
  });

  it('against an OPEN instance, CONNECT succeeds', () => {
    const s = new RmanSession(new RmanSessionOptionsBuilder().build(), ctxAt('OPEN'));
    const r = s.processLine('CONNECT TARGET /');
    expect(r.ok).toBe(true);
  });
});

describe('RESTORE DATABASE — DEF-RMAN-09', () => {
  beforeEach(() => BackupKey._reset());

  it('against an OPEN instance, RESTORE returns RMAN_06403', () => {
    const s = new RmanSession(new RmanSessionOptionsBuilder().build(), ctxAt('OPEN'));
    s.connect();
    // Even after a BACKUP, RESTORE on an OPEN instance is rejected
    s.processLine('BACKUP DATABASE');
    const types: string[] = [];
    s.events$.subscribe(e => types.push(e.type));
    s.processLine('RESTORE DATABASE');
    const ev = types.find(t => t === 'JOB_FAILED');
    expect(ev).toBeDefined();
  });

  it('against a MOUNT instance, RESTORE succeeds (after a prior BACKUP)', () => {
    const s = new RmanSession(new RmanSessionOptionsBuilder().build(), ctxAt('MOUNT'));
    s.connect();
    s.processLine('BACKUP DATABASE');
    const types: string[] = [];
    s.events$.subscribe(e => types.push(e.type));
    s.processLine('RESTORE DATABASE');
    expect(types).toContain('JOB_COMPLETED');
    expect(types).not.toContain('JOB_FAILED');
  });
});

describe('RECOVER DATABASE — DEF-RMAN-09', () => {
  it('against a SHUTDOWN instance, RECOVER runs but the job refuses', () => {
    const s = new RmanSession(new RmanSessionOptionsBuilder().build(), ctxAt('SHUTDOWN'));
    expect(s.processLine('CONNECT TARGET /').ok).toBe(true);
    // engine.run() reports a job refusal through the event stream, not
    // through its Result — the operator-visible RMAN-06403 is asserted
    // in oracle-rman-instance-control.test.ts, on the real lab.
    expect(s.processLine('RECOVER DATABASE').ok).toBe(true);
  });

  it('against an OPEN instance, RECOVER succeeds', () => {
    const s = new RmanSession(new RmanSessionOptionsBuilder().build(), ctxAt('OPEN'));
    s.connect();
    const r = s.processLine('RECOVER DATABASE');
    expect(r.ok).toBe(true);
  });
});
