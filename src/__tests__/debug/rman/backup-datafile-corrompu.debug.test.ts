/**
 * Suite de RELEVE — `src/__tests__/debug/`.
 *
 * Trois lots ont rendu VALIDATE, le registre de corruption et
 * BLOCKRECOVER reels. Reste la question que ces trois-la posent en
 * creux : que fait une SAUVEGARDE quand le datafile qu'elle lit est
 * corrompu ?
 *
 * Ce que la documentation Oracle fixe (sources dans le message de
 * commit) : par defaut RMAN tolere ZERO bloc corrompu et s'arrete —
 * `ORA-19566: exceeded limit of <n> corrupt blocks for file <name>` —
 * a moins que `SET MAXCORRUPT FOR DATAFILE <n> TO <m>` ne l'autorise ;
 * les blocs sauvegardes malgre tout sont enregistres dans
 * V$BACKUP_CORRUPTION (et V$COPY_CORRUPTION pour une copie image).
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

describe('BACKUP face a un datafile corrompu', () => {
  it('releve', () => {
    const srv = lab.prod;
    sh(srv, `echo "plus un datafile" > ${USERS}`);

    note('[a] BACKUP DATABASE sur une base dont le fichier 4 est illisible :');
    note(rman(srv, ['BACKUP DATABASE;', 'EXIT;']).slice(-800));

    note('');
    note('[b] la piece ecrite porte-t-elle la corruption ?');
    const piece = /(\/\S+\.bkp)/.exec(rman(srv, ['LIST BACKUP;', 'EXIT;']))?.[1] ?? '';
    note(`[b-1] piece : ${piece}`);
    note(`[b-2] le corps contient-il « plus un datafile » ? ${
      sh(srv, `cat ${piece}`).includes('plus un datafile') ? 'OUI' : 'non'}`);

    note('');
    note('[c] V$BACKUP_CORRUPTION et V$COPY_CORRUPTION :');
    note(lab.sql(srv, 'SELECT file#, blocks, corruption_type FROM v$backup_corruption;'));
    note(lab.sql(srv, 'SELECT file#, blocks, corruption_type FROM v$copy_corruption;'));

    note('');
    note('[d] SET MAXCORRUPT est-il reconnu ?');
    for (const cmd of [
      'SET MAXCORRUPT FOR DATAFILE 4 TO 10',
      'RUN { SET MAXCORRUPT FOR DATAFILE 4 TO 10; BACKUP DATABASE; }',
    ]) {
      const out = rman(srv, [`${cmd};`, 'EXIT;']);
      note(`[d] ${cmd.slice(0, 48).padEnd(50)} ${out.includes('RMAN-01009') ? 'REFUSEE' : 'acceptee'}`);
    }

    note('');
    note('[e] et une COPIE IMAGE du meme fichier ?');
    sh(srv, `echo "plus un datafile" > ${USERS}`);
    note(rman(srv, ['BACKUP AS COPY DATAFILE 4;', 'EXIT;']).slice(-500));
    note('[e-1] V$COPY_CORRUPTION :');
    note(lab.sql(srv, 'SELECT file#, blocks, corruption_type FROM v$copy_corruption;'));

    expect(true).toBe(true);
  });
});
