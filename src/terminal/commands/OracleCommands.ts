/**
 * OracleCommands — Single-shot Oracle CLI tool handlers.
 *
 * Extracts lsnrctl and tnsping logic from LinuxTerminalSession
 * so the session class doesn't need to know about Oracle internals.
 */

import type { Equipment } from '@/network';
import { getOracleDatabase, initOracleFilesystem, syncAlertLogToDevice } from './database';
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

  // Sync alert log to VFS after listener operations
  if (subcommand === 'START' || subcommand === 'STOP') {
    syncAlertLogToDevice(device, db.instance.getAlertLog());
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

/**
 * Handle `expdp` — Oracle Data Pump Export.
 *
 * Produces realistic output for common export modes:
 *   expdp user/pass SCHEMAS=HR DIRECTORY=DATA_PUMP_DIR DUMPFILE=hr.dmp LOGFILE=hr_exp.log
 *   expdp user/pass FULL=Y ...
 *   expdp user/pass TABLES=HR.EMPLOYEES ...
 */
export function handleExpdp(
  device: Equipment,
  args: string[],
  addLine: OutputFn,
): void {
  initOracleFilesystem(device);
  const db = getOracleDatabase(device.getId());

  addLine('');
  addLine(`Export: Release ${ORACLE_CONFIG.VERSION}.0 - Production on ${new Date().toDateString()}`);
  addLine(ORACLE_BANNER.COPYRIGHT);
  addLine('');

  if (args.length === 0) {
    addLine('Usage: expdp user/password[@connect_string] [keyword=value ...]');
    addLine('');
    addLine('Common keywords:');
    addLine('  SCHEMAS      - list of schemas to export');
    addLine('  TABLES       - list of tables to export');
    addLine('  FULL         - export entire database (Y/N)');
    addLine('  DIRECTORY    - directory object for dump/log files');
    addLine('  DUMPFILE     - name of dump file');
    addLine('  LOGFILE      - name of log file');
    addLine('  CONTENT      - ALL, DATA_ONLY, or METADATA_ONLY');
    addLine('  PARALLEL     - degree of parallelism');
    return;
  }

  // Parse keyword=value pairs
  const params = parseDataPumpParams(args);
  const schemas = (params.get('SCHEMAS') || 'HR').toUpperCase().split(',');
  const dumpfile = params.get('DUMPFILE') || 'expdat.dmp';
  const logfile = params.get('LOGFILE') || 'export.log';
  const tables = params.get('TABLES')?.toUpperCase().split(',');
  const full = params.get('FULL')?.toUpperCase() === 'Y';
  const directory = params.get('DIRECTORY') || 'DATA_PUMP_DIR';

  addLine(`Connected to: Oracle Database ${ORACLE_CONFIG.VERSION}c Enterprise Edition`);
  addLine(`Starting "${schemas[0]}"."SYS_EXPORT_${full ? 'FULL' : tables ? 'TABLE' : 'SCHEMA'}_01":`);
  addLine('');

  // Gather objects to "export"
  const storage = db.storage as import('@/database/oracle/OracleStorage').OracleStorage;
  let totalTables = 0;
  let totalRows = 0;

  for (const schema of schemas) {
    const tableNames = storage.getTableNames(schema);
    const exportTables = tables
      ? tableNames.filter(t => tables.some(tt => tt === t || tt === `${schema}.${t}`))
      : tableNames;

    for (const tname of exportTables) {
      const rows = storage.getRows(schema, tname);
      totalTables++;
      totalRows += rows.length;
      addLine(`. . exported "${schema}"."${tname}"                     ${rows.length} rows`);
    }
  }

  addLine('');
  addLine(`Master table "${schemas[0]}"."SYS_EXPORT_${full ? 'FULL' : tables ? 'TABLE' : 'SCHEMA'}_01" successfully loaded/unloaded`);
  addLine('******************************************************************************');
  addLine(`Dump file set for ${schemas[0]}.SYS_EXPORT_${full ? 'FULL' : tables ? 'TABLE' : 'SCHEMA'}_01 is:`);
  addLine(`  /u01/app/oracle/admin/${ORACLE_CONFIG.SID}/dpdump/${dumpfile}`);
  addLine(`Job "${schemas[0]}"."SYS_EXPORT_${full ? 'FULL' : tables ? 'TABLE' : 'SCHEMA'}_01" successfully completed at ${new Date().toLocaleTimeString()}`);

  // Create the dump file on VFS
  const dumpPath = `/u01/app/oracle/admin/${ORACLE_CONFIG.SID}/dpdump/${dumpfile}`;
  const logPath = `/u01/app/oracle/admin/${ORACLE_CONFIG.SID}/dpdump/${logfile}`;
  device.writeFileFromEditor(dumpPath, `[ORACLE DATA PUMP DUMP - ${totalTables} tables, ${totalRows} rows - ${new Date().toISOString()}]`);
  device.writeFileFromEditor(logPath, `Export: Release ${ORACLE_CONFIG.VERSION}.0\nSchemas: ${schemas.join(',')}\nTables: ${totalTables}\nRows: ${totalRows}\nCompleted at ${new Date().toISOString()}`);
}

/**
 * Handle `impdp` — Oracle Data Pump Import.
 *
 * Produces realistic output for common import modes:
 *   impdp user/pass SCHEMAS=HR DIRECTORY=DATA_PUMP_DIR DUMPFILE=hr.dmp LOGFILE=hr_imp.log
 *   impdp user/pass TABLES=HR.EMPLOYEES ...
 *   impdp user/pass FULL=Y ...
 */
export function handleImpdp(
  device: Equipment,
  args: string[],
  addLine: OutputFn,
): void {
  initOracleFilesystem(device);

  addLine('');
  addLine(`Import: Release ${ORACLE_CONFIG.VERSION}.0 - Production on ${new Date().toDateString()}`);
  addLine(ORACLE_BANNER.COPYRIGHT);
  addLine('');

  if (args.length === 0) {
    addLine('Usage: impdp user/password[@connect_string] [keyword=value ...]');
    addLine('');
    addLine('Common keywords:');
    addLine('  SCHEMAS      - list of schemas to import');
    addLine('  TABLES       - list of tables to import');
    addLine('  FULL         - import entire dump file (Y/N)');
    addLine('  DIRECTORY    - directory object for dump/log files');
    addLine('  DUMPFILE     - name of dump file to read');
    addLine('  LOGFILE      - name of log file');
    addLine('  REMAP_SCHEMA - remap source schema to target (old:new)');
    addLine('  TABLE_EXISTS_ACTION - SKIP, APPEND, TRUNCATE, REPLACE');
    addLine('  CONTENT      - ALL, DATA_ONLY, or METADATA_ONLY');
    return;
  }

  const params = parseDataPumpParams(args);
  const schemas = (params.get('SCHEMAS') || 'HR').toUpperCase().split(',');
  const dumpfile = params.get('DUMPFILE') || 'expdat.dmp';
  const logfile = params.get('LOGFILE') || 'import.log';
  const tables = params.get('TABLES')?.toUpperCase().split(',');
  const full = params.get('FULL')?.toUpperCase() === 'Y';
  const remap = params.get('REMAP_SCHEMA');
  const directory = params.get('DIRECTORY') || 'DATA_PUMP_DIR';

  // Check if dump file exists on VFS
  const dumpPath = `/u01/app/oracle/admin/${ORACLE_CONFIG.SID}/dpdump/${dumpfile}`;
  const fileContent = device.readFileForEditor(dumpPath);
  if (!fileContent) {
    addLine(`ORA-39001: invalid argument value`);
    addLine(`ORA-39000: bad dump file specification`);
    addLine(`ORA-39143: dump file "${dumpPath}" not found`);
    return;
  }

  addLine(`Connected to: Oracle Database ${ORACLE_CONFIG.VERSION}c Enterprise Edition`);
  addLine(`Master table "${schemas[0]}"."SYS_IMPORT_${full ? 'FULL' : tables ? 'TABLE' : 'SCHEMA'}_01" successfully loaded/unloaded`);
  addLine(`Starting "${schemas[0]}"."SYS_IMPORT_${full ? 'FULL' : tables ? 'TABLE' : 'SCHEMA'}_01":`);
  addLine('');

  if (remap) {
    const [src, dst] = remap.split(':');
    addLine(`Remapping schema "${src}" to "${dst}"`);
  }

  // Parse the dump file to know what was in it
  const dumpMeta = fileContent.match(/(\d+) tables, (\d+) rows/);
  const nTables = dumpMeta ? parseInt(dumpMeta[1]) : 5;
  const nRows = dumpMeta ? parseInt(dumpMeta[2]) : 100;

  addLine(`. . imported "${schemas[0]}"  ${nTables} tables, ${nRows} rows`);
  addLine('');
  addLine(`Job "${schemas[0]}"."SYS_IMPORT_${full ? 'FULL' : tables ? 'TABLE' : 'SCHEMA'}_01" successfully completed at ${new Date().toLocaleTimeString()}`);

  // Write log file
  const logPath = `/u01/app/oracle/admin/${ORACLE_CONFIG.SID}/dpdump/${logfile}`;
  device.writeFileFromEditor(logPath, `Import: Release ${ORACLE_CONFIG.VERSION}.0\nSchemas: ${schemas.join(',')}\nTables: ${nTables}\nRows: ${nRows}\nCompleted at ${new Date().toISOString()}`);
}

/** Parse Data Pump keyword=value pairs from args. */
function parseDataPumpParams(args: string[]): Map<string, string> {
  const params = new Map<string, string>();
  for (const arg of args) {
    const eqIdx = arg.indexOf('=');
    if (eqIdx > 0) {
      params.set(arg.substring(0, eqIdx).toUpperCase(), arg.substring(eqIdx + 1));
    }
  }
  return params;
}

