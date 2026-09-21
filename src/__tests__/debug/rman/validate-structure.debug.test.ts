/**
 * Suite de RELEVE — `src/__tests__/debug/`.
 *
 * Dernier item ouvert du §6 de `docs/ASSESSMENT-RMAN.md` : « la
 * STRUCTURE d'une piece de sauvegarde — en-tete, jeu de blocs, somme de
 * controle — decide de ce que VALIDATE peut verifier ». Ce banc mesure
 * ce que VALIDATE repond aujourd hui, et ce qu'il repond quand la piece
 * qu'on lui demande de valider a ete corrompue sur le disque.
 *
 * Le gabarit de sortie d'un vrai VALIDATE (sources dans le message de
 * commit) :
 *
 *   List of Datafiles
 *   =================
 *   File Status Marked Corrupt Empty Blocks Blocks Examined High SCN
 *   ---- ------ -------------- ------------ --------------- --------
 *   1    OK     0              2            127             481907
 *   File Name: /u01/.../system01.dbf
 *     Block Type Blocks Failing Blocks Processed
 *     ---------- -------------- ----------------
 *     Data       0              36
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { LinuxServer } from '@/network/devices/LinuxServer';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { resetAllOracleInstances } from '@/terminal/commands/database';
import { buildRmanLab, type RmanLab } from '../../support/rmanLab';

const note = (l: string) => { console.log(l); };
let lab: RmanLab;

beforeEach(async () => {
  resetCounters();
  resetDeviceCounters();
  resetAllOracleInstances();
  Logger.reset();
  lab = await buildRmanLab();
});

const sh = (srv: LinuxServer, cmd: string) => srv.executeShellCommandSync(cmd);
const rman = (srv: LinuxServer, lignes: string[]): string =>
  sh(srv, `echo "${lignes.join('\n')}" | rman target /`);

describe('ce que VALIDATE verifie', () => {
  it('releve : database, datafile, backupset, et une piece corrompue', () => {
    const srv = lab.prod;

    note('[a] VALIDATE DATABASE :');
    note(rman(srv, ['VALIDATE DATABASE;', 'EXIT;']).slice(-800));

    note('');
    note('[b] VALIDATE DATAFILE 1 :');
    note(rman(srv, ['VALIDATE DATAFILE 1;', 'EXIT;']).slice(-600));

    note('');
    note('[c] BACKUP DATABASE puis VALIDATE BACKUPSET 1 :');
    note(rman(srv, ['BACKUP DATABASE;', 'EXIT;']).slice(-300));
    note(rman(srv, ['VALIDATE BACKUPSET 1;', 'EXIT;']).slice(-600));

    note('');
    note('[d] LIST BACKUP pour connaitre la piece :');
    const liste = rman(srv, ['LIST BACKUP;', 'EXIT;']);
    note(liste.slice(-900));
    const piece = /(\/\S+\.bkp)/.exec(liste)?.[1] ?? '';
    note(`[d-1] piece : ${piece}`);
    note(`[d-2] en-tete du fichier : ${sh(srv, `head -c 200 ${piece}`)}`);

    note('');
    note('[e] on ECRASE la piece avec du texte quelconque, puis VALIDATE :');
    note(sh(srv, `echo "ceci n est pas une piece" > ${piece}`));
    note(`[e-1] contenu : ${sh(srv, `cat ${piece}`)}`);
    note('[e-2] VALIDATE BACKUPSET 1 :');
    note(rman(srv, ['VALIDATE BACKUPSET 1;', 'EXIT;']).slice(-700));
    note('[e-3] CROSSCHECK BACKUP :');
    note(rman(srv, ['CROSSCHECK BACKUP;', 'EXIT;']).slice(-500));
    note('[e-4] RESTORE DATABASE (la piece est corrompue) :');
    note(rman(srv, [
      'SHUTDOWN IMMEDIATE;', 'STARTUP MOUNT;', 'RESTORE DATABASE;', 'EXIT;',
    ]).slice(-900));

    note('');
    note('[f] on EFFACE la piece, puis VALIDATE :');
    note(sh(srv, `rm -f ${piece}`));
    note(rman(srv, ['VALIDATE BACKUPSET 1;', 'EXIT;']).slice(-700));

    note('');
    note('[g] V$DATABASE_BLOCK_CORRUPTION existe-t-elle ?');
    note(lab.sql(srv, 'SELECT * FROM v$database_block_corruption;'));

    expect(true).toBe(true);
  });
});
