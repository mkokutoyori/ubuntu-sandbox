/**
 * Sonde — DUPLICATE ... FOR STANDBY : la commande par laquelle une
 * standby NAIT, et les briques qui lui manquaient.
 *
 * Le chantier Data Guard avait rendu reels le transport (R13),
 * l'application (R14) et la bascule (R15) ; mais aucune commande ne
 * CREAIT la standby. Le banc `debug/rman/duplicate-pour-standby` a
 * mesure la chaine entiere de ce qui bloquait :
 *
 *   - les trois formes `FOR STANDBY` etaient refusees par le
 *     dispatcheur (RMAN-01009), son motif exigeant un `TO <nom>` que
 *     cette commande n'a justement pas ;
 *   - une instance auxiliaire NOMOUNT etait INJOIGNABLE : le listener
 *     refusait ORA-12528 alors que son propre `listener.ora` declarait
 *     le SID en SID_LIST_LISTENER et que `lsnrctl status` le rendait.
 *     Deux vues du meme fait qui se contredisaient (regle 3), et un
 *     verrou qui interdisait toute duplication ;
 *   - `ALTER DATABASE MOUNT STANDBY DATABASE` — l'ordre que le script
 *     memoire de RMAN emet lui-meme — etait une erreur de syntaxe ;
 *   - `ALTER DATABASE OPEN READ ONLY` etait accepte, analyse (le
 *     parseur remplissait `details`) et IGNORE : OPEN_MODE repondait
 *     READ WRITE et la base acceptait les ecritures (regle 6) ;
 *   - une base MONTEE repondait aux requetes utilisateur, la ou tout
 *     Oracle repond ORA-01219 ;
 *   - `RESTORE ... PREVIEW` imprimait « 1 backup set(s) examined » au
 *     lieu de la liste des sauvegardes et des SCN de reprise.
 *
 * Les octets des datafiles TRAVERSENT le reseau (regle 4) : un appel
 * Oracle Net ShipDatafile, decoupe comme le ShipRedo de R13 puisque
 * l'en-tete NS porte sa longueur sur 16 bits, et reassemble par le
 * processus serveur d'en face, qui charge le tablespace et publie
 * l'ecriture sur SON disque. Rien n'est pris sur l'objet du pair.
 *
 * Autorites (docs.oracle.com est injoignable depuis cet environnement ;
 * les formulations viennent d'extraits de recherche et sont citees comme
 * telles) : RMAN-05501 « aborting duplication of target database »,
 * RMAN-05500 « the auxiliary database must be not mounted when issuing a
 * DUPLICATE command », RMAN-05001 « auxiliary file name ... conflicts
 * with a file used by the target database », RMAN-06171 « not connected
 * to auxiliary database », et pour PREVIEW les trois lignes « recovery
 * will be done up to SCN / Media recovery start SCN is / Recovery must
 * be done beyond SCN ... to clear datafile fuzziness ».
 *
 * Discrimination par `git stash push -- src/database src/network
 * src/terminal src/adapters` : 12 cas sur 15 tombent avant (mesure).
 *
 * Les TROIS qui ne discriminent pas, nommes avec leur raison :
 *  - « TEMOIN DU FIL — pare-feu ferme » : TEMOIN. Il passe avant (la
 *    commande etait refusee) comme apres (le transport echoue), donc il
 *    ne prouve rien seul ; ce qu'il garde, c'est la DIFFERENCE avec le
 *    cas pare-feu ouvert, qui lui tombe avant.
 *  - « TEMOIN — la forme clone DUPLICATE ... TO AUX » : non-regression.
 *  - « TEMOIN — LIST BACKUP rend toujours sa table » : non-regression du
 *    rendu extrait en commun avec PREVIEW.
 *
 * AJOUT APRES MESURE : les tableaux sont desormais rendus par
 * `renderTable` (`shells/cli/TextTable`), l'utilitaire du depot, et non
 * plus par des `padEnd` comptes a la main des deux cotes — deux colonnes
 * debordaient leur largeur declaree (`Completion Time` et `Ckp Time`
 * portent 20 caracteres, pas 19 ni 15) et decalaient tout ce qui les
 * suivait. Les deux cas « alignes » verifient la STRUCTURE : a chaque
 * frontiere que le filet dessine, chaque ligne de donnees porte un
 * blanc. Ils tombent avant le lot.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { LinuxServer } from '@/network/devices/LinuxServer';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { getOracleDatabase, resetAllOracleInstances } from '@/terminal/commands/database';
import { BackupKey, DeviceCatalogRegistry } from '@/terminal/subshells/rman';
import { buildRmanLab, type RmanLab } from '../support/rmanLab';

const ORADATA = '/u01/app/oracle/oradata/ORCL';
let lab: RmanLab;

beforeEach(async () => {
  resetCounters();
  resetDeviceCounters();
  resetAllOracleInstances();
  Logger.reset();
  BackupKey._reset();
  DeviceCatalogRegistry._reset();
  lab = await buildRmanLab();
});

const sh = (srv: LinuxServer, cmd: string) => srv.executeShellCommandSync(cmd);
const rman = (srv: LinuxServer, lines: string[]): string =>
  sh(srv, `echo "${lines.join('\n')}" | rman target /`);

function inArchivelog(srv: LinuxServer): void {
  const db = getOracleDatabase(srv.getId());
  (db.instance as unknown as { _archiveLogMode: boolean })._archiveLogMode = true;
}

function primaryWithOneRow(): LinuxServer {
  const { prod } = lab;
  inArchivelog(prod);
  inArchivelog(lab.dr);
  lab.sql(prod, 'CREATE TABLE clients (id NUMBER);');
  lab.sql(prod, 'INSERT INTO clients VALUES (1);');
  lab.sql(prod, 'COMMIT;');
  return prod;
}

function auxiliaryInNomount(): void {
  lab.sql(lab.dr, 'SHUTDOWN IMMEDIATE;');
  lab.sql(lab.dr, 'STARTUP NOMOUNT;');
}

const DUPLICATE_FULL =
  'DUPLICATE TARGET DATABASE FOR STANDBY FROM ACTIVE DATABASE DORECOVER NOFILENAMECHECK;';

function duplicateFromProd(command = DUPLICATE_FULL, withAuxiliary = true): string {
  const lines = withAuxiliary
    ? [`CONNECT AUXILIARY sys/oracle@${lab.drIp}:1521/ORCL;`, command, 'EXIT;']
    : [command, 'EXIT;'];
  return rman(lab.prod, lines);
}

function count(output: string): number | null {
  const line = output.split('\n').map(l => l.trim())
    .find(l => /^\d+$/.test(l));
  return line === undefined ? null : Number(line);
}

describe('DUPLICATE ... FOR STANDBY', () => {
  it('cree une standby : role, datafiles et fichier de controle sur l auxiliaire', () => {
    primaryWithOneRow();
    auxiliaryInNomount();
    const out = duplicateFromProd();
    expect(out).toContain('Finished Duplicate Db at');
    expect(out).toContain('sql statement: alter database mount standby database');
    expect(lab.sql(lab.dr, 'SELECT database_role FROM v$database;'))
      .toContain('PHYSICAL STANDBY');
    expect(sh(lab.dr, `ls ${ORADATA}`)).toContain('users01.dbf');
    expect(lab.sql(lab.dr, 'SELECT name FROM v$datafile;')).toContain('users01.dbf');
  });

  it('les octets du primaire arrivent vraiment : la ligne est lisible apres bascule', () => {
    primaryWithOneRow();
    auxiliaryInNomount();
    duplicateFromProd();
    lab.sql(lab.dr, 'ALTER DATABASE FAILOVER TO DR;');
    lab.sql(lab.dr, 'ALTER DATABASE OPEN;');
    expect(count(lab.sql(lab.dr, 'SELECT COUNT(*) FROM clients;'))).toBe(1);
  });

  it('le corps recu est CELUI du primaire, octet pour octet', () => {
    primaryWithOneRow();
    auxiliaryInNomount();
    duplicateFromProd();
    const onProd = sh(lab.prod, `cat ${ORADATA}/users01.dbf`);
    expect(sh(lab.dr, `cat ${ORADATA}/users01.dbf`)).toBe(onProd);
    expect(onProd.toUpperCase()).toContain('CLIENTS');
  });

  it('sans NOFILENAMECHECK, les memes noms sont refuses (RMAN-05001)', () => {
    primaryWithOneRow();
    auxiliaryInNomount();
    const out = duplicateFromProd('DUPLICATE TARGET DATABASE FOR STANDBY FROM ACTIVE DATABASE;');
    expect(out).toContain('RMAN-05501: aborting duplication of target database');
    expect(out).toContain(`RMAN-05001: auxiliary file name ${ORADATA}/system01.dbf`
      + ' conflicts with a file used by the target database');
    expect(lab.sql(lab.dr, 'SELECT database_role FROM v$database;')).toContain('PRIMARY');
  });

  it('sans session AUXILIARY, la duplication est refusee (RMAN-06171)', () => {
    primaryWithOneRow();
    auxiliaryInNomount();
    const out = duplicateFromProd(DUPLICATE_FULL, false);
    expect(out).toContain('RMAN-05501: aborting duplication of target database');
    expect(out).toContain('RMAN-06171: not connected to auxiliary database');
  });

  it('une auxiliaire deja MONTEE est refusee (RMAN-05500)', () => {
    primaryWithOneRow();
    lab.sql(lab.dr, 'SHUTDOWN IMMEDIATE;');
    lab.sql(lab.dr, 'STARTUP NOMOUNT;');
    lab.sql(lab.dr, 'ALTER DATABASE MOUNT;');
    const out = duplicateFromProd();
    expect(out).toContain(
      'RMAN-05500: the auxiliary database must be not mounted when issuing a DUPLICATE command');
  });

  it('TEMOIN DU FIL — pare-feu ferme, aucun datafile n arrive', async () => {
    primaryWithOneRow();
    auxiliaryInNomount();
    for (const line of [
      'config firewall policy', 'edit 1', 'set action deny', 'next', 'end',
    ]) await lab.firewall.executeCommand(line);
    const out = duplicateFromProd();
    expect(out).not.toContain('Finished Duplicate Db at');
    expect(lab.sql(lab.dr, 'SELECT database_role FROM v$database;')).toContain('PRIMARY');
  });

  it('TEMOIN — la forme clone DUPLICATE ... TO AUX reste servie', () => {
    primaryWithOneRow();
    rman(lab.prod, ['BACKUP DATABASE;', 'EXIT;']);
    const out = rman(lab.prod, ['DUPLICATE TARGET DATABASE TO AUX;', 'EXIT;']);
    expect(out).toContain('Finished Duplicate Db at');
    expect(out).toContain('restore clone database');
  });
});

describe('les briques que la duplication exigeait', () => {
  it('listener.ora declare le SID en statique, donc une instance NOMOUNT repond', () => {
    auxiliaryInNomount();
    const out = duplicateFromProd('EXIT;').toString();
    expect(out).not.toContain('ORA-12528');
    expect(sh(lab.dr, 'lsnrctl status')).toContain('status UNKNOWN');
  });

  it('une base MONTEE refuse une requete utilisateur et sert les vues fixes', () => {
    primaryWithOneRow();
    lab.sql(lab.dr, 'CREATE TABLE marqueur (id NUMBER);');
    lab.sql(lab.dr, 'SHUTDOWN IMMEDIATE;');
    lab.sql(lab.dr, 'STARTUP MOUNT;');
    expect(lab.sql(lab.dr, 'SELECT COUNT(*) FROM marqueur;'))
      .toContain('ORA-01219');
    expect(lab.sql(lab.dr, 'SELECT status FROM v$instance;')).toContain('MOUNTED');
  });

  it('ALTER DATABASE OPEN READ ONLY est honore : OPEN_MODE et refus d ecriture', () => {
    const prod = primaryWithOneRow();
    lab.sql(prod, 'SHUTDOWN IMMEDIATE;');
    lab.sql(prod, 'STARTUP MOUNT;');
    expect(lab.sql(prod, 'ALTER DATABASE OPEN READ ONLY;')).toContain('Database altered.');
    expect(lab.sql(prod, 'SELECT open_mode FROM v$database;')).toContain('READ ONLY');
    expect(lab.sql(prod, 'INSERT INTO clients VALUES (2);')).toContain('ORA-16000');
    expect(count(lab.sql(prod, 'SELECT COUNT(*) FROM clients;'))).toBe(1);
  });
});

function boundaryColumns(rule: string): number[] {
  const at: number[] = [];
  for (let i = 0; i < rule.length; i++) if (rule[i] === ' ') at.push(i);
  return at;
}

function tableIsAligned(lines: readonly string[], headerStart: string): boolean {
  const head = lines.findIndex(l => l.startsWith(headerStart));
  if (head < 0) return false;
  const rule = lines[head + 1];
  if (!/^\s*-/.test(rule)) return false;
  const boundaries = boundaryColumns(rule);
  if (boundaries.length === 0) return false;
  const indent = (line: string): number => (/^\s*/.exec(line)?.[0].length ?? 0);
  const firstRow = lines[head + 2];
  if (firstRow === undefined || !/^\s*\d/.test(firstRow)) return false;
  let rows = 0;
  for (let i = head + 2; i < lines.length; i++) {
    if (!/^\s*\d/.test(lines[i]) || indent(lines[i]) !== indent(firstRow)) break;
    if (boundaries.some(at => lines[i][at] !== ' ')) return false;
    rows++;
  }
  return rows > 0 && boundaries.every(at => lines[head][at] === ' ');
}

