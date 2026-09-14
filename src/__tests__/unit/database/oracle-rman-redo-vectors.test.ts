/**
 * Sonde — le journal archive porte des VECTEURS DE CHANGEMENT, et la
 * granularite de UNTIL SCN descend a la transaction.
 * Laboratoire routeur + pare-feu (le meme que tout le lot RMAN).
 *
 * Releve AVANT, sur la limite nommee en tete de la sonde du lot R4 :
 *
 *   CREATE clients ; INSERT 1 ; COMMIT ; BACKUP DATABASE
 *   INSERT 2 ; COMMIT     -> SCN retenu comme borne
 *   INSERT 3 ; COMMIT ; INSERT 4 ; COMMIT ; SWITCH LOGFILE
 *   RESTORE ; RECOVER DATABASE UNTIL SCN <borne>
 *     lignes obtenues                            1
 *     lignes attendues                           1,2
 *
 *   cat .../archivelog/1_1_arc.arc
 *     [ORACLE ARCHIVED REDO LOG - sequence 1]
 *     ORACLE-BACKUP-PIECE-IMAGE {...}            <- un INSTANTANE, et rien d'autre
 *
 * Le journal ne portait qu'une photo des tablespaces prise au moment du
 * switch. Une borne tombant entre deux switchs ne pouvait donc rien
 * retenir : l'instantane entier etait posterieur a la borne, il etait
 * rejete, et la reprise revenait au dernier jeu de sauvegarde. La borne
 * etait reelle mais sa granularite etait le switch.
 *
 * Le moteur produisait pourtant deja les vecteurs : `UndoRecord` dans
 * TransactionManager decrit chaque insert / update / delete par sa ligne
 * avant et apres. Appliquer un undo a l'endroit, c'est du redo. Le
 * chemin pose ici : COMMIT rend son journal d'annulation a `onCommit`,
 * l'executeur l'estampille du SCN courant et le met en tampon dans
 * l'instance, le switch de journal le vide dans l'evenement d'archivage,
 * OracleFilesystemSync l'ecrit derriere l'instantane, et RmanJobEngine
 * rejoue instantane PUIS vecteurs, en sautant ceux que la sauvegarde
 * restauree porte deja (`rec.scn <= _restoredScn`) et en s'arretant a la
 * borne.
 *
 * Discrimination par `git stash push -- src/terminal src/database src/adapters` :
 * 4 cas sur 7 tombent avant le correctif.
 *
 * Les TROIS qui ne discriminent pas, nommes avec leur raison :
 *  - « une borne posterieure a tous les commits rend toutes les lignes » :
 *    TEMOIN. Il prouve que le laboratoire ecrit bien quatre lignes et
 *    qu'un UNTIL SCN ne les perd pas par simple troncature ; c'est lui
 *    qui donne son sens aux echecs des autres. Il passait deja parce que
 *    l'instantane du dernier switch portait l'etat complet.
 *  - « le redo anterieur a la sauvegarde restauree n'est pas rejoue deux
 *    fois » : NON-REGRESSION, et elle garde un defaut que ce lot a
 *    reellement introduit avant de le fermer — la premiere redaction
 *    rendait 1,1,2, la ligne 1 arrivant une fois par l'instantane
 *    restaure et une fois par son vecteur. Avant le correctif il n'y
 *    avait aucun vecteur a rejouer deux fois, donc le cas passait ;
 *    c'est apres qu'il mord.
 *  - « sans journal archive, RECOVER refuse au lieu de mentir » :
 *    NON-REGRESSION du lot R4. Le refus devait survivre a l'ajout des
 *    vecteurs.
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

const sql = (statement: string): string => lab.sql(lab.prod, statement);

const currentScn = (): number =>
  Number((/(\d{6,})/.exec(sql('SELECT current_scn FROM v$database;')) ?? [, '0'])[1]);

const ids = (): string =>
  sql('SELECT id FROM clients ORDER BY id;')
    .split('\n')
    .filter(line => /^\s*\d+\s*$/.test(line))
    .map(line => line.trim())
    .join(',');

function intoArchivelogMode(): void {
  rman('SHUTDOWN IMMEDIATE;\\nSTARTUP MOUNT;\\nSQL "ALTER DATABASE ARCHIVELOG";\\nALTER DATABASE OPEN;');
}

function commit(statement: string): void {
  sql(statement);
  sql('COMMIT;');
}

function backedUpWithOneRow(): void {
  intoArchivelogMode();
  sql('CREATE TABLE clients (id NUMBER);');
  commit('INSERT INTO clients VALUES (1);');
  rman('BACKUP DATABASE;');
}

function restoreUntil(scn: number): string {
  return rman(
    `SHUTDOWN IMMEDIATE;\\nSTARTUP MOUNT;\\nRESTORE DATABASE;\\nRECOVER DATABASE UNTIL SCN ${scn};\\nALTER DATABASE OPEN;`);
}

describe('le journal archive porte des vecteurs de changement', () => {
  it('un switch ecrit le flux de redo derriere l instantane', () => {
    intoArchivelogMode();
    sql('CREATE TABLE clients (id NUMBER);');
    commit('INSERT INTO clients VALUES (7);');
    sql('ALTER SYSTEM SWITCH LOGFILE;');

    const arc = lab.sh(lab.prod, `cat $(find ${ARC_DIR} -name "*.arc" | head -1)`);
    expect(arc).toContain('ORACLE-BACKUP-PIECE-IMAGE');
    expect(arc).toContain('ORACLE-REDO-STREAM');
    expect(arc).toMatch(/"kind":"insert"/);
    expect(arc).toMatch(/"table":"CLIENTS"/i);
  });

  it('chaque vecteur porte le SCN de son commit, pas celui du switch', () => {
    intoArchivelogMode();
    sql('CREATE TABLE clients (id NUMBER);');
    commit('INSERT INTO clients VALUES (1);');
    commit('INSERT INTO clients VALUES (2);');
    sql('ALTER SYSTEM SWITCH LOGFILE;');

    const arc = lab.sh(lab.prod, `cat $(find ${ARC_DIR} -name "*.arc" | head -1)`);
    const stamps = [...arc.matchAll(/"scn":(\d+)/g)].map(m => Number(m[1]));
    expect(stamps.length).toBeGreaterThanOrEqual(2);
    expect(new Set(stamps).size).toBeGreaterThanOrEqual(2);
  });
});

describe('UNTIL SCN s arrete a la transaction, pas au switch', () => {
  it('une borne posee entre deux commits du meme journal retient exactement ce qui precede', () => {
    backedUpWithOneRow();
    commit('INSERT INTO clients VALUES (2);');
    const bound = currentScn();
    commit('INSERT INTO clients VALUES (3);');
    commit('INSERT INTO clients VALUES (4);');
    sql('ALTER SYSTEM SWITCH LOGFILE;');
    expect(ids()).toBe('1,2,3,4');

    const out = restoreUntil(bound);
    expect(out).not.toContain('RMAN-06054');
    expect(ids()).toBe('1,2');
  });

  it('un UPDATE et un DELETE se rejouent comme un INSERT', () => {
    backedUpWithOneRow();
    commit('INSERT INTO clients VALUES (2);');
    commit('INSERT INTO clients VALUES (3);');
    commit('UPDATE clients SET id = 9 WHERE id = 3;');
    commit('DELETE FROM clients WHERE id = 2;');
    const bound = currentScn();
    commit('INSERT INTO clients VALUES (5);');
    sql('ALTER SYSTEM SWITCH LOGFILE;');

    restoreUntil(bound);
    expect(ids()).toBe('1,9');
  });

  it('TEMOIN — une borne posterieure a tous les commits rend toutes les lignes', () => {
    backedUpWithOneRow();
    commit('INSERT INTO clients VALUES (2);');
    commit('INSERT INTO clients VALUES (3);');
    commit('INSERT INTO clients VALUES (4);');
    sql('ALTER SYSTEM SWITCH LOGFILE;');
    const bound = currentScn() + 1000;

    restoreUntil(bound);
    expect(ids()).toBe('1,2,3,4');
  });

  it('le redo anterieur a la sauvegarde restauree n est pas rejoue deux fois', () => {
    backedUpWithOneRow();
    commit('INSERT INTO clients VALUES (2);');
    sql('ALTER SYSTEM SWITCH LOGFILE;');

    rman('SHUTDOWN IMMEDIATE;\\nSTARTUP MOUNT;\\nRESTORE DATABASE;\\nRECOVER DATABASE;\\nALTER DATABASE OPEN;');
    expect(ids()).toBe('1,2');
  });

  it('NON-REGRESSION — sans journal archive, RECOVER refuse au lieu de mentir', () => {
    sql('CREATE TABLE clients (id NUMBER);');
    commit('INSERT INTO clients VALUES (1);');
    rman('BACKUP DATABASE;');
    const out = rman(
      'SHUTDOWN IMMEDIATE;\\nSTARTUP MOUNT;\\nRESTORE DATABASE;\\nRECOVER DATABASE;');
    expect(out).toContain('RMAN-06054');
  });
});
