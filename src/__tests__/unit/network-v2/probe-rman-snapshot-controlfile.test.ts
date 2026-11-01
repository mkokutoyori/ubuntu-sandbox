/**
 * `CONFIGURE|SHOW SNAPSHOT CONTROLFILE NAME` de RMAN etaient refuses (« unrecognized CONFIGURE clause » / « unknown command »)
 * et `SHOW ALL` ne portait pas la ligne. Le parametre est maintenant stocke ET evalue : RMAN cree le fichier de controle
 * instantane (snapshot) au chemin configure quand il sauvegarde le fichier de controle (c'est le role documente du
 * parametre), par defaut `$ORACLE_HOME/dbs/snapcf_<SID>.f`. `SHOW` imprime la ligne `CONFIGURE SNAPSHOT CONTROLFILE NAME
 * TO '<chemin>';`, suivie de `# default` tant que rien n'a ete configure, comme les autres parametres par defaut de SHOW
 * ALL ; `CLEAR` rend le defaut.
 * Non source (TODO.md [rman]) : la creation par `RESYNC CATALOG` (le catalogue de recuperation distant est un autre
 * sous-systeme), ici seule la sauvegarde du fichier de controle cree le snapshot.
 *
 * Discrimine par `git stash` sur src/terminal : 5 des 7 cas tombent avant. TEMOINS : SHOW ALL liste toujours les autres
 * parametres (la ligne RETENTION POLICY), et une sauvegarde sans fichier de controle ne cree aucun snapshot.
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
const exists = async (path: string): Promise<boolean> =>
  !String(await lab.prod.executeCommand(`ls ${path} 2>&1`)).includes('No such file');

const DEFAULT_PATH = '/u01/app/oracle/product/19c/dbhome_1/dbs/snapcf_ORCL.f';

describe('SNAPSHOT CONTROLFILE NAME', () => {
  it('TEMOIN — SHOW ALL still lists the other parameters', () => {
    expect(rman('SHOW ALL;')).toContain('CONFIGURE RETENTION POLICY');
  });

  it('SHOW prints the default path and says it is the default', () => {
    expect(rman('SHOW SNAPSHOT CONTROLFILE NAME;')).toContain(
      `CONFIGURE SNAPSHOT CONTROLFILE NAME TO '${DEFAULT_PATH}'; # default`);
  });

  it('SHOW ALL carries the same line', () => {
    expect(rman('SHOW ALL;')).toContain(`CONFIGURE SNAPSHOT CONTROLFILE NAME TO '${DEFAULT_PATH}'; # default`);
  });

  it('CONFIGURE sets the path, SHOW prints it without the default mark, CLEAR restores the default', () => {
    const set = rman("CONFIGURE SNAPSHOT CONTROLFILE NAME TO '/u01/app/oracle/snap/snap_ORCL.f';", 'SHOW SNAPSHOT CONTROLFILE NAME;');
    expect(set).toContain("CONFIGURE SNAPSHOT CONTROLFILE NAME TO '/u01/app/oracle/snap/snap_ORCL.f';");
    expect(set).not.toContain("snap_ORCL.f'; # default");
    expect(rman('CONFIGURE SNAPSHOT CONTROLFILE NAME CLEAR;', 'SHOW SNAPSHOT CONTROLFILE NAME;')).toContain(`'${DEFAULT_PATH}'; # default`);
  });

  it('a controlfile backup creates the snapshot file at the default path', async () => {
    expect(await exists(DEFAULT_PATH)).toBe(false);
    rman('BACKUP CURRENT CONTROLFILE;');
    expect(await exists(DEFAULT_PATH)).toBe(true);
  });

  it('a controlfile backup creates it at the configured path', async () => {
    rman("CONFIGURE SNAPSHOT CONTROLFILE NAME TO '/u01/app/oracle/snap/snap_ORCL.f';", 'BACKUP CURRENT CONTROLFILE;');
    expect(await exists('/u01/app/oracle/snap/snap_ORCL.f')).toBe(true);
  });

  it('a backup that includes no controlfile creates no snapshot', async () => {
    rman('CONFIGURE CONTROLFILE AUTOBACKUP OFF;', 'BACKUP DATAFILE 4;');
    expect(await exists(DEFAULT_PATH)).toBe(false);
  });
});
