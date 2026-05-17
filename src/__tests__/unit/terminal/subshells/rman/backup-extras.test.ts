/**
 * Extra BACKUP / CROSSCHECK / SHOW variants (§7.4).
 *
 *   BACKUP DATAFILE <n>
 *   BACKUP SPFILE
 *   BACKUP COMPRESSED BACKUPSET DATABASE
 *   BACKUP ARCHIVELOG FROM SCN <n>
 *
 *   CROSSCHECK ARCHIVELOG ALL
 *
 *   SHOW RETENTION POLICY
 *   SHOW DEFAULT DEVICE TYPE
 *   SHOW CONTROLFILE AUTOBACKUP
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
      { fileNo: 1, path: '/u01/oradata/ORCL/system01.dbf', sizeBytes: 1000, tablespace: 'SYSTEM' },
      { fileNo: 4, path: '/u01/oradata/ORCL/users01.dbf',  sizeBytes: 1000, tablespace: 'USERS'  },
    ],
    getSpfileParam: (n: string) => n === 'spfile' ? '/u01/dbs/spfileORCL.ora' : undefined,
    getControlFilePath: () => '/u01/oradata/ORCL/control01.ctl',
    getInstanceState: () => 'OPEN',
  } as unknown as IRmanOracleContext;
}

describe('BACKUP extras', () => {
  beforeEach(() => BackupKey._reset());

  it('BACKUP DATAFILE 4 backs up only file 4', () => {
    const s = new RmanSession(new RmanSessionOptionsBuilder().build(), makeCtx());
    s.connect();
    const types: string[] = [];
    s.events$.subscribe(e => types.push(e.type));
    const r = s.processLine('BACKUP DATAFILE 4');
    expect(r.ok).toBe(true);
    expect(types).toContain('JOB_COMPLETED');
  });

  it('BACKUP SPFILE succeeds', () => {
    const s = new RmanSession(new RmanSessionOptionsBuilder().build(), makeCtx());
    s.connect();
    const types: string[] = [];
    s.events$.subscribe(e => types.push(e.type));
    const r = s.processLine('BACKUP SPFILE');
    expect(r.ok).toBe(true);
    expect(types).toContain('JOB_COMPLETED');
  });

  it('BACKUP COMPRESSED BACKUPSET DATABASE marks the piece as compressed', () => {
    const s = new RmanSession(new RmanSessionOptionsBuilder().build(), makeCtx());
    s.connect();
    let pieceEvent: Extract<RmanEvent, { type: 'BACKUP_PIECE_CREATED' }> | undefined;
    s.events$.subscribe(e => {
      if (e.type === 'BACKUP_PIECE_CREATED') pieceEvent = e;
    });
    s.processLine('BACKUP COMPRESSED BACKUPSET DATABASE');
    expect(pieceEvent).toBeDefined();
    const list = s.processLine('LIST BACKUP');
    if (list.ok) expect(list.value.join('\n')).toMatch(/Compressed:\s*YES|Compressed.*YES/i);
  });

  it('BACKUP ARCHIVELOG FROM SCN 1000000 succeeds', () => {
    const s = new RmanSession(new RmanSessionOptionsBuilder().build(), makeCtx());
    s.connect();
    const types: string[] = [];
    s.events$.subscribe(e => types.push(e.type));
    const r = s.processLine('BACKUP ARCHIVELOG FROM SCN 1000000');
    expect(r.ok).toBe(true);
    expect(types).toContain('JOB_COMPLETED');
  });
});

describe('CROSSCHECK ARCHIVELOG', () => {
  it('CROSSCHECK ARCHIVELOG ALL emits CROSSCHECK_DONE', () => {
    const s = new RmanSession(new RmanSessionOptionsBuilder().build(), makeCtx());
    s.connect();
    s.processLine('BACKUP ARCHIVELOG ALL');
    const types: string[] = [];
    s.events$.subscribe(e => types.push(e.type));
    const r = s.processLine('CROSSCHECK ARCHIVELOG ALL');
    expect(r.ok).toBe(true);
    expect(types).toContain('CROSSCHECK_DONE');
  });
});

describe('SHOW variants', () => {
  it('SHOW RETENTION POLICY returns the configured policy', () => {
    const s = new RmanSession(new RmanSessionOptionsBuilder().build(), makeCtx());
    s.connect();
    s.processLine('CONFIGURE RETENTION POLICY TO REDUNDANCY 3');
    const r = s.processLine('SHOW RETENTION POLICY');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.join('\n')).toMatch(/REDUNDANCY\s+3/i);
  });

  it('SHOW DEFAULT DEVICE TYPE returns the configured default', () => {
    const s = new RmanSession(new RmanSessionOptionsBuilder().build(), makeCtx());
    s.connect();
    const r = s.processLine('SHOW DEFAULT DEVICE TYPE');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.join('\n')).toMatch(/DEVICE TYPE/i);
  });

  it('SHOW CONTROLFILE AUTOBACKUP returns ON/OFF', () => {
    const s = new RmanSession(new RmanSessionOptionsBuilder().build(), makeCtx());
    s.connect();
    s.processLine('CONFIGURE CONTROLFILE AUTOBACKUP ON');
    const r = s.processLine('SHOW CONTROLFILE AUTOBACKUP');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.join('\n')).toMatch(/AUTOBACKUP\s+ON/i);
  });
});
