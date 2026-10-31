/**
 * `SET DBID n` de RMAN etait refuse (« unknown command »). Il fixe, pour la session, le DBID de la base dont
 * `RESTORE CONTROLFILE | SPFILE FROM AUTOBACKUP` cherche les autosauvegardes (c-<DBID>-...) : avec le DBID de la base on
 * retrouve l'autosauvegarde, avec un autre DBID on ne trouve rien (RMAN-06172), et le nom annonce porte le DBID cherche.
 * Le critere est donc evalue, pas seulement stocke : avant le changement les sets du catalogue n'etaient pas filtres par
 * DBID. La reponse `executing command: SET DBID` suit les autres SET de la session.
 * Non source (TODO.md [rman]) : le contrôle de RMAN quand SET DBID est donne avec une cible deja connectee.
 *
 * Discrimine par `git stash` sur src/terminal : 2 des 4 cas tombent avant (la reponse de SET DBID et le refus avec un autre
 * DBID). TEMOINS : la restauration sans SET DBID, et celle avec le DBID de la base (le nom portait deja ce DBID).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  RmanSession, RmanSessionOptionsBuilder, BackupKey, DbId, ok,
  DeviceCatalogRegistry,
  type IRmanOracleContext,
} from '@/terminal/subshells/rman';
import { renderControlFileImage } from '@/database/oracle/storage/ControlFileImage';

const PIECE = new TextEncoder().encode(renderControlFileImage(
  '[ORACLE RMAN BACKUP PIECE - 9650176 bytes]',
  { dbName: 'ORCL', dbId: DbId.DEFAULT.value, datafiles: [], backupSets: [] },
));
const SYSTEM01 = '/u01/oradata/ORCL/system01.dbf';

function ctx(state: 'OPEN' | 'NOMOUNT'): IRmanOracleContext {
  return {
    dbId: DbId.DEFAULT, dbName: 'ORCL',
    vfs: {
      writeFile: () => ok(undefined),
      readFile: (path: string) => ok(path === SYSTEM01 ? new TextEncoder().encode('[ORACLE DATAFILE - SYSTEM tablespace - 1M]') : PIECE),
      fileExists: () => true, deleteFile: () => ok(undefined), availableBytes: () => 1e10,
    },
    getDatafiles: () => [{ fileNo: 1, path: SYSTEM01, sizeBytes: 1_000, tablespace: 'SYSTEM' }],
    getSpfileParam: () => undefined,
    getInstanceState: () => state,
    getControlFilePath: () => '/u01/oradata/ORCL/control01.ctl',
    getArchivelogPaths: () => ['/u01/backup/arch/arch_1_1.arc'],
  } as unknown as IRmanOracleContext;
}

beforeEach(() => { BackupKey._reset(); DeviceCatalogRegistry._reset(); });

function seededSession(): RmanSession {
  const catalog = DeviceCatalogRegistry.get('set-dbid');
  const backup = new RmanSession(new RmanSessionOptionsBuilder().withCatalog(catalog).build(), ctx('OPEN'));
  backup.connect();
  backup.processLine('CONFIGURE CONTROLFILE AUTOBACKUP ON');
  backup.processLine('BACKUP DATABASE');
  backup.dispose();
  const session = new RmanSession(new RmanSessionOptionsBuilder().withCatalog(catalog).build(), ctx('NOMOUNT'));
  session.connect();
  return session;
}

describe('SET DBID', () => {
  it('TEMOIN — without SET DBID the autobackup of the database is found', () => {
    const r = seededSession().processLine('RESTORE CONTROLFILE FROM AUTOBACKUP');
    expect(r.ok).toBe(true);
  });

  it('answers like the other SET commands', () => {
    const r = seededSession().processLine(`SET DBID ${DbId.DEFAULT.value}`);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual(['executing command: SET DBID']);
  });

  it('with the database DBID the autobackup is found and its name carries that DBID', () => {
    const s = seededSession();
    s.processLine(`SET DBID ${DbId.DEFAULT.value}`);
    const r = s.processLine('RESTORE CONTROLFILE FROM AUTOBACKUP');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.join('\n')).toContain(`c-${DbId.DEFAULT.value}-`);
  });

  it('with another DBID no autobackup is found (RMAN-06172)', () => {
    const s = seededSession();
    s.processLine('SET DBID 42');
    const r = s.processLine('RESTORE CONTROLFILE FROM AUTOBACKUP');
    expect(r.ok).toBe(false);
    if (r.ok === false) expect(r.error.code).toBe('RMAN_06172');
  });
});
