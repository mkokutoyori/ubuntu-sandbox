/**
 * Suite de RELEVE — `src/__tests__/debug/`.
 *
 * `docs/ASSESSMENT-RMAN.md` §6 laisse ouvert « le comportement de
 * RECOVER quand un archivelog manque ». Ce banc mesure ce que le
 * simulateur repond aujourd hui dans les trois situations qu un vrai
 * RMAN distingue, et ce que chaque vue dit de la meme chaine.
 *
 * Les trois situations, d apres la documentation d erreur Oracle :
 *
 *   1. le log n est PAS connu du fichier de controle
 *      -> RMAN-06054: media recovery requesting unknown archived log
 *         for thread <t> with sequence <s> and starting SCN of <scn>
 *   2. le log EST connu mais absent du disque, et aucune sauvegarde ne
 *      permet de le restaurer
 *      -> RMAN-06053: unable to perform media recovery because of
 *         missing log
 *         RMAN-06025: no backup of archived log for thread <t> with
 *         sequence <s> and starting SCN of <scn> found to restore
 *   3. la chaine est complete -> la reprise aboutit.
 *
 * Le banc n affirme rien : il imprime. Le piege connu de ce lab est que
 * `lab.rman()` lance `rman` SANS `target /` ; on ouvre donc la session
 * avec `rman target /` explicitement.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { LinuxServer } from '@/network/devices/LinuxServer';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { getOracleDatabase, resetAllOracleInstances } from '@/terminal/commands/database';
import { SqlPlusSubShell } from '@/terminal/subshells/SqlPlusSubShell';
import { buildRmanLab, type RmanLab } from '../../support/rmanLab';
import { LinuxRmanContext } from '@/terminal/subshells/rman/integration/LinuxRmanContext';

const note = (l: string) => { console.log(l); };
const ARC_DIR = '/u01/app/oracle/archivelog';

let lab: RmanLab;

beforeEach(async () => {
  resetCounters();
  resetDeviceCounters();
  resetAllOracleInstances();
  Logger.reset();
  lab = await buildRmanLab();
});

function enArchivelog(srv: LinuxServer): SqlPlusSubShell {
  const { subShell } = SqlPlusSubShell.create(srv, ['/', 'as', 'sysdba']);
  const db = getOracleDatabase(srv.getId());
  (db.instance as unknown as { _archiveLogMode: boolean })._archiveLogMode = true;
  return subShell;
}

const sh = (srv: LinuxServer, cmd: string) => srv.executeShellCommandSync(cmd);

function enMount(sql: SqlPlusSubShell): string {
  sql.processLine('SHUTDOWN IMMEDIATE;');
  sql.processLine('STARTUP MOUNT;');
  return sql.processLine('SELECT status FROM v$instance;').output.join(' ').replace(/\s+/g, ' ').trim();
}

function rman(srv: LinuxServer, lignes: string[]): string {
  return sh(srv, `echo "${lignes.join('\n')}" | rman target /`);
}

describe('RECOVER avec un archivelog manquant', () => {
  it('releve : chaine complete, trou au milieu, chaine vide', () => {
    const srv = lab.prod;
    const sql = enArchivelog(srv);

    for (let i = 0; i < 5; i++) sql.processLine('ALTER SYSTEM SWITCH LOGFILE;');

    const ctx = LinuxRmanContext.forDevice(srv);
    note(`[a-1] getArchivelogPaths : ${JSON.stringify(ctx.getArchivelogPaths())}`);
    note(`[a-2] ls ${ARC_DIR} : ${sh(srv, `ls ${ARC_DIR}`).replace(/\n/g, ' | ')}`);
    note('[a-3] V$ARCHIVED_LOG (sequence, name) :');
    note(sql.processLine(
      'SELECT sequence#, name FROM v$archived_log ORDER BY sequence#;').output.join('\n'));

    note('');
    note('[b] BACKUP DATABASE puis RESTORE + RECOVER, chaine COMPLETE');
    note(rman(srv, ['BACKUP DATABASE;', 'EXIT;']).slice(-600));
    note(`[b-0] etat avant restore : ${enMount(sql)}`);
    const complet = rman(srv, ['RESTORE DATABASE;', 'RECOVER DATABASE;', 'EXIT;']);
    note(complet.slice(-900));

    note('');
    note('[c] on efface UN archivelog au milieu de la chaine');
    const paths = [...ctx.getArchivelogPaths()].sort();
    const victime = paths[Math.floor(paths.length / 2)];
    note(`[c-1] victime : ${victime}`);
    note(`[c-2] rm : ${sh(srv, `rm -f ${victime}`)}`);
    note(`[c-3] ls ${ARC_DIR} : ${sh(srv, `ls ${ARC_DIR}`).replace(/\n/g, ' | ')}`);
    note(`[c-4] getArchivelogPaths APRES rm : ${JSON.stringify(ctx.getArchivelogPaths())}`);
    note('[c-5] V$ARCHIVED_LOG APRES rm :');
    note(sql.processLine(
      'SELECT sequence#, name FROM v$archived_log ORDER BY sequence#;').output.join('\n'));
    note(`[c-6] etat : ${enMount(sql)}`);
    note('[c-7] RESTORE + RECOVER avec le trou :');
    note(rman(srv, ['RESTORE DATABASE;', 'RECOVER DATABASE;', 'EXIT;']).slice(-1200));

    note('');
    note('[d] on efface TOUS les archivelogs');
    note(`[d-1] rm : ${sh(srv, `rm -f ${ARC_DIR}/*.arc`)}`);
    note(`[d-2] getArchivelogPaths : ${JSON.stringify(ctx.getArchivelogPaths())}`);
    note(`[d-3] etat : ${enMount(sql)}`);
    note('[d-4] RESTORE + RECOVER sans aucun log :');
    note(rman(srv, ['RESTORE DATABASE;', 'RECOVER DATABASE;', 'EXIT;']).slice(-1200));

    sql.dispose();
    expect(true).toBe(true);
  });
});
