/**
 * Suite de RELEVE — `src/__tests__/debug/`.
 *
 * `BlockRecoverCommand` porte encore deux modes qui retombent sur une
 * reprise de base ordinaire : `RECOVER COPY OF DATABASE` et
 * `RECOVER COPY OF DATAFILE <n>`. Ce sont les deux moities de la
 * strategie de la COPIE MISE A JOUR INCREMENTALEMENT, que la
 * documentation Oracle ecrit ainsi :
 *
 *   RUN {
 *     RECOVER COPY OF DATABASE WITH TAG 'mydb_incr_backup';
 *     BACKUP INCREMENTAL LEVEL 1 FOR RECOVER OF COPY
 *       WITH TAG 'mydb_incr_backup' DATABASE;
 *   }
 *
 * Une copie image de niveau 0 est prise une fois, puis chaque niveau 1
 * lui est APPLIQUE : la copie roule en avant sans qu'on reprenne jamais
 * une sauvegarde complete. Ce banc mesure ce que le simulateur fait des
 * deux commandes, et de la clause `FOR RECOVER OF COPY` qui les relie.
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

describe('la copie mise a jour incrementalement', () => {
  it('releve', () => {
    const srv = lab.prod;
    lab.sql(srv, 'CREATE TABLE clients (id NUMBER);');
    lab.sql(srv, 'INSERT INTO clients VALUES (1);');
    lab.sql(srv, 'COMMIT;');

    note('[a] les formes de la strategie sont-elles reconnues ?');
    for (const cmd of [
      "RECOVER COPY OF DATABASE",
      "RECOVER COPY OF DATABASE WITH TAG 'INCR'",
      "BACKUP INCREMENTAL LEVEL 1 FOR RECOVER OF COPY WITH TAG 'INCR' DATABASE",
      "BACKUP INCREMENTAL LEVEL 1 DATABASE",
    ]) {
      const out = rman(srv, [`${cmd};`, 'EXIT;']);
      note(`[a] ${cmd.slice(0, 62).padEnd(64)} ${out.includes('RMAN-01009') ? 'REFUSEE' : 'acceptee'}`);
    }

    note('');
    note('[b] ce que RECOVER COPY OF DATABASE imprime aujourd hui :');
    note(rman(srv, ['RECOVER COPY OF DATABASE;', 'EXIT;']).slice(-600));

    note('');
    note('[c] la strategie complete, premier tour (aucune copie encore) :');
    note(rman(srv, [
      'RUN {',
      "RECOVER COPY OF DATABASE WITH TAG 'INCR';",
      "BACKUP INCREMENTAL LEVEL 1 FOR RECOVER OF COPY WITH TAG 'INCR' DATABASE;",
      '}', 'EXIT;',
    ]).slice(-900));

    note('');
    note('[d] LIST COPY / LIST BACKUP apres :');
    note(rman(srv, ['LIST COPY;', 'EXIT;']).slice(-700));
    note(rman(srv, ['LIST BACKUP;', 'EXIT;']).slice(-700));

    note('');
    note('[e] une ligne de plus, puis deuxieme tour :');
    lab.sql(srv, 'INSERT INTO clients VALUES (2);');
    lab.sql(srv, 'COMMIT;');
    note(rman(srv, [
      'RUN {',
      "RECOVER COPY OF DATABASE WITH TAG 'INCR';",
      "BACKUP INCREMENTAL LEVEL 1 FOR RECOVER OF COPY WITH TAG 'INCR' DATABASE;",
      '}', 'EXIT;',
    ]).slice(-900));
    note(rman(srv, ['LIST COPY;', 'EXIT;']).slice(-700));

    expect(true).toBe(true);
  });
});
