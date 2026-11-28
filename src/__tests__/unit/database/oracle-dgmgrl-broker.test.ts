/*
 * Sonde — `dgmgrl` : le Data Guard Broker existe (CREATE / ADD / ENABLE CONFIGURATION, SHOW, EDIT PROTECTION MODE, SWITCHOVER).
 *
 * Releve AVANT : `dgmgrl` repondait « interactive Oracle utility — non-interactive batch mode not supported in this simulator » ; la standby ne se
 * gerait qu'a la main (ALTER SYSTEM SET log_archive_dest_2, ALTER DATABASE RECOVER MANAGED STANDBY, SWITCHOVER TO).
 *
 * Oracle (Data Guard Broker, DGMGRL command reference) : CREATE CONFIGURATION nomme la configuration et la primaire ; ADD DATABASE declare une standby par son
 * identifiant de connexion ; ENABLE CONFIGURATION fait POSER par le broker la destination d'archivage et DEMARRER l'application sur la standby ; SHOW CONFIGURATION rend
 * `Configuration Status: SUCCESS` ; EDIT CONFIGURATION SET PROTECTION MODE n'est accepte que si un membre SYNC le soutient (ORA-16627) ; SWITCHOVER TO bascule les roles.
 * Le broker ne parle a la standby QUE par Oracle Net (il demarre l'application par une session sur le fil), et passe par le meme moteur de bascule que
 * `ALTER DATABASE SWITCHOVER`.
 *
 * Discrimine par `git stash push -- src/network` : les 7 cas tombent (« dgmgrl: command not found »).
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

const dgmgrl = (...commands: string[]): string =>
  lab.sh(lab.prod, `dgmgrl / <<'EOF'\n${commands.join('\n')}\nEOF`);

const configured = (): void => {
  addStandbyRedoLogs(lab);
  dgmgrl("CREATE CONFIGURATION 'lumiere_dg' AS PRIMARY DATABASE IS 'ORCL' CONNECT IDENTIFIER IS orcl;", `ADD DATABASE 'ORCL_STB' AS CONNECT IDENTIFIER IS ${lab.drIp}:1521/ORCL MAINTAINED AS PHYSICAL;`, 'ENABLE CONFIGURATION;');
};

describe('dgmgrl', () => {
  it('une commande inconnue est un DGM-16905', () => {
    expect(dgmgrl('FROBNICATE;')).toContain('DGM-16905');
  });

  it('CREATE CONFIGURATION et ADD DATABASE', () => {
    const out = dgmgrl("CREATE CONFIGURATION 'lumiere_dg' AS PRIMARY DATABASE IS 'ORCL' CONNECT IDENTIFIER IS orcl;", `ADD DATABASE 'ORCL_STB' AS CONNECT IDENTIFIER IS ${lab.drIp}:1521/ORCL MAINTAINED AS PHYSICAL;`);
    expect(out).toContain('Configuration "lumiere_dg" created with primary database "ORCL"');
    expect(out).toContain('Database "ORCL_STB" added');
  });

  it('SHOW CONFIGURATION avant ENABLE est DISABLED, apres ENABLE SUCCESS', () => {
    addStandbyRedoLogs(lab);
    dgmgrl("CREATE CONFIGURATION 'lumiere_dg' AS PRIMARY DATABASE IS 'ORCL' CONNECT IDENTIFIER IS orcl;", `ADD DATABASE 'ORCL_STB' AS CONNECT IDENTIFIER IS ${lab.drIp}:1521/ORCL MAINTAINED AS PHYSICAL;`);
    expect(dgmgrl('SHOW CONFIGURATION;')).toContain('DISABLED');
    expect(dgmgrl('ENABLE CONFIGURATION;')).toContain('Enabled.');
    const shown = dgmgrl('SHOW CONFIGURATION;');
    expect(shown).toContain('ORCL_STB - Physical standby database');
    expect(shown).toContain('SUCCESS');
  });

  it('ENABLE fait poser la destination et appliquer sur la standby : un commit suivi d un journal y arrive', () => {
    configured();
    expect(lab.sql(lab.prod, 'SELECT destination FROM v$archive_dest WHERE dest_id = 2;')).toContain(lab.drIp);
    lab.sql(lab.prod, 'CREATE TABLE t (id NUMBER);');
    lab.sql(lab.prod, 'INSERT INTO t VALUES (1);\nCOMMIT;');
    lab.sql(lab.prod, 'ALTER SYSTEM SWITCH LOGFILE;');
    lab.sql(lab.dr, 'ALTER DATABASE RECOVER MANAGED STANDBY DATABASE CANCEL;');
    lab.sql(lab.dr, 'ALTER DATABASE OPEN READ ONLY;');
    expect(lab.sql(lab.dr, 'SELECT COUNT(*) AS n FROM t;')).toMatch(/^\s*1\s*$/m);
  });

  it('MaxAvailability est refuse tant que le membre est ASYNC, accepte une fois SYNC', () => {
    configured();
    expect(dgmgrl('EDIT CONFIGURATION SET PROTECTION MODE AS MaxAvailability;')).toContain('ORA-16627');
    expect(dgmgrl("EDIT DATABASE 'ORCL_STB' SET PROPERTY LogXptMode='SYNC';")).toContain('updated');
    expect(dgmgrl('EDIT CONFIGURATION SET PROTECTION MODE AS MaxAvailability;')).toContain('Succeeded.');
    expect(lab.sql(lab.prod, 'SELECT protection_mode FROM v$database;')).toContain('MAXIMUM AVAILABILITY');
  });

  it('SWITCHOVER TO bascule les roles', () => {
    configured();
    expect(dgmgrl("SWITCHOVER TO 'ORCL_STB';")).toContain('Switchover succeeded, new primary is "ORCL_STB"');
    expect(lab.sql(lab.dr, 'SELECT database_role FROM v$database;')).toContain('PRIMARY');
  });

  it('sans configuration, SHOW CONFIGURATION est ORA-16532', () => {
    expect(dgmgrl('SHOW CONFIGURATION;')).toContain('ORA-16532');
  });
});
