/**
 * Suite de RELEVE — `src/__tests__/debug/`.
 *
 * Deux questions restees ouvertes apres les lots VALIDATE / registre de
 * corruption / BLOCKRECOVER :
 *
 *   1. `CHECK LOGICAL` — la procedure Oracle canonique est
 *      `RUN { BACKUP VALIDATE CHECK LOGICAL DATABASE; BLOCKRECOVER
 *      CORRUPTION LIST; }`. Le premier membre etait-il seulement
 *      reconnu ?
 *   2. `RESTORE DATABASE VALIDATE` et `VALIDATE BACKUPSET` repondent a
 *      la MEME question — « ce jeu est-il restaurable ? ». Disent-ils
 *      la meme chose de la meme piece ?
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

describe('CHECK LOGICAL et la coherence de RESTORE VALIDATE', () => {
  it('releve', () => {
    const srv = lab.prod;
    lab.sql(srv, 'CREATE TABLE clients (id NUMBER);');
    lab.sql(srv, 'INSERT INTO clients VALUES (1);');
    lab.sql(srv, 'COMMIT;');
    rman(srv, ['BACKUP DATABASE;', 'EXIT;']);

    note('[a] les quatre orthographes de CHECK LOGICAL :');
    for (const cmd of [
      'VALIDATE CHECK LOGICAL DATABASE',
      'VALIDATE CHECK LOGICAL TABLESPACE USERS',
      'VALIDATE CHECK LOGICAL DATAFILE 4',
      'BACKUP VALIDATE CHECK LOGICAL DATABASE',
    ]) {
      const out = rman(srv, [`${cmd};`, 'EXIT;']);
      const refus = out.includes('RMAN-01009') ? 'REFUSEE' : 'acceptee';
      note(`[a] ${cmd.padEnd(42)} ${refus}`);
    }

    note('');
    note('[b] un datafile dont la BANNIERE est intacte mais dont la');
    note('    charge utile ne parle plus du bon tablespace :');
    const corps = sh(srv, `cat ${USERS}`);
    const banniere = corps.split('\n')[0];
    sh(srv, `echo '${banniere}' > ${USERS}`);
    sh(srv, `echo 'ORACLE-SEGMENT-IMAGE {"tablespace":"SYSTEM","tables":[]}' >> ${USERS}`);
    note(`[b-1] contenu : ${sh(srv, `cat ${USERS}`).replace(/\n/g, ' | ').slice(0, 140)}`);
    note('[b-2] VALIDATE DATABASE (physique seul) :');
    note(rman(srv, ['VALIDATE DATABASE;', 'EXIT;']).slice(-520));
    note('[b-3] VALIDATE CHECK LOGICAL DATABASE :');
    note(rman(srv, ['VALIDATE CHECK LOGICAL DATABASE;', 'EXIT;']).slice(-620));
    note('[b-4] V$DATABASE_BLOCK_CORRUPTION :');
    note(lab.sql(srv, 'SELECT file#, corruption_type FROM v$database_block_corruption;'));

    note('');
    note('[c] la meme piece, vue par les deux commandes :');
    const piece = /(\/\S+\.bkp)/.exec(rman(srv, ['LIST BACKUP;', 'EXIT;']))?.[1] ?? '';
    sh(srv, `echo "ceci n est pas une piece" > ${piece}`);
    note('[c-1] VALIDATE BACKUPSET 1 :');
    note(rman(srv, ['VALIDATE BACKUPSET 1;', 'EXIT;']).slice(-450));
    note('[c-2] RESTORE DATABASE VALIDATE :');
    note(rman(srv, ['RESTORE DATABASE VALIDATE;', 'EXIT;']).slice(-450));
    note(`[c-3] le datafile a-t-il ete touche par le VALIDATE ? ${
      sh(srv, `head -c 40 ${USERS}`)}`);

    expect(true).toBe(true);
  });
});
