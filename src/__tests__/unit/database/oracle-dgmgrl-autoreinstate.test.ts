/*
 * Sonde — reinstallation automatique par l'observateur (`Auto-reinstate: TRUE` de SHOW FAST_START FAILOVER, page de la documentation Oracle Data Guard Broker 26ai : apres un fast-start failover,
 * l'observateur reinstalle l'ancienne primaire des qu'elle redevient joignable, ce qui demande Flashback Database sur elle).
 *
 * Releve AVANT : la ligne `Auto-reinstate: TRUE` etait affichee sans effet (regle 6), l'observateur s'arretait apres la bascule et le FSFO etait desactive.
 *
 * Fonctionnement : apres la bascule (`OBSERVER FAILOVER TO`, canal interne) le FSFO reste actif avec l'ancienne primaire pour cible (SYNC) ; l'observateur continue de pinguer la nouvelle primaire et, quand
 * un membre a reinstaller repond (base montee), lui envoie `REINSTATE DATABASE` une seule fois par apparition.
 *
 * Discrimine par `git stash push -- src/terminal src/database src/adapters` : 3 cas tombent sur 4 (bascule qui garde le FSFO, reinstallation automatique, echec unique journalise). Le temoin (STOP OBSERVER : rien ne se reinstalle) passe avant et apres.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { resetAllOracleInstances } from '@/terminal/commands/database';
import { __resetBrokers } from '@/terminal/commands/DgmgrlCommands';
import { BackupKey, DeviceCatalogRegistry } from '@/terminal/subshells/rman';
import { VirtualTimeScheduler, __setDefaultScheduler } from '@/events/Scheduler';
import { addStandbyRedoLogs, buildRmanLab, type RmanLab } from '../../support/rmanLab';

let lab: RmanLab;
let scheduler: VirtualTimeScheduler;

beforeEach(async () => {
  scheduler = new VirtualTimeScheduler();
  __setDefaultScheduler(scheduler);
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

const dgmgrl = (device: Parameters<RmanLab['sh']>[0], ...commands: string[]): string =>
  lab.sh(device, `dgmgrl / <<'EOF'\n${commands.join('\n')}\nEOF`);

const configured = (sync = true): void => {
  addStandbyRedoLogs(lab);
  dgmgrl(lab.prod, "CREATE CONFIGURATION 'lumiere_dg' AS PRIMARY DATABASE IS 'ORCL' CONNECT IDENTIFIER IS orcl;", `ADD DATABASE 'ORCL_STB' AS CONNECT IDENTIFIER IS ${lab.drIp}:1521/ORCL MAINTAINED AS PHYSICAL;`, 'ENABLE CONFIGURATION;');
  if (sync) dgmgrl(lab.prod, "EDIT DATABASE 'ORCL_STB' SET PROPERTY LogXptMode='SYNC';", 'EDIT CONFIGURATION SET PROTECTION MODE AS MaxAvailability;');
};

const roleOf = (device: Parameters<RmanLab['sql']>[0]): string => lab.sql(device, 'SELECT database_role FROM v$database;');

const enableObserved = (flashback = true): void => {
  configured();
  if (flashback) lab.sql(lab.prod, 'ALTER DATABASE FLASHBACK ON;');
  dgmgrl(lab.prod, 'ENABLE FAST_START FAILOVER;');
  dgmgrl(lab.prod, 'START OBSERVER obs1;');
  scheduler.advance(6000);
};

const lostPrimary = (): void => {
  lab.sql(lab.prod, 'CREATE TABLE t (id NUMBER);');
  lab.sql(lab.prod, 'INSERT INTO t VALUES (1);\nCOMMIT;');
  lab.sql(lab.prod, 'ALTER SYSTEM SWITCH LOGFILE;');
  lab.sql(lab.prod, 'SHUTDOWN ABORT;');
  scheduler.advance(45000);
};

describe('observer auto-reinstate', () => {
  it('after the automatic failover fast-start failover stays enabled and the lost primary needs reinstatement', () => {
    enableObserved();
    lostPrimary();
    expect(roleOf(lab.dr)).toContain('PRIMARY');
    const out = dgmgrl(lab.dr, 'SHOW CONFIGURATION;');
    expect(out).toMatch(/ORCL - Physical standby database\s+Error: ORA-16661/);
    expect(dgmgrl(lab.dr, 'SHOW FAST_START FAILOVER;')).toContain('Active Target:      ORCL');
  });

  it('when the former primary is mounted again the observer reinstates it by itself', () => {
    enableObserved();
    lostPrimary();
    lab.sql(lab.prod, 'STARTUP MOUNT;');
    scheduler.advance(9000);
    expect(lab.sql(lab.prod, 'SELECT database_role FROM v$database;')).toContain('PHYSICAL STANDBY');
    expect(dgmgrl(lab.dr, 'SHOW CONFIGURATION;')).toMatch(/Configuration Status:\s+SUCCESS/);
    expect(dgmgrl(lab.dr, 'SHOW FAST_START FAILOVER;')).toContain('Enabled in Zero Data Loss Mode');
  });

  it('TEMOIN — with the observer stopped nothing is reinstated', () => {
    enableObserved();
    lostPrimary();
    dgmgrl(lab.dr, 'STOP OBSERVER;');
    lab.sql(lab.prod, 'STARTUP MOUNT;');
    scheduler.advance(30000);
    expect(dgmgrl(lab.dr, 'SHOW CONFIGURATION;')).toContain('ORA-16661');
  });

  it('without flashback on the former primary the attempt fails once and the member stays to reinstate', () => {
    enableObserved(false);
    lostPrimary();
    lab.sql(lab.prod, 'STARTUP MOUNT;');
    scheduler.advance(30000);
    expect(dgmgrl(lab.dr, 'SHOW CONFIGURATION;')).toContain('ORA-16661');
    expect(lab.sh(lab.dr, 'grep -c "REINSTATE DATABASE ORCL failed" /u01/app/oracle/diag/rdbms/orcl/ORCL/trace/alert_ORCL.log').trim()).toBe('1');
  });
});