describe('la forme des sorties : un seul calcul pour l en-tete, le filet et les donnees', () => {
  it('LIST BACKUP et son sous-tableau de datafiles sont alignes', () => {
    const prod = primaryWithOneRow();
    rman(prod, ['BACKUP DATABASE;', 'BACKUP INCREMENTAL LEVEL 0 DATABASE;', 'EXIT;']);
    const lines = rman(prod, ['LIST BACKUP;', 'EXIT;']).split('\n');
    expect(tableIsAligned(lines, 'BS Key  Type LV Size')).toBe(true);
    expect(tableIsAligned(lines.map(l => l.replace(/^ {2}/, '')), 'File LV Type Ckp SCN')).toBe(true);
  });

  it('LIST BACKUP SUMMARY et LIST INCARNATION sont alignes', () => {
    const prod = primaryWithOneRow();
    rman(prod, ['BACKUP DATABASE;', 'EXIT;']);
    expect(tableIsAligned(rman(prod, ['LIST BACKUP SUMMARY;', 'EXIT;']).split('\n'), 'Key     TY LV S'))
      .toBe(true);
    expect(tableIsAligned(rman(prod, ['LIST INCARNATION;', 'EXIT;']).split('\n'), 'DB Key  Inc Key'))
      .toBe(true);
  });
});

