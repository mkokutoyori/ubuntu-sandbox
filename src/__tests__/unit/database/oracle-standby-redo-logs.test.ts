/*
 * Sonde — les standby redo logs sont des FICHIERS et le broker les exige. Sources : docs.oracle.com, V$STANDBY_LOG (colonnes GROUP#, DBID, THREAD#, SEQUENCE#, BYTES, BLOCKSIZE, USED, ARCHIVED, STATUS ;
 * DBID vaut UNASSIGNED tant que le journal n'est pas affecte), la page d'erreur ORA-16789 (« standby redo logs configured incorrectly » : « Standby redo logs are required when the redo transport mode
 * is set to SYNC or ASYNC »), ORA-01184 (le groupe existe deja), ORA-01185 (numero de groupe invalide), et la page ENABLE FAST_START FAILOVER (la primaire et la cible doivent avoir des standby redo logs).
 *
 * Releve AVANT : `ALTER DATABASE ADD STANDBY LOGFILE` n'existait pas (CLAUDE.md : « standby redo logs as files » non construit), V$STANDBY_LOG etait un faux (il listait les bases standby declarees comme des groupes de journaux, sans fichier) que `oracle-scheduler-multitenant-dg` figeait, et le broker declarait SUCCESS une standby sans
 * aucun standby redo log.
 *
 * Les fichiers naissent sur la machine par l'evenement `oracle.redo.standby-log-changed`. La RECEPTION du redo les remplit : le redo d'un COMMIT synchrone affecte un groupe (STATUS ACTIVE, DBID de la
 * primaire, SEQUENCE#, USED), l'arrivee de l'archive de ce journal le libere (UNASSIGNED, ARCHIVED NO : « the standby redo log has been archived and is again available », page V$STANDBY_LOG).
 *
 * Discrimine par `git stash push -- src/terminal src/database src/adapters` : 5 des 7 premiers cas tombent (et 2 des 3 derniers contre la version sans reception). Deux passent des deux cotes et sont nommes : le TEMOIN (avec des standby redo logs, SUCCESS) et l'effacement
 * de l'erreur par l'ajout sur la standby (vrai avant, parce que le broker disait SUCCESS sans rien verifier).
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

const dgmgrl = (device: Parameters<RmanLab['sh']>[0], ...commands: string[]): string =>
  lab.sh(device, `dgmgrl / <<'EOF'\n${commands.join('\n')}\nEOF`);

const SRL = "ALTER DATABASE ADD STANDBY LOGFILE GROUP 11 ('/u01/app/oracle/oradata/ORCL/srl11.log') SIZE 50M;";

const configured = (): void => {
  dgmgrl(lab.prod, "CREATE CONFIGURATION 'lumiere_dg' AS PRIMARY DATABASE IS 'ORCL' CONNECT IDENTIFIER IS orcl;", `ADD DATABASE 'ORCL_STB' AS CONNECT IDENTIFIER IS ${lab.drIp}:1521/ORCL MAINTAINED AS PHYSICAL;`, 'ENABLE CONFIGURATION;');
};

describe('standby redo logs', () => {
  it('ADD STANDBY LOGFILE creates the group, its file, and V$STANDBY_LOG shows it unassigned', () => {
    expect(lab.sql(lab.prod, SRL)).toContain('Database altered.');
    const view = lab.sql(lab.prod, 'SELECT group#, thread#, bytes, dbid, status FROM v$standby_log;');
    expect(view).toMatch(/11\s+1\s+52428800\s+UNASSIGNED\s+UNASSIGNED/);
    expect(lab.sh(lab.prod, 'ls -l /u01/app/oracle/oradata/ORCL/srl11.log')).toMatch(/oracle\s+oinstall/);
  });

  it('several members and a thread are accepted, an existing group is ORA-01184', () => {
    expect(lab.sql(lab.prod, "ALTER DATABASE ADD STANDBY LOGFILE THREAD 1 ('/u01/app/oracle/oradata/ORCL/srl12.log', '/u01/app/oracle/oradata/ORCL/srl12b.log') SIZE 50M;")).toContain('Database altered.');
    expect(lab.sh(lab.prod, 'ls /u01/app/oracle/oradata/ORCL | grep -c srl12')).toContain('2');
    lab.sql(lab.prod, SRL);
    expect(lab.sql(lab.prod, SRL)).toContain('ORA-01184: logfile group 11 already exists');
  });

  it('DROP STANDBY LOGFILE removes the group and its file; an unknown group is ORA-01185', () => {
    lab.sql(lab.prod, SRL);
    expect(lab.sql(lab.prod, 'ALTER DATABASE DROP STANDBY LOGFILE GROUP 11;')).toContain('Database altered.');
    expect(lab.sh(lab.prod, 'ls /u01/app/oracle/oradata/ORCL | grep -c srl11')).toContain('0');
    expect(lab.sql(lab.prod, 'ALTER DATABASE DROP STANDBY LOGFILE GROUP 99;')).toContain('ORA-01185: logfile group number 99 is invalid');
  });

  it('TEMOIN — a standby with standby redo logs is SUCCESS', () => {
    addStandbyRedoLogs(lab);
    configured();
    expect(dgmgrl(lab.prod, 'SHOW CONFIGURATION;')).toMatch(/Configuration Status:\s+SUCCESS/);
  });

  it('a standby with none is an error: ORA-16789 under the member, in SHOW DATABASE and as the configuration status', () => {
    configured();
    const configuration = dgmgrl(lab.prod, 'SHOW CONFIGURATION;');
    expect(configuration).toContain('Error: ORA-16789: standby redo logs configured incorrectly');
    expect(configuration).toMatch(/Configuration Status:\s+ORA-16789[^\n]*\s+ERROR/);
    const database = dgmgrl(lab.prod, "SHOW DATABASE 'ORCL_STB';");
    expect(database).toContain('Database Error(s):');
    expect(database).toMatch(/Database Status:\s+ERROR/);
  });

  it('adding the standby redo logs on the standby clears the error', () => {
    configured();
    lab.sql(lab.dr, SRL);
    expect(dgmgrl(lab.prod, "SHOW DATABASE 'ORCL_STB';")).toMatch(/Database Status:\s+SUCCESS/);
  });

  it('fast-start failover needs standby redo logs on the primary and on the target', () => {
    configured();
    dgmgrl(lab.prod, "EDIT DATABASE 'ORCL_STB' SET PROPERTY LogXptMode='SYNC';", 'EDIT CONFIGURATION SET PROTECTION MODE AS MaxAvailability;');
    expect(dgmgrl(lab.prod, 'ENABLE FAST_START FAILOVER;')).toContain('ORA-16693');
    lab.sql(lab.prod, SRL);
    expect(dgmgrl(lab.prod, 'ENABLE FAST_START FAILOVER;')).toContain('ORA-16693');
    lab.sql(lab.dr, SRL);
    expect(dgmgrl(lab.prod, 'ENABLE FAST_START FAILOVER;')).toContain('Enabled in Zero Data Loss Mode.');
  });

  const synchronous = (): void => {
    addStandbyRedoLogs(lab);
    configured();
    dgmgrl(lab.prod, "EDIT DATABASE 'ORCL_STB' SET PROPERTY LogXptMode='SYNC';", 'EDIT CONFIGURATION SET PROTECTION MODE AS MaxAvailability;');
  };
  const standbyView = (): string => lab.sql(lab.dr, 'SELECT group#, dbid, sequence#, used, archived, status FROM v$standby_log;');

  it('TEMOIN — before any commit the group is unassigned and unused', () => {
    synchronous();
    expect(standbyView()).toMatch(/11\s+UNASSIGNED\s+0\s+0\s+YES\s+UNASSIGNED/);
  });

  it('the redo of a synchronous commit fills a group: ACTIVE, the primary DBID, bytes used', () => {
    synchronous();
    lab.sql(lab.prod, 'CREATE TABLE t (id NUMBER);');
    lab.sql(lab.prod, "INSERT INTO t VALUES (1);\nCOMMIT;");
    const view = standbyView();
    expect(view).toMatch(/11\s+\d{6,}\s+\d+\s+[1-9]\d*\s+NO\s+ACTIVE/);
  });

  it('the archive of that log releases the group: UNASSIGNED, ARCHIVED NO, nothing used', () => {
    synchronous();
    lab.sql(lab.prod, 'CREATE TABLE t (id NUMBER);');
    lab.sql(lab.prod, "INSERT INTO t VALUES (1);\nCOMMIT;");
    lab.sql(lab.prod, 'ALTER SYSTEM SWITCH LOGFILE;');
    expect(standbyView()).toMatch(/11\s+UNASSIGNED\s+\d+\s+0\s+NO\s+UNASSIGNED/);
  });
});
