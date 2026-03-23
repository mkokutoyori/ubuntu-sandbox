/**
 * OracleCommands — Single-shot Oracle CLI tool handlers.
 *
 * Extracts lsnrctl and tnsping logic from LinuxTerminalSession
 * so the session class doesn't need to know about Oracle internals.
 */

import type { Equipment } from '@/network';
import { getOracleDatabase, initOracleFilesystem } from './database';
import { ORACLE_CONFIG, ORACLE_BANNER, TNS_ERRORS } from './OracleConfig';

/** Callback to append a line to the terminal. */
type OutputFn = (text: string, type?: string) => void;

/**
 * Handle `lsnrctl <subcommand>` — Oracle Listener Control.
 */
export function handleLsnrctl(
  device: Equipment,
  args: string[],
  addLine: OutputFn,
): void {
  initOracleFilesystem(device);
  const deviceId = device.getId();
  const db = getOracleDatabase(deviceId);
  const subcommand = (args[0] || '').toUpperCase();
  const hostname = device.getHostname();

  addLine('');
  addLine(`${ORACLE_BANNER.LSNRCTL_HEADER} on ${new Date().toDateString()}`);
  addLine('');
  addLine(ORACLE_BANNER.COPYRIGHT);
  addLine('');

  switch (subcommand) {
    case 'START': {
      db.instance.startListener();
      addLine(`Starting ${ORACLE_CONFIG.HOME}/bin/tnslsnr: please wait...`);
      addLine('');
      addLine(`TNSLSNR for Linux: Version ${ORACLE_CONFIG.VERSION}.0.0.0 - Production`);
      addLine(`Log messages written to ${ORACLE_CONFIG.BASE}/diag/tnslsnr/${hostname}/listener/alert/log.xml`);
      addLine(`Listening on: (DESCRIPTION=(ADDRESS=(PROTOCOL=tcp)(HOST=0.0.0.0)(PORT=${ORACLE_CONFIG.PORT})))`);
      addLine('');
      addLine(`Connecting to (DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=0.0.0.0)(PORT=${ORACLE_CONFIG.PORT})))`);
      addLine('STATUS of the LISTENER');
      addLine('------------------------');
      addLine('Alias                     LISTENER');
      addLine(`Version                   TNSLSNR for Linux: Version ${ORACLE_CONFIG.VERSION}.0.0.0 - Production`);
      addLine('Start Date                ' + new Date().toLocaleString());
      addLine('Uptime                    0 days 0 hr. 0 min. 0 sec');
      addLine('Trace Level               off');
      addLine('Security                  ON: Local OS Authentication');
      addLine('SNMP                      OFF');
      addLine(`Listener Log File         ${ORACLE_CONFIG.BASE}/diag/tnslsnr/${hostname}/listener/alert/log.xml`);
      addLine('Listening Endpoints Summary...');
      addLine(`  (DESCRIPTION=(ADDRESS=(PROTOCOL=tcp)(HOST=0.0.0.0)(PORT=${ORACLE_CONFIG.PORT})))`);
      addLine('The command completed successfully');
      break;
    }
    case 'STOP': {
      db.instance.stopListener();
      addLine(`Connecting to (DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=0.0.0.0)(PORT=${ORACLE_CONFIG.PORT})))`);
      addLine('The command completed successfully');
      break;
    }
    case 'STATUS': {
      const status = db.instance.getListenerStatus();
      addLine(`Connecting to (DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=0.0.0.0)(PORT=${ORACLE_CONFIG.PORT})))`);
      if (status.running) {
        addLine('STATUS of the LISTENER');
        addLine('------------------------');
        addLine('Alias                     LISTENER');
        addLine(`Version                   TNSLSNR for Linux: Version ${ORACLE_CONFIG.VERSION}.0.0.0 - Production`);
        addLine('Start Date                ' + (status.startedAt ? new Date(status.startedAt).toLocaleString() : 'N/A'));
        addLine('Trace Level               off');
        addLine('Security                  ON: Local OS Authentication');
        addLine('SNMP                      OFF');
        addLine('Listening Endpoints Summary...');
        addLine(`  (DESCRIPTION=(ADDRESS=(PROTOCOL=tcp)(HOST=0.0.0.0)(PORT=${ORACLE_CONFIG.PORT})))`);
        addLine('Services Summary...');
        addLine(`  Service "${db.getSid()}" has 1 instance(s).`);
        addLine(`    Instance "${db.getSid()}", status READY, has 1 handler(s) for this service...`);
        addLine('The command completed successfully');
      } else {
        addLine(TNS_ERRORS.TNS_12541);
        addLine(` ${TNS_ERRORS.TNS_12560}`);
        addLine(`  ${TNS_ERRORS.TNS_00511}`);
      }
      break;
    }
    case 'SERVICES': {
      const status = db.instance.getListenerStatus();
      addLine(`Connecting to (DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=0.0.0.0)(PORT=${ORACLE_CONFIG.PORT})))`);
      if (status.running) {
        addLine('Services Summary...');
        addLine(`  Service "${db.getSid()}" has 1 instance(s).`);
        addLine(`    Instance "${db.getSid()}", status READY, has 1 handler(s) for this service...`);
        addLine('      Handler(s):');
        addLine('        "DEDICATED" established:0 refused:0 state:ready');
        addLine('           LOCAL SERVER');
        addLine('The command completed successfully');
      } else {
        addLine(TNS_ERRORS.TNS_12541);
      }
      break;
    }
    case 'RELOAD': {
      addLine(`Connecting to (DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=0.0.0.0)(PORT=${ORACLE_CONFIG.PORT})))`);
      addLine('The command completed successfully');
      break;
    }
    default: {
      if (!subcommand) {
        addLine('The following operations are available');
        addLine('An asterisk (*) denotes a modifier or extended command:');
        addLine('');
        addLine('start             stop              status');
        addLine('services          reload            version');
        addLine('');
      } else {
        addLine(`LSNRCTL-00112: Unknown command "${subcommand}"`);
      }
      break;
    }
  }
}

