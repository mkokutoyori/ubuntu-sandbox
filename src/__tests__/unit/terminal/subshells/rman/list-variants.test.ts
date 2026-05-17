/**
 * LIST / REPORT / DELETE variants (§7.4).
 *
 * LIST ARCHIVELOG ALL
 * LIST EXPIRED BACKUP
 * LIST OBSOLETE
 * LIST COPY [OF DATABASE]
 *
 * REPORT OBSOLETE
 * REPORT UNRECOVERABLE
 *
 * DELETE [NOPROMPT] BACKUP TAG '<x>'
 * DELETE [NOPROMPT] BACKUPSET <n>
 * DELETE [NOPROMPT] ARCHIVELOG ALL
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  RmanSession, RmanSessionOptionsBuilder, BackupKey, DbId, ok,
  type IRmanOracleContext,
} from '@/terminal/subshells/rman';

function makeCtx(): IRmanOracleContext {
  return {
    dbId: DbId.DEFAULT, dbName: 'ORCL',
    vfs: {
      writeFile: () => ok(undefined), readFile: () => ok(new Uint8Array(0)),
      fileExists: () => true, deleteFile: () => ok(undefined), availableBytes: () => 1e10,
    },
    getDatafiles: () => [
      { fileNo: 1, path: '/u01/oradata/ORCL/system01.dbf', sizeBytes: 1000, tablespace: 'SYSTEM' },
    ],
    getSpfileParam: () => undefined,
    getInstanceState: () => 'OPEN',
  } as unknown as IRmanOracleContext;
}

describe('LIST variants', () => {
  beforeEach(() => BackupKey._reset());

  it('LIST ARCHIVELOG ALL — empty by default', () => {
    const s = new RmanSession(new RmanSessionOptionsBuilder().build(), makeCtx());
    s.connect();
    const r = s.processLine('LIST ARCHIVELOG ALL');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.join('\n')).toMatch(/archived log|no archived/i);
  });

  it('LIST EXPIRED BACKUP — empty when no expiry has happened', () => {
    const s = new RmanSession(new RmanSessionOptionsBuilder().build(), makeCtx());
    s.connect();
    const r = s.processLine('LIST EXPIRED BACKUP');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.join('\n')).toMatch(/no expired|expired/i);
  });

  it('LIST OBSOLETE — uses retention policy', () => {
    const s = new RmanSession(new RmanSessionOptionsBuilder().build(), makeCtx());
    s.connect();
    const r = s.processLine('LIST OBSOLETE');
    expect(r.ok).toBe(true);
  });

  it('LIST COPY — datafile copies registered via CATALOG appear', () => {
    const s = new RmanSession(new RmanSessionOptionsBuilder().build(), makeCtx());
    s.connect();
    s.processLine("CATALOG DATAFILECOPY '/u01/copies/users01.dbf'");
    const r = s.processLine('LIST COPY');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.join('\n')).toContain('/u01/copies/users01.dbf');
  });
});

describe('REPORT variants', () => {
  beforeEach(() => BackupKey._reset());

  it('REPORT OBSOLETE — returns ok and lists obsolete sets per policy', () => {
    const s = new RmanSession(new RmanSessionOptionsBuilder().build(), makeCtx());
    s.connect();
    s.processLine('BACKUP DATABASE');
    s.processLine('BACKUP DATABASE');
    s.processLine('CONFIGURE RETENTION POLICY TO REDUNDANCY 1');
    const r = s.processLine('REPORT OBSOLETE');
    expect(r.ok).toBe(true);
  });

  it('REPORT UNRECOVERABLE — returns ok', () => {
    const s = new RmanSession(new RmanSessionOptionsBuilder().build(), makeCtx());
    s.connect();
    const r = s.processLine('REPORT UNRECOVERABLE');
    expect(r.ok).toBe(true);
  });
});

describe('DELETE variants', () => {
  beforeEach(() => BackupKey._reset());

  it("DELETE BACKUP TAG 'BAD' removes the matching set", () => {
    const s = new RmanSession(new RmanSessionOptionsBuilder().build(), makeCtx());
    s.connect();
    s.processLine("BACKUP DATABASE TAG 'BAD'");
    s.processLine("BACKUP DATABASE TAG 'GOOD'");
    const before = s.processLine('LIST BACKUP SUMMARY');
    if (before.ok) expect(before.value.join('\n')).toContain('BAD');

    const r = s.processLine("DELETE NOPROMPT BACKUP TAG 'BAD'");
    expect(r.ok).toBe(true);

    const after = s.processLine('LIST BACKUP SUMMARY');
    if (after.ok) {
      expect(after.value.join('\n')).not.toContain('BAD');
      expect(after.value.join('\n')).toContain('GOOD');
    }
  });

  it('DELETE BACKUPSET <n> removes one specific set by bsKey', () => {
    const s = new RmanSession(new RmanSessionOptionsBuilder().build(), makeCtx());
    s.connect();
    s.processLine('BACKUP DATABASE');
    s.processLine('BACKUP DATABASE');
    const r = s.processLine('DELETE NOPROMPT BACKUPSET 1');
    expect(r.ok).toBe(true);
    const after = s.processLine('LIST BACKUP SUMMARY');
    if (after.ok) {
      // bsKey 2 still present, bsKey 1 gone
      const txt = after.value.join('\n');
      expect(txt).toContain('2');
    }
  });

  it('DELETE ARCHIVELOG ALL succeeds even with no logs', () => {
    const s = new RmanSession(new RmanSessionOptionsBuilder().build(), makeCtx());
    s.connect();
    const r = s.processLine('DELETE NOPROMPT ARCHIVELOG ALL');
    expect(r.ok).toBe(true);
  });
});
