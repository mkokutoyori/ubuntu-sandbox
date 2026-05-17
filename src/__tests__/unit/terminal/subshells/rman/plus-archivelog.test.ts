/**
 * BACKUP DATABASE PLUS ARCHIVELOG (DEF-RMAN-10).
 *
 * Oracle's compound form runs two jobs back-to-back: a database backup,
 * then an archivelog backup. With DELETE INPUT, the archivelog backup
 * also deletes the source archived redo logs.
 *
 *   BACKUP DATABASE PLUS ARCHIVELOG;
 *   BACKUP DATABASE PLUS ARCHIVELOG DELETE INPUT;
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  RmanSession, RmanSessionOptionsBuilder, BackupKey, DbId, ok,
  type IRmanOracleContext, type RmanEvent,
} from '@/terminal/subshells/rman';

function makeCtx(arclogs: string[] = []): IRmanOracleContext {
  return {
    dbId: DbId.DEFAULT, dbName: 'ORCL',
    vfs: {
      writeFile: () => ok(undefined),
      readFile:  () => ok(new Uint8Array(0)),
      fileExists: () => true,
      deleteFile: () => ok(undefined),
      availableBytes: () => 1e10,
    },
    getDatafiles: () => [
      { fileNo: 1, path: '/u01/dbs/system01.dbf', sizeBytes: 1_000, tablespace: 'SYSTEM' },
    ],
    getSpfileParam: () => undefined,
    getArchivelogPaths: () => arclogs,
  } as unknown as IRmanOracleContext;
}

describe('BACKUP DATABASE PLUS ARCHIVELOG — DEF-RMAN-10', () => {
  beforeEach(() => BackupKey._reset());

  it('runs two jobs: BACKUP_DATABASE then BACKUP_ARCHIVELOG', () => {
    const s = new RmanSession(new RmanSessionOptionsBuilder().build(), makeCtx());
    s.connect();
    const ops: string[] = [];
    s.events$.subscribe(e => {
      if (e.type === 'JOB_COMPLETED') ops.push((e as Extract<RmanEvent, { type: 'JOB_COMPLETED' }>).operation);
    });
    s.processLine('BACKUP DATABASE PLUS ARCHIVELOG');
    expect(ops).toEqual(['BACKUP_DATABASE', 'BACKUP_ARCHIVELOG']);
  });

  it('with DELETE INPUT, archivelogs are removed after the second job', () => {
    const arclogs = ['/u01/arch/1_42_111.arc', '/u01/arch/1_43_111.arc'];
    const s = new RmanSession(new RmanSessionOptionsBuilder().build(), makeCtx(arclogs));
    s.connect();
    const deleted: string[] = [];
    s.events$.subscribe(e => {
      if (e.type === 'ARCHIVELOG_DELETED') deleted.push((e as Extract<RmanEvent, { type: 'ARCHIVELOG_DELETED' }>).path);
    });
    s.processLine('BACKUP DATABASE PLUS ARCHIVELOG DELETE INPUT');
    expect(deleted).toEqual(arclogs);
  });
});