describe('RESTORE ... PREVIEW', () => {
  it('liste les sauvegardes employees et les SCN de reprise', () => {
    const prod = primaryWithOneRow();
    rman(prod, ['BACKUP DATABASE;', 'EXIT;']);
    const out = rman(prod, ['RESTORE DATABASE PREVIEW;', 'EXIT;']);
    expect(out).toContain('List of Backup Sets');
    expect(out).toMatch(/BS Key\s+Type LV Size/);
    expect(out).toMatch(/Piece Name: \/u01\/app\/oracle\/fast_recovery_area\S+\.bkp/);
    expect(out).toMatch(/recovery will be done up to SCN \d+/);
    expect(out).toMatch(/Media recovery start SCN is \d+/);
    expect(out).toMatch(/Recovery must be done beyond SCN \d+ to clear datafile fuzziness/);
    expect(out).not.toContain('backup set(s) examined');
  });

  it('TEMOIN — LIST BACKUP rend toujours sa table', () => {
    const prod = primaryWithOneRow();
    rman(prod, ['BACKUP DATABASE;', 'EXIT;']);
    const out = rman(prod, ['LIST BACKUP;', 'EXIT;']);
    expect(out).toContain('List of Backup Sets');
    expect(out).toMatch(/BP Key: 1\s+Status: AVAILABLE/);
    expect(out).toContain('List of Datafiles in backup set 1');
  });
});
