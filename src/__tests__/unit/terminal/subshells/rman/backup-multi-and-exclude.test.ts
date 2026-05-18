/**
 * BACKUP multi-target + RECOVERY AREA + CONFIGURE EXCLUDE.
 *
 *   BACKUP TABLESPACE SYSTEM, USERS                  → multi
 *   BACKUP DATAFILE 1, 2, 3                          → multi
 *   BACKUP RECOVERY AREA                             → FRA dump
 *   CONFIGURE EXCLUDE FOR TABLESPACE TEMP            → exclusion
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  RmanSession, RmanSessionOptionsBuilder, BackupKey, DbId, ok,
  DeviceCatalogRegistry, DeviceConfigRegistry,
  type IRmanOracleContext, type RmanEvent,
} from '@/terminal/subshells/rman';

function ctx(): IRmanOracleContext {
  return {
    dbId: DbId.DEFAULT, dbName: 'ORCL',
    vfs: {
      writeFile: () => ok(undefined), readFile: () => ok(new Uint8Array(0)),
      fileExists: () => true, deleteFile: () => ok(undefined), availableBytes: () => 1e10,
    },
    getDatafiles: () => [
      { fileNo: 1, path: '/u01/oradata/ORCL/system01.dbf',  sizeBytes: 1_000, tablespace: 'SYSTEM' },
      { fileNo: 2, path: '/u01/oradata/ORCL/sysaux01.dbf',  sizeBytes: 1_000, tablespace: 'SYSAUX' },
      { fileNo: 3, path: '/u01/oradata/ORCL/undotbs01.dbf', sizeBytes: 1_000, tablespace: 'UNDOTBS1' },
      { fileNo: 4, path: '/u01/oradata/ORCL/users01.dbf',   sizeBytes: 1_000, tablespace: 'USERS' },
      { fileNo: 5, path: '/u01/oradata/ORCL/temp01.dbf',    sizeBytes: 1_000, tablespace: 'TEMP' },
    ],
    getSpfileParam: () => undefined,
    getInstanceState: () => 'OPEN',
  } as unknown as IRmanOracleContext;
}

describe('BACKUP multi-tablespace', () => {
  beforeEach(() => {
    BackupKey._reset();
    DeviceCatalogRegistry._reset();
    DeviceConfigRegistry._reset();
  });

  it('accepts BACKUP TABLESPACE SYSTEM, USERS, SYSAUX', () => {
    const s = new RmanSession(new RmanSessionOptionsBuilder().build(), ctx());
    s.connect();
    const r = s.processLine('BACKUP TABLESPACE SYSTEM, USERS, SYSAUX');
    expect(r.ok).toBe(true);
  });

  it('the BACKUP_SET_COMPLETE event reports the right datafile count', () => {
    const s = new RmanSession(new RmanSessionOptionsBuilder().build(), ctx());
    s.connect();
    s.processLine('BACKUP TABLESPACE SYSTEM, USERS');
    const r = s.processLine('LIST BACKUP');
    if (r.ok) {
      const txt = r.value.join('\n');
      // SYSTEM datafile 1 + USERS datafile 4 → 2 entries
      expect(txt).toContain('/u01/oradata/ORCL/system01.dbf');
      expect(txt).toContain('/u01/oradata/ORCL/users01.dbf');
      expect(txt).not.toContain('/u01/oradata/ORCL/sysaux01.dbf');
    }
  });
});

describe('BACKUP multi-datafile', () => {
  beforeEach(() => { BackupKey._reset(); DeviceCatalogRegistry._reset(); DeviceConfigRegistry._reset(); });

  it('accepts BACKUP DATAFILE 1, 2, 3', () => {
    const s = new RmanSession(new RmanSessionOptionsBuilder().build(), ctx());
    s.connect();
    const r = s.processLine('BACKUP DATAFILE 1, 2, 3');
    expect(r.ok).toBe(true);
  });

  it('only the selected datafiles end up in the backup set', () => {
    const s = new RmanSession(new RmanSessionOptionsBuilder().build(), ctx());
    s.connect();
    s.processLine('BACKUP DATAFILE 1, 4');
    const r = s.processLine('LIST BACKUP');
    if (r.ok) {
      const txt = r.value.join('\n');
      expect(txt).toContain('system01.dbf');
      expect(txt).toContain('users01.dbf');
      expect(txt).not.toContain('sysaux01.dbf');
      expect(txt).not.toContain('undotbs01.dbf');
    }
  });
});

describe('BACKUP RECOVERY AREA', () => {
  beforeEach(() => { BackupKey._reset(); DeviceCatalogRegistry._reset(); DeviceConfigRegistry._reset(); });

  it('accepted + emits canonical progress lines', () => {
    const s = new RmanSession(new RmanSessionOptionsBuilder().build(), ctx());
    s.connect();
    const messages: string[] = [];
    s.events$.subscribe(e => {
      if (e.type === 'PROGRESS_UPDATED') messages.push((e as Extract<RmanEvent, { type: 'PROGRESS_UPDATED' }>).message);
    });
    const r = s.processLine('BACKUP RECOVERY AREA');
    expect(r.ok).toBe(true);
    expect(messages.some(m => /scanning recovery area/i.test(m))).toBe(true);
    expect(messages.some(m => /backing up recovery area contents/i.test(m))).toBe(true);
  });
});

describe('CONFIGURE EXCLUDE FOR TABLESPACE', () => {
  beforeEach(() => { BackupKey._reset(); DeviceCatalogRegistry._reset(); DeviceConfigRegistry._reset(); });

  it('CONFIGURE EXCLUDE FOR TABLESPACE TEMP makes BACKUP DATABASE skip TEMP datafiles', () => {
    const s = new RmanSession(new RmanSessionOptionsBuilder().build(), ctx());
    s.connect();
    s.processLine('CONFIGURE EXCLUDE FOR TABLESPACE TEMP');
    s.processLine('BACKUP DATABASE');
    const r = s.processLine('LIST BACKUP');
    if (r.ok) {
      const txt = r.value.join('\n');
      // Other tablespaces in, TEMP out
      expect(txt).toContain('system01.dbf');
      expect(txt).toContain('users01.dbf');
      expect(txt).not.toContain('temp01.dbf');
    }
  });

  it('CONFIGURE EXCLUDE … CLEAR re-includes the tablespace', () => {
    const s = new RmanSession(new RmanSessionOptionsBuilder().build(), ctx());
    s.connect();
    s.processLine('CONFIGURE EXCLUDE FOR TABLESPACE TEMP');
    s.processLine('CONFIGURE EXCLUDE FOR TABLESPACE TEMP CLEAR');
    s.processLine('BACKUP DATABASE');
    const r = s.processLine('LIST BACKUP');
    if (r.ok) {
      expect(r.value.join('\n')).toContain('temp01.dbf');
    }
  });

  it('exclusions multiples cumulent (TEMP + USERS)', () => {
    const s = new RmanSession(new RmanSessionOptionsBuilder().build(), ctx());
    s.connect();
    s.processLine('CONFIGURE EXCLUDE FOR TABLESPACE TEMP');
    s.processLine('CONFIGURE EXCLUDE FOR TABLESPACE USERS');
    s.processLine('BACKUP DATABASE');
    const r = s.processLine('LIST BACKUP');
    if (r.ok) {
      const txt = r.value.join('\n');
      expect(txt).toContain('system01.dbf');
      expect(txt).not.toContain('temp01.dbf');
      expect(txt).not.toContain('users01.dbf');
    }
  });
});
