/*
 * Sonde — REINSTATE DATABASE. Sources (docs.oracle.com, le jour du developpement) : la page REINSTATE DATABASE (la commande « reinstates a database as a new standby database in the broker configuration for
 * the current primary database » ; sortie `Reinstating database "X", please wait...` puis `Reinstatement of database "X" succeeded` ; si les conditions ne sont pas remplies, la reinstallation echoue avec
 * un statut d'erreur et la base reste desactivee), les pages d'erreur ORA-16661 (« the standby database needs to be reinstated », apres un changement de role) et ORA-16653 (« failed to reinstate database »,
 * detail dans les journaux du broker), et FLASHBACK DATABASE (l'ancienne primaire est ramenee AVANT le point de divergence, puis convertie en standby).
 *
 * Releve AVANT : un FAILOVER faisait disparaitre l'ancienne primaire de la configuration, sans moyen de la reprendre ; l'ancienne primaire gardait les transactions perdues.
 *
 * Fonctionnement : le FAILOVER garde l'ancienne primaire comme membre « a reinstaller » (ORA-16661, statut ERROR) et note le SCN de divergence ; REINSTATE, tape sur la nouvelle primaire, envoie a l'ancienne
 * (par Oracle Net, base MONTEE) `FLASHBACK DATABASE TO BEFORE SCN <divergence>` puis `ALTER DATABASE CONVERT TO PHYSICAL STANDBY`, la reintegre (destination d'archivage, application) et change de journal
 * pour lui expedier le redo de la nouvelle histoire. Le detail d'un echec va dans le journal d'alerte de la nouvelle primaire, pas dans la sortie (la page n'en montre pas).
 *
 * Discrimine par `git stash push -- src/terminal src/database src/adapters`.
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
const prod = (statement: string): string => lab.sql(lab.prod, statement);
const dr = (statement: string): string => lab.sql(lab.dr, statement);

function failedOver(withFlashback = true): void {
  addStandbyRedoLogs(lab);
  if (withFlashback) prod('ALTER DATABASE FLASHBACK ON;');
  dgmgrl(lab.prod, "CREATE CONFIGURATION 'lumiere_dg' AS PRIMARY DATABASE IS 'ORCL' CONNECT IDENTIFIER IS orcl;", `ADD DATABASE 'ORCL_STB' AS CONNECT IDENTIFIER IS ${lab.drIp}:1521/ORCL MAINTAINED AS PHYSICAL;`, 'ENABLE CONFIGURATION;');
  prod('CREATE TABLE t (id NUMBER);');
  prod('INSERT INTO t VALUES (1);\nCOMMIT;');
  prod('ALTER SYSTEM SWITCH LOGFILE;');
  prod('INSERT INTO t VALUES (2);\nCOMMIT;');
  prod('SHUTDOWN ABORT;');
  dgmgrl(lab.dr, "FAILOVER TO 'ORCL_STB';");
  dr('ALTER DATABASE OPEN;');
  dr('INSERT INTO t VALUES (3);\nCOMMIT;');
}

describe('REINSTATE DATABASE', () => {
  it('after a FAILOVER the lost primary stays in the configuration and needs reinstatement', () => {
    failedOver();
    const out = dgmgrl(lab.dr, 'SHOW CONFIGURATION;');
    expect(out).toMatch(/ORCL_STB - Primary database/);
    expect(out).toMatch(/ORCL - Physical standby database\s+Error: ORA-16661: the standby database needs to be reinstated/);
    expect(out).toMatch(/Configuration Status:\s+ERROR/);
  });

  it('REINSTATE on the new primary brings the former primary back as a standby', () => {
    failedOver();
    prod('STARTUP MOUNT;');
    const out = dgmgrl(lab.dr, "REINSTATE DATABASE 'ORCL';");
    expect(out).toContain('Reinstating database "ORCL", please wait...');
    expect(out).toContain('Reinstatement of database "ORCL" succeeded');
    expect(prod('SELECT database_role, open_mode FROM v$database;')).toMatch(/PHYSICAL STANDBY\s+MOUNTED/);
    expect(dgmgrl(lab.dr, 'SHOW CONFIGURATION;')).toMatch(/Configuration Status:\s+SUCCESS/);
  });

  it('the transactions the failover lost are gone from the reinstated database, the new history reaches it', () => {
    failedOver();
    prod('STARTUP MOUNT;');
    dgmgrl(lab.dr, "REINSTATE DATABASE 'ORCL';");
    prod('ALTER DATABASE RECOVER MANAGED STANDBY DATABASE CANCEL;');
    prod('ALTER DATABASE OPEN READ ONLY;');
    const rows = prod('SELECT id FROM t ORDER BY 1;');
    const ids = rows.split('\n').map((line) => line.trim()).filter((line) => /^\d+$/.test(line));
    expect(ids).toEqual(['1', '3']);
  });

  it('a database that is not mounted cannot be reinstated: ORA-16653, and it still needs reinstatement', () => {
    failedOver();
    const out = dgmgrl(lab.dr, "REINSTATE DATABASE 'ORCL';");
    expect(out).toContain('Error: ORA-16653: failed to reinstate database');
    expect(out).not.toContain('succeeded');
    expect(dgmgrl(lab.dr, 'SHOW CONFIGURATION;')).toContain('ORA-16661');
  });

  it('without flashback on the former primary it fails with ORA-16653 and the cause is in the alert log', () => {
    failedOver(false);
    prod('STARTUP MOUNT;');
    expect(dgmgrl(lab.dr, "REINSTATE DATABASE 'ORCL';")).toContain('ORA-16653');
    expect(lab.sh(lab.dr, 'grep -c "REINSTATE DATABASE ORCL failed" /u01/app/oracle/diag/rdbms/orcl/ORCL/trace/alert_ORCL.log')).toMatch(/[1-9]/);
  });

  it('a member that does not need reinstatement answers ORA-16653, an unknown one ORA-16541', () => {
    failedOver();
    prod('STARTUP MOUNT;');
    dgmgrl(lab.dr, "REINSTATE DATABASE 'ORCL';");
    expect(dgmgrl(lab.dr, "REINSTATE DATABASE 'ORCL';")).toContain('ORA-16653');
    expect(dgmgrl(lab.dr, "REINSTATE DATABASE 'NOPE';")).toContain('ORA-16541');
  });

  it('TEMOIN — before the failover the configuration of the same lab is SUCCESS', () => {
    addStandbyRedoLogs(lab);
    dgmgrl(lab.prod, "CREATE CONFIGURATION 'lumiere_dg' AS PRIMARY DATABASE IS 'ORCL' CONNECT IDENTIFIER IS orcl;", `ADD DATABASE 'ORCL_STB' AS CONNECT IDENTIFIER IS ${lab.drIp}:1521/ORCL MAINTAINED AS PHYSICAL;`, 'ENABLE CONFIGURATION;');
    expect(dgmgrl(lab.prod, 'SHOW CONFIGURATION;')).toMatch(/Configuration Status:\s+SUCCESS/);
  });
});
