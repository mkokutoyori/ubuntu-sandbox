/**
 * Sonde — la Fast Recovery Area est celle que l'instance déclare : la
 * destination par DÉFAUT de RMAN, le nom OMF de la pièce, son
 * propriétaire, le QUOTA, et les vues V$ qui comptent ce que LIST BACKUP
 * montre.
 *
 * Relevé AVANT le correctif, sur un LinuxServer fraîchement amorcé :
 *
 *   SQL> SHOW PARAMETER db_recovery_file_dest
 *        db_recovery_file_dest  string  /u01/app/oracle/fast_recovery_area
 *   SQL> SELECT name FROM V$RECOVERY_FILE_DEST;
 *        /u01/app/oracle/fast_recovery_area
 *   RMAN> BACKUP DATABASE;
 *        RMAN-03014: RMAN-19625: ORA-19504: failed to create file
 *                    "/u01/backup/ORCL_g4mhdykm.bkp"
 *
 *   Puis, quatre sauvegardes de 1,73 Go dans une FRA de 4 Go :
 *        4 pièces écrites, aucune erreur
 *   SQL> SELECT space_used FROM V$RECOVERY_FILE_DEST;   ->  0
 *   SQL> SELECT * FROM V$RECOVERY_AREA_USAGE;           ->  tout à 0
 *   SQL> SELECT COUNT(*) FROM V$BACKUP_SET;             ->  0
 *
 *   BACKUP … FORMAT '/u01/bk/%d_%T_%s_%p_%U_%t_%n_%I.bkp';
 *        %d_TAG20260910T160713_1_1_ORCL_71xyf4ig_%t_%n_%I.bkp
 *
 * Quatre défauts d'une seule famille : RMAN et le moteur Oracle ne
 * parlaient pas du même magasin. RMAN écrivait dans un `/u01/backup`
 * que personne d'autre ne nomme ; `oracle.backup.recorded` n'était émis
 * par personne, si bien que HUIT vues V$ (BACKUP_SET, BACKUP_PIECE,
 * BACKUP_DATAFILE, BACKUP_FILES, BACKUP_REDOLOG, RMAN_STATUS,
 * RMAN_OUTPUT, RECOVERY_AREA_USAGE) restaient vides pendant que les
 * pièces existaient sur le disque ; le quota déclaré n'était évalué
 * nulle part ; et quatre variables de FORMAT sur huit traversaient le
 * nom de fichier telles quelles, %T rendant le tag au lieu de la date.
 *
 * Discrimination par `git stash push -- src/database src/terminal src/network`
 * (sans -u, pour que les modules neufs restent chargeables) :
 * 10 cas sur 12 tombent avant le correctif.
 *
 * Les deux qui ne discriminent pas, et pourquoi :
 *  - « TÉMOIN — une destination FORMAT que le DBA a créée reçoit bien la
 *    pièce » : c'est le TÉMOIN. Il passe des deux côtés et prouve que le
 *    laboratoire sait encore mener une sauvegarde jusqu'au bout, donc que
 *    les dix écarts au-dessus sont des écarts et non un banc mort.
 *  - « une pièce écrite HORS de la FRA ne consomme pas son quota » :
 *    NON-RÉGRESSION. Avant le correctif il passait pour une mauvaise
 *    raison — la FRA comptait zéro pour TOUT. Il ne devient un vrai test
 *    qu'après, une fois que les pièces de la FRA, elles, comptent.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { resetAllOracleInstances } from '@/terminal/commands/database';
import { SqlPlusSubShell } from '@/terminal/subshells/SqlPlusSubShell';
import { ReactiveRmanSubShell } from '@/terminal/subshells/rman';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  resetAllOracleInstances();
  Logger.reset();
});

const sh = (srv: LinuxServer, cmd: string) => srv.executeShellCommandSync(cmd);

function bootOracleServer(name: string): LinuxServer {
  const srv = new LinuxServer('linux-server', name, 0, 0);
  SqlPlusSubShell.create(srv, ['/', 'as', 'sysdba']).subShell.dispose();
  return srv;
}

function backupDatabase(srv: LinuxServer, command = 'backup database;'): string {
  const rman = ReactiveRmanSubShell.create(srv, ['target', '/']);
  const out = rman.subShell.processLine(command).output.join('\n');
  rman.subShell.dispose();
  return out;
}

function recoveryFileDest(srv: LinuxServer): string {
  const sql = SqlPlusSubShell.create(srv, ['/', 'as', 'sysdba']).subShell;
  const out = sql.processLine('SELECT name FROM V$RECOVERY_FILE_DEST;').output.join('\n');
  sql.dispose();
  const line = out.split('\n').find(l => l.trim().startsWith('/'));
  return (line ?? '').trim();
}

describe('la pièce de sauvegarde atterrit dans la FRA que le moteur déclare', () => {
  it('le chemin de la pièce commence par V$RECOVERY_FILE_DEST', () => {
    const srv = bootOracleServer('fra1');
    const dest = recoveryFileDest(srv);
    expect(dest).toBe('/u01/app/oracle/fast_recovery_area');

    const out = backupDatabase(srv);
    const handle = out.split('\n').find(l => l.includes('piece handle='));
    expect(handle).toBeDefined();
    expect(handle).toContain(`piece handle=${dest}/`);
  });

  it('la pièce porte un nom OMF sous <FRA>/<DB>/backupset/<AAAA_MM_JJ>/', () => {
    const srv = bootOracleServer('fra2');
    backupDatabase(srv);
    const found = sh(srv, 'find /u01/app/oracle/fast_recovery_area -type f -name "*.bkp"').trim();
    expect(found).toMatch(
      /\/u01\/app\/oracle\/fast_recovery_area\/ORCL\/backupset\/\d{4}_\d{2}_\d{2}\/o1_mf_nnndf_TAG\d{8}T\d{6}_[a-z0-9]{8}_\.bkp/);
  });

  it('le répertoire daté de la FRA est créé par la base, appartenant à oracle', () => {
    const srv = bootOracleServer('fra3');
    backupDatabase(srv);
    const listing = sh(srv, 'ls -ld /u01/app/oracle/fast_recovery_area/ORCL/backupset').trim();
    expect(listing).toContain('oracle');
    expect(listing.startsWith('d')).toBe(true);
  });

  it('une sauvegarde incrémentale porte le code OMF de son niveau', () => {
    const srv = bootOracleServer('fra4');
    backupDatabase(srv, 'backup incremental level 0 database;');
    const found = sh(srv, 'find /u01/app/oracle/fast_recovery_area -type f -name "*.bkp"').trim();
    expect(found).toContain('/o1_mf_nnnd0_');
  });

  it('une destination FORMAT que personne n\'a créée est refusée', () => {
    const srv = bootOracleServer('fra5');
    const out = backupDatabase(srv, "backup database format '/mnt/nfs_absent/%U';");
    expect(out).toContain('ORA-19504');
    expect(sh(srv, 'ls /mnt/nfs_absent')).toContain('No such file or directory');
  });

  it('la pièce appartient à oracle:oinstall, comme le fichier de données', () => {
    const srv = bootOracleServer('fra7');
    backupDatabase(srv);
    const day = sh(srv, 'ls /u01/app/oracle/fast_recovery_area/ORCL/backupset').trim();
    const piece = sh(srv, `ls -l /u01/app/oracle/fast_recovery_area/ORCL/backupset/${day}`);
    const datafile = sh(srv, 'ls -l /u01/app/oracle/oradata/ORCL/users01.dbf');
    expect(piece).toContain('oracle oinstall');
    expect(datafile).toContain('oracle oinstall');
  });

  it('une destination FORMAT que le DBA a créée sans la donner à oracle est refusée', () => {
    const srv = bootOracleServer('fra8');
    sh(srv, 'mkdir -p /u01/backup_root');
    const out = backupDatabase(srv, "backup database format '/u01/backup_root/%U';");
    expect(out).toContain('ORA-19504');
  });

  it('TÉMOIN — une destination FORMAT que le DBA a créée reçoit bien la pièce', () => {
    const srv = bootOracleServer('fra6');
    sh(srv, 'mkdir -p /u01/backup && chown oracle:oinstall /u01/backup');
    const out = backupDatabase(srv, "backup database format '/u01/backup/%U';");
    expect(out).toContain('Finished backup');
    expect(sh(srv, 'find /u01/backup -type f').trim()).toContain('/u01/backup/');
  });
});

describe('FORMAT : toute variable annoncée est substituée', () => {
  it('%d %T %s %p %U %t %n %I ne laissent aucun littéral dans le nom', () => {
    const srv = bootOracleServer('fmt1');
    sh(srv, 'mkdir -p /u01/bk && chown oracle:oinstall /u01/bk');
    backupDatabase(srv, "backup database format '/u01/bk/%d_%T_%s_%p_%U_%t_%n_%I.bkp';");
    const name = sh(srv, 'ls /u01/bk').trim();
    expect(name).not.toContain('%');
    expect(name.startsWith('ORCL_')).toBe(true);
    const day = new Date();
    const compact = `${day.getFullYear()}`
      + `${String(day.getMonth() + 1).padStart(2, '0')}`
      + `${String(day.getDate()).padStart(2, '0')}`;
    expect(name).toContain(`ORCL_${compact}_`);
    expect(name).toContain('_ORCLxxxx_');
  });
});

describe('la FRA est un QUOTA, pas seulement un répertoire', () => {
  it('une pièce qui dépasserait db_recovery_file_dest_size est refusée (ORA-19809)', () => {
    const srv = bootOracleServer('quota1');
    expect(backupDatabase(srv)).toContain('Finished backup');
    expect(backupDatabase(srv)).toContain('Finished backup');
    const third = backupDatabase(srv);
    expect(third).toContain('ORA-19809');
    expect(third).toContain('ORA-19804');
    expect(sh(srv, 'find /u01/app/oracle/fast_recovery_area -name "*.bkp"')
      .trim().split('\n').filter(Boolean).length).toBe(2);
  });

  it('V$RECOVERY_FILE_DEST et V$RECOVERY_AREA_USAGE comptent la pièce que LIST BACKUP montre', () => {
    const srv = bootOracleServer('quota2');
    backupDatabase(srv);
    const sql = SqlPlusSubShell.create(srv, ['/', 'as', 'sysdba']).subShell;
    const dest = sql.processLine('SELECT space_used FROM V$RECOVERY_FILE_DEST;').output.join('\n');
    const usage = sql.processLine(
      "SELECT number_of_files FROM V$RECOVERY_AREA_USAGE WHERE file_type = 'BACKUP PIECE';")
      .output.join('\n');
    const sets = sql.processLine('SELECT COUNT(*) FROM V$BACKUP_SET;').output.join('\n');
    sql.dispose();
    expect(dest).toMatch(/\b1730150400\b/);
    expect(usage).toMatch(/\b1\b/);
    expect(sets).toMatch(/\b1\b/);
  });

  it('une pièce écrite HORS de la FRA ne consomme pas son quota', () => {
    const srv = bootOracleServer('quota3');
    sh(srv, 'mkdir -p /u01/hors && chown oracle:oinstall /u01/hors');
    backupDatabase(srv, "backup database format '/u01/hors/%U';");
    const sql = SqlPlusSubShell.create(srv, ['/', 'as', 'sysdba']).subShell;
    const dest = sql.processLine('SELECT space_used FROM V$RECOVERY_FILE_DEST;').output.join('\n');
    const sets = sql.processLine('SELECT COUNT(*) FROM V$BACKUP_SET;').output.join('\n');
    sql.dispose();
    expect(dest).toMatch(/\b0\b/);
    expect(sets).toMatch(/\b1\b/);
  });
});
