/**
 * `SHOW <parametre>` de RMAN n'existait que pour quatre parametres (RETENTION POLICY, DEFAULT DEVICE TYPE, CONTROLFILE
 * AUTOBACKUP, CHANNEL) ; BACKUP OPTIMIZATION, MAXSETSIZE, EXCLUDE, COMPRESSION ALGORITHM, ENCRYPTION ALGORITHM,
 * ENCRYPTION FOR DATABASE, ARCHIVELOG DELETION POLICY, ARCHIVELOG / DATAFILE BACKUP COPIES, DEVICE TYPE et CONTROLFILE
 * AUTOBACKUP FORMAT repondaient « RMAN-01009 unknown command » alors que `SHOW ALL` les imprimait et que `CONFIGURE`
 * les acceptait. Les quatre premiers recopiaient chacun le texte de la ligne de `SHOW ALL` (deux ecritures du meme fait).
 * Corrige : une seule liste de lignes de configuration (ShowCommand.configurationLines), filtree par parametre pour
 * `SHOW x` et rendue en entier pour `SHOW ALL` ; chaque `SHOW x` imprime donc exactement la ligne de `SHOW ALL`, sans
 * pouvoir diverger apres un `CONFIGURE`.
 * Non traite : `SHOW SNAPSHOT CONTROLFILE NAME` (le parametre n'est pas modelise, TODO.md [rman]).
 *
 * Discrimine par `git stash` sur src/terminal : 12 des 15 cas tombent avant. TEMOINS : SHOW RETENTION POLICY, SHOW
 * DEFAULT DEVICE TYPE et SHOW CONTROLFILE AUTOBACKUP, deja supportes.
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

const PARAMETERS: ReadonlyArray<readonly [string, string]> = [
  ['RETENTION POLICY', 'CONFIGURE RETENTION POLICY'],
  ['DEFAULT DEVICE TYPE', 'CONFIGURE DEFAULT DEVICE TYPE'],
  ['CONTROLFILE AUTOBACKUP', 'CONFIGURE CONTROLFILE AUTOBACKUP O'],
  ['CONTROLFILE AUTOBACKUP FORMAT', 'CONFIGURE CONTROLFILE AUTOBACKUP FORMAT'],
  ['BACKUP OPTIMIZATION', 'CONFIGURE BACKUP OPTIMIZATION'],
  ['DEVICE TYPE', 'CONFIGURE DEVICE TYPE'],
  ['DATAFILE BACKUP COPIES', 'CONFIGURE DATAFILE BACKUP COPIES'],
  ['ARCHIVELOG BACKUP COPIES', 'CONFIGURE ARCHIVELOG BACKUP COPIES'],
  ['MAXSETSIZE', 'CONFIGURE MAXSETSIZE'],
  ['ENCRYPTION FOR DATABASE', 'CONFIGURE ENCRYPTION FOR DATABASE'],
  ['ENCRYPTION ALGORITHM', 'CONFIGURE ENCRYPTION ALGORITHM'],
  ['COMPRESSION ALGORITHM', 'CONFIGURE COMPRESSION ALGORITHM'],
  ['EXCLUDE', 'CONFIGURE EXCLUDE FOR TABLESPACE'],
  ['ARCHIVELOG DELETION POLICY', 'CONFIGURE ARCHIVELOG DELETION POLICY'],
];

const configureLines = (out: string): string[] => out.split('\n').filter((line) => line.startsWith('CONFIGURE '));

describe('SHOW <parameter>', () => {
  it.each(PARAMETERS)('SHOW %s prints its line of SHOW ALL and nothing else', (parameter, prefix) => {
    const all = configureLines(rman('SHOW ALL;'));
    const single = configureLines(rman(`SHOW ${parameter};`));
    expect(single.length).toBeGreaterThan(0);
    expect(single.every((line) => line.startsWith(prefix))).toBe(true);
    expect(single.every((line) => all.includes(line))).toBe(true);
    expect(rman(`SHOW ${parameter};`)).not.toContain('RMAN-01009');
  });

  it('a SHOW follows the CONFIGURE that changed the parameter, as SHOW ALL does', () => {
    const out = rman("CONFIGURE COMPRESSION ALGORITHM 'MEDIUM';", 'SHOW COMPRESSION ALGORITHM;', 'SHOW ALL;');
    const shown = configureLines(out).filter((line) => line.includes('COMPRESSION ALGORITHM') && line.includes('AS OF RELEASE'));
    expect(shown.length).toBe(2);
    expect(shown.every((line) => line.includes("'MEDIUM'"))).toBe(true);
  });
});
