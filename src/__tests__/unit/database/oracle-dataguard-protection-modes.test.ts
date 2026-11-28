/*
 * Sonde — les modes de protection Data Guard sont IMPOSES : transport synchrone au COMMIT, et la reaction du primaire quand la standby ne repond plus.
 *
 * Releve AVANT (laboratoire RMAN, standby construite par DUPLICATE, `log_archive_dest_2='SERVICE=... SYNC AFFIRM'`) :
 *
 *   ALTER DATABASE SET STANDBY DATABASE TO MAXIMIZE PROTECTION;     ->  la commande n'existait pas (la valeur ne se posait nulle part)
 *   SELECT protection_mode, protection_level FROM v$database;       ->  ORA-00904 : les deux colonnes n'existaient pas
 *   INSERT ... ; COMMIT;  (sans changement de journal)               ->  rien sur la standby : le redo ne partait qu'au switch, meme avec SYNC
 *   standby arretee, commit sous MAXIMUM PROTECTION                  ->  le primaire continuait
 *
 * Oracle (Data Guard Concepts and Administration, « Data Guard Protection Modes ») : MAXIMUM PROTECTION exige un transport SYNC AFFIRM et un accuse de reception
 * de la standby AVANT que le commit rende la main ; si aucune standby n'accuse, le primaire s'ARRETE (zero perte de donnees garantie). MAXIMUM AVAILABILITY est
 * synchrone tant que la standby repond, puis repasse en asynchrone sans interrompre le primaire (PROTECTION_LEVEL = RESYNCHRONIZATION) et revient quand elle revient.
 * MAXIMUM PERFORMANCE est asynchrone. `ALTER DATABASE SET STANDBY DATABASE TO MAXIMIZE {PROTECTION | AVAILABILITY | PERFORMANCE}` exige, hors performance, une
 * destination SYNC (ORA-16072), et MAXIMUM PROTECTION une base montee (ORA-01126). Le redo d'un commit part sur le fil (ShipRedo, un fichier `.srl` par commit,
 * ecrit par le RFS) et le MRP l'applique par SCN, sans rejouer ce que le journal archive contient deja.
 *
 * Discrimine par `git stash push -- src/database src/adapters src/terminal` : 6 des 7 cas tombent (le TEMOIN du mode par defaut tombe aussi : la colonne manquait). Seul le cas ASYNC passe des deux cotes : il prouve qu'un commit asynchrone ne part pas avec le commit, ce qui donne son sens au cas SYNC.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { resetAllOracleInstances } from '@/terminal/commands/database';
import { BackupKey, DeviceCatalogRegistry } from '@/terminal/subshells/rman';
import { buildRmanLab, type RmanLab } from '../../support/rmanLab';

let lab: RmanLab;

beforeEach(async () => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); resetAllOracleInstances(); Logger.reset(); BackupKey._reset(); DeviceCatalogRegistry._reset();
  lab = await buildRmanLab();
  lab.sql(lab.prod, 'SHUTDOWN IMMEDIATE;');
  lab.sql(lab.prod, 'STARTUP MOUNT;');
  lab.sql(lab.prod, 'ALTER DATABASE ARCHIVELOG;');
  lab.sql(lab.prod, 'ALTER DATABASE OPEN;');
  lab.sql(lab.prod, 'CREATE TABLE t (id NUMBER);');
  lab.sql(lab.prod, 'COMMIT;');
  lab.sql(lab.dr, 'SHUTDOWN IMMEDIATE;');
  lab.sql(lab.dr, 'STARTUP NOMOUNT;');
  lab.sh(lab.prod, `rman target / <<'EOF'\nCONNECT AUXILIARY sys/oracle@${lab.drIp}:1521/ORCL;\nDUPLICATE TARGET DATABASE FOR STANDBY FROM ACTIVE DATABASE DORECOVER NOFILENAMECHECK;\nEOF`);
});

const destination = (transport: 'SYNC AFFIRM' | 'ASYNC') => {
  lab.sql(lab.prod, `ALTER SYSTEM SET log_archive_dest_2='SERVICE=${lab.drIp}:1521/ORCL ${transport} DB_UNIQUE_NAME=ORCL_STB' SCOPE=BOTH;`);
  lab.sql(lab.prod, 'ALTER SYSTEM SET log_archive_dest_state_2=ENABLE SCOPE=BOTH;');
  lab.sql(lab.dr, 'ALTER DATABASE RECOVER MANAGED STANDBY DATABASE DISCONNECT FROM SESSION;');
};

const commitRow = (id: number): string => lab.sql(lab.prod, `INSERT INTO t VALUES (${id});\nCOMMIT;`);
const standbyCount = (): string => {
  lab.sql(lab.dr, 'ALTER DATABASE RECOVER MANAGED STANDBY DATABASE CANCEL;');
  lab.sql(lab.dr, 'ALTER DATABASE OPEN READ ONLY;');
  return lab.sql(lab.dr, 'SELECT COUNT(*) AS n FROM t;');
};
const level = (): string => lab.sql(lab.prod, 'SELECT protection_mode, protection_level FROM v$database;');

describe('modes de protection Data Guard', () => {
  it('TEMOIN — par defaut la base est en MAXIMUM PERFORMANCE', () => {
    expect(level()).toContain('MAXIMUM PERFORMANCE');
  });

  it('MAXIMIZE AVAILABILITY exige une destination SYNC : ORA-16072', () => {
    destination('ASYNC');
    expect(lab.sql(lab.prod, 'ALTER DATABASE SET STANDBY DATABASE TO MAXIMIZE AVAILABILITY;')).toContain('ORA-16072');
  });

  it('avec une destination SYNC le mode se pose et se lit', () => {
    destination('SYNC AFFIRM');
    expect(lab.sql(lab.prod, 'ALTER DATABASE SET STANDBY DATABASE TO MAXIMIZE AVAILABILITY;')).toContain('Database altered.');
    expect(level()).toMatch(/MAXIMUM AVAILABILITY\s+MAXIMUM AVAILABILITY/);
  });

  it('un commit SYNC est sur la standby sans changement de journal', () => {
    destination('SYNC AFFIRM');
    commitRow(1);
    expect(standbyCount()).toMatch(/^\s*1\s*$/m);
  });

  it('le meme commit en ASYNC n est PAS sur la standby avant le journal suivant', () => {
    destination('ASYNC');
    commitRow(1);
    expect(standbyCount()).toMatch(/^\s*0\s*$/m);
  });

  it('MAXIMUM AVAILABILITY : standby arretee, le commit passe et le niveau devient RESYNCHRONIZATION', () => {
    destination('SYNC AFFIRM');
    lab.sql(lab.prod, 'ALTER DATABASE SET STANDBY DATABASE TO MAXIMIZE AVAILABILITY;');
    lab.sql(lab.dr, 'SHUTDOWN ABORT;');
    expect(commitRow(2)).not.toMatch(/ORA-03113|ORA-01034/);
    expect(level()).toContain('RESYNCHRONIZATION');
  });

  it('MAXIMUM PROTECTION : standby arretee, le primaire s arrete et le commit echoue', () => {
    destination('SYNC AFFIRM');
    lab.sql(lab.prod, 'SHUTDOWN IMMEDIATE;');
    lab.sql(lab.prod, 'STARTUP MOUNT;');
    expect(lab.sql(lab.prod, 'ALTER DATABASE SET STANDBY DATABASE TO MAXIMIZE PROTECTION;')).toContain('Database altered.');
    lab.sql(lab.prod, 'ALTER DATABASE OPEN;');
    lab.sql(lab.dr, 'SHUTDOWN ABORT;');
    expect(commitRow(3)).toContain('ORA-03113');
    expect(lab.sh(lab.prod, 'grep -c "MAXIMUM PROTECTION" /u01/app/oracle/diag/rdbms/orcl/ORCL/trace/alert_ORCL.log')).toMatch(/[1-9]/);
    expect(lab.sql(lab.prod, 'SELECT status FROM v$instance;')).toContain('SHUTDOWN');
  });
});
