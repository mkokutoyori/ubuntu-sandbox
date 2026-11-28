/*
 * Sonde — fast-start failover en mode Potential Data Loss et retard de transport reel. Sources (reference de la CLI du broker 19c, docs.oracle.com, lue le jour du developpement) : la page VALIDATE
 * FAST_START FAILOVER donne le libelle `Fast-Start Failover: Enabled in Potential Data Loss Mode` en protection MaxPerformance ; SHOW FAST_START FAILOVER affiche `Lag Limit` (celui de
 * FastStartFailoverLagLimit, 30 s par defaut d'apres l'exemple 2 de SHOW CONFIGURATION) ; la page ENABLE FAST_START FAILOVER montre `Enabled in Zero Data Loss Mode.` : le simulateur dit
 * `Enabled in Potential Data Loss Mode.`, texte releve sur des transcripts publics (ASRblogger, le guide Google Cloud de l'observateur Data Guard), qui priment sur la documentation quand elle ne le montre pas (regle 8).
 *
 * Releve AVANT : ENABLE etait refuse en MaxPerformance (ORA-16693), `Lag Limit` valait toujours 0 et le `Transport Lag` de SHOW DATABASE etait constant (0).
 *
 * Fonctionnement : la primaire date le premier COMMIT que chaque destination non synchrone n'a pas encore recu (l'archive expediee au log switch, ou le redo synchrone, l'efface) ; le retard de transport
 * est l'age de ce COMMIT. L'observateur releve le retard de la cible a chaque ping ; quand la primaire se tait, il ne bascule que si le dernier retard connu tient dans la limite (en Potential Data Loss).
 *
 * Discrimine par `git stash push -- src/terminal src/database src/adapters` ; 4 cas tombent sur 5 ; le cinquieme (une cible en retard ne prend pas la main) passe avant parce que ENABLE etait refuse, c'est un cas structurel : il n'a de sens qu'avec le cas « a jour » qui le precede, qui lui tombe.
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

const commit = (id: number): void => { lab.sql(lab.prod, `INSERT INTO t VALUES (${id});\nCOMMIT;`); };

const potentialDataLoss = (): void => {
  configured(false);
  lab.sql(lab.prod, 'CREATE TABLE t (id NUMBER);');
  lab.sql(lab.prod, 'ALTER SYSTEM SWITCH LOGFILE;');
  dgmgrl(lab.prod, 'ENABLE FAST_START FAILOVER;');
  dgmgrl(lab.prod, 'START OBSERVER obs1;');
  scheduler.advance(6000);
};

describe('potential data loss fast-start failover', () => {
  it('ENABLE in MaxPerformance is accepted and shows the lag limit', () => {
    configured(false);
    expect(dgmgrl(lab.prod, 'ENABLE FAST_START FAILOVER;')).toContain('Enabled in Potential Data Loss Mode.');
    const out = dgmgrl(lab.prod, 'SHOW FAST_START FAILOVER;');
    expect(out).toContain('Fast-Start Failover: Enabled in Potential Data Loss Mode');
    expect(out).toContain('Lag Limit:          30 seconds');
  });

  it('the transport lag is the age of the oldest commit the standby has not received', () => {
    configured(false);
    lab.sql(lab.prod, 'CREATE TABLE t (id NUMBER);');
    lab.sql(lab.prod, 'ALTER SYSTEM SWITCH LOGFILE;');
    expect(dgmgrl(lab.prod, "SHOW DATABASE 'ORCL_STB';")).toContain('Transport Lag:      0 seconds');
    commit(1);
    scheduler.advance(12000);
    expect(dgmgrl(lab.prod, "SHOW DATABASE 'ORCL_STB';")).toMatch(/Transport Lag:\s+(1[2-9]|2\d) seconds/);
    expect(dgmgrl(lab.dr, "SHOW DATABASE 'ORCL_STB';")).toMatch(/Transport Lag:\s+(1[2-9]|2\d) seconds/);
    lab.sql(lab.prod, 'ALTER SYSTEM SWITCH LOGFILE;');
    expect(dgmgrl(lab.prod, "SHOW DATABASE 'ORCL_STB';")).toContain('Transport Lag:      0 seconds');
  });

  it('a target within the lag limit takes over', () => {
    potentialDataLoss();
    commit(1);
    lab.sql(lab.prod, 'ALTER SYSTEM SWITCH LOGFILE;');
    scheduler.advance(6000);
    lab.sql(lab.prod, 'SHUTDOWN ABORT;');
    scheduler.advance(45000);
    expect(roleOf(lab.dr)).toContain('PRIMARY');
  });

  it('a target lagging beyond the limit does not take over', () => {
    potentialDataLoss();
    commit(1);
    scheduler.advance(40000);
    lab.sql(lab.prod, 'SHUTDOWN ABORT;');
    scheduler.advance(90000);
    expect(roleOf(lab.dr)).not.toContain('PRIMARY');
  });

  it('raising FastStartFailoverLagLimit lets the same lag through', () => {
    potentialDataLoss();
    dgmgrl(lab.prod, 'EDIT CONFIGURATION SET PROPERTY FastStartFailoverLagLimit=120;');
    commit(1);
    scheduler.advance(40000);
    lab.sql(lab.prod, 'SHUTDOWN ABORT;');
    scheduler.advance(60000);
    expect(roleOf(lab.dr)).toContain('PRIMARY');
    expect(dgmgrl(lab.dr, 'SHOW CONFIGURATION VERBOSE;')).toMatch(/FastStartFailoverLagLimit\s+= '120'/);
  });
});
