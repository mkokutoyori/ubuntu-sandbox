/**
 * `LIST BACKUP BY FILE` de RMAN etait refuse (« unknown command »). Il regroupe les sauvegardes par fichier sauvegarde :
 * « List of Datafile Backups » (une ligne par fichier de donnees et par jeu qui le contient : File, Key, TY, LV, S,
 * Ckp SCN, Ckp Time, #Pieces, #Copies, Compressed, Tag) puis « List of Control File Backups » (CF Ckp SCN, Ckp Time,
 * BS Key, S, ...). Les donnees viennent du catalogue (fichiers du jeu, points de controle, pieces).
 * NON SOURCE (TODO.md [rman]) : les titres, l'ordre et les noms des colonnes viennent de la memoire de l'auteur
 * (docs.oracle.com injoignable) ; la section « List of Archived Log Backups » (Thrd, Seq, Low SCN...) manque parce que le
 * catalogue ne garde ni numero de thread ni sequence par jeu ; SPFILE non plus.
 *
 * Discrimine par `git stash` sur src/terminal : 4 des 5 cas tombent avant. TEMOIN : LIST BACKUP SUMMARY.
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
const listing = (backups: readonly string[]): string => {
  rman(...backups);
  return rman('LIST BACKUP BY FILE;');
};

describe('LIST BACKUP BY FILE', () => {
  it('TEMOIN — LIST BACKUP SUMMARY still works', () => {
    expect(rman('LIST BACKUP SUMMARY;')).not.toContain('RMAN-01009');
  });

  it('an empty repository says so', () => {
    expect(rman('LIST BACKUP BY FILE;')).toContain('specification does not match any backup in the repository');
  });

  it('lists one row per datafile of the set under the datafile heading', () => {
    const out = listing(["BACKUP DATABASE TAG 'DB1';"]);
    expect(out).toContain('List of Datafile Backups');
    expect(out).toMatch(/File Key\s+TY LV S Ckp SCN\s+Ckp Time\s+#Pieces #Copies Compressed Tag/);
    const rows = out.split('\n').filter(line => /^\d+\s+\d+\s+B\s+F\s+A\s/.test(line) && line.includes('DB1'));
    expect(rows.length).toBeGreaterThanOrEqual(4);
  });

  it('a file held by two sets appears once per set', () => {
    const out = listing(["BACKUP DATAFILE 4 TAG 'ONE';", "BACKUP DATAFILE 4 TAG 'TWO';"]);
    const rows = out.split('\n').filter(line => /^4\s+\d+\s+B\s/.test(line));
    expect(rows.map(row => /ONE|TWO/.exec(row)?.[0])).toEqual(['ONE', 'TWO']);
  });

  it('control file backups have their own section', () => {
    const out = listing(["BACKUP CURRENT CONTROLFILE TAG 'CF1';"]);
    expect(out).toContain('List of Control File Backups');
    expect(out).toContain('CF1');
  });
});
