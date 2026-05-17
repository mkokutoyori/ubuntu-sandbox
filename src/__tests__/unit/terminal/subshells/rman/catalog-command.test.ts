/**
 * CATALOG DATAFILECOPY / BACKUPPIECE (DEF-RMAN-16).
 *
 * The CATALOG command lets a DBA register an existing file with the RMAN
 * catalog after the fact (e.g. a piece copied in from another server).
 *
 *   CATALOG DATAFILECOPY '/u01/copies/users01.dbf';
 *   CATALOG BACKUPPIECE  '/u01/backup/df_1_1.bkp';
 *
 * Effects:
 *   - File must exist in the VFS (otherwise RMAN-06004 / fs error).
 *   - A new BackupSet is appended to the catalog with the supplied path.
 *   - A CATALOG_UPDATED event fires.
 *   - LIST BACKUP afterwards reports the new piece.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  RmanSession, RmanSessionOptionsBuilder, BackupKey, DbId, ok,
  type IRmanOracleContext,
} from '@/terminal/subshells/rman';

function makeCtx(files: Set<string> = new Set()): IRmanOracleContext {
  return {
    dbId: DbId.DEFAULT, dbName: 'ORCL',
    vfs: {
      writeFile: () => ok(undefined),
      readFile:  () => ok(new Uint8Array(0)),
      fileExists: (p: string) => files.has(p),
      deleteFile: () => ok(undefined),
      availableBytes: () => 1e10,
    },
    getDatafiles: () => [],
    getSpfileParam: () => undefined,
  } as unknown as IRmanOracleContext;
}

describe('CATALOG DATAFILECOPY — DEF-RMAN-16', () => {
  beforeEach(() => BackupKey._reset());

  it("rejects when the target file doesn't exist", () => {
    const s = new RmanSession(new RmanSessionOptionsBuilder().build(), makeCtx());
    s.connect();
    const r = s.processLine("CATALOG DATAFILECOPY '/missing/file.dbf'");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('RMAN_06004');
  });

  it('records an existing copy and emits CATALOG_UPDATED', () => {
    const files = new Set(['/u01/copies/users01.dbf']);
    const s = new RmanSession(new RmanSessionOptionsBuilder().build(), makeCtx(files));
    s.connect();
    const events: string[] = [];
    s.events$.subscribe(e => events.push(e.type));

    const r = s.processLine("CATALOG DATAFILECOPY '/u01/copies/users01.dbf'");
    expect(r.ok).toBe(true);
    expect(events).toContain('CATALOG_UPDATED');
  });
});

describe('CATALOG BACKUPPIECE — DEF-RMAN-16', () => {
  beforeEach(() => BackupKey._reset());

  it('rejects when the piece file is absent', () => {
    const s = new RmanSession(new RmanSessionOptionsBuilder().build(), makeCtx());
    s.connect();
    const r = s.processLine("CATALOG BACKUPPIECE '/missing/df.bkp'");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('RMAN_06004');
  });

  it('appends the piece to the catalog so LIST BACKUP sees it', () => {
    const files = new Set(['/u01/backup/df_1_1.bkp']);
    const s = new RmanSession(new RmanSessionOptionsBuilder().build(), makeCtx(files));
    s.connect();
    const r = s.processLine("CATALOG BACKUPPIECE '/u01/backup/df_1_1.bkp'");
    expect(r.ok).toBe(true);

    const list = s.processLine('LIST BACKUP');
    expect(list.ok).toBe(true);
    if (list.ok) {
      expect(list.value.join('\n')).toContain('/u01/backup/df_1_1.bkp');
    }
  });
});
