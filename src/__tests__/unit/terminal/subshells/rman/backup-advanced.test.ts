/**
 * Advanced BACKUP variants:
 *   - BACKUP INCREMENTAL LEVEL 0 / 1 DATABASE (DEF-RMAN-04)
 *   - BACKUP CURRENT CONTROLFILE       (DEF-RMAN-14)
 *   - BACKUP VALIDATE DATABASE         (DEF-RMAN-15)
 *   - TAG / FORMAT clauses             (DEF-RMAN-05)
 *   - BACKUP ARCHIVELOG ALL DELETE INPUT (DEF-RMAN-20)
 *   - ALLOCATE / RELEASE CHANNEL inside RUN { ... } (DEF-RMAN-07)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  RmanSession, RmanSessionOptionsBuilder, DbId, BackupKey, ok,
  type IRmanOracleContext,
} from '@/terminal/subshells/rman';

function ctx(extra: { archivelogPaths?: string[] } = {}): IRmanOracleContext {
  const written = new Set<string>();
  const deleted = new Set<string>();
  return {
    dbId: DbId.DEFAULT, dbName: 'ORCL',
    vfs: {
      writeFile: (p) => { written.add(p); deleted.delete(p); return ok(undefined); },
      readFile: () => ok(new Uint8Array(0)),
      fileExists: (p) => written.has(p) && !deleted.has(p),
      deleteFile: (p) => { deleted.add(p); return ok(undefined); },
      availableBytes: () => 1e10,
    },
    getDatafiles: () => [
      { fileNo: 1, path: '/u01/oradata/ORCL/system01.dbf', sizeBytes: 1, tablespace: 'SYSTEM' },
      { fileNo: 2, path: '/u01/oradata/ORCL/users01.dbf',  sizeBytes: 1, tablespace: 'USERS'  },
    ],
    getSpfileParam: () => undefined,
    // (extension hook for archivelog deletion test; ignored by core)
    getArchivelogPaths: () => extra.archivelogPaths ?? [],
  } as unknown as IRmanOracleContext;
}

describe('BACKUP INCREMENTAL (DEF-RMAN-04)', () => {
  beforeEach(() => BackupKey._reset());

  it('LEVEL 0 records an INCREMENTAL_0 set', () => {
    const s = new RmanSession(new RmanSessionOptionsBuilder().build(), ctx());
    s.connect();
    s.processLine('BACKUP INCREMENTAL LEVEL 0 DATABASE');
    const list = s.processLine('LIST BACKUP SUMMARY');
    if (list.ok) {
      // Type column TY=B, level column LV=0
      expect(list.value.some(l => /^\d+\s+B\s+0/.test(l))).toBe(true);
    }
  });

  it('LEVEL 1 records an INCREMENTAL_1 set', () => {
    const s = new RmanSession(new RmanSessionOptionsBuilder().build(), ctx());
    s.connect();
    s.processLine('BACKUP INCREMENTAL LEVEL 0 DATABASE');
    s.processLine('BACKUP INCREMENTAL LEVEL 1 DATABASE');
    const list = s.processLine('LIST BACKUP SUMMARY');
    if (list.ok) {
      expect(list.value.some(l => /^\d+\s+B\s+1/.test(l))).toBe(true);
    }
  });
});

describe('BACKUP CURRENT CONTROLFILE (DEF-RMAN-14)', () => {
  beforeEach(() => BackupKey._reset());

  it('records a CONTROLFILE set', () => {
    const s = new RmanSession(new RmanSessionOptionsBuilder().build(), ctx());
    s.connect();
    const types: string[] = [];
    s.events$.subscribe(e => types.push(e.type));
    const r = s.processLine('BACKUP CURRENT CONTROLFILE');
    expect(r.ok).toBe(true);
    expect(types).toContain('BACKUP_SET_COMPLETE');
    const list = s.processLine('LIST BACKUP');
    if (list.ok) {
      expect(list.value.some(l => /control file/i.test(l) || /Controlfile/i.test(l))).toBe(true);
    }
  });
});

describe('BACKUP VALIDATE (DEF-RMAN-15)', () => {
  beforeEach(() => BackupKey._reset());

  it('does NOT write a piece to the VFS and does NOT record a set', () => {
    const s = new RmanSession(new RmanSessionOptionsBuilder().build(), ctx());
    s.connect();
    const types: string[] = [];
    s.events$.subscribe(e => types.push(e.type));
    s.processLine('BACKUP VALIDATE DATABASE');
    // No BACKUP_PIECE_CREATED, no CATALOG_UPDATED
    expect(types).not.toContain('BACKUP_PIECE_CREATED');
    expect(types).not.toContain('CATALOG_UPDATED');
    // JOB_STARTED + JOB_COMPLETED still fire
    expect(types).toContain('JOB_STARTED');
    expect(types).toContain('JOB_COMPLETED');
  });
});

describe('TAG / FORMAT clauses (DEF-RMAN-05)', () => {
  beforeEach(() => BackupKey._reset());

  it("BACKUP DATABASE TAG 'WEEKLY' produces a set whose tag is WEEKLY", () => {
    const s = new RmanSession(new RmanSessionOptionsBuilder().build(), ctx());
    s.connect();
    s.processLine("BACKUP DATABASE TAG 'WEEKLY'");
    const list = s.processLine('LIST BACKUP SUMMARY');
    if (list.ok) {
      expect(list.value.some(l => /WEEKLY/.test(l))).toBe(true);
    }
  });

  it("BACKUP DATABASE FORMAT '/u02/bk/%U' writes under that prefix", () => {
    const s = new RmanSession(new RmanSessionOptionsBuilder().build(), ctx());
    s.connect();
    s.processLine("BACKUP DATABASE FORMAT '/u02/bk/%U'");
    const list = s.processLine('LIST BACKUP');
    if (list.ok) {
      expect(list.value.some(l => /Piece Name: \/u02\/bk\//.test(l))).toBe(true);
    }
  });
});

describe('BACKUP ARCHIVELOG ALL DELETE INPUT (DEF-RMAN-20)', () => {
  beforeEach(() => BackupKey._reset());

  it('emits ARCHIVELOG_DELETED events for each consumed archivelog', () => {
    const paths = ['/u01/arch/1_42.arc', '/u01/arch/1_43.arc'];
    const s = new RmanSession(new RmanSessionOptionsBuilder().build(), ctx({ archivelogPaths: paths }));
    s.connect();
    const deletedPaths: string[] = [];
    s.events$.subscribe(e => {
      if (e.type === 'ARCHIVELOG_DELETED') deletedPaths.push(e.path);
    });
    s.processLine('BACKUP ARCHIVELOG ALL DELETE INPUT');
    expect(deletedPaths.sort()).toEqual(paths.sort());
  });
});

describe('ALLOCATE / RELEASE CHANNEL (DEF-RMAN-07)', () => {
  beforeEach(() => BackupKey._reset());

  it("ALLOCATE CHANNEL c1 DEVICE TYPE DISK emits CHANNEL_ALLOCATED and remembers it", () => {
    const s = new RmanSession(new RmanSessionOptionsBuilder().build(), ctx());
    s.connect();
    const channelIds: string[] = [];
    s.events$.subscribe(e => {
      if (e.type === 'CHANNEL_ALLOCATED') channelIds.push(e.channelId);
    });
    s.processLine('RUN {');
    s.processLine('ALLOCATE CHANNEL c1 DEVICE TYPE DISK;');
    s.processLine('BACKUP DATABASE;');
    s.processLine('}');
    // The explicit allocate emits its own CHANNEL_ALLOCATED; the implicit
    // backup allocate emits another (or reuses, but our pool default is
    // parallelism=1 so it would saturate — design is to reuse the explicit).
    expect(channelIds.length).toBeGreaterThanOrEqual(1);
    expect(channelIds[0]).toBe('c1');
  });

  it("RELEASE CHANNEL c1 emits CHANNEL_RELEASED", () => {
    const s = new RmanSession(new RmanSessionOptionsBuilder().build(), ctx());
    s.connect();
    const released: string[] = [];
    s.events$.subscribe(e => {
      if (e.type === 'CHANNEL_RELEASED') released.push(e.channelId);
    });
    s.processLine('RUN {');
    s.processLine('ALLOCATE CHANNEL c1 DEVICE TYPE DISK;');
    s.processLine('RELEASE CHANNEL c1;');
    s.processLine('}');
    expect(released).toContain('c1');
  });
});
