/**
 * Mesure (Node, LinuxServer + SQL*Plus + RMAN) de deux familles de defauts relevees pendant les epreuves de charge Oracle.
 *
 * HORLOGE. Une machine n'a qu'une horloge (`date -s`, avance, acceleration) et SYSDATE la lisait, mais le reste du moteur Oracle lisait l'horloge globale de la
 * simulation : apres `date -s` de +2 mois, `V$SESSION.LOGON_TIME` d'une session neuve, les lignes du journal d'alerte, les instantanes AWR, l'expiration des mots de passe
 * (`PASSWORD_LIFE_TIME`), la date de fin et l'etiquette TAGyyyymmddThhmmss d'une sauvegarde RMAN et la fenetre de retention (`RECOVERY WINDOW OF n DAYS`) restaient sur
 * la date d'avant le saut. L'instance ouvre maintenant une portee d'horloge (`withHostClock`) autour de chaque point d'entree (SQL, connexion, cycle de vie, ligne SQL*Plus) et
 * RMAN lit l'horloge de la base cible (`hostNowMs` du contexte). `STARTUP_TIME` reste a l'ancienne date, comme sur une vraie machine.
 *
 * SUPPRESSION RMAN. `DELETE NOPROMPT BACKUP;` et `DELETE NOPROMPT BACKUP COMPLETED BEFORE 'SYSDATE-30';` rendaient « RMAN-01009: unknown command » ; `BACKUP AS COMPRESSED BACKUPSET
 * DATABASE;` aussi ; `TAG nom` sans guillemets etait ignore (etiquette horodatee a la place) ; `DELETE BACKUPSET n` ne disait ni piece ni total (« Finished delete » seul) ;
 * et surtout la suppression retirait le fichier et l'entree du catalogue mais PAS l'enregistrement qui alimente V$RECOVERY_FILE_DEST : l'espace n'etait jamais rendu et la
 * troisieme sauvegarde echouait en ORA-19809 alors que la zone etait vide. `V$BACKUP_PIECE` rend maintenant STATUS = 'D' et `V$ARCHIVED_LOG.DELETED` = 'YES'.
 * Une zone pleine reprend maintenant la place des sauvegardes obsoletes selon la politique de retention (REDUNDANCY 1 par defaut) : quatre BACKUP DATABASE de suite echouaient en ORA-19809 des la troisieme, ce que les epreuves de charge n'ont pas vu parce qu'elles jettent la sortie dans /dev/null.
 * V$RECOVERY_FILE_DEST.SPACE_RECLAIMABLE valait 10 % de SPACE_USED (valeur inventee) ; elle est maintenant la taille des pieces de la zone que la politique de retention du device declare obsoletes (meme fonction que celle qui reprend la place quand la zone est pleine).
 * Le STAMP imprime avec « backup piece handle=… RECID=… STAMP=… » compte les secondes depuis le 1er janvier 1988 (origine retenue de memoire, non verifiable ici).
 *
 * Discrimine par `git stash push -- src/database src/terminal` : 20 cas sur 22 tombent ; passent des deux cotes, TEMOINS : SYSDATE apres `date -s` (deja correct) et le refus ORA-19809 d'une zone pleine sans politique de retention (la place n'est reprise qu'aux sauvegardes obsoletes ; sans elle, la zone se remplit et la troisieme sauvegarde est refusee).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { getOracleDatabase } from '@/terminal/commands/database';
import { createSqlPlusRunner, type SqlPlusRunner } from '../../debug/oracle/_oracle-dump';
import { createRmanRunner, type RmanShellRunner } from '../../debug/rman/_rman-dump';

let server: LinuxServer;
let sql: SqlPlusRunner;
let rman: RmanShellRunner;

const setClock = (wall: string) => server.executeCommand(`date -s "${wall}"`);
const alertLog = () => server.executeCommand('cat /u01/app/oracle/diag/rdbms/orcl/ORCL/trace/alert_ORCL.log');

beforeEach(async () => {
  server = new LinuxServer('linux-server', 'ora-clock', 100, 100);
  await setClock('2026-01-10 08:00:00');
  getOracleDatabase(server.id);
  sql = createSqlPlusRunner(server);
  rman = createRmanRunner(server);
});

describe('horloge de la machine', () => {
  it('TEMOIN — SYSDATE suit date -s', async () => {
    await setClock('2026-03-15 09:30:00');
    expect(sql.execute("SELECT TO_CHAR(SYSDATE, 'YYYY-MM-DD HH24:MI') FROM dual;")).toContain('2026-03-15 09:30');
  });

  it('STARTUP_TIME garde la date du demarrage', async () => {
    await setClock('2026-03-15 09:30:00');
    expect(sql.execute("SELECT TO_CHAR(startup_time, 'YYYY-MM-DD') FROM v$instance;")).toContain('2026-01-10');
  });

  it('LOGON_TIME d\'une session ouverte apres un saut de deux mois', async () => {
    await setClock('2026-03-15 09:30:00');
    const later = createSqlPlusRunner(server);
    const out = later.execute("SELECT TO_CHAR(logon_time, 'YYYY-MM-DD HH24:MI') FROM v$session WHERE sid = SYS_CONTEXT('USERENV', 'SID');");
    expect(out).toContain('2026-03-15 09:30');
  });

  it('le journal d\'alerte date les evenements suivants avec l\'horloge de la machine', async () => {
    await setClock('2026-03-15 09:30:00');
    createSqlPlusRunner(server);
    expect(String(await alertLog())).toContain('2026-03-15 09:30:00: Logon');
  });

  it('un instantane AWR pris apres le saut porte la nouvelle date', async () => {
    await setClock('2026-03-15 09:30:00');
    sql.execute('EXEC DBMS_WORKLOAD_REPOSITORY.CREATE_SNAPSHOT');
    const out = sql.execute("SELECT TO_CHAR(MAX(end_interval_time), 'YYYY-MM-DD') FROM dba_hist_snapshot;");
    expect(out).toContain('2026-03-15');
  });

  it('un mot de passe de plus de PASSWORD_LIFE_TIME jours expire apres le saut', async () => {
    sql.execute('CREATE USER bob IDENTIFIED BY pw;');
    sql.execute('GRANT CREATE SESSION TO bob;');
    sql.execute('ALTER PROFILE DEFAULT LIMIT PASSWORD_LIFE_TIME 30;');
    expect(createSqlPlusRunner(server, ['bob/pw']).banner().join(' ')).not.toContain('ORA-28001');
    await setClock('2026-03-15 09:30:00');
    expect(createSqlPlusRunner(server, ['bob/pw']).banner().join(' ')).toContain('ORA-28001');
  });
});

describe('RMAN suit l\'horloge de la machine', () => {
  it('la sauvegarde porte la date et l\'etiquette du jour de la machine', async () => {
    await setClock('2026-03-15 09:30:00');
    const out = rman.execute('BACKUP DATABASE;');
    expect(out).toContain('Finished backup at 15-MAR-2026 09:30:33');
    expect(rman.execute('LIST BACKUP SUMMARY;')).toContain('TAG20260315T093000');
  });

  it('DELETE OBSOLETE retire la sauvegarde de janvier quand la fenetre de 7 jours est depassee', async () => {
    rman.execute('BACKUP DATABASE TAG janvier_a;');
    await setClock('2026-01-11 08:00:00');
    rman.execute('BACKUP DATABASE TAG janvier_b;');
    await setClock('2026-03-15 09:30:00');
    const out = rman.execute('DELETE NOPROMPT OBSOLETE RECOVERY WINDOW OF 7 DAYS;');
    expect(out).toContain('Deleted');
    const list = rman.execute('LIST BACKUP SUMMARY;');
    expect(list).toContain('JANVIER_B');
    expect(list).not.toContain('JANVIER_A');
  });

  it('DELETE BACKUP COMPLETED BEFORE SYSDATE-30 garde la sauvegarde recente', async () => {
    rman.execute('BACKUP DATABASE TAG ancienne;');
    await setClock('2026-03-15 09:30:00');
    rman.execute('BACKUP DATABASE TAG recente;');
    const out = rman.execute("DELETE NOPROMPT BACKUP COMPLETED BEFORE 'SYSDATE-30';");
    expect(out).toContain('Deleted 1 objects');
    const list = rman.execute('LIST BACKUP SUMMARY;');
    expect(list).toContain('RECENTE');
    expect(list).not.toContain('ANCIENNE');
  });
});

describe('suppression RMAN', () => {
  it('la sauvegarde sans option produit une etiquette horodatee', () => {
    rman.execute('BACKUP DATABASE;');
    expect(rman.execute('LIST BACKUP SUMMARY;')).toContain('TAG20260110T080000');
  });

  it('TAG sans guillemets est retenu', () => {
    rman.execute('BACKUP DATABASE TAG nocturne;');
    expect(rman.execute('LIST BACKUP SUMMARY;')).toContain('NOCTURNE');
  });

  it('BACKUP AS COMPRESSED BACKUPSET est accepte', () => {
    const out = rman.execute('BACKUP AS COMPRESSED BACKUPSET DATABASE;');
    expect(out).not.toContain('RMAN-01009');
    expect(out).toContain('Finished backup');
    expect(rman.execute('LIST BACKUP SUMMARY;')).toMatch(/ YES /);
  });

  it('DELETE NOPROMPT BACKUP supprime tout et le dit', () => {
    rman.execute('BACKUP DATABASE;');
    const out = rman.execute('DELETE NOPROMPT BACKUP;');
    expect(out).not.toContain('RMAN-01009');
    expect(out).toContain('deleted backup piece');
    expect(out).toMatch(/backup piece handle=\S+ RECID=\d+ STAMP=\d+/);
    expect(out).toContain('Deleted 1 objects');
    expect(rman.execute('LIST BACKUP SUMMARY;')).toContain('no backup found');
  });

  it('DELETE NOPROMPT BACKUPSET n rapporte la piece supprimee', () => {
    rman.execute('BACKUP DATABASE;');
    const key = /\n(\d+)\s+B\s+F/.exec(rman.execute('LIST BACKUP SUMMARY;'))![1];
    const out = rman.execute(`DELETE NOPROMPT BACKUPSET ${key};`);
    expect(out).toContain('deleted backup piece');
    expect(out).toContain('Deleted 1 objects');
  });

  it('DELETE d\'un jeu inexistant le dit', () => {
    expect(rman.execute('DELETE NOPROMPT BACKUPSET 99;')).toContain('specification does not match any backup in the repository');
  });

  it('DELETE OBSOLETE sans rien d\'obsolete le dit', () => {
    rman.execute('BACKUP DATABASE;');
    expect(rman.execute('DELETE NOPROMPT OBSOLETE;')).toContain('no obsolete backups found');
  });

  it('l\'espace de la zone de recuperation est rendu a la suppression', () => {
    rman.execute('BACKUP DATABASE;');
    rman.execute('BACKUP DATABASE;');
    rman.execute('DELETE NOPROMPT BACKUP;');
    expect(sql.execute('SELECT space_used FROM v$recovery_file_dest;')).toMatch(/\n\s*0\s*\n/);
    const third = rman.execute('BACKUP DATABASE;');
    expect(third).not.toContain('ORA-19809');
    expect(third).toContain('Finished backup');
  });

  it('une zone pleine reprend la place des sauvegardes obsoletes (REDUNDANCY 1) au lieu d\'echouer', () => {
    const outputs = [1, 2, 3, 4].map(() => rman.execute('BACKUP DATABASE;'));
    for (const out of outputs) {
      expect(out).not.toContain('ORA-19809');
      expect(out).toContain('Finished backup');
    }
    const kept = rman.execute('LIST BACKUP SUMMARY;').match(/\n\d+\s+B\s+F/g) ?? [];
    expect(kept.length).toBeLessThanOrEqual(2);
  });

  it('TEMOIN — sans politique de retention rien n\'est recuperable et la zone pleine refuse', () => {
    rman.execute('CONFIGURE RETENTION POLICY TO NONE;');
    const outputs = [1, 2, 3].map(() => rman.execute('BACKUP DATABASE;'));
    expect(outputs[2]).toContain('ORA-19809');
    expect(rman.execute('LIST BACKUP SUMMARY;').match(/\n\d+\s+B\s+F/g)?.length).toBe(2);
  });

  it('SPACE_RECLAIMABLE compte les pieces obsoletes selon la politique de retention, pas 10 % de l\'espace utilise', () => {
    const reclaimable = (): number => Number(/\n\s*\S+\s+\d+\s+\d+\s+(\d+)\s+\d+/.exec(
      sql.execute('SELECT name, space_limit, space_used, space_reclaimable, number_of_files FROM v$recovery_file_dest;'))?.[1]);
    rman.execute('BACKUP DATABASE;');
    expect(reclaimable()).toBe(0);
    rman.execute('BACKUP DATABASE;');
    const used = Number(/\n\s*\S+\s+\d+\s+(\d+)/.exec(sql.execute('SELECT name, space_limit, space_used FROM v$recovery_file_dest;'))?.[1]);
    expect(reclaimable()).toBeGreaterThan(0);
    expect(reclaimable()).toBe(used / 2);
  });

  it('sans politique de retention rien n\'est recuperable', () => {
    rman.execute('CONFIGURE RETENTION POLICY TO NONE;');
    rman.execute('BACKUP DATABASE;');
    rman.execute('BACKUP DATABASE;');
    expect(sql.execute('SELECT space_reclaimable FROM v$recovery_file_dest;')).toMatch(/\n\s*0\s*\n/);
  });

  it('V$BACKUP_PIECE marque la piece supprimee « D »', () => {
    rman.execute('BACKUP DATABASE;');
    rman.execute('DELETE NOPROMPT BACKUP;');
    expect(sql.execute('SELECT DISTINCT status FROM v$backup_piece;')).toMatch(/\bD\b/);
  });
});
