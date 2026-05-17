/**
 * RECOVER … UNTIL clauses (DEF-RMAN-18).
 *
 *   RECOVER DATABASE UNTIL SCN <n>
 *   RECOVER DATABASE UNTIL TIME '<oracle-date>'
 *   RECOVER DATABASE UNTIL SEQUENCE <n> THREAD <n>
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  RmanSession, RmanSessionOptionsBuilder, DbId, BackupKey, ok,
  type IRmanOracleContext,
} from '@/terminal/subshells/rman';

function ctx(): IRmanOracleContext {
  return {
    dbId: DbId.DEFAULT, dbName: 'ORCL',
    vfs: {
      writeFile: () => ok(undefined), readFile: () => ok(new Uint8Array(0)),
      fileExists: () => true, deleteFile: () => ok(undefined), availableBytes: () => 1e10,
    },
    getDatafiles: () => [],
    getSpfileParam: () => undefined,
  };
}

describe('RECOVER UNTIL …', () => {
  beforeEach(() => BackupKey._reset());

  it('RECOVER DATABASE UNTIL SCN 1900000 sets fromScn in the event', () => {
    const s = new RmanSession(new RmanSessionOptionsBuilder().build(), ctx());
    s.connect();
    let fromScn = -1;
    s.events$.subscribe(e => {
      if (e.type === 'RECOVER_STARTED') fromScn = e.fromScn.value;
    });
    s.processLine('RECOVER DATABASE UNTIL SCN 1900000');
    expect(fromScn).toBe(1900000);
  });

  it("RECOVER DATABASE UNTIL TIME '06-MAY-2026 14:30:22' parses and emits", () => {
    const s = new RmanSession(new RmanSessionOptionsBuilder().build(), ctx());
    s.connect();
    const types: string[] = [];
    s.events$.subscribe(e => types.push(e.type));
    const r = s.processLine("RECOVER DATABASE UNTIL TIME '06-MAY-2026 14:30:22'");
    expect(r.ok).toBe(true);
    expect(types).toContain('RECOVER_STARTED');
    expect(types).toContain('RECOVER_COMPLETED');
  });

  it('RECOVER DATABASE with no UNTIL still works (full recovery)', () => {
    const s = new RmanSession(new RmanSessionOptionsBuilder().build(), ctx());
    s.connect();
    const r = s.processLine('RECOVER DATABASE');
    expect(r.ok).toBe(true);
  });

  it('rejects an invalid SCN', () => {
    const s = new RmanSession(new RmanSessionOptionsBuilder().build(), ctx());
    s.connect();
    const r = s.processLine('RECOVER DATABASE UNTIL SCN notanumber');
    expect(r.ok).toBe(false);
  });
});
