/**
 * `SWITCH DATABASE | TABLESPACE t | DATAFILE n TO COPY` de RMAN etait refuse (« unknown command »). Il fait pointer la base
 * sur la derniere copie image du fichier (`BACKUP AS COPY`) : le fichier de donnees est renomme dans la base (comme
 * `ALTER DATABASE RENAME FILE`), l'enregistrement de la copie disparait du catalogue (la copie EST maintenant le fichier),
 * et RMAN ecrit `datafile N switched to datafile copy "<chemin>"` par fichier. Sans copie : « datafile N does not have
 * recoverable copy ». `SWITCH DATABASE` exige une base montee, pas ouverte.
 * NON SOURCE (TODO.md [rman]) : ces deux textes et le code RMAN-06571 viennent de la memoire de l'auteur, pas de la
 * documentation (docs.oracle.com injoignable) ; a verifier. Le comportement (renommage, retrait du catalogue) suit la
 * description des resultats de recherche de la documentation : « deletes the RMAN repository records for the datafile copy ».
 *
 * Discrimine par `git stash` sur src/terminal : 5 des 6 cas tombent avant. TEMOIN : BACKUP AS COPY cree toujours les copies.
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
const datafileName = (fileNo: number): string => lab.sql(lab.prod, `SELECT name FROM v$datafile WHERE file# = ${fileNo};`).replace(/\s+/g, '');

describe('SWITCH ... TO COPY', () => {
  it('TEMOIN — BACKUP AS COPY records datafile copies', () => {
    expect(rman('BACKUP AS COPY DATAFILE 4;', 'LIST COPY;')).toContain('Name:');
  });

  it('SWITCH DATAFILE n TO COPY names the copy the file now lives in', () => {
    const out = rman('BACKUP AS COPY DATAFILE 4;', 'SWITCH DATAFILE 4 TO COPY;');
    expect(out).toMatch(/datafile 4 switched to datafile copy "[^"]+"/);
  });

  it('the database really points at the copy afterwards', () => {
    const before = datafileName(4);
    const out = rman('BACKUP AS COPY DATAFILE 4;', 'SWITCH DATAFILE 4 TO COPY;');
    const copy = /datafile 4 switched to datafile copy "([^"]+)"/.exec(out)?.[1] ?? '';
    expect(copy).not.toBe('');
    expect(datafileName(4)).toContain(copy.replace(/\s+/g, ''));
    expect(datafileName(4)).not.toBe(before);
  });

  it('the copy leaves the catalog: it is the datafile now', () => {
    rman('BACKUP AS COPY DATAFILE 4;', 'SWITCH DATAFILE 4 TO COPY;');
    expect(rman('LIST COPY;')).toContain('specification does not match any datafile copy');
  });

  it('a datafile without a copy is refused', () => {
    expect(rman('SWITCH DATAFILE 4 TO COPY;')).toContain('datafile 4 does not have recoverable copy');
  });

  it('SWITCH DATABASE is refused while the database is open', () => {
    expect(rman('BACKUP AS COPY DATABASE;', 'SWITCH DATABASE TO COPY;')).toContain('RMAN-06403');
  });
});
