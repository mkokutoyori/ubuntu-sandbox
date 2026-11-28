/*
 * Sonde — Flashback Database. Sources (docs.oracle.com, lues le jour du developpement) : la page FLASHBACK DATABASE (TO SCN, TO BEFORE SCN, TO TIMESTAMP, base MONTEE et non ouverte, ARCHIVELOG,
 * ALTER DATABASE FLASHBACK ON requis, ouverture ensuite par RESETLOGS), V$FLASHBACK_DATABASE_LOG (OLDEST_FLASHBACK_SCN, OLDEST_FLASHBACK_TIME, RETENTION_TARGET en minutes, FLASHBACK_SIZE) et les pages
 * d'erreur ORA-38707 (media recovery non active), ORA-38757 (base ouverte), ORA-38729 (pas assez de journaux de flashback).
 *
 * Releve AVANT : `ALTER DATABASE FLASHBACK ON` ne faisait que lever un drapeau (aucun journal, V$FLASHBACK_DATABASE_LOG lisait un historique sans rapport) et `FLASHBACK DATABASE` n'existait pas.
 * Modele : a chaque COMMIT et chaque DDL, une base flashback ON ecrit un journal de flashback (un fichier de la zone de recuperation, l'etat des fichiers de donnees a ce SCN). FLASHBACK DATABASE
 * remet les fichiers du dernier journal anterieur a la cible (comme Oracle restaure les blocs de ses journaux) ; la base se rouvre par RESETLOGS. Difference assumee : Oracle rejoue ensuite le redo
 * jusqu'au SCN exact ; ici chaque COMMIT a son journal, donc le dernier journal <= cible EST l'etat a la cible.
 *
 * Discrimine par `git stash push -- src/database src/adapters` : les 10 cas tombent (le temoin aussi : sans le correctif, l'ancienne instruction FLASHBACK DATABASE etait un no-op loggue et le journal
 * de flashback n'existait pas). Le defaut ferme au passage : le parseur generique acceptait FLASHBACK DATABASE comme un no-op (« Flashback complete. » sans rien faire, y compris base ouverte) ;
 * il est maintenant branche sur le moteur, qui refuse par ORA-38757 / ORA-38729 / ORA-38707 comme les pages d'erreur.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { resetAllOracleInstances } from '@/terminal/commands/database';
import { __resetBrokers } from '@/terminal/commands/DgmgrlCommands';
import { BackupKey, DeviceCatalogRegistry } from '@/terminal/subshells/rman';
import { addStandbyRedoLogs, buildRmanLab, type RmanLab } from '../../support/rmanLab';

let lab: RmanLab;

beforeEach(async () => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); resetAllOracleInstances(); Logger.reset(); BackupKey._reset(); DeviceCatalogRegistry._reset(); __resetBrokers();
  lab = await buildRmanLab();
  lab.sql(lab.prod, 'SHUTDOWN IMMEDIATE;');
  lab.sql(lab.prod, 'STARTUP MOUNT;');
  lab.sql(lab.prod, 'ALTER DATABASE ARCHIVELOG;');
  lab.sql(lab.prod, 'ALTER DATABASE OPEN;');
  lab.sql(lab.dr, 'SHUTDOWN IMMEDIATE;');
  lab.sql(lab.dr, 'STARTUP NOMOUNT;');
  lab.sh(lab.prod, `rman target / <<'EOF'\nCONNECT AUXILIARY sys/oracle@${lab.drIp}:1521/ORCL;\nDUPLICATE TARGET DATABASE FOR STANDBY FROM ACTIVE DATABASE DORECOVER NOFILENAMECHECK;\nEOF`);
});

const prod = (statement: string): string => lab.sql(lab.prod, statement);
const scnOf = (): number => Number(/\d{4,}/.exec(prod('SELECT current_scn FROM v$database;'))?.[0] ?? '0');

function archivelog(): void {
  lab.rman(lab.prod, 'SHUTDOWN IMMEDIATE;\nSTARTUP MOUNT;\nSQL "ALTER DATABASE ARCHIVELOG";\nALTER DATABASE OPEN;');
}

function flashbackWorld(): number {
  archivelog();
  expect(prod('ALTER DATABASE FLASHBACK ON;')).toContain('Database altered.');
  prod('CREATE TABLE orders (id NUMBER);');
  prod('INSERT INTO orders VALUES (1);\nCOMMIT;');
  const target = scnOf();
  prod('INSERT INTO orders VALUES (2);\nCOMMIT;');
  prod('INSERT INTO orders VALUES (3);\nCOMMIT;');
  return target;
}

function mountedFlashback(statement: string): string {
  prod('SHUTDOWN IMMEDIATE;');
  prod('STARTUP MOUNT;');
  return prod(statement);
}

describe('flashback database', () => {
  it('FLASHBACK ON needs ARCHIVELOG: ORA-38707', () => {
    prod('SHUTDOWN IMMEDIATE;');
    prod('STARTUP MOUNT;');
    prod('ALTER DATABASE NOARCHIVELOG;');
    prod('ALTER DATABASE OPEN;');
    expect(prod('SELECT log_mode FROM v$database;')).toContain('NOARCHIVELOG');
    expect(prod('ALTER DATABASE FLASHBACK ON;')).toContain('ORA-38707: Media recovery is not enabled.');
  });

  it('TEMOIN — with ARCHIVELOG it is accepted and V$DATABASE says so', () => {
    archivelog();
    expect(prod('ALTER DATABASE FLASHBACK ON;')).toContain('Database altered.');
    expect(prod('SELECT flashback_on FROM v$database;')).toMatch(/YES/);
  });

  it('every commit writes a flashback log file in the recovery area and V$FLASHBACK_DATABASE_LOG counts them', () => {
    flashbackWorld();
    expect(lab.sh(lab.prod, 'ls /u01/app/oracle/fast_recovery_area/ORCL/flashback | wc -l')).toMatch(/[4-9]|\d{2}/);
    const view = prod('SELECT oldest_flashback_scn, retention_target, flashback_size FROM v$flashback_database_log;');
    expect(view).toMatch(/\d{4,}\s+1440\s+[1-9]\d*/);
  });

  it('FLASHBACK DATABASE TO SCN returns the data to that point', () => {
    const target = flashbackWorld();
    expect(prod('SELECT COUNT(*) AS n FROM orders;')).toMatch(/\b3\b/);
    expect(mountedFlashback(`FLASHBACK DATABASE TO SCN ${target};`)).toContain('Flashback complete.');
    expect(prod('ALTER DATABASE OPEN;')).toContain('ORA-01589');
    expect(prod('ALTER DATABASE OPEN RESETLOGS;')).toContain('Database altered.');
    expect(prod('SELECT COUNT(*) AS n FROM orders;')).toMatch(/\b1\b/);
    expect(prod('SELECT COUNT(*) AS n FROM orders;')).not.toMatch(/\b3\b/);
  });

  it('a dropped table comes back', () => {
    const target = flashbackWorld();
    prod('DROP TABLE orders PURGE;');
    expect(mountedFlashback(`FLASHBACK DATABASE TO SCN ${target};`)).toContain('Flashback complete.');
    prod('ALTER DATABASE OPEN RESETLOGS;');
    expect(prod('SELECT COUNT(*) AS n FROM orders;')).toMatch(/\b1\b/);
  });

  it('TO BEFORE SCN stops one log earlier than TO SCN', () => {
    const target = flashbackWorld();
    mountedFlashback(`FLASHBACK DATABASE TO BEFORE SCN ${target};`);
    prod('ALTER DATABASE OPEN RESETLOGS;');
    expect(prod('SELECT COUNT(*) AS n FROM orders;')).toMatch(/no rows selected|\b0\b/);
  });

  it('TO TIMESTAMP before the oldest flashback log is ORA-38729', () => {
    flashbackWorld();
    expect(mountedFlashback('FLASHBACK DATABASE TO TIMESTAMP SYSDATE - 2;')).toContain('ORA-38729');
  });

  it('on an open database it is ORA-38757', () => {
    const target = flashbackWorld();
    expect(prod(`FLASHBACK DATABASE TO SCN ${target};`)).toContain('ORA-38757');
  });

  it('with flashback OFF there is nothing to flash back to: ORA-38729', () => {
    archivelog();
    prod('CREATE TABLE orders (id NUMBER);');
    expect(mountedFlashback('FLASHBACK DATABASE TO SCN 1;')).toContain('ORA-38729');
  });

  it('FLASHBACK OFF deletes the logs', () => {
    flashbackWorld();
    prod('ALTER DATABASE FLASHBACK OFF;');
    expect(lab.sh(lab.prod, 'ls /u01/app/oracle/fast_recovery_area/ORCL/flashback 2>/dev/null | wc -l')).toMatch(/\b0\b/);
    expect(prod('SELECT COUNT(*) FROM v$flashback_database_log;')).toMatch(/\b0\b/);
  });
});
