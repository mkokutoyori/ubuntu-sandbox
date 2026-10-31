/**
 * `LIST FAILURE` de RMAN (Data Recovery Advisor) etait refuse (« unknown command »). Il liste les defaillances que la
 * base peut constater : ici les fichiers de donnees dont le fichier a disparu du disque de la machine. Un fichier du
 * tablespace SYSTEM manquant est CRITICAL (« System datafile N: '<chemin>' is missing »), les autres sont regroupes en une
 * defaillance HIGH (« One or more non-system datafiles are missing »). Sans defaillance : « no failures found that match
 * specification ». Le critere est evalue (le fichier est cherche dans le systeme de fichiers de la machine), pas stocke.
 * NON SOURCE (TODO.md [rman]) : ces libelles, les priorites, l'en-tete du tableau et le format `DD-MON-YY` de la colonne
 * « Time Detected » viennent de la memoire de l'auteur (docs.oracle.com injoignable) ; le numero de defaillance (100 + le
 * plus petit numero de fichier) et la date (celle de l'appel, pas celle de la premiere detection) sont des choix du
 * simulateur. Ni ADVISE FAILURE, ni REPAIR FAILURE, ni LIST FAILURE <n> DETAIL.
 *
 * Discrimine par `git stash` sur src/terminal : 4 des 5 cas tombent avant. TEMOIN : LIST BACKUP SUMMARY continue de marcher.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { buildRmanLab, type RmanLab } from '../../support/rmanLab';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { resetAllOracleInstances } from '@/terminal/commands/database';

let lab: RmanLab;

beforeEach(async () => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); resetAllOracleInstances();
  lab = await buildRmanLab();
  lab.sql(lab.prod, 'SELECT 1 FROM dual;');
});

const rman = (...lines: string[]): string => lab.rman(lab.prod, ['CONNECT TARGET /;', ...lines].join('\n'));
const remove = (path: string) => lab.prod.executeCommand(`rm -f ${path}`);

describe('LIST FAILURE', () => {
  it('TEMOIN — a neighbouring command still works', () => {
    expect(rman('LIST BACKUP SUMMARY;')).not.toContain('RMAN-01009');
  });

  it('a healthy database has no failure', () => {
    expect(rman('LIST FAILURE;')).toContain('no failures found that match specification');
  });

  it('a missing non-system datafile is one HIGH failure', async () => {
    await remove('/u01/app/oracle/oradata/ORCL/users01.dbf');
    const out = rman('LIST FAILURE;');
    expect(out).toContain('List of Database Failures');
    expect(out).toMatch(/\d+\s+HIGH\s+OPEN\s+\d{2}-[A-Z]{3}-\d{2}\s+One or more non-system datafiles are missing/);
  });

  it('a missing SYSTEM datafile is CRITICAL and names the file', async () => {
    await remove('/u01/app/oracle/oradata/ORCL/system01.dbf');
    expect(rman('LIST FAILURE;')).toMatch(/CRITICAL\s+OPEN\s+\S+\s+System datafile 1: '\/u01\/app\/oracle\/oradata\/ORCL\/system01\.dbf' is missing/);
  });

  it('several missing non-system files are still one failure', async () => {
    await remove('/u01/app/oracle/oradata/ORCL/users01.dbf');
    await remove('/u01/app/oracle/oradata/ORCL/sysaux01.dbf');
    const rows = rman('LIST FAILURE;').split('\n').filter(line => line.includes('non-system datafiles'));
    expect(rows).toHaveLength(1);
  });
});
