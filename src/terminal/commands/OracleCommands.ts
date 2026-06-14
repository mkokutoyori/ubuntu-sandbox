/**
 * OracleCommands — Single-shot Oracle CLI tool handlers.
 *
 * Extracts lsnrctl and tnsping logic from LinuxTerminalSession
 * so the session class doesn't need to know about Oracle internals.
 */

import type { HostCapableDevice } from '@/network';
import { getOracleDatabase, initOracleFilesystem } from './database';
import { parseConnectIdentifier, resolveOracleConnectTarget } from './oracleNet';
import { ORACLE_CONFIG, ORACLE_BANNER, TNS_ERRORS } from '@/database/oracle/OracleConfig';
import { DataPumpEngine, type TableExistsAction } from '@/database/oracle/datapump/DataPumpEngine';

/** Callback to append a line to the terminal. */
type OutputFn = (text: string, type?: string) => void;

/**
 * Handle `lsnrctl <subcommand>` — Oracle Listener Control.
 */
export function handleLsnrctl(
  device: HostCapableDevice,
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

  const listener = db.instance.listener;
  switch (subcommand) {
    case 'START': {
      if (!listener.running) {
        db.instance.startListener();
        addLine(`Starting ${ORACLE_CONFIG.HOME}/bin/tnslsnr: please wait...`);
        addLine('');
        addLine(`TNSLSNR for Linux: Version ${ORACLE_CONFIG.VERSION}.0.0.0 - Production`);
        addLine(`Log messages written to ${ORACLE_CONFIG.BASE}/diag/tnslsnr/${hostname}/listener/alert/log.xml`);
        addLine(`Listening on: (DESCRIPTION=(ADDRESS=(PROTOCOL=tcp)(HOST=0.0.0.0)(PORT=${ORACLE_CONFIG.PORT})))`);
        addLine('');
        addLine(`Connecting to (DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=0.0.0.0)(PORT=${ORACLE_CONFIG.PORT})))`);
        for (const line of listener.statusBody()) addLine(line);
      } else {
        addLine(TNS_ERRORS.TNS_01106);
      }
      break;
    }
    case 'STOP': {
      addLine(`Connecting to (DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=0.0.0.0)(PORT=${ORACLE_CONFIG.PORT})))`);
      if (listener.running) {
        db.instance.stopListener();
        addLine('The command completed successfully');
      } else {
        addLine(TNS_ERRORS.TNS_12541);
      }
      break;
    }
    case 'STATUS': {
      addLine(`Connecting to (DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=0.0.0.0)(PORT=${ORACLE_CONFIG.PORT})))`);
      const body = listener.running ? listener.statusBody() : listener.notRunningBody();
      for (const line of body) addLine(line);
      break;
    }
    case 'SERVICES': {
      addLine(`Connecting to (DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=0.0.0.0)(PORT=${ORACLE_CONFIG.PORT})))`);
      const body = listener.running ? listener.servicesBody() : [TNS_ERRORS.TNS_12541];
      for (const line of body) addLine(line);
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

  // Phase 7c: OracleFilesystemSync (auto-attached by getOracleDatabase)
  // materialises the alert log via the bus — no manual sync here.
}

/**
 * Handle `dbca` — Database Configuration Assistant (simplified stub).
 */
export function handleDbca(
  _device: HostCapableDevice,
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
  _device: HostCapableDevice,
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
 * Handle `adrci` — Automatic Diagnostic Repository Command Interpreter.
 * SHOW ALERT reads the live instance alert log (the same one the
 * filesystem sync materialises under the diag home).
 */
export function handleAdrci(
  device: HostCapableDevice,
  args: string[],
  addLine: OutputFn,
): void {
  initOracleFilesystem(device);
  const db = getOracleDatabase(device.getId());

  addLine('');
  addLine('ADRCI: Release 19.0.0.0.0 - Production');
  addLine('');
  addLine(ORACLE_BANNER.COPYRIGHT);
  addLine('');

  if (args.length === 0) {
    addLine('adrci> This is a simulated ADRCI environment.');
    addLine('adrci> Available commands: SHOW HOMES, SHOW ALERT [-TAIL n], SHOW INCIDENT, EXIT');
    addLine('');
    return;
  }

  const subcmd = args.join(' ').toUpperCase();
  const adrHomeRel = ORACLE_CONFIG.DIAG_HOME.startsWith(ORACLE_CONFIG.BASE + '/')
    ? ORACLE_CONFIG.DIAG_HOME.slice(ORACLE_CONFIG.BASE.length + 1)
    : ORACLE_CONFIG.DIAG_HOME;
  if (subcmd.includes('SHOW HOMES') || subcmd.includes('SHOW HOME')) {
    addLine('ADR Homes:');
    addLine(`  ${adrHomeRel}`);
  } else if (subcmd.includes('SHOW ALERT')) {
    addLine(`ADR Home = ${ORACLE_CONFIG.DIAG_HOME}:`);
    addLine('*************************************************************************');
    const alertLog = db.instance.getAlertLog();
    const tailMatch = subcmd.match(/-TAIL\s+(\d+)/);
    const entries = tailMatch ? alertLog.slice(-parseInt(tailMatch[1], 10)) : alertLog;
    if (entries.length === 0) {
      addLine('No alert log entries.');
    } else {
      for (const line of entries) addLine(line);
    }
  } else if (subcmd.includes('SHOW INCIDENT')) {
    addLine(`ADR Home = ${ORACLE_CONFIG.DIAG_HOME}:`);
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
  device: HostCapableDevice,
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

  // Real client-side resolution: tnsnames.ora alias or EZConnect,
  // local or across the simulated network. A bare SID name is also
  // accepted for the local instance (historical convenience).
  const upper = serviceName.toUpperCase();
  const localShortcut =
    upper === db.getSid().toUpperCase() || upper === db.getServiceName().toUpperCase();
  const desc = parseConnectIdentifier(device, serviceName)
    ?? (localShortcut || upper === 'LOCALHOST'
      ? { host: 'localhost', port: ORACLE_CONFIG.PORT, service: db.getServiceName() }
      : null);
  if (!desc) {
    addLine(TNS_ERRORS.TNS_03505);
    return;
  }

  const adapter = desc.alias || localShortcut || upper === 'LOCALHOST'
    ? 'Used TNSNAMES adapter to resolve the alias'
    : 'Used EZCONNECT adapter to resolve the alias';
  const connectDesc = `(DESCRIPTION = (ADDRESS = (PROTOCOL = TCP)(HOST = ${desc.host})(PORT = ${desc.port})) (CONNECT_DATA = (SERVER = DEDICATED) (SERVICE_NAME = ${desc.service})))`;
  addLine(adapter);
  addLine(`Attempting to contact ${connectDesc}`);

  // tnsping only checks that a listener answers at the endpoint — it
  // does NOT validate the service (real tnsping says OK even for an
  // unknown service, because it never sends a CONNECT_DATA probe).
  const probe = resolveOracleConnectTarget(
    device, `//${desc.host}:${desc.port}/${desc.service}`, getOracleDatabase);
  if (probe.ok) {
    const latency = Math.floor(Math.random() * 5) + 1;
    addLine(`OK (${latency} msec)`);
  } else if (/ORA-12514|ORA-12528/.test(probe.error)) {
    // Listener answered; service-level refusals are invisible to tnsping.
    const latency = Math.floor(Math.random() * 5) + 1;
    addLine(`OK (${latency} msec)`);
  } else {
    addLine(TNS_ERRORS.TNS_12541);
    addLine(` ${TNS_ERRORS.TNS_12560}`);
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
  device: HostCapableDevice,
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

  const directory = (params.get('DIRECTORY') || 'DATA_PUMP_DIR').toUpperCase();
  const dir = db.catalog.getDirectory(directory);
  if (!dir) {
    addLine('ORA-39002: invalid operation');
    addLine('ORA-39070: Unable to open the log file.');
    addLine(`ORA-39087: directory name ${directory} is invalid`);
    return;
  }
  const dumpPath = joinDirectoryPath(dir.path, dumpfile);
  const logPath = joinDirectoryPath(dir.path, logfile);

  const jobName = `SYS_EXPORT_${full ? 'FULL' : tables ? 'TABLE' : 'SCHEMA'}_01`;
  addLine(`Connected to: Oracle Database ${ORACLE_CONFIG.VERSION}c Enterprise Edition`);
  addLine(`Starting "${schemas[0]}"."${jobName}":`);
  addLine('');

  const engine = new DataPumpEngine(db);
  const { dump, report } = engine.export({ schemas, tables, full });
  for (const line of report.lines) addLine(line);

  addLine('');
  addLine(`Master table "${schemas[0]}"."${jobName}" successfully loaded/unloaded`);
  addLine('******************************************************************************');
  addLine(`Dump file set for ${schemas[0]}.${jobName} is:`);
  addLine(`  ${dumpPath}`);
  addLine(`Job "${schemas[0]}"."${jobName}" successfully completed at ${new Date().toLocaleTimeString()}`);

  device.writeFileFromEditor?.(dumpPath, JSON.stringify(dump));
  device.writeFileFromEditor?.(logPath, [
    `Export: Release ${ORACLE_CONFIG.VERSION}.0`,
    `Schemas: ${schemas.join(',')}`,
    ...report.lines,
    `Tables: ${report.tables}`,
    `Rows: ${report.rows}`,
    `Completed at ${new Date().toISOString()}`,
  ].join('\n'));
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
  device: HostCapableDevice,
  args: string[],
  addLine: OutputFn,
): void {
  initOracleFilesystem(device);
  const db = getOracleDatabase(device.getId());

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
  const existsAction = (params.get('TABLE_EXISTS_ACTION')?.toUpperCase() ?? 'SKIP') as TableExistsAction;

  const directory = (params.get('DIRECTORY') || 'DATA_PUMP_DIR').toUpperCase();
  const dir = db.catalog.getDirectory(directory);
  if (!dir) {
    addLine('ORA-39002: invalid operation');
    addLine('ORA-39070: Unable to open the log file.');
    addLine(`ORA-39087: directory name ${directory} is invalid`);
    return;
  }
  const dumpPath = joinDirectoryPath(dir.path, dumpfile);
  const fileContent = device.readFileForEditor?.(dumpPath);
  if (!fileContent) {
    addLine(`ORA-39001: invalid argument value`);
    addLine(`ORA-39000: bad dump file specification`);
    addLine(`ORA-39143: dump file "${dumpPath}" not found`);
    return;
  }

  const dump = DataPumpEngine.parse(fileContent);
  if (!dump) {
    addLine(`ORA-39000: bad dump file specification`);
    addLine(`ORA-39143: dump file "${dumpPath}" may be an original export dump file`);
    return;
  }

  const jobName = `SYS_IMPORT_${full ? 'FULL' : tables ? 'TABLE' : 'SCHEMA'}_01`;
  addLine(`Connected to: Oracle Database ${ORACLE_CONFIG.VERSION}c Enterprise Edition`);
  addLine(`Master table "${schemas[0]}"."${jobName}" successfully loaded/unloaded`);
  addLine(`Starting "${schemas[0]}"."${jobName}":`);
  addLine('');

  let remapOption: { from: string; to: string } | undefined;
  if (remap) {
    const [src, dst] = remap.split(':');
    if (src && dst) {
      remapOption = { from: src, to: dst };
      addLine(`Remapping schema "${src.toUpperCase()}" to "${dst.toUpperCase()}"`);
    }
  }

  const engine = new DataPumpEngine(db);
  const report = engine.import(dump, { remapSchema: remapOption, tableExistsAction: existsAction });
  for (const line of report.lines) addLine(line);

  addLine('');
  addLine(`Job "${schemas[0]}"."${jobName}" successfully completed at ${new Date().toLocaleTimeString()}`);

  const logPath = joinDirectoryPath(dir.path, logfile);
  device.writeFileFromEditor?.(logPath, [
    `Import: Release ${ORACLE_CONFIG.VERSION}.0`,
    ...report.lines,
    `Tables: ${report.tables}`,
    `Rows: ${report.rows}`,
    `Completed at ${new Date().toISOString()}`,
  ].join('\n'));
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

function joinDirectoryPath(base: string, file: string): string {
  return `${base.replace(/\/+$/, '')}/${file}`;
}

