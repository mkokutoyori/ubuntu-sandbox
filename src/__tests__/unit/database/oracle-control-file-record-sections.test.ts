/**
 * Sonde — le fichier de controle porte sa structure des le demarrage, et
 * V$CONTROLFILE_RECORD_SECTION compte ce qu'il contient vraiment.
 * Laboratoire routeur + pare-feu (le meme que tout le lot RMAN).
 *
 * Releve AVANT, sur la limite nommee en tete de la sonde du lot R5 :
 *
 *   cat control01.ctl (base fraiche)      "[ORACLE CONTROL FILE 1]"
 *                                         et rien d'autre
 *
 *   SELECT type, records_total, records_used FROM v$controlfile_record_section
 *     DATABASE                1     0
 *     REDO LOG               16     1
 *     DATAFILE              200    20
 *     TABLESPACE             12     1
 *     ARCHIVED LOG           31     3
 *     BACKUP SET           4096   409
 *     BACKUP PIECE         4203   420
 *
 *   SELECT COUNT(*) FROM v$datafile      4
 *   SELECT COUNT(*) FROM v$tablespace    5
 *   SELECT COUNT(*) FROM v$log           3
 *
 *   BACKUP DATABASE ; puis la MEME requete  -> les memes chiffres
 *
 * Trois defauts, un seul mensonge. RECORDS_USED valait RECORDS_TOTAL / 10
 * pour toutes les sections : un chiffre qu'aucun fait ne soutient, qui
 * contredisait V$DATAFILE (20 contre 4) et V$TABLESPACE (1 contre 5) sur
 * la MEME machine au MEME instant, qui annoncait 409 jeux de sauvegarde
 * sur une base qui n'en avait aucun, et qui ne bougeait pas d'un pouce
 * apres une sauvegarde reelle. Le fichier de controle, lui, ne portait
 * que sa banniere tant que RMAN n'avait pas tourne ; un tablespace cree
 * apres la derniere sauvegarde n'y entrait jamais.
 *
 * La fermeture tient en une idee : le compte d'une section EST le nombre
 * d'enregistrements que cette section porte, et c'est la vue soeur qui
 * les enumere. Chaque section delegue donc a la sienne — DATAFILE a
 * V$DATAFILE, TABLESPACE a V$TABLESPACE, BACKUP PIECE a V$BACKUP_PIECE —
 * ce qui rend la divergence inexprimable. Les sections que ce simulateur
 * n'alimente pas (CKPT PROGRESS, RMAN CONFIGURATION, OFFLINE RANGE)
 * comptent zero, ce qui est leur compte exact.
 *
 * Cote fichier, le §2 du R5 refusait deux redacteurs pour un fichier.
 * La reponse n'est pas un seul redacteur mais une seule ECRITURE et deux
 * sections : `controlFileStructureOf` compose la moitie structurelle
 * depuis `storage.listDatafiles()` (l'enumeration canonique de
 * V$DATAFILE), `mergeControlFileImage` preserve la moitie RMAN telle que
 * RMAN l'a ecrite, et `controlFileBody` est le seul endroit qui sait a
 * quoi ressemble un fichier de controle. C'est le modele du vrai fichier
 * de controle, dont les sections ont des redacteurs differents.
 *
 * Discrimination par `git stash push -- src/database src/adapters src/terminal` :
 * 5 cas sur 7 tombent avant le correctif.
 *
 * Les DEUX qui ne discriminent pas, nommes avec leur raison :
 *  - « RECORDS_TOTAL ne bouge pas » : NON-REGRESSION. L'allocation des
 *    sections est une constante du vrai fichier de controle ; ce lot
 *    corrige le compte utilise et ne doit pas toucher a l'allocation.
 *  - « un redemarrage n'efface pas les jeux de sauvegarde du fichier de
 *    controle » : NON-REGRESSION, et elle garde le defaut que ce lot
 *    pouvait introduire — l'adaptateur reecrit maintenant le fichier a
 *    chaque changement de structure, et sans la fusion il ecraserait le
 *    repertoire RMAN. Avant le correctif l'adaptateur ne reecrivait
 *    jamais, donc le cas passait ; c'est apres qu'il mord.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { resetAllOracleInstances } from '@/terminal/commands/database';
import { buildRmanLab, type RmanLab } from '../../support/rmanLab';

let lab: RmanLab;

beforeEach(async () => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  resetAllOracleInstances();
  Logger.reset();
  lab = await buildRmanLab();
});

const rman = (script: string): string =>
  lab.sh(lab.prod, `printf '${script}\\n' | rman target /`);

const controlFile = (): string =>
  lab.sh(lab.prod, 'cat $(find / -name "control01.ctl" 2>/dev/null | head -1)');

const count = (view: string): number =>
  Number((/^\s*(\d+)\s*$/m.exec(lab.sql(lab.prod, `SELECT COUNT(*) FROM ${view};`)) ?? [, '-1'])[1]);

function recordsUsed(section: string): number {
  const out = lab.sql(lab.prod,
    `SELECT records_used FROM v$controlfile_record_section WHERE type = '${section}';`);
  return Number((/^\s*(\d+)\s*$/m.exec(out) ?? [, '-1'])[1]);
}

function recordsTotal(section: string): number {
  const out = lab.sql(lab.prod,
    `SELECT records_total FROM v$controlfile_record_section WHERE type = '${section}';`);
  return Number((/^\s*(\d+)\s*$/m.exec(out) ?? [, '-1'])[1]);
}

describe('le fichier de controle porte sa structure sans attendre RMAN', () => {
  it('une base jamais sauvegardee y inscrit deja son nom, son DBID et ses datafiles', () => {
    const body = controlFile();
    expect(body).toContain('ORACLE-CONTROL-FILE-IMAGE');
    expect(body).toContain('"dbName":"ORCL"');
    expect(body).toMatch(/"dbId":\d{9,}/);
    expect(body).toContain('system01.dbf');
    expect(body).toContain('users01.dbf');
  });

  it('un tablespace cree apres la derniere sauvegarde y entre quand meme', () => {
    rman('BACKUP DATABASE;');
    expect(controlFile()).not.toContain('apps01.dbf');

    lab.sql(lab.prod,
      "CREATE TABLESPACE apps DATAFILE '/u01/app/oracle/oradata/ORCL/apps01.dbf' SIZE 50M;");
    expect(controlFile()).toContain('apps01.dbf');
  });

  it('NON-REGRESSION — un redemarrage n efface pas les jeux de sauvegarde du fichier de controle', () => {
    rman('BACKUP DATABASE;');
    expect(controlFile()).toMatch(/"backupSets":\[\{/);

    rman('SHUTDOWN IMMEDIATE;\\nSTARTUP;');
    lab.sql(lab.prod, 'ALTER SYSTEM CHECKPOINT;');
    expect(controlFile()).toMatch(/"backupSets":\[\{/);
  });
});

describe('V$CONTROLFILE_RECORD_SECTION compte, il n invente pas', () => {
  it('les sections de structure s accordent avec les vues qui enumerent leurs enregistrements', () => {
    expect(recordsUsed('DATAFILE')).toBe(count('v$datafile'));
    expect(recordsUsed('TABLESPACE')).toBe(count('v$tablespace'));
    expect(recordsUsed('TEMPORARY FILENAME')).toBe(count('v$tempfile'));
    expect(recordsUsed('REDO LOG')).toBe(count('v$logfile'));
    expect(recordsUsed('DATABASE')).toBe(1);
  });

  it('les sections de sauvegarde partent de zero et suivent la sauvegarde reelle', () => {
    expect(recordsUsed('BACKUP SET')).toBe(0);
    expect(recordsUsed('BACKUP PIECE')).toBe(0);
    expect(recordsUsed('BACKUP DATAFILE')).toBe(0);

    rman('BACKUP DATABASE;');

    expect(recordsUsed('BACKUP SET')).toBe(count('v$backup_set'));
    expect(recordsUsed('BACKUP SET')).toBeGreaterThan(0);
    expect(recordsUsed('BACKUP PIECE')).toBe(count('v$backup_piece'));
    expect(recordsUsed('BACKUP DATAFILE')).toBe(count('v$backup_datafile'));
  });

  it('un tempfile n est pas compte parmi les datafiles sauvegardes', () => {
    rman('BACKUP DATABASE;');
    expect(count('v$backup_datafile')).toBe(count('v$datafile'));
    expect(lab.sql(lab.prod, 'SELECT name FROM v$backup_datafile;')).not.toContain('temp01.dbf');
  });

  it('NON-REGRESSION — RECORDS_TOTAL reste l allocation du vrai fichier de controle', () => {
    expect(recordsTotal('DATAFILE')).toBe(200);
    expect(recordsTotal('TABLESPACE')).toBe(12);
    expect(recordsTotal('BACKUP SET')).toBe(4096);
    rman('BACKUP DATABASE;');
    expect(recordsTotal('BACKUP SET')).toBe(4096);
  });
});
