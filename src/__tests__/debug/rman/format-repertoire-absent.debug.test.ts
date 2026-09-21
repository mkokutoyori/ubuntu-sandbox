/**
 * Suite de RELEVE — `src/__tests__/debug/`.
 *
 * Trouve en ecrivant le banc de la nomenclature FORMAT : un `FORMAT`
 * qui designe un repertoire INEXISTANT. Un vrai RMAN ne cree pas le
 * repertoire : il echoue. Que dit celui-ci ?
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { resetAllOracleInstances } from '@/terminal/commands/database';
import { buildRmanLab } from '../../support/rmanLab';

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter();
  resetAllOracleInstances(); Logger.reset();
});

const note = (l: string) => { console.log(l); };

/** `lab.rman` lance `rman` SANS cible : la sonde doit la donner. */
const rmanCible = (lab: { sh(d: unknown, c: string): string; prod: unknown }, script: string): string =>
  (lab.sh as (d: unknown, c: string) => string)(
    lab.prod, `echo "${script}" | rman target /`);

describe('FORMAT vers un repertoire qui n existe pas', () => {
  it('que repond RMAN, et que trouve-t-on sur le disque ?', async () => {
    const lab = await buildRmanLab();
    const sortie = rmanCible(lab, "BACKUP DATABASE FORMAT '/u01/backup/fixe.bkp';");
    note(`[dir-1] RMAN repond : ${JSON.stringify(
      sortie.split('\n').filter((l) => l.trim()).slice(-3).join(' | '))}`);
    note(`[dir-2] ls /u01/backup : ${JSON.stringify(lab.sh(lab.prod, 'ls /u01/backup 2>&1').trim())}`);

    lab.sh(lab.prod, 'mkdir -p /u01/backup2');
    note(`[dir-2b] ls -ld /u01/backup2 : ${JSON.stringify(lab.sh(lab.prod, 'ls -ld /u01/backup2').trim())}`);
    const sortie2 = rmanCible(lab, "BACKUP DATABASE FORMAT '/u01/backup2/fixe.bkp';");
    note(`[dir-3] TEMOIN — repertoire CREE d abord : ${JSON.stringify(
      sortie2.split('\n').filter((l) => l.trim()).slice(-2).join(' | '))}`);
    note(`[dir-4] ls /u01/backup2 : ${JSON.stringify(lab.sh(lab.prod, 'ls /u01/backup2 2>&1').trim())}`);

    lab.sh(lab.prod, 'mkdir -p /u01/backup3 && chown oracle:oinstall /u01/backup3');
    const sortie3 = rmanCible(lab, "BACKUP DATABASE FORMAT '/u01/backup3/fixe.bkp';");
    note(`[dir-4b] TEMOIN — repertoire cree ET donne a oracle : ${JSON.stringify(
      sortie3.split('\n').filter((l) => l.trim()).slice(-2).join(' | '))}`);
    note(`[dir-4c] ls /u01/backup3 : ${JSON.stringify(lab.sh(lab.prod, 'ls /u01/backup3 2>&1').trim())}`);

    const sansFormat = rmanCible(lab, 'BACKUP DATABASE;');
    note(`[dir-5] TEMOIN — sans FORMAT du tout : ${JSON.stringify(
      sansFormat.split('\n').filter((l) => l.trim()).slice(-2).join(' | '))}`);
    note(`[dir-6] pieces dans la FRA : ${lab.sh(lab.prod,
      'find /u01/app/oracle/fast_recovery_area -name "*.bkp" | wc -l').trim()}`);
    expect(true).toBe(true);
  }, 60000);
});
