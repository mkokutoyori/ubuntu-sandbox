/**
 * Suite de RELEVE — `src/__tests__/debug/`.
 *
 * Le lot de la chaine d'archivelogs a fait dire a RMAN, dans les mots
 * d'Oracle, qu'un journal manquant se repare en le CATALOGUANT :
 *
 *   RMAN-06054: media recovery requesting unknown archived log ...
 *   (remede documente : CATALOG le journal, puis relancer RECOVER)
 *
 * Ce banc mesure si ce remede est typable. Et plus largement quelles
 * formes de CATALOG existent : `CATALOG START WITH '<prefixe>'` est la
 * plus employee — elle balaye un repertoire et catalogue tout ce qu'elle
 * y trouve — et `CATALOG RECOVERY AREA` fait de meme sur la FRA.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { LinuxServer } from '@/network/devices/LinuxServer';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { getOracleDatabase, resetAllOracleInstances } from '@/terminal/commands/database';
import { BackupKey, DeviceCatalogRegistry } from '@/terminal/subshells/rman';
import { buildRmanLab, type RmanLab } from '../../support/rmanLab';

const note = (l: string) => { console.log(l); };
const ARC_DIR = '/u01/app/oracle/archivelog';
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

describe('CATALOG : les fichiers qu on trouve sur le disque', () => {
  it('releve', () => {
    const srv = lab.prod;
    const db = getOracleDatabase(srv.getId());
    (db.instance as unknown as { _archiveLogMode: boolean })._archiveLogMode = true;
    for (let i = 0; i < 3; i++) lab.sql(srv, 'ALTER SYSTEM SWITCH LOGFILE;');

    note('[a] quelles formes de CATALOG sont reconnues ?');
    for (const cmd of [
      `CATALOG ARCHIVELOG '${ARC_DIR}/1_1_arc.arc'`,
      `CATALOG START WITH '${ARC_DIR}'`,
      'CATALOG RECOVERY AREA',
      `CATALOG BACKUPPIECE '${ARC_DIR}/1_1_arc.arc'`,
      `CATALOG DATAFILECOPY '${ARC_DIR}/1_1_arc.arc'`,
    ]) {
      const out = rman(srv, [`${cmd};`, 'EXIT;']);
      note(`[a] ${cmd.slice(0, 54).padEnd(56)} ${out.includes('RMAN-01009') ? 'REFUSEE' : 'acceptee'}`);
    }

    note('');
    note('[b] le remede documente du RMAN-06054/06053, de bout en bout :');
    rman(srv, ['BACKUP DATABASE;', 'EXIT;']);
    note(`[b-1] on deplace un journal hors de la vue : ${
      sh(srv, `mv ${ARC_DIR}/1_2_arc.arc /tmp/1_2_arc.arc`)}`);
    note('[b-2] RESTORE + RECOVER :');
    note(rman(srv, [
      'SHUTDOWN IMMEDIATE;', 'STARTUP MOUNT;', 'RESTORE DATABASE;', 'RECOVER DATABASE;', 'EXIT;',
    ]).slice(-700));
    note(`[b-3] on le remet et on le CATALOGUE : ${
      sh(srv, `mv /tmp/1_2_arc.arc ${ARC_DIR}/1_2_arc.arc`)}`);
    note(rman(srv, [`CATALOG ARCHIVELOG '${ARC_DIR}/1_2_arc.arc';`, 'EXIT;']).slice(-400));
    note('[b-4] RECOVER de nouveau :');
    note(rman(srv, ['RECOVER DATABASE;', 'EXIT;']).slice(-500));

    note('');
    note('[c] une piece trouvee sur le disque, inconnue du catalogue :');
    note(`[c-1] ${sh(srv, 'ls /u01/app/oracle/fast_recovery_area/ORCL/backupset/*/ | head -3').replace(/\n/g, ' ')}`);
    note(rman(srv, [`CATALOG START WITH '/u01/app/oracle/fast_recovery_area';`, 'EXIT;']).slice(-600));

    expect(true).toBe(true);
  });
});
