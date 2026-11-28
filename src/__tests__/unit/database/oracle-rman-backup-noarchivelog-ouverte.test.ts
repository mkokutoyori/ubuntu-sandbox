/*
 * Sonde — `BACKUP DATABASE` d'une base OUVERTE en NOARCHIVELOG est refuse : RMAN-06149.
 *
 * Releve AVANT (laboratoire RMAN, base livree en NOARCHIVELOG, ouverte) : `BACKUP DATABASE;` reussissait et ecrivait des pieces. Oracle (Backup and Recovery User's
 * Guide, « Making Backups in NOARCHIVELOG Mode ») : sans journaux archives une sauvegarde faite base ouverte serait incoherente et inutilisable ; RMAN la refuse avec
 * `RMAN-06149: cannot BACKUP DATABASE in NOARCHIVELOG mode`. Deux issues : passer la base en ARCHIVELOG, ou la sauvegarder MONTEE apres un arret propre.
 *
 * Les suites ecrites avant ce refus sauvegardent par centaines une base ouverte en NOARCHIVELOG ; elles gardent l'ancienne permissivite par
 * `__setOpenNoarchivelogBackupAllowed(true)` (setupGlobalState), et cette sonde la coupe pour mesurer la production.
 *
 * Discrimine par `git stash push -- src/terminal src/__tests__/setupGlobalState.ts` : 2 des 4 cas tombent. Les deux qui passent des deux cotes : le TEMOIN
 * (en ARCHIVELOG la sauvegarde reussit) et la sauvegarde a froid (base montee), qui doit rester permise.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { resetAllOracleInstances } from '@/terminal/commands/database';
import { __setOpenNoarchivelogBackupAllowed } from '@/terminal/subshells/rman/job/NoarchivelogBackupPolicy';
import { buildRmanLab, type RmanLab } from '../../support/rmanLab';

let lab: RmanLab;

beforeEach(async () => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  resetAllOracleInstances();
  Logger.reset();
  __setOpenNoarchivelogBackupAllowed(false);
  lab = await buildRmanLab();
});

const rman = (script: string): string => lab.sh(lab.prod, `printf '${script}\\n' | rman target /`);

describe('sauvegarde de la base selon son mode', () => {
  it('base ouverte en NOARCHIVELOG : RMAN-06149 et aucune piece', () => {
    const out = rman('BACKUP DATABASE;');
    expect(out).toContain('RMAN-06149: cannot BACKUP DATABASE in NOARCHIVELOG mode');
    expect(out).not.toContain('piece handle=');
  });

  it('TEMOIN — la meme base passee en ARCHIVELOG se sauvegarde', () => {
    rman('SHUTDOWN IMMEDIATE;\\nSTARTUP MOUNT;\\nSQL "ALTER DATABASE ARCHIVELOG";\\nALTER DATABASE OPEN;');
    const out = rman('BACKUP DATABASE;');
    expect(out).not.toContain('RMAN-06149');
    expect(out).toContain('piece handle=');
  });

  it('la sauvegarde a froid (base montee, NOARCHIVELOG) reste permise', () => {
    const out = rman('SHUTDOWN IMMEDIATE;\\nSTARTUP MOUNT;\\nBACKUP DATABASE;');
    expect(out).not.toContain('RMAN-06149');
    expect(out).toContain('piece handle=');
  });

  it('le refus laisse la base intacte : la sauvegarde qui suit le passage en ARCHIVELOG reussit', () => {
    expect(rman('BACKUP DATABASE;')).toContain('RMAN-06149');
    rman('SHUTDOWN IMMEDIATE;\\nSTARTUP MOUNT;\\nSQL "ALTER DATABASE ARCHIVELOG";\\nALTER DATABASE OPEN;');
    expect(rman('BACKUP DATABASE;')).toContain('Finished backup');
  });
});
