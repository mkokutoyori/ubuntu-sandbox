/**
 * Suite de RELEVE — `src/__tests__/debug/`.
 *
 * Le lot « CHECK LOGICAL » a route `BACKUP VALIDATE CHECK LOGICAL
 * DATABASE` vers la commande VALIDATE reelle, et LAISSE `BACKUP
 * VALIDATE DATABASE` sur l'ancien chemin. La meme famille se retrouve
 * donc partagee entre deux implantations selon qu'on tape ou non
 * CHECK LOGICAL — un doublon que j'ai introduit et que la regle 2
 * demandait de fermer dans le meme changement. Ce banc mesure ce que
 * les deux repondent du MEME datafile corrompu.
 *
 * Ce que la documentation dit de BACKUP VALIDATE : « RMAN reads the
 * files to be backed up in their entirety, as it would during a real
 * backup, but does not produce any backup sets or image copies », et
 * la validation de sauvegarde alimente V$DATABASE_BLOCK_CORRUPTION.
 * Les deux commandes font donc le MEME travail ; seules leurs lignes
 * de bannière different.
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

describe('BACKUP VALIDATE et VALIDATE, du meme datafile corrompu', () => {
  it('releve', () => {
    const srv = lab.prod;
    sh(srv, `echo "plus un datafile" > ${USERS}`);

    note('[a] VALIDATE DATABASE :');
    note(rman(srv, ['VALIDATE DATABASE;', 'EXIT;']).slice(-700));
    note('[a-1] V$DATABASE_BLOCK_CORRUPTION :');
    note(lab.sql(srv, 'SELECT file#, corruption_type FROM v$database_block_corruption;'));

    note('');
    note('[b] BACKUP VALIDATE DATABASE, sur la meme base :');
    note(rman(srv, ['BACKUP VALIDATE DATABASE;', 'EXIT;']).slice(-700));

    note('');
    note('[c] les autres portees de BACKUP VALIDATE :');
    for (const cmd of [
      'BACKUP VALIDATE TABLESPACE USERS',
      'BACKUP VALIDATE DATAFILE 4',
    ]) {
      const out = rman(srv, [`${cmd};`, 'EXIT;']);
      note(`[c] ${cmd.padEnd(36)} ${out.includes('RMAN-01009') ? 'REFUSEE' : 'acceptee'}`);
    }

    note('');
    note('[d] une piece de sauvegarde est-elle ecrite par BACKUP VALIDATE ?');
    note(rman(srv, ['LIST BACKUP;', 'EXIT;']).slice(-400));

    expect(true).toBe(true);
  });
});
