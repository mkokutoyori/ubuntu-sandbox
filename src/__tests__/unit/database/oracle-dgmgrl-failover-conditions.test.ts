/*
 * Sonde — conditions de bascule configurables du fast-start failover. Source : pages ENABLE/DISABLE FAST_START FAILOVER CONDITION et SHOW FAST_START FAILOVER de la reference de la CLI du broker 19c
 * (docs.oracle.com, lue le jour du developpement) : `ENABLE FAST_START FAILOVER CONDITION value` prend un nom de condition de sante (entre guillemets) ou `240` (la page 26ai : « ORA-240 is the only Oracle error that can be named », affiche `ORA-240: control file enqueue held for more than %s seconds`) ;
 * `SHOW FAST_START FAILOVER` liste les conditions de sante (YES/NO) et les `Oracle Error Conditions`. Un nom inconnu est refuse par ORA-16524 (« unsupported command, option, or argument », releve sur un
 * transcript public). `Succeeded.` est la sortie de l'exemple 3 de ENABLE FAST_START FAILOVER CONDITION dans la reference 12.2. Les pages disent qu'une condition deja posee (ou retiree sans avoir ete posee) est une erreur mais n'en donnent pas le code : les deux commandes sont idempotentes.
 *
 * Evalue : une condition numerique est comparee aux lignes ORA-nnnnn que la primaire ecrit dans son journal d'alerte APRES l'activation ; a la sonde suivante l'observateur bascule sans attendre le seuil
 * (`Shutdown Primary: TRUE` : la primaire est arretee). Evalue aussi, par un verificateur de sante qui passe toutes les minutes (la page SHOW CONFIGURATION : « the health ... is evaluated once a minute ») et a chaque checkpoint : `Corrupted Controlfile` (un fichier de controle qui ne porte plus son en-tete a un checkpoint : ORA-00227 puis ORA-00202) et `Corrupted Dictionary` (le fichier de donnees SYSTEM ecrase : ORA-01578), titres des pages d'erreur, conditions actives par defaut ; le simulateur ne repare plus ces fichiers en silence ; `Inaccessible Logfile` (un COMMIT qui ne peut ecrire AUCUN membre du groupe courant, fichiers supprimes ou disque plein : ORA-00345 puis ORA-00312, titres des pages d'erreur) et `Datafile Write Errors` (un checkpoint dont l'ecriture des fichiers de donnees echoue, disque plein : ORA-01114, titre de la page d'erreur ; condition active par defaut, comme dans SHOW FAST_START FAILOVER) et `Stuck Archiver` (le journal archive ne peut pas s'ecrire, disque plein : ORA-19504 puis ORA-00257, titres des pages d'erreur). NON evalue, enregistre dans TODO.md : les autres conditions de sante nommees s'activent et se desactivent mais le moteur n'a pas d'evenement pour les detecter.
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
    expect(dgmgrl(lab.prod, 'SHOW FAST_START FAILOVER;')).toContain('    ORA-240: control file enqueue held for more than %s seconds');
    expect(dgmgrl(lab.prod, 'ENABLE FAST_START FAILOVER CONDITION 600;')).toContain('ORA-16524');
    dgmgrl(lab.prod, 'DISABLE FAST_START FAILOVER CONDITION 240;');
    expect(dgmgrl(lab.prod, 'SHOW FAST_START FAILOVER;')).not.toContain('ORA-240');
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
    vfs.setCapacityBytes(vfs.usedBytes() - 1);
  };

  const failDatafileWrite = (): void => {
    lab.sql(lab.prod, 'CREATE TABLE grown (id NUMBER);');
    fillProdDisk();
    lab.sql(lab.prod, 'INSERT INTO grown SELECT level FROM dual CONNECT BY level <= 200;\nCOMMIT;');
    lab.sql(lab.prod, 'ALTER SYSTEM CHECKPOINT;');
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
    dgmgrl(lab.prod, 'DISABLE FAST_START FAILOVER CONDITION "Datafile Write Errors";');
    fillProdDisk();
    lab.sql(lab.prod, 'ALTER SYSTEM SWITCH LOGFILE;');
    scheduler.advance(20000);
    expect(roleOf(lab.dr)).not.toContain('PRIMARY');
  });

  it('Datafile Write Errors (on by default): a checkpoint that cannot write the datafiles raises ORA-01114 and fails over', () => {
    observed();
    dgmgrl(lab.prod, 'DISABLE FAST_START FAILOVER CONDITION "Stuck Archiver";');
    failDatafileWrite();
    expect(getOracleDatabase(lab.prod.getId()).instance.getAlertLog().join('\n')).toMatch(/ORA-01114: IO error writing block to file \d+ \(block # 1\)/);
    scheduler.advance(6000);
    expect(roleOf(lab.dr)).toContain('PRIMARY');
  });

  it('the same checkpoint with Datafile Write Errors disabled does not fail over', () => {
    observed();
    dgmgrl(lab.prod, 'DISABLE FAST_START FAILOVER CONDITION "Datafile Write Errors";');
    failDatafileWrite();
    expect(getOracleDatabase(lab.prod.getId()).instance.getAlertLog().join('\n')).toContain('ORA-01114');
    scheduler.advance(20000);
    expect(roleOf(lab.dr)).not.toContain('PRIMARY');
  });

  const loseRedoLogs = (): void => {
    lab.sh(lab.prod, 'rm -f /u01/app/oracle/oradata/ORCL/redo*.log /u01/app/oracle/fast_recovery_area/ORCL/redo*.log');
    lab.sql(lab.prod, 'CREATE TABLE lost (id NUMBER);');
    lab.sql(lab.prod, 'INSERT INTO lost VALUES (1);\nCOMMIT;');
  };

  it('Inaccessible Logfile: a commit that cannot write any member of the current group raises ORA-00345 and fails over once enabled', () => {
    observed();
    dgmgrl(lab.prod, 'ENABLE FAST_START FAILOVER CONDITION "Inaccessible Logfile";');
    loseRedoLogs();
    expect(getOracleDatabase(lab.prod.getId()).instance.getAlertLog().join('\n')).toMatch(/ORA-00345: redo log write error block 1 count 1[\s\S]*ORA-00312: online log \d+ thread 1: '/);
    scheduler.advance(6000);
    expect(roleOf(lab.dr)).toContain('PRIMARY');
  });

  it('the same loss with the condition off (the default) raises the error but does not fail over', () => {
    observed();
    loseRedoLogs();
    expect(getOracleDatabase(lab.prod.getId()).instance.getAlertLog().join('\n')).toContain('ORA-00345');
    scheduler.advance(20000);
    expect(roleOf(lab.dr)).not.toContain('PRIMARY');
  });

  const corrupt = (file: string): void => {
    lab.sh(lab.prod, `echo garbage > ${file}`);
    lab.sql(lab.prod, 'ALTER SYSTEM CHECKPOINT;');
  };
  const alertOf = (): string => getOracleDatabase(lab.prod.getId()).instance.getAlertLog().join('\n');

  it('Corrupted Controlfile (on by default): a control file that is no longer a control file raises ORA-00227 and fails over', () => {
    observed();
    const path = getOracleDatabase(lab.prod.getId()).instance.getControlFilePaths()[0];
    corrupt(path);
    expect(alertOf()).toMatch(/ORA-00227: corrupt block detected in control file[\s\S]*ORA-00202: control file: '/);
    scheduler.advance(6000);
    expect(roleOf(lab.dr)).toContain('PRIMARY');
  });

  it('Corrupted Dictionary (on by default): a SYSTEM datafile that is overwritten raises ORA-01578 and fails over', () => {
    observed();
    corrupt('/u01/app/oracle/oradata/ORCL/system01.dbf');
    expect(alertOf()).toContain('ORA-01578: ORACLE data block corrupted (file # 1, block # 1)');
    scheduler.advance(6000);
    expect(roleOf(lab.dr)).toContain('PRIMARY');
  });

  it('the same corruption with its condition disabled raises the error but does not fail over', () => {
    observed();
    dgmgrl(lab.prod, 'DISABLE FAST_START FAILOVER CONDITION "Corrupted Dictionary";');
    corrupt('/u01/app/oracle/oradata/ORCL/system01.dbf');
    expect(alertOf()).toContain('ORA-01578');
    scheduler.advance(20000);
    expect(roleOf(lab.dr)).not.toContain('PRIMARY');
  });

  it('TEMOIN — an intact lab raises neither corruption error at a checkpoint', () => {
    observed();
    lab.sql(lab.prod, 'ALTER SYSTEM CHECKPOINT;');
    expect(alertOf()).not.toMatch(/ORA-00227|ORA-01578/);
    scheduler.advance(20000);
    expect(roleOf(lab.dr)).not.toContain('PRIMARY');
  });

  it('the health checker finds a corrupted control file once a minute, with no checkpoint to trigger it', () => {
    observed();
    const path = getOracleDatabase(lab.prod.getId()).instance.getControlFilePaths()[0];
    lab.sh(lab.prod, `echo garbage > ${path}`);
    scheduler.advance(30000);
    expect(alertOf()).not.toContain('ORA-00227');
    expect(roleOf(lab.dr)).not.toContain('PRIMARY');
    scheduler.advance(40000);
    expect(alertOf()).toContain('ORA-00227');
    expect(roleOf(lab.dr)).toContain('PRIMARY');
  });

  it('the health checker finds an overwritten SYSTEM datafile and reports it once, not at every pass', () => {
    observed();
    lab.sh(lab.prod, 'echo garbage > /u01/app/oracle/oradata/ORCL/system01.dbf');
    scheduler.advance(63000);
    expect(alertOf().match(/ORA-01578/g)?.length).toBe(1);
    expect(roleOf(lab.dr)).toContain('PRIMARY');
  });

  it('TEMOIN — the health checker leaves an intact database alone', () => {
    observed();
    scheduler.advance(180000);
    expect(alertOf()).not.toMatch(/ORA-00227|ORA-01578/);
    expect(roleOf(lab.dr)).not.toContain('PRIMARY');
  });
});
