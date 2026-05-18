/**
 * CONTROLFILE AUTOBACKUP + RESTORE CONTROLFILE FROM AUTOBACKUP.
 *
 * Quand `CONFIGURE CONTROLFILE AUTOBACKUP ON`, chaque BACKUP DATABASE
 * (ou DATAFILE / TABLESPACE / INCREMENTAL / ARCHIVELOG) doit
 * automatiquement enchaîner un BACKUP CONTROLFILE tagué AUTOBACKUP.
 *
 * Inversement, RESTORE CONTROLFILE FROM AUTOBACKUP doit n'être accepté
 * qu'en NOMOUNT/MOUNT et émettre les lignes canoniques Oracle.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  RmanSession, RmanSessionOptionsBuilder, BackupKey, DbId, ok,
  DeviceCatalogRegistry,
  type IRmanOracleContext, type RmanEvent,
} from '@/terminal/subshells/rman';

function ctx(state: 'OPEN' | 'MOUNT' | 'NOMOUNT' | 'SHUTDOWN'): IRmanOracleContext {
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
    getInstanceState: () => state,
    getControlFilePath: () => '/u01/oradata/ORCL/control01.ctl',
  } as unknown as IRmanOracleContext;
}

describe('CONTROLFILE AUTOBACKUP — auto-trigger', () => {
  beforeEach(() => { BackupKey._reset(); DeviceCatalogRegistry._reset(); });

  it('after BACKUP DATABASE with AUTOBACKUP ON, a CF backup is recorded', () => {
    const s = new RmanSession(new RmanSessionOptionsBuilder().build(), ctx('OPEN'));
    s.connect();
    s.processLine('CONFIGURE CONTROLFILE AUTOBACKUP ON');
    const tags: string[] = [];
    s.events$.subscribe(e => {
      if (e.type === 'BACKUP_SET_COMPLETE') {
        tags.push((e as Extract<RmanEvent, { type: 'BACKUP_SET_COMPLETE' }>).tag.label);
      }
    });
    s.processLine('BACKUP DATABASE');
    // Two backup sets: the DB one + the AUTOBACKUP CF one
    expect(tags.length).toBe(2);
    expect(tags).toContain('AUTOBACKUP');
  });

  it('with AUTOBACKUP OFF, no CF backup follows', () => {
    const s = new RmanSession(new RmanSessionOptionsBuilder().build(), ctx('OPEN'));
    s.connect();
    s.processLine('CONFIGURE CONTROLFILE AUTOBACKUP OFF');
    const tags: string[] = [];
    s.events$.subscribe(e => {
      if (e.type === 'BACKUP_SET_COMPLETE') {
        tags.push((e as Extract<RmanEvent, { type: 'BACKUP_SET_COMPLETE' }>).tag.label);
      }
    });
    s.processLine('BACKUP DATABASE');
    expect(tags.length).toBe(1);
    expect(tags).not.toContain('AUTOBACKUP');
  });

  it('BACKUP CURRENT CONTROLFILE does not recurse (no AUTOBACKUP after manual CF backup)', () => {
    const s = new RmanSession(new RmanSessionOptionsBuilder().build(), ctx('OPEN'));
    s.connect();
    s.processLine('CONFIGURE CONTROLFILE AUTOBACKUP ON');
    const tags: string[] = [];
    s.events$.subscribe(e => {
      if (e.type === 'BACKUP_SET_COMPLETE') {
        tags.push((e as Extract<RmanEvent, { type: 'BACKUP_SET_COMPLETE' }>).tag.label);
      }
    });
    s.processLine('BACKUP CURRENT CONTROLFILE');
    // Only one — the explicit one. No AUTOBACKUP recursion.
    expect(tags.length).toBe(1);
    expect(tags).not.toContain('AUTOBACKUP');
  });

  it('BACKUP TABLESPACE and BACKUP DATAFILE also trigger the autobackup', () => {
    const s = new RmanSession(new RmanSessionOptionsBuilder().build(), ctx('OPEN'));
    s.connect();
    s.processLine('CONFIGURE CONTROLFILE AUTOBACKUP ON');
    const tags: string[] = [];
    s.events$.subscribe(e => {
      if (e.type === 'BACKUP_SET_COMPLETE') {
        tags.push((e as Extract<RmanEvent, { type: 'BACKUP_SET_COMPLETE' }>).tag.label);
      }
    });
    s.processLine('BACKUP TABLESPACE USERS');
    s.processLine('BACKUP DATAFILE 1');
    // 2 explicit backups + 2 AUTOBACKUP = 4
    expect(tags.length).toBe(4);
    expect(tags.filter(t => t === 'AUTOBACKUP').length).toBe(2);
  });
});

describe('RESTORE CONTROLFILE FROM AUTOBACKUP', () => {
  beforeEach(() => { BackupKey._reset(); DeviceCatalogRegistry._reset(); });

  it('rejects when instance is OPEN', () => {
    const s = new RmanSession(new RmanSessionOptionsBuilder().build(), ctx('OPEN'));
    s.connect();
    const r = s.processLine('RESTORE CONTROLFILE FROM AUTOBACKUP');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('RMAN_06403');
  });

  it('succeeds when instance is NOMOUNT and emits the canonical recipe', () => {
    const s = new RmanSession(new RmanSessionOptionsBuilder().build(), ctx('NOMOUNT'));
    s.connect();
    const r = s.processLine('RESTORE CONTROLFILE FROM AUTOBACKUP');
    expect(r.ok).toBe(true);
    if (r.ok) {
      const txt = r.value.join('\n');
      expect(txt).toMatch(/Starting restore at /);
      expect(txt).toMatch(/AUTOBACKUP/i);
      expect(txt).toMatch(/control file restore from AUTOBACKUP complete/i);
      expect(txt).toMatch(/Finished restore at /);
    }
  });

  it('succeeds when MOUNT', () => {
    const s = new RmanSession(new RmanSessionOptionsBuilder().build(), ctx('MOUNT'));
    s.connect();
    const r = s.processLine('RESTORE CONTROLFILE FROM AUTOBACKUP');
    expect(r.ok).toBe(true);
  });

  it("RESTORE CONTROLFILE FROM '<path>' accepts an existing piece", () => {
    const s = new RmanSession(new RmanSessionOptionsBuilder().build(), ctx('NOMOUNT'));
    s.connect();
    const r = s.processLine("RESTORE CONTROLFILE FROM '/u01/backup/cf_001.bkp'");
    expect(r.ok).toBe(true);
  });

  it("RESTORE CONTROLFILE FROM '<missing>' returns RMAN-06004", () => {
    // Override fileExists to return false
    const c: IRmanOracleContext = {
      ...ctx('NOMOUNT'),
      vfs: { ...ctx('NOMOUNT').vfs, fileExists: () => false },
    } as IRmanOracleContext;
    const s = new RmanSession(new RmanSessionOptionsBuilder().build(), c);
    s.connect();
    const r = s.processLine("RESTORE CONTROLFILE FROM '/missing/cf.bkp'");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('RMAN_06004');
  });

  it('RESTORE SPFILE FROM AUTOBACKUP works in NOMOUNT', () => {
    const s = new RmanSession(new RmanSessionOptionsBuilder().build(), ctx('NOMOUNT'));
    s.connect();
    const r = s.processLine('RESTORE SPFILE FROM AUTOBACKUP');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.join('\n')).toMatch(/SPFILE restore complete/i);
  });
});

describe('Canonical DR recipe — RESTORE CF + RESTORE DB + RECOVER', () => {
  beforeEach(() => { BackupKey._reset(); DeviceCatalogRegistry._reset(); });

  it('the full DR recipe runs end-to-end', () => {
    const sharedCatalog = DeviceCatalogRegistry.get('dr-srv');

    // Phase 1 — OPEN, prendre un backup
    const sBackup = new RmanSession(
      new RmanSessionOptionsBuilder().withCatalog(sharedCatalog).build(),
      ctx('OPEN'),
    );
    sBackup.connect();
    sBackup.processLine('CONFIGURE CONTROLFILE AUTOBACKUP ON');
    sBackup.processLine('BACKUP DATABASE');
    sBackup.dispose();

    // Phase 2 — sinistre, instance en NOMOUNT, restore CF
    const sRestore = new RmanSession(
      new RmanSessionOptionsBuilder().withCatalog(sharedCatalog).build(),
      ctx('NOMOUNT'),
    );
    sRestore.connect();
    const rCf = sRestore.processLine('RESTORE CONTROLFILE FROM AUTOBACKUP');
    expect(rCf.ok).toBe(true);
    sRestore.dispose();

    // Phase 3 — passage en MOUNT, restore + recover
    const sFinish = new RmanSession(
      new RmanSessionOptionsBuilder().withCatalog(sharedCatalog).build(),
      ctx('MOUNT'),
    );
    sFinish.connect();
    const types: string[] = [];
    sFinish.events$.subscribe(e => types.push(e.type));
    sFinish.processLine('RESTORE DATABASE');
    sFinish.processLine('RECOVER DATABASE');
    expect(types).toContain('RESTORE_DATAFILE_COMPLETED');
    expect(types).toContain('RECOVER_COMPLETED');
    sFinish.dispose();
  });
});
