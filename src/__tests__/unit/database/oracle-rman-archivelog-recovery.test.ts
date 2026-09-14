/**
 * Sonde — le journal archive porte l'etat, et RECOVER roule en avant.
 * Laboratoire routeur + pare-feu.
 *
 * Releve AVANT :
 *
 *   cat .../archivelog/1_1_arc.arc     "[ORACLE ARCHIVED REDO LOG - sequence 1]"
 *
 *   BACKUP DATABASE ; INSERT (2e ligne) ; COMMIT ; SWITCH LOGFILE
 *   lignes avant sinistre                        2
 *   SHUTDOWN / STARTUP MOUNT / RESTORE / RECOVER
 *     RMAN-03014: RMAN-06054: media recovery requesting unknown
 *                 archived log for thread 1 with sequence 1
 *   lignes apres                                 1
 *
 * Le journal archive existait, V$ARCHIVED_LOG le listait, son nom sur le
 * disque correspondait — mais il ne portait qu'une phrase. La ligne
 * ecrite APRES la sauvegarde etait perdue : sans redo, une restauration
 * ne peut que revenir au dernier jeu de sauvegarde.
 *
 * Deux causes, fermees ici :
 *   - le fichier .arc ne portait aucun etat ;
 *   - getArchivelogPaths lisait l'etat d'execution en memoire, que le
 *     SHUTDOWN efface. Les journaux etaient sur le disque et invisibles,
 *     d'ou le RMAN-06054 au moment precis ou ils servent. La liste vient
 *     maintenant du DISQUE, comme l'autobackup du lot R5.
 *
 * La limite que ce lot avait nommee — le journal ne portait qu'un
 * INSTANTANE au switch, donc `UNTIL SCN` etait quantifie au switch — est
 * fermee par le lot R4b, dont la sonde est oracle-rman-redo-vectors.
 * L'instantane reste : il est la base sur laquelle les vecteurs se
 * rejouent, et c'est lui que les cas ci-dessous mesurent.
 *
 * Discrimination par `git stash push -- src/terminal src/database src/adapters` :
 * 2 cas sur 5 tombent avant le correctif — les deux qui portent le lot :
 * le contenu du journal archive, et le roulement en avant.
 *
 * Les TROIS qui ne discriminent pas, nommes avec leur raison :
 *  - « V$ARCHIVED_LOG nomme les fichiers qui sont vraiment la » :
 *    NON-REGRESSION. Cette coherence-la existait deja ; le lot deplace la
 *    source de la liste vers le disque et ne doit pas la casser.
 *  - « BACKUP ARCHIVELOG ALL ecrit une piece au code OMF des journaux » :
 *    NON-REGRESSION du lot R6, qui a pose le code `annnn`.
 *  - « sans journal archive, RECOVER refuse » : TEMOIN. Le refus existait
 *    et devait survivre ; c'est lui qui prouve que les deux reussites
 *    viennent des journaux appliques et non d'un RECOVER complaisant.
 *
 * (Une premiere redaction de cet en-tete annoncait 4 sur 5. La mesure en
 * donne 2 : les deux non-regressions ci-dessus passaient deja.)
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

const ARC_DIR = '/u01/app/oracle/archivelog';

const rman = (script: string): string =>
  lab.sh(lab.prod, `printf '${script}\\n' | rman target /`);

const rowCount = (): string =>
  lab.sql(lab.prod, 'SELECT COUNT(*) FROM clients;');

function intoArchivelogMode(): void {
  rman('SHUTDOWN IMMEDIATE;\\nSTARTUP MOUNT;\\nSQL "ALTER DATABASE ARCHIVELOG";\\nALTER DATABASE OPEN;');
}

describe('le journal archive porte un etat, pas une phrase', () => {
  it('un switch en mode ARCHIVELOG ecrit les images des tablespaces', () => {
    intoArchivelogMode();
    lab.sql(lab.prod, 'CREATE TABLE clients (id NUMBER);');
    lab.sql(lab.prod, 'INSERT INTO clients VALUES (1);');
    lab.sql(lab.prod, 'COMMIT;');
    lab.sql(lab.prod, 'ALTER SYSTEM SWITCH LOGFILE;');

    const arc = lab.sh(lab.prod, `cat $(find ${ARC_DIR} -name "*.arc" | head -1)`);
    expect(arc).toContain('ORACLE ARCHIVED REDO LOG');
    expect(arc).toContain('ORACLE-BACKUP-PIECE-IMAGE');
    expect(arc).toContain('CLIENTS');
  });

  it('V$ARCHIVED_LOG nomme les fichiers qui sont vraiment la', () => {
    intoArchivelogMode();
    lab.sql(lab.prod, 'ALTER SYSTEM SWITCH LOGFILE;');
    const view = lab.sql(lab.prod, 'SELECT name FROM v$archived_log;');
    const onDisk = lab.sh(lab.prod, `find ${ARC_DIR} -name "*.arc"`).trim();
    const first = view.split('\n').find(l => l.includes('.arc'))?.trim() ?? '';
    expect(first).not.toBe('');
    expect(onDisk).toContain(first);
  });
});

describe('la reprise roule en avant au-dela de la sauvegarde', () => {
  it('une ligne ecrite APRES la sauvegarde revient par le journal archive', () => {
    intoArchivelogMode();
    lab.sql(lab.prod, 'CREATE TABLE clients (id NUMBER);');
    lab.sql(lab.prod, 'INSERT INTO clients VALUES (1);');
    lab.sql(lab.prod, 'COMMIT;');
    rman('BACKUP DATABASE;');

    lab.sql(lab.prod, 'INSERT INTO clients VALUES (2);');
    lab.sql(lab.prod, 'COMMIT;');
    lab.sql(lab.prod, 'ALTER SYSTEM SWITCH LOGFILE;');
    expect(rowCount()).toMatch(/\b2\b/);

    const out = rman(
      'SHUTDOWN IMMEDIATE;\\nSTARTUP MOUNT;\\nRESTORE DATABASE;\\nRECOVER DATABASE;\\nALTER DATABASE OPEN;');
    expect(out).toContain('media recovery complete');
    expect(out).not.toContain('RMAN-06054');
    expect(rowCount()).toMatch(/\b2\b/);
  });

  it('BACKUP ARCHIVELOG ALL ecrit une piece au code OMF des journaux', () => {
    intoArchivelogMode();
    lab.sql(lab.prod, 'ALTER SYSTEM SWITCH LOGFILE;');
    const out = rman('BACKUP ARCHIVELOG ALL;');
    expect(out).toContain('Finished backup');
    expect(out).toMatch(/o1_mf_annnn_/);
  });

  it('TEMOIN — sans journal archive, RECOVER refuse au lieu de mentir', () => {
    lab.sql(lab.prod, 'CREATE TABLE clients (id NUMBER);');
    lab.sql(lab.prod, 'INSERT INTO clients VALUES (1);');
    lab.sql(lab.prod, 'COMMIT;');
    rman('BACKUP DATABASE;');
    const out = rman(
      'SHUTDOWN IMMEDIATE;\\nSTARTUP MOUNT;\\nRESTORE DATABASE;\\nRECOVER DATABASE;');
    expect(out).toContain('RMAN-06054');
  });
});
