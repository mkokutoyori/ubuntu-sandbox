/**
 * `LIST BACKUP OF DATABASE | DATAFILE n | ARCHIVELOG ALL | CONTROLFILE` etait refuse (« RMAN-01009 unknown command »)
 * alors que la liste detaillee des jeux de sauvegarde existe (`LIST BACKUP`). Corrige : la meme liste, filtree sur ce
 * que le jeu sauvegarde (les fichiers de donnees du jeu pour DATAFILE n, le type du jeu pour les autres) ; aucun jeu ne
 * correspond -> « specification does not match any backup in the repository », texte deja emis par LIST BACKUP COMPLETED.
 * Non traites (mise en page non sourcee) : `LIST BACKUP BY FILE`, `LIST BACKUP OF TABLESPACE`.
 *
 * Discrimine par `git stash` sur src/terminal : 4 des 5 cas tombent avant. TEMOIN : `LIST BACKUP` simple, qui liste tout
 * avant comme apres.
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

const listing = (backups: readonly string[], list: string): string => {
  rman(...backups);
  return rman(list);
};

describe('LIST BACKUP OF', () => {
  it('TEMOIN — LIST BACKUP lists the sets that exist', () => {
    expect(rman("BACKUP DATABASE TAG 'DB1';", 'LIST BACKUP;')).toContain('DB1');
  });

  it('OF DATABASE lists a database backup and not an archived-log backup', () => {
    const out = listing(["BACKUP DATABASE TAG 'DB1';", "BACKUP ARCHIVELOG ALL TAG 'AR1';"], 'LIST BACKUP OF DATABASE;');
    expect(out).toContain('DB1');
    expect(out).not.toContain('AR1');
  });

  it('OF ARCHIVELOG ALL lists the archived-log backup and not the database one', () => {
    const out = listing(["BACKUP DATABASE TAG 'DB1';", "BACKUP ARCHIVELOG ALL TAG 'AR1';"], 'LIST BACKUP OF ARCHIVELOG ALL;');
    expect(out).toContain('AR1');
    expect(out).not.toContain('DB1');
  });

  it('OF DATAFILE n lists the set that holds that file and not one that does not', () => {
    const out = listing(["BACKUP DATAFILE 4 TAG 'F4';", "BACKUP DATAFILE 1 TAG 'F1';"], 'LIST BACKUP OF DATAFILE 4;');
    expect(out).toContain('F4');
    expect(out).not.toContain('F1');
  });

  it('a specification that matches no set says so', () => {
    expect(listing(["BACKUP DATAFILE 4 TAG 'F4';"], 'LIST BACKUP OF CONTROLFILE;')).toContain(
      'specification does not match any backup in the repository');
  });
});
