/*
 * Sonde — conditions de bascule configurables du fast-start failover. Source : pages ENABLE/DISABLE FAST_START FAILOVER CONDITION et SHOW FAST_START FAILOVER de la reference de la CLI du broker 19c
 * (docs.oracle.com, lue le jour du developpement) : `ENABLE FAST_START FAILOVER CONDITION value` prend un nom de condition de sante (entre guillemets) ou un numero d'erreur Oracle (`240` pour ORA-00240) ;
 * `SHOW FAST_START FAILOVER` liste les conditions de sante (YES/NO) et les `Oracle Error Conditions`. Un nom inconnu est refuse par ORA-16524 (« unsupported command, option, or argument », releve sur un
 * transcript public). Les pages ne donnent ni le texte de sortie de ENABLE/DISABLE CONDITION (le simulateur dit `Succeeded.`) ni le code d'une condition deja posee : les deux commandes sont idempotentes.
 *
 * Evalue : une condition numerique est comparee aux lignes ORA-nnnnn que la primaire ecrit dans son journal d'alerte APRES l'activation ; a la sonde suivante l'observateur bascule sans attendre le seuil
 * (`Shutdown Primary: TRUE` : la primaire est arretee). Evalue aussi : `Stuck Archiver` (le journal archive ne peut pas s'ecrire, disque plein : ORA-19504 puis ORA-00257, titres des pages d'erreur). NON evalue, enregistre dans TODO.md : les autres conditions de sante nommees s'activent et se desactivent mais le moteur n'a pas d'evenement pour les detecter.
 *
 * SHOW CONFIGURATION VERBOSE (page SHOW CONFIGURATION, exemple 2) : cible FSFO marquee `(*)`, liste `Properties:` puis resume du FSFO ; le mot etait accepte et ignore.
 *
 * Discrimine par `git stash push -- src/terminal src/database src/adapters` : 3 des 5 premiers cas tombent sans les conditions, et les 2 derniers (VERBOSE) tombent sans la forme detaillee ; sur 7 ; passent avant comme apres le temoin (une erreur NON listee ne bascule pas) et le cas structurel (une erreur ecrite AVANT l'activation ne compte pas, rien ne bascule dans les deux etats).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { getOracleDatabase, resetAllOracleInstances } from '@/terminal/commands/database';
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

const observed = (): void => {
  configured();
  dgmgrl(lab.prod, 'ENABLE FAST_START FAILOVER;');
  dgmgrl(lab.prod, 'START OBSERVER obs1;');
  scheduler.advance(6000);
};

const raise = (code: string): void => {
  getOracleDatabase(lab.prod.getId()).instance.logAlertEvent(`Errors in file lab_ckpt.trc:\n${code}: raised by the test`);
};

describe('configurable fast-start failover conditions', () => {
  it('SHOW FAST_START FAILOVER lists the Oracle error conditions that were enabled', () => {
    configured();
    dgmgrl(lab.prod, 'ENABLE FAST_START FAILOVER;');
    expect(dgmgrl(lab.prod, 'SHOW FAST_START FAILOVER;')).toContain('Oracle Error Conditions:\n    (none)');
    expect(dgmgrl(lab.prod, 'ENABLE FAST_START FAILOVER CONDITION 240;')).toContain('Succeeded.');
    expect(dgmgrl(lab.prod, 'SHOW FAST_START FAILOVER;')).toContain('    ORA-00240');
    dgmgrl(lab.prod, 'DISABLE FAST_START FAILOVER CONDITION 240;');
    expect(dgmgrl(lab.prod, 'SHOW FAST_START FAILOVER;')).not.toContain('ORA-00240');
  });

  it('a health condition is switched on and off and an unknown name is refused', () => {
    configured();
    dgmgrl(lab.prod, 'ENABLE FAST_START FAILOVER;');
    dgmgrl(lab.prod, 'ENABLE FAST_START FAILOVER CONDITION "Stuck Archiver";');
    expect(dgmgrl(lab.prod, 'SHOW FAST_START FAILOVER;')).toMatch(/Stuck Archiver\s+YES/);
    dgmgrl(lab.prod, 'DISABLE FAST_START FAILOVER CONDITION "Corrupted Controlfile";');
    expect(dgmgrl(lab.prod, 'SHOW FAST_START FAILOVER;')).toMatch(/Corrupted Controlfile\s+NO/);
    expect(dgmgrl(lab.prod, 'ENABLE FAST_START FAILOVER CONDITION "Nonsense";')).toContain('ORA-16524');
  });

  it('an enabled error in the primary alert log fails over at once, without waiting for the threshold', () => {
    observed();
    dgmgrl(lab.prod, 'ENABLE FAST_START FAILOVER CONDITION 240;');
    raise('ORA-00240');
    scheduler.advance(6000);
    expect(roleOf(lab.dr)).toContain('PRIMARY');
  });

  it('TEMOIN — an error that is not listed does not fail over', () => {
    observed();
    dgmgrl(lab.prod, 'ENABLE FAST_START FAILOVER CONDITION 240;');
    raise('ORA-00600');
    scheduler.advance(20000);
    expect(roleOf(lab.dr)).not.toContain('PRIMARY');
    expect(roleOf(lab.prod)).toContain('PRIMARY');
  });

  it('an error written before the condition was enabled does not count', () => {
    observed();
    raise('ORA-00240');
    dgmgrl(lab.prod, 'ENABLE FAST_START FAILOVER CONDITION 240;');
    scheduler.advance(20000);
    expect(roleOf(lab.dr)).not.toContain('PRIMARY');
  });

  it('SHOW CONFIGURATION VERBOSE adds the properties, the target mark and the fast-start failover summary', () => {
    configured();
    dgmgrl(lab.prod, 'ENABLE FAST_START FAILOVER;', 'EDIT CONFIGURATION SET PROPERTY FastStartFailoverThreshold=90;');
    const plain = dgmgrl(lab.prod, 'SHOW CONFIGURATION;');
    const verbose = dgmgrl(lab.prod, 'SHOW CONFIGURATION VERBOSE;');
    expect(plain).not.toContain('Properties:');
    expect(verbose).toMatch(/ORCL_STB - \(\*\) Physical standby database/);
    expect(verbose).toContain('(*) Fast-Start Failover target');
    expect(verbose).toMatch(/FastStartFailoverThreshold\s+= '90'/);
    expect(verbose).toMatch(/ConfigurationWideServiceName\s+= 'ORCL_CFG'/);
    expect(verbose).toMatch(/Threshold:\s+90 seconds/);
    expect(verbose).toMatch(/Active Target:\s+ORCL_STB/);
    expect(verbose.indexOf('Properties:')).toBeLessThan(verbose.indexOf('Fast-Start Failover: Enabled'));
  });

  it('VERBOSE without fast-start failover shows the properties and DISABLED', () => {
    configured();
    const verbose = dgmgrl(lab.prod, 'SHOW CONFIGURATION VERBOSE;');
    expect(verbose).toContain('Properties:');
    expect(verbose).toContain('Fast-Start Failover: DISABLED');
    expect(verbose).not.toContain('(*)');
  });

  const fillProdDisk = (): void => {
    const vfs = (lab.prod as unknown as { executor: { vfs: { setCapacityBytes(n: number): void; usedBytes(): number } } }).executor.vfs;
    vfs.setCapacityBytes(vfs.usedBytes() + 10);
  };

  it('Stuck Archiver: a full archive disk writes the archiver errors and fails over once the condition is enabled', () => {
    observed();
    dgmgrl(lab.prod, 'ENABLE FAST_START FAILOVER CONDITION "Stuck Archiver";');
    fillProdDisk();
    lab.sql(lab.prod, 'ALTER SYSTEM SWITCH LOGFILE;');
    expect(getOracleDatabase(lab.prod.getId()).instance.getAlertLog().join('\n')).toMatch(/ORA-19504: failed to create file[\s\S]*ORA-00257: Archiver error/);
    scheduler.advance(6000);
    expect(roleOf(lab.dr)).toContain('PRIMARY');
  });

  it('a full archive disk alone, with the condition off (the default), does not fail over', () => {
    observed();
    fillProdDisk();
    lab.sql(lab.prod, 'ALTER SYSTEM SWITCH LOGFILE;');
    scheduler.advance(20000);
    expect(roleOf(lab.dr)).not.toContain('PRIMARY');
  });
});