/**
 * Handle `dbca` — Database Configuration Assistant (simplified stub).
 */
export function handleDbca(
  _device: Equipment,
  args: string[],
  addLine: OutputFn,
): void {
  addLine('');
  addLine('Oracle Database Configuration Assistant (DBCA)');
  addLine(`Release ${ORACLE_CONFIG.VERSION}.0.0.0 - Production`);
  addLine('');
  addLine(ORACLE_BANNER.COPYRIGHT);
  addLine('');

  if (args.length === 0) {
    addLine('Usage: dbca [-silent] [-createDatabase] [-deleteDatabase] [-configureDatabase]');
    addLine('');
    addLine('Options:');
    addLine('  -silent                    Run in silent (non-interactive) mode');
    addLine('  -createDatabase            Create a new database');
    addLine('  -deleteDatabase            Delete an existing database');
    addLine('  -configureDatabase         Configure an existing database');
    addLine('  -responseFile <file>       Use response file');
    addLine('');
    addLine('Note: This is a simulated environment. DBCA operations are not supported.');
    return;
  }

  const subcmd = args[0]?.toLowerCase();
  if (subcmd === '-silent' || subcmd === '-createdatabase' || subcmd === '-deletedatabase') {
    addLine(`[WARNING] DBCA operations are simulated. No actual database changes will be made.`);
    addLine('');
    addLine('100% complete');
    addLine('Database operation completed successfully.');
  } else {
    addLine(`DBCA-00100: Unknown option: ${args[0]}`);
  }
}

/**
 * Handle `orapwd` — Oracle Password File Utility (stub).
 */
