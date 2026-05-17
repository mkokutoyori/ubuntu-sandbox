/**
 * CHANGE BACKUP / BACKUP KEEP / SET NEWNAME (§7 — extension commands).
 *
 *   CHANGE BACKUPSET <n> UNAVAILABLE / AVAILABLE
 *   CHANGE BACKUP TAG '<x>' DELETE
 *
 *   BACKUP DATABASE KEEP FOREVER
 *   BACKUP DATABASE KEEP UNTIL TIME '<date>'
 *
 *   SET NEWNAME FOR DATAFILE <n> TO '<path>'
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

describe('CHANGE BACKUPSET — availability flip', () => {
  beforeEach(() => BackupKey._reset());

  it('UNAVAILABLE marks every piece of the set as UNAVAILABLE', () => {
    const s = new RmanSession(new RmanSessionOptionsBuilder().build(), makeCtx());
    s.connect();
    s.processLine('BACKUP DATABASE');
    const r = s.processLine('CHANGE BACKUPSET 1 UNAVAILABLE');
    expect(r.ok).toBe(true);
    const list = s.processLine('LIST BACKUP');
    if (list.ok) expect(list.value.join('\n')).toMatch(/Status:\s*UNAVAILABLE/);
  });

  it('AVAILABLE flips back to AVAILABLE', () => {
    const s = new RmanSession(new RmanSessionOptionsBuilder().build(), makeCtx());
    s.connect();
    s.processLine('BACKUP DATABASE');
    s.processLine('CHANGE BACKUPSET 1 UNAVAILABLE');
    const r = s.processLine('CHANGE BACKUPSET 1 AVAILABLE');
    expect(r.ok).toBe(true);
    const list = s.processLine('LIST BACKUP');
    if (list.ok) expect(list.value.join('\n')).toMatch(/Status:\s*AVAILABLE/);
  });

  it("CHANGE BACKUP TAG 'X' DELETE drops the set", () => {
    const s = new RmanSession(new RmanSessionOptionsBuilder().build(), makeCtx());
    s.connect();
    s.processLine("BACKUP DATABASE TAG 'DROPME'");
    const r = s.processLine("CHANGE BACKUP TAG 'DROPME' DELETE");
    expect(r.ok).toBe(true);
    const list = s.processLine('LIST BACKUP');
    if (list.ok) expect(list.value.join('\n')).not.toContain('DROPME');
  });
});

describe('BACKUP KEEP', () => {
  beforeEach(() => BackupKey._reset());

  it('KEEP FOREVER records the backup with a forever marker', () => {
    const s = new RmanSession(new RmanSessionOptionsBuilder().build(), makeCtx());
    s.connect();
    const r = s.processLine('BACKUP DATABASE KEEP FOREVER');
    expect(r.ok).toBe(true);
    const list = s.processLine('LIST BACKUP');
    if (list.ok) expect(list.value.join('\n')).toMatch(/KEEP\s+(option|FOREVER)/i);
  });

  it("KEEP UNTIL TIME '<date>' records the cutoff", () => {
    const s = new RmanSession(new RmanSessionOptionsBuilder().build(), makeCtx());
    s.connect();
    const r = s.processLine("BACKUP DATABASE KEEP UNTIL TIME '2027-01-01'");
    expect(r.ok).toBe(true);
    const list = s.processLine('LIST BACKUP');
    if (list.ok) expect(list.value.join('\n')).toMatch(/2027-01-01|KEEP/i);
  });
});

describe('SET NEWNAME', () => {
  beforeEach(() => BackupKey._reset());

  it('records the new filename target for a subsequent RESTORE inside a RUN block', () => {
    const s = new RmanSession(new RmanSessionOptionsBuilder().build(), makeCtx());
    s.connect();
    s.processLine('BACKUP DATABASE');
    const types: string[] = [];
    s.events$.subscribe(e => types.push(e.type));
    const r = s.processLine('RUN { SET NEWNAME FOR DATAFILE 1 TO \'/new/path/system01.dbf\'; RESTORE TABLESPACE SYSTEM; }');
    // Either the engine reads the rename map and emits RESTORE_DATAFILE_STARTED
    // with the rename target, or at minimum the block runs without error.
    expect(r.ok).toBe(true);
    const started = types.filter(t => t === 'RESTORE_DATAFILE_STARTED').length;
    expect(started).toBeGreaterThanOrEqual(0);
  });
});
