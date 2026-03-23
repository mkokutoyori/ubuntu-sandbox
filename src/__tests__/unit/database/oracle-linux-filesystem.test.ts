/**
 * Integration tests — Oracle filesystem on Linux device.
 *
 * These tests create a real LinuxServer, initialize the Oracle filesystem,
 * and verify everything via shell commands (ls, cat, grep, find) exactly
 * as a real user would in the simulated terminal.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { LinuxPC } from '@/network/devices/LinuxPC';
import {
  initOracleFilesystem,
  getOracleDatabase,
  resetAllOracleInstances,
  syncAlertLogToDevice,
  updateSpfileOnDevice,
} from '@/terminal/commands/database';
import { ORACLE_CONFIG } from '@/terminal/commands/OracleConfig';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

const HOME = ORACLE_CONFIG.HOME;     // /u01/app/oracle/product/19c/dbhome_1
const BASE = ORACLE_CONFIG.BASE;     // /u01/app/oracle
const SID  = ORACLE_CONFIG.SID;      // ORCL

let server: LinuxServer;

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  resetAllOracleInstances();
  Logger.reset();
  server = new LinuxServer('linux-server', 'OracleDB1');
  initOracleFilesystem(server);
});

// ═══════════════════════════════════════════════════════════════════
// GROUP 1: Arborescence Oracle ($ORACLE_HOME)
// ═══════════════════════════════════════════════════════════════════

describe('Group 1: Oracle directory tree on Linux filesystem', () => {

  it('T01 — /u01/app/oracle directory tree exists', async () => {
    const output = await server.executeCommand(`ls /u01/app/oracle`);
    expect(output).toContain('product');
    expect(output).toContain('oradata');
    expect(output).toContain('diag');
    expect(output).toContain('admin');
  });

  it('T02 — $ORACLE_HOME/bin contains Oracle binaries', async () => {
    const output = await server.executeCommand(`ls ${HOME}/bin`);
    expect(output).toContain('sqlplus');
    expect(output).toContain('lsnrctl');
    expect(output).toContain('tnsping');
    expect(output).toContain('dbca');
    expect(output).toContain('orapwd');
    expect(output).toContain('rman');
    expect(output).toContain('expdp');
    expect(output).toContain('impdp');
    expect(output).toContain('adrci');
  });

  it('T03 — $ORACLE_HOME/dbs contains init, spfile and password file', async () => {
    const output = await server.executeCommand(`ls ${HOME}/dbs`);
    expect(output).toContain(`init${SID}.ora`);
    expect(output).toContain(`spfile${SID}.ora`);
    expect(output).toContain(`orapw${SID}`);
  });

  it('T04 — $ORACLE_HOME/network/admin contains TNS config files', async () => {
    const output = await server.executeCommand(`ls ${HOME}/network/admin`);
    expect(output).toContain('tnsnames.ora');
    expect(output).toContain('listener.ora');
    expect(output).toContain('sqlnet.ora');
  });

  it('T05 — $ORACLE_HOME/rdbms/admin contains admin scripts', async () => {
    const output = await server.executeCommand(`ls ${HOME}/rdbms/admin`);
    expect(output).toContain('catalog.sql');
    expect(output).toContain('catproc.sql');
    expect(output).toContain('utlrp.sql');
  });

  it('T06 — $ORACLE_HOME/lib contains Oracle shared libraries', async () => {
    const output = await server.executeCommand(`ls ${HOME}/lib`);
    expect(output).toContain('libclntsh.so');
    expect(output).toContain('libsqlplus.so');
  });

  it('T07 — oradata directory contains datafiles, redo logs and control files', async () => {
    const output = await server.executeCommand(`ls ${BASE}/oradata/${SID}`);
    expect(output).toContain('system01.dbf');
    expect(output).toContain('sysaux01.dbf');
    expect(output).toContain('undotbs01.dbf');
    expect(output).toContain('users01.dbf');
    expect(output).toContain('temp01.dbf');
    expect(output).toContain('redo01.log');
    expect(output).toContain('redo02.log');
    expect(output).toContain('redo03.log');
    expect(output).toContain('control01.ctl');
    expect(output).toContain('control02.ctl');
  });

  it('T08 — admin dump directories exist', async () => {
    const adump = await server.executeCommand(`test -d ${BASE}/admin/${SID}/adump && echo yes`);
    const bdump = await server.executeCommand(`test -d ${BASE}/admin/${SID}/bdump && echo yes`);
    const cdump = await server.executeCommand(`test -d ${BASE}/admin/${SID}/cdump && echo yes`);
    const udump = await server.executeCommand(`test -d ${BASE}/admin/${SID}/udump && echo yes`);
    expect(adump.trim()).toBe('yes');
    expect(bdump.trim()).toBe('yes');
    expect(cdump.trim()).toBe('yes');
    expect(udump.trim()).toBe('yes');
  });

  it('T09 — archivelog and fast_recovery_area directories exist', async () => {
    const arch = await server.executeCommand(`test -d ${BASE}/archivelog && echo yes`);
    const fra = await server.executeCommand(`test -d ${BASE}/fast_recovery_area && echo yes`);
    expect(arch.trim()).toBe('yes');
    expect(fra.trim()).toBe('yes');
  });
});

// ═══════════════════════════════════════════════════════════════════
// GROUP 2: Contenu des fichiers de configuration (cat)
// ═══════════════════════════════════════════════════════════════════

describe('Group 2: Configuration file contents via cat', () => {

  it('T10 — cat initORCL.ora shows all critical parameters', async () => {
    const content = await server.executeCommand(`cat ${HOME}/dbs/init${SID}.ora`);
    expect(content).toContain('db_name');
    expect(content).toContain(SID);
    expect(content).toContain('db_block_size');
    expect(content).toContain('8192');
    expect(content).toContain('sga_target');
    expect(content).toContain('processes');
    expect(content).toContain('300');
    expect(content).toContain('undo_management');
    expect(content).toContain('AUTO');
    expect(content).toContain('compatible');
    expect(content).toContain('19.0.0');
    expect(content).toContain('control_files');
    expect(content).toContain('control01.ctl');
    expect(content).toContain('log_archive_dest_1');
    expect(content).toContain('db_recovery_file_dest');
    expect(content).toContain('audit_file_dest');
    expect(content).toContain('audit_trail');
  });

  it('T11 — cat spfileORCL.ora shows *.param=value format', async () => {
    const content = await server.executeCommand(`cat ${HOME}/dbs/spfile${SID}.ora`);
    expect(content).toContain(`*.db_name='${SID}'`);
    expect(content).toContain('*.db_block_size=8192');
    expect(content).toContain('*.sga_target=');
    expect(content).toContain('*.processes=300');
    expect(content).toContain('*.compatible=');
  });

  it('T12 — cat tnsnames.ora shows ORCL and ORCLPDB entries', async () => {
    const content = await server.executeCommand(`cat ${HOME}/network/admin/tnsnames.ora`);
    // ORCL entry
    expect(content).toContain('ORCL =');
    expect(content).toContain('SERVICE_NAME = ORCL');
    expect(content).toContain('1521');
    expect(content).toContain('DEDICATED');
    // ORCLPDB entry
    expect(content).toContain('ORCLPDB =');
    expect(content).toContain('SERVICE_NAME = ORCLPDB');
  });

  it('T13 — cat listener.ora shows listener configuration', async () => {
    const content = await server.executeCommand(`cat ${HOME}/network/admin/listener.ora`);
    expect(content).toContain('LISTENER =');
    expect(content).toContain('0.0.0.0');
    expect(content).toContain('1521');
    expect(content).toContain('SID_LIST_LISTENER');
    expect(content).toContain(`GLOBAL_DBNAME = ${SID}`);
    expect(content).toContain(`SID_NAME = ${SID}`);
    expect(content).toContain('ADR_BASE_LISTENER');
  });

  it('T14 — cat sqlnet.ora shows network settings', async () => {
    const content = await server.executeCommand(`cat ${HOME}/network/admin/sqlnet.ora`);
    expect(content).toContain('NAMES.DIRECTORY_PATH');
    expect(content).toContain('TNSNAMES');
    expect(content).toContain('SQLNET.AUTHENTICATION_SERVICES');
    expect(content).toContain('SQLNET.EXPIRE_TIME');
  });

  it('T15 — cat /etc/oratab shows Oracle SID registration', async () => {
    const content = await server.executeCommand('cat /etc/oratab');
    expect(content).toContain(`${SID}:${HOME}:Y`);
  });

  it('T16 — cat /etc/profile.d/oracle.sh shows environment variables', async () => {
    const content = await server.executeCommand('cat /etc/profile.d/oracle.sh');
    expect(content).toContain(`ORACLE_HOME=${HOME}`);
    expect(content).toContain(`ORACLE_SID=${SID}`);
    expect(content).toContain(`ORACLE_BASE=${BASE}`);
    expect(content).toContain('PATH=$ORACLE_HOME/bin');
    expect(content).toContain('LD_LIBRARY_PATH=$ORACLE_HOME/lib');
    expect(content).toContain('TNS_ADMIN=$ORACLE_HOME/network/admin');
  });

  it('T17 — cat alert_ORCL.log shows startup trace', async () => {
    const alertPath = `${BASE}/diag/rdbms/orcl/${SID}/trace/alert_${SID}.log`;
    const content = await server.executeCommand(`cat ${alertPath}`);
    expect(content).toContain('Starting ORACLE instance');
    expect(content).toContain('redo');
    expect(content).toContain('AL32UTF8');
    expect(content).toContain(`Database ${SID} opened`);
  });
});

// ═══════════════════════════════════════════════════════════════════
// GROUP 3: Recherche de fichiers (find, grep)
// ═══════════════════════════════════════════════════════════════════

describe('Group 3: File search with find and grep', () => {

  it('T18 — find all .ora files under ORACLE_HOME', async () => {
    const output = await server.executeCommand(`find ${HOME} -name "*.ora"`);
    expect(output).toContain('initORCL.ora');
    expect(output).toContain('spfileORCL.ora');
    expect(output).toContain('tnsnames.ora');
    expect(output).toContain('listener.ora');
    expect(output).toContain('sqlnet.ora');
  });

  it('T19 — find all .dbf datafiles under oradata', async () => {
    const output = await server.executeCommand(`find ${BASE}/oradata -name "*.dbf"`);
    expect(output).toContain('system01.dbf');
    expect(output).toContain('sysaux01.dbf');
    expect(output).toContain('users01.dbf');
    expect(output).toContain('undotbs01.dbf');
    expect(output).toContain('temp01.dbf');
  });

  it('T20 — find all .log redo log files', async () => {
    const output = await server.executeCommand(`find ${BASE}/oradata -name "*.log"`);
    expect(output).toContain('redo01.log');
    expect(output).toContain('redo02.log');
    expect(output).toContain('redo03.log');
  });

  it('T21 — find all .ctl control files', async () => {
    const output = await server.executeCommand(`find ${BASE}/oradata -name "*.ctl"`);
    expect(output).toContain('control01.ctl');
    expect(output).toContain('control02.ctl');
  });

  it('T22 — find SQL admin scripts under rdbms/admin', async () => {
    const output = await server.executeCommand(`find ${HOME}/rdbms -name "*.sql"`);
    expect(output).toContain('catalog.sql');
    expect(output).toContain('catproc.sql');
    expect(output).toContain('utlrp.sql');
  });

  it('T23 — grep db_name in initORCL.ora returns matching line', async () => {
    const output = await server.executeCommand(`grep db_name ${HOME}/dbs/init${SID}.ora`);
    expect(output).toContain('db_name');
    expect(output).toContain(SID);
  });

  it('T24 — grep ORCL in tnsnames.ora', async () => {
    const output = await server.executeCommand(`grep ORCL ${HOME}/network/admin/tnsnames.ora`);
    expect(output).toContain('ORCL');
  });
});

// ═══════════════════════════════════════════════════════════════════
// GROUP 4: Synchronisation dynamique (alert log, spfile)
// ═══════════════════════════════════════════════════════════════════

describe('Group 4: Dynamic state synchronization to VFS', () => {

  it('T25 — alert log updates on VFS after shutdown/startup cycle', async () => {
    const db = getOracleDatabase(server.getId());
    const alertPath = `${BASE}/diag/rdbms/orcl/${SID}/trace/alert_${SID}.log`;

    // Shutdown instance
    db.instance.shutdown('IMMEDIATE');
    syncAlertLogToDevice(server, db.instance.getAlertLog());

    const afterShutdown = await server.executeCommand(`cat ${alertPath}`);
    expect(afterShutdown).toContain('Shutting down');
    expect(afterShutdown).toContain('shut down');

    // Restart
    db.instance.startup();
    syncAlertLogToDevice(server, db.instance.getAlertLog());

    const afterRestart = await server.executeCommand(`cat ${alertPath}`);
    // Should contain both shutdown and new startup entries
    expect(afterRestart).toContain('Shutting down');
    expect(afterRestart).toContain('Starting ORACLE instance');
  });

  it('T26 — spfile updates on VFS after ALTER SYSTEM SET', async () => {
    const db = getOracleDatabase(server.getId());
    const spfilePath = `${HOME}/dbs/spfile${SID}.ora`;

    // Modify parameter
    db.instance.setParameter('open_cursors', '999', 'BOTH');
    updateSpfileOnDevice(server, db.instance.getSpfileParameters());

    const content = await server.executeCommand(`cat ${spfilePath}`);
    expect(content).toContain('999');
  });

  it('T27 — alert log records log switch event', async () => {
    const db = getOracleDatabase(server.getId());
    const alertPath = `${BASE}/diag/rdbms/orcl/${SID}/trace/alert_${SID}.log`;

    db.instance.switchLogfile();
    syncAlertLogToDevice(server, db.instance.getAlertLog());

    const content = await server.executeCommand(`cat ${alertPath}`);
    expect(content).toContain('advanced to log sequence');
  });
});

// ═══════════════════════════════════════════════════════════════════
// GROUP 5: Lecture des fichiers admin scripts
// ═══════════════════════════════════════════════════════════════════

describe('Group 5: Admin script contents', () => {

  it('T28 — catalog.sql contains data dictionary comment', async () => {
    const content = await server.executeCommand(`cat ${HOME}/rdbms/admin/catalog.sql`);
    expect(content).toContain('catalog.sql');
    expect(content).toContain('data dictionary');
    expect(content).toContain('AS SYSDBA');
  });

  it('T29 — catproc.sql contains PL/SQL packages comment', async () => {
    const content = await server.executeCommand(`cat ${HOME}/rdbms/admin/catproc.sql`);
    expect(content).toContain('catproc.sql');
    expect(content).toContain('PL/SQL');
    expect(content).toContain('AS SYSDBA');
  });

  it('T30 — utlrp.sql contains recompile comment', async () => {
    const content = await server.executeCommand(`cat ${HOME}/rdbms/admin/utlrp.sql`);
    expect(content).toContain('utlrp.sql');
    expect(content).toContain('invalid');
  });

  it('T31 — orapwORCL password file exists and has expected format', async () => {
    const content = await server.executeCommand(`cat ${HOME}/dbs/orapw${SID}`);
    expect(content).toContain('password file');
    expect(content).toContain('SYS');
  });
});

// ═══════════════════════════════════════════════════════════════════
// GROUP 6: Idempotence et isolation multi-devices
// ═══════════════════════════════════════════════════════════════════

describe('Group 6: Idempotence and multi-device isolation', () => {

  it('T32 — calling initOracleFilesystem twice does not break anything', async () => {
    // Already initialized in beforeEach, call again
    initOracleFilesystem(server);

    const output = await server.executeCommand(`ls ${HOME}/dbs`);
    expect(output).toContain(`init${SID}.ora`);

    const content = await server.executeCommand(`cat ${HOME}/dbs/init${SID}.ora`);
    expect(content).toContain('db_name');
  });

  it('T33 — a LinuxPC also gets Oracle filesystem after init', async () => {
    const pc = new LinuxPC('linux-pc', 'DevPC');
    initOracleFilesystem(pc);

    const output = await pc.executeCommand(`cat /etc/oratab`);
    expect(output).toContain(`${SID}:${HOME}:Y`);

    const initOra = await pc.executeCommand(`cat ${HOME}/dbs/init${SID}.ora`);
    expect(initOra).toContain('db_name');
    expect(initOra).toContain(SID);
  });

  it('T34 — two servers have independent Oracle filesystems', async () => {
    const server2 = new LinuxServer('linux-server', 'OracleDB2');
    initOracleFilesystem(server2);

    // Both should have Oracle files
    const s1 = await server.executeCommand(`cat /etc/oratab`);
    const s2 = await server2.executeCommand(`cat /etc/oratab`);
    expect(s1).toContain(SID);
    expect(s2).toContain(SID);

    // Write a custom file on server1 only
    await server.executeCommand(`echo "custom" > /tmp/oracle_marker`);
    const s1marker = await server.executeCommand(`cat /tmp/oracle_marker`);
    const s2marker = await server2.executeCommand(`cat /tmp/oracle_marker`);
    expect(s1marker.trim()).toBe('custom');
    // server2 should NOT have this file
    expect(s2marker).not.toContain('custom');
  });
});

// ═══════════════════════════════════════════════════════════════════
// GROUP 7: Datafile stub content
// ═══════════════════════════════════════════════════════════════════

describe('Group 7: Datafile and redo log stub content', () => {

  it('T35 — system01.dbf stub identifies as SYSTEM tablespace', async () => {
    const content = await server.executeCommand(`cat ${BASE}/oradata/${SID}/system01.dbf`);
    expect(content).toContain('SYSTEM');
    expect(content).toContain('DATAFILE');
  });

  it('T36 — redo01.log stub identifies as redo log group 1', async () => {
    const content = await server.executeCommand(`cat ${BASE}/oradata/${SID}/redo01.log`);
    expect(content).toContain('REDO LOG');
    expect(content).toContain('Group 1');
  });

  it('T37 — control01.ctl stub identifies as control file', async () => {
    const content = await server.executeCommand(`cat ${BASE}/oradata/${SID}/control01.ctl`);
    expect(content).toContain('CONTROL FILE');
  });

  it('T38 — temp01.dbf stub identifies as TEMP tablespace', async () => {
    const content = await server.executeCommand(`cat ${BASE}/oradata/${SID}/temp01.dbf`);
    expect(content).toContain('TEMP');
  });
});

// ═══════════════════════════════════════════════════════════════════
// GROUP 8: Cohérence paramètres fichier ↔ instance
// ═══════════════════════════════════════════════════════════════════

describe('Group 8: File content ↔ instance parameter consistency', () => {

  it('T39 — initORCL.ora db_name matches instance parameter', async () => {
    const db = getOracleDatabase(server.getId());
    const fileContent = await server.executeCommand(`grep db_name ${HOME}/dbs/init${SID}.ora`);
    expect(fileContent).toContain(SID);
    expect(db.instance.getParameter('db_name')).toBe(SID);
  });

  it('T40 — initORCL.ora processes matches instance parameter', async () => {
    const db = getOracleDatabase(server.getId());
    const fileContent = await server.executeCommand(`grep processes ${HOME}/dbs/init${SID}.ora`);
    expect(fileContent).toContain('300');
    expect(db.instance.getParameter('processes')).toBe('300');
  });

  it('T41 — tnsnames.ora port matches ORACLE_CONFIG.PORT', async () => {
    const fileContent = await server.executeCommand(`cat ${HOME}/network/admin/tnsnames.ora`);
    expect(fileContent).toContain(String(ORACLE_CONFIG.PORT));
  });

  it('T42 — listener.ora ORACLE_HOME matches ORACLE_CONFIG.HOME', async () => {
    const fileContent = await server.executeCommand(`cat ${HOME}/network/admin/listener.ora`);
    expect(fileContent).toContain(HOME);
  });
});