export function handleOrapwd(
  _device: Equipment,
  args: string[],
  addLine: OutputFn,
): void {
  addLine('');
  if (args.length === 0) {
    addLine('Usage: orapwd file=<fname> password=<password> [entries=<users>] [force=<y/n>]');
    addLine('');
    addLine('  file     - name of password file (required)');
    addLine('  password - password for SYS (required)');
    addLine('  entries  - maximum number of distinct DBA users');
    addLine('  force    - whether to overwrite existing file (y/n)');
    return;
  }

  // Parse file= and password= from args
  const joined = args.join(' ');
  const fileMatch = joined.match(/file=(\S+)/i);
  const passMatch = joined.match(/password=(\S+)/i);

  if (!fileMatch || !passMatch) {
    addLine('OPW-00001: Unable to open password file');
    addLine('Usage: orapwd file=<fname> password=<password>');
    return;
  }

  addLine(`Password file "${fileMatch[1]}" created successfully.`);
}

/**
 * Handle `adrci` — Automatic Diagnostic Repository Command Interpreter (stub).
 */
export function handleAdrci(
  _device: Equipment,
  args: string[],
  addLine: OutputFn,
): void {
  addLine('');
  addLine('ADRCI: Release 19.0.0.0.0 - Production');
  addLine('');
  addLine(ORACLE_BANNER.COPYRIGHT);
  addLine('');

  if (args.length === 0) {
    addLine('adrci> This is a simulated ADRCI environment.');
    addLine('adrci> Available commands: SHOW HOMES, SHOW ALERT, SHOW INCIDENT, EXIT');
    addLine('');
    return;
  }

  const subcmd = args.join(' ').toUpperCase();
  if (subcmd.includes('SHOW HOMES') || subcmd.includes('SHOW HOME')) {
    addLine('ADR Homes:');
    addLine(`  diag/rdbms/orcl/ORCL`);
  } else if (subcmd.includes('SHOW ALERT')) {
    addLine('ADR Home = /u01/app/oracle/diag/rdbms/orcl/ORCL:');
    addLine('');
    addLine('No alert log entries found in simulated environment.');
  } else if (subcmd.includes('SHOW INCIDENT')) {
    addLine('ADR Home = /u01/app/oracle/diag/rdbms/orcl/ORCL:');
    addLine('');
    addLine('0 incidents found.');
  } else {
    addLine(`DIA-48415: Syntax error found in string [${args.join(' ')}]`);
  }
}

/**
 * Handle `tnsping <service>` — Oracle TNS connectivity test.
 */
export function handleTnsping(
  device: Equipment,
  args: string[],
  addLine: OutputFn,
): void {
  initOracleFilesystem(device);
  const deviceId = device.getId();
  const db = getOracleDatabase(deviceId);
  const serviceName = args[0] || '';

  addLine('');
  addLine(`${ORACLE_BANNER.TNSPING_HEADER} on ${new Date().toDateString()}`);
  addLine('');
  addLine(ORACLE_BANNER.COPYRIGHT);
  addLine('');
  addLine('Used parameter files:');
  addLine(`${ORACLE_CONFIG.HOME}/network/admin/sqlnet.ora`);
  addLine('');

  if (!serviceName) {
    addLine(TNS_ERRORS.TNS_03505);
    return;
  }

  const upper = serviceName.toUpperCase();
  const status = db.instance.getListenerStatus();

  if (upper === db.getSid().toUpperCase() || upper === db.getServiceName().toUpperCase() || upper === 'LOCALHOST') {
    const connectDesc = `(DESCRIPTION = (ADDRESS = (PROTOCOL = TCP)(HOST = localhost)(PORT = ${ORACLE_CONFIG.PORT})) (CONNECT_DATA = (SERVER = DEDICATED) (SERVICE_NAME = ${db.getServiceName()})))`;
    if (status.running) {
      addLine('Used TNSNAMES adapter to resolve the alias');
      addLine(`Attempting to contact ${connectDesc}`);
      const latency = Math.floor(Math.random() * 5) + 1;
      addLine(`OK (${latency} msec)`);
    } else {
      addLine('Used TNSNAMES adapter to resolve the alias');
      addLine(`Attempting to contact ${connectDesc}`);
      addLine(TNS_ERRORS.TNS_12541);
      addLine(` ${TNS_ERRORS.TNS_12560}`);
    }
  } else {
    addLine(TNS_ERRORS.TNS_03505);
  }
}
