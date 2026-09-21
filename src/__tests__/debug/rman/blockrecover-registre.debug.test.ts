/**
 * Suite de RELEVE — `src/__tests__/debug/`.
 *
 * BlockRecoverCommand porte en en-tete : « The simulator doesn't track
 * block-level corruption, so these are accepted as no-ops ». Le lot
 * precedent a rendu V$DATABASE_BLOCK_CORRUPTION reel ; la limite
 * nommee ne tient donc plus. Ce banc mesure ce que BLOCKRECOVER fait
 * aujourd hui d'un registre qui, lui, porte quelque chose.
 *
 * Ce que la documentation Oracle fixe (sources dans le message de
 * commit) : « After a corrupt block is repaired, the row identifying
 * this block is deleted from the view », et « the target database must
 * be mounted or open ».
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { LinuxServer } from '@/network/devices/LinuxServer';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { resetAllOracleInstances } from '@/terminal/commands/database';
import { BackupKey, DeviceCatalogRegistry } from '@/terminal/subshells/rman';
import { buildRmanLab, type RmanLab } from '../../support/rmanLab';

const note = (l: string) => { console.log(l); };
const USERS = '/u01/app/oracle/oradata/ORCL/users01.dbf';
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
const rman = (srv: LinuxServer, lignes: string[]): string =>
  sh(srv, `echo "${lignes.join('\n')}" | rman target /`);

describe('BLOCKRECOVER face a un registre qui porte quelque chose', () => {
  it('releve', () => {
    const srv = lab.prod;
    note('[a] BACKUP DATABASE, puis on corrompt users01.dbf, puis VALIDATE :');
    note(rman(srv, ['BACKUP DATABASE;', 'EXIT;']).slice(-200));
    note(`[a-1] avant corruption : ${sh(srv, `head -c 60 ${USERS}`)}`);
    sh(srv, `echo "plus un datafile" > ${USERS}`);
    rman(srv, ['VALIDATE DATABASE;', 'EXIT;']);
    note('[a-2] V$DATABASE_BLOCK_CORRUPTION :');
    note(lab.sql(srv, 'SELECT file#, blocks, corruption_type FROM v$database_block_corruption;'));

    note('');
    note('[b] BLOCKRECOVER CORRUPTION LIST :');
    note(rman(srv, ['BLOCKRECOVER CORRUPTION LIST;', 'EXIT;']).slice(-900));
    note('[b-1] V$DATABASE_BLOCK_CORRUPTION APRES :');
    note(lab.sql(srv, 'SELECT file#, blocks, corruption_type FROM v$database_block_corruption;'));
    note(`[b-2] contenu du datafile APRES : ${sh(srv, `head -c 60 ${USERS}`)}`);
    note('[b-3] VALIDATE DATABASE APRES :');
    note(rman(srv, ['VALIDATE DATABASE;', 'EXIT;']).slice(-500));

    note('');
    note('[c] BLOCKRECOVER DATAFILE 4 BLOCK 1234 :');
    note(rman(srv, ['BLOCKRECOVER DATAFILE 4 BLOCK 1234;', 'EXIT;']).slice(-700));

    note('');
    note('[d] les orthographes modernes :');
    note(rman(srv, ['RECOVER CORRUPTION LIST;', 'EXIT;']).slice(-500));
    note(rman(srv, ['RECOVER DATAFILE 4 BLOCK 1234;', 'EXIT;']).slice(-500));

    note('');
    note('[e] BLOCKRECOVER sur une instance arretee :');
    note(rman(srv, ['SHUTDOWN IMMEDIATE;', 'BLOCKRECOVER CORRUPTION LIST;', 'EXIT;']).slice(-600));

    expect(true).toBe(true);
  });
});
