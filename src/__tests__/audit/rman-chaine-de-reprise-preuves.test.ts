/**
 * Sonde — la chaine de reprise est VERIFIEE, et le fichier de controle
 * survit a un arret.
 *
 * `docs/ASSESSMENT-RMAN.md` §6 laissait ouvert « le comportement de
 * RECOVER quand un archivelog manque ». Le banc de releve
 * `debug/rman/recover-log-manquant` a mesure cinq ecarts sur le meme
 * lab (5 switches, BACKUP, SHUTDOWN, STARTUP MOUNT, RESTORE, RECOVER) :
 *
 *   - SHUTDOWN vidait V$ARCHIVED_LOG et V$BACKUP_SET. Ce sont des
 *     enregistrements du FICHIER DE CONTROLE : ils survivent a l'arret
 *     d'une vraie instance, et c'est precisement ce qui fait du fichier
 *     de controle l'autorite de la reprise.
 *   - un trou au milieu de la chaine passait inapercu : le journal 3
 *     efface, la reprise annoncait « media recovery complete ».
 *   - la sequence imprimee etait une POSITION : le journal
 *     `1_4_arc.arc` etait applique comme « sequence 3 » des que le 3
 *     manquait, en contradiction avec son nom et avec V$ARCHIVED_LOG.
 *   - RMAN-06054 etait tronque (ni « and starting SCN of »), et sa
 *     sequence etait ecrite en dur a 1.
 *   - la pile d'erreur s'ouvrait sur RMAN-03014 au lieu de
 *     « RMAN-03002: failure of recover command at <date> ».
 *
 * L'AUTORITE des messages : la documentation d'erreur Oracle, atteinte
 * par extraits de recherche (docs.oracle.com est injoignable depuis cet
 * environnement, cf. le message de commit). Les deux familles que RMAN
 * distingue :
 *   - le journal n'est PAS connu du fichier de controle
 *       RMAN-06054: media recovery requesting unknown archived log for
 *       thread <t> with sequence <s> and starting SCN of <scn>
 *   - le journal EST connu, absent du disque, et aucune sauvegarde ne
 *     permet de le restaurer
 *       RMAN-06053: unable to perform media recovery because of
 *       missing log
 *       RMAN-06025: no backup of archived log for thread <t> with
 *       sequence <s> and starting SCN of <scn> found to restore
 *
 * Discrimination par `git stash push -- src/terminal src/database` :
 * 8 cas sur 10 tombent avant le correctif.
 *
 * Les DEUX qui ne discriminent pas, nommes avec leur raison :
 *  - « TEMOIN — une chaine complete se rejoue toujours » : TEMOIN. Il
 *    doit passer avant ET apres ; c'est lui qui prouve que les refus
 *    ci-dessus viennent du trou mesure et non d'un lab casse.
 *  - « V$ARCHIVED_LOG nomme des fichiers qui sont vraiment la » :
 *    NON-REGRESSION. Cette coherence existait avant l'arret ; le lot
 *    deplace l'autorite vers le fichier de controle et ne doit pas la
 *    casser.
 *
 * Pieges de ce lab, payes une fois chacun : `lab.rman()` lance `rman`
 * SANS `target /`, et RESTORE exige l'etat MOUNT — toute mesure prise
 * sans les deux mesure autre chose. Et un COUNT(*) ne se lit pas par
 * `toMatch(/[1-9]/)` sur la sortie entiere : la ligne « 1 row
 * selected » porte un chiffre, si bien qu'un compte de ZERO passait le
 * test. La premiere redaction de ce cas etait vide pour cette raison ;
 * `compte()` lit la valeur, pas la page.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { LinuxServer } from '@/network/devices/LinuxServer';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { getOracleDatabase, resetAllOracleInstances } from '@/terminal/commands/database';
import { SqlPlusSubShell } from '@/terminal/subshells/SqlPlusSubShell';
import { buildRmanLab, type RmanLab } from '../support/rmanLab';

let lab: RmanLab;

beforeEach(async () => {
  resetCounters();
  resetDeviceCounters();
  resetAllOracleInstances();
  Logger.reset();
  lab = await buildRmanLab();
});

const ARC_DIR = '/u01/app/oracle/archivelog';

const sh = (srv: LinuxServer, cmd: string) => srv.executeShellCommandSync(cmd);

const rman = (srv: LinuxServer, lignes: string[]): string =>
  sh(srv, `echo "${lignes.join('\n')}" | rman target /`);

function enArchivelog(srv: LinuxServer): SqlPlusSubShell {
  const { subShell } = SqlPlusSubShell.create(srv, ['/', 'as', 'sysdba']);
  const db = getOracleDatabase(srv.getId());
  (db.instance as unknown as { _archiveLogMode: boolean })._archiveLogMode = true;
  return subShell;
}

function chaineDeCinq(): { srv: LinuxServer; sql: SqlPlusSubShell } {
  const srv = lab.prod;
  const sql = enArchivelog(srv);
  for (let i = 0; i < 5; i++) sql.processLine('ALTER SYSTEM SWITCH LOGFILE;');
  rman(srv, ['BACKUP DATABASE;', 'EXIT;']);
  return { srv, sql };
}

function compte(sql: SqlPlusSubShell, requete: string): number {
  const lignes = sql.processLine(requete).output.join('\n').split('\n');
  const valeur = lignes.find(l => /^\s*\d+\s*$/.test(l));
  return valeur === undefined ? -1 : Number(valeur.trim());
}

function enMount(sql: SqlPlusSubShell): void {
  sql.processLine('SHUTDOWN IMMEDIATE;');
  sql.processLine('STARTUP MOUNT;');
}

describe('le fichier de controle survit a un arret', () => {
  it('V$ARCHIVED_LOG garde ses enregistrements apres SHUTDOWN / STARTUP MOUNT', () => {
    const { sql } = chaineDeCinq();
    enMount(sql);
    const vue = sql.processLine(
      'SELECT sequence# FROM v$archived_log ORDER BY sequence#;').output.join('\n');
    expect(vue).not.toMatch(/no rows selected/);
    for (const seq of [1, 2, 3, 4, 5]) expect(vue).toMatch(new RegExp(`\\b${seq}\\b`));
    sql.dispose();
  });

  it('V$BACKUP_SET garde la sauvegarde prise avant l arret', () => {
    const { sql } = chaineDeCinq();
    const avant = compte(sql, 'SELECT COUNT(*) FROM v$backup_set;');
    enMount(sql);
    expect(avant).toBeGreaterThan(0);
    expect(compte(sql, 'SELECT COUNT(*) FROM v$backup_set;')).toBe(avant);
    sql.dispose();
  });

  it('FIRST_CHANGE# vient du SCN de l instance, pas d un compteur de ligne', () => {
    const { sql } = chaineDeCinq();
    const vue = sql.processLine(
      'SELECT sequence#, first_change#, next_change# FROM v$archived_log ORDER BY sequence#;',
    ).output.join('\n');
    expect(vue).not.toMatch(/\s100\s/);
    const scns = vue.split('\n')
      .map(l => /^\s*\d+\s+(\d+)\s+(\d+)\s*$/.exec(l))
      .filter((m): m is RegExpExecArray => m !== null)
      .map(m => [Number(m[1]), Number(m[2])] as const);
    expect(scns.length).toBe(5);
    for (const [first, next] of scns) expect(first).toBeLessThan(next);
    for (let i = 1; i < scns.length; i++) {
      expect(scns[i][0]).toBeGreaterThanOrEqual(scns[i - 1][0]);
    }
    sql.dispose();
  });

  it('NON-REGRESSION — V$ARCHIVED_LOG nomme des fichiers qui sont vraiment la', () => {
    const { srv, sql } = chaineDeCinq();
    const vue = sql.processLine('SELECT name FROM v$archived_log;').output.join('\n');
    for (const ligne of vue.split('\n')) {
      const chemin = /(\/\S+\.arc)/.exec(ligne)?.[1];
      if (chemin) expect(sh(srv, `ls ${chemin}`)).not.toMatch(/No such file/);
    }
    sql.dispose();
  });
});

describe('un trou dans la chaine arrete la reprise', () => {
  it('le journal 3 efface : RMAN-06053 au lieu de « media recovery complete »', () => {
    const { srv, sql } = chaineDeCinq();
    sh(srv, `rm -f ${ARC_DIR}/1_3_arc.arc`);
    enMount(sql);
    const out = rman(srv, ['RESTORE DATABASE;', 'RECOVER DATABASE;', 'EXIT;']);
    expect(out).toContain('RMAN-06053: unable to perform media recovery because of missing log');
    expect(out).not.toContain('media recovery complete');
    sql.dispose();
  });

  it('RMAN-06025 nomme la sequence REELLEMENT manquante, avec son SCN', () => {
    const { srv, sql } = chaineDeCinq();
    sh(srv, `rm -f ${ARC_DIR}/1_3_arc.arc`);
    enMount(sql);
    const out = rman(srv, ['RESTORE DATABASE;', 'RECOVER DATABASE;', 'EXIT;']);
    const ligne = out.split('\n').find(l => l.includes('RMAN-06025')) ?? '';
    expect(ligne).toMatch(
      /no backup of archived log for thread 1 with sequence 3 and starting SCN of \d+ found to restore/);
    expect(out.split('\n').filter(l => l.includes('RMAN-06025')).length).toBe(1);
    sql.dispose();
  });

  it('toute la chaine effacee : un RMAN-06025 par journal, dans l ordre', () => {
    const { srv, sql } = chaineDeCinq();
    sh(srv, `rm -f ${ARC_DIR}/*.arc`);
    enMount(sql);
    const out = rman(srv, ['RESTORE DATABASE;', 'RECOVER DATABASE;', 'EXIT;']);
    const sequences = out.split('\n')
      .map(l => /RMAN-06025: no backup of archived log for thread 1 with sequence (\d+)/.exec(l))
      .filter((m): m is RegExpExecArray => m !== null)
      .map(m => Number(m[1]));
    expect(sequences).toEqual([1, 2, 3, 4, 5]);
    sql.dispose();
  });

  it('la pile s ouvre sur « failure of recover command at »', () => {
    const { srv, sql } = chaineDeCinq();
    sh(srv, `rm -f ${ARC_DIR}/1_3_arc.arc`);
    enMount(sql);
    const out = rman(srv, ['RESTORE DATABASE;', 'RECOVER DATABASE;', 'EXIT;']);
    expect(out).toMatch(/RMAN-03002: failure of recover command at /);
    expect(out).not.toContain('RMAN-03014');
    sql.dispose();
  });

  it('un journal sauvegarde puis efface revient de sa piece et la reprise aboutit', () => {
    const { srv, sql } = chaineDeCinq();
    rman(srv, ['BACKUP ARCHIVELOG ALL DELETE INPUT;', 'EXIT;']);
    expect(sh(srv, `ls ${ARC_DIR}/1_3_arc.arc`)).toMatch(/No such file/);
    enMount(sql);
    const out = rman(srv, ['RESTORE DATABASE;', 'RECOVER DATABASE;', 'EXIT;']);
    expect(out).toContain('media recovery complete');
    expect(out).not.toContain('RMAN-060');
    expect(sh(srv, `ls ${ARC_DIR}/1_3_arc.arc`)).not.toMatch(/No such file/);
    sql.dispose();
  });

  it('TEMOIN — une chaine complete se rejoue toujours', () => {
    const { srv, sql } = chaineDeCinq();
    enMount(sql);
    const out = rman(srv, ['RESTORE DATABASE;', 'RECOVER DATABASE;', 'EXIT;']);
    expect(out).toContain('media recovery complete');
    expect(out).not.toContain('RMAN-060');
    sql.dispose();
  });
});
