/**
 * RECOVER granularity (§7.4 RecoverCommand).
 *
 *   RECOVER TABLESPACE <name>
 *   RECOVER DATAFILE  <n>
 *   RECOVER DATABASE UNTIL CANCEL
 */

import { describe, it, expect } from 'vitest';
import {
  RmanSession, RmanSessionOptionsBuilder, DbId, ok,
  type IRmanOracleContext, type RmanEvent,
} from '@/terminal/subshells/rman';

function ctxOpen(): IRmanOracleContext {
  return {
    dbId: DbId.DEFAULT, dbName: 'ORCL',
    vfs: {
      writeFile: () => ok(undefined), readFile: () => ok(new Uint8Array(0)),
      fileExists: () => true, deleteFile: () => ok(undefined), availableBytes: () => 1e10,
    },
    getDatafiles: () => [],
    getSpfileParam: () => undefined,
    getInstanceState: () => 'OPEN',
  } as unknown as IRmanOracleContext;
}

describe('RECOVER TABLESPACE / DATAFILE — §7.4', () => {
  it('RECOVER TABLESPACE USERS succeeds and emits RECOVER_COMPLETED', () => {
    const s = new RmanSession(new RmanSessionOptionsBuilder().build(), ctxOpen());
    s.connect();
    const types: string[] = [];
    s.events$.subscribe(e => types.push(e.type));
    const r = s.processLine('RECOVER TABLESPACE USERS');
    expect(r.ok).toBe(true);
    expect(types).toContain('RECOVER_COMPLETED');
  });

  it('RECOVER DATAFILE 4 succeeds and the scope is reflected in progress', () => {
    const s = new RmanSession(new RmanSessionOptionsBuilder().build(), ctxOpen());
    s.connect();
    const messages: string[] = [];
    s.events$.subscribe(e => {
      if (e.type === 'PROGRESS_UPDATED') messages.push((e as Extract<RmanEvent, { type: 'PROGRESS_UPDATED' }>).message);
    });
    const r = s.processLine('RECOVER DATAFILE 4');
    expect(r.ok).toBe(true);
    expect(messages.some(m => m.includes('datafile 4'))).toBe(true);
  });

  it("RECOVER DATABASE UNTIL CANCEL completes (operator-aborted recovery)", () => {
    const s = new RmanSession(new RmanSessionOptionsBuilder().build(), ctxOpen());
    s.connect();
    const types: string[] = [];
    s.events$.subscribe(e => types.push(e.type));
    const r = s.processLine('RECOVER DATABASE UNTIL CANCEL');
    expect(r.ok).toBe(true);
    expect(types).toContain('JOB_COMPLETED');
  });
});
