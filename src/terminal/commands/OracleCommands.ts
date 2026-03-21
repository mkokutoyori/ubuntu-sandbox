/**
 * OracleCommands — Single-shot Oracle CLI tool handlers.
 *
 * Extracts lsnrctl and tnsping logic from LinuxTerminalSession
 * so the session class doesn't need to know about Oracle internals.
 */

import type { Equipment } from '@/network';
import { getOracleDatabase, initOracleFilesystem } from './database';

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
  addLine('LSNRCTL for Linux: Version 19.0.0.0.0 - Production on ' + new Date().toDateString());
  addLine('');
  addLine('Copyright (c) 1991, 2019, Oracle.  All rights reserved.');
  addLine('');

  switch (subcommand) {
    case 'START': {
      db.instance.startListener();
      addLine('Starting /u01/app/oracle/product/19c/dbhome_1/bin/tnslsnr: please wait...');
      addLine('');
      addLine('TNSLSNR for Linux: Version 19.0.0.0.0 - Production');
      addLine(`Log messages written to /u01/app/oracle/diag/tnslsnr/${hostname}/listener/alert/log.xml`);
      addLine('Listening on: (DESCRIPTION=(ADDRESS=(PROTOCOL=tcp)(HOST=0.0.0.0)(PORT=1521)))');
      addLine('');
      addLine('Connecting to (DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=0.0.0.0)(PORT=1521)))');
      addLine('STATUS of the LISTENER');
      addLine('------------------------');
      addLine('Alias                     LISTENER');
      addLine('Version                   TNSLSNR for Linux: Version 19.0.0.0.0 - Production');
      addLine('Start Date                ' + new Date().toLocaleString());
      addLine('Uptime                    0 days 0 hr. 0 min. 0 sec');
      addLine('Trace Level               off');
      addLine('Security                  ON: Local OS Authentication');
      addLine('SNMP                      OFF');
      addLine(`Listener Log File         /u01/app/oracle/diag/tnslsnr/${hostname}/listener/alert/log.xml`);
      addLine('Listening Endpoints Summary...');
      addLine('  (DESCRIPTION=(ADDRESS=(PROTOCOL=tcp)(HOST=0.0.0.0)(PORT=1521)))');
      addLine('The command completed successfully');
      break;
    }
    case 'STOP': {
      db.instance.stopListener();
      addLine('Connecting to (DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=0.0.0.0)(PORT=1521)))');
      addLine('The command completed successfully');
      break;
    }
    case 'STATUS': {
      const status = db.instance.getListenerStatus();
      addLine('Connecting to (DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=0.0.0.0)(PORT=1521)))');
      if (status.running) {
        addLine('STATUS of the LISTENER');
        addLine('------------------------');
        addLine('Alias                     LISTENER');
        addLine('Version                   TNSLSNR for Linux: Version 19.0.0.0.0 - Production');
        addLine('Start Date                ' + (status.startedAt ? new Date(status.startedAt).toLocaleString() : 'N/A'));
        addLine('Trace Level               off');
        addLine('Security                  ON: Local OS Authentication');
        addLine('SNMP                      OFF');
        addLine('Listening Endpoints Summary...');
        addLine('  (DESCRIPTION=(ADDRESS=(PROTOCOL=tcp)(HOST=0.0.0.0)(PORT=1521)))');
        addLine('Services Summary...');
        addLine(`  Service "${db.getSid()}" has 1 instance(s).`);
        addLine(`    Instance "${db.getSid()}", status READY, has 1 handler(s) for this service...`);
        addLine('The command completed successfully');
      } else {
        addLine('TNS-12541: TNS:no listener');
        addLine(' TNS-12560: TNS:protocol adapter error');
        addLine('  TNS-00511: No listener');
      }
      break;
    }
    case 'SERVICES': {
      const status = db.instance.getListenerStatus();
      addLine('Connecting to (DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=0.0.0.0)(PORT=1521)))');
      if (status.running) {
        addLine('Services Summary...');
        addLine(`  Service "${db.getSid()}" has 1 instance(s).`);
        addLine(`    Instance "${db.getSid()}", status READY, has 1 handler(s) for this service...`);
        addLine('      Handler(s):');
        addLine('        "DEDICATED" established:0 refused:0 state:ready');
        addLine('           LOCAL SERVER');
        addLine('The command completed successfully');
      } else {
        addLine('TNS-12541: TNS:no listener');
      }
      break;
    }
    case 'RELOAD': {
      addLine('Connecting to (DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=0.0.0.0)(PORT=1521)))');
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
  addLine('TNS Ping Utility for Linux: Version 19.0.0.0.0 - Production on ' + new Date().toDateString());
  addLine('');
  addLine('Copyright (c) 1997, 2019, Oracle.  All rights reserved.');
  addLine('');
  addLine('Used parameter files:');
  addLine('/u01/app/oracle/product/19c/dbhome_1/network/admin/sqlnet.ora');
  addLine('');

  if (!serviceName) {
    addLine('TNS-03505: Failed to resolve name');
    return;
  }

  const upper = serviceName.toUpperCase();
  const status = db.instance.getListenerStatus();

  if (upper === db.getSid().toUpperCase() || upper === db.getServiceName().toUpperCase() || upper === 'LOCALHOST') {
    if (status.running) {
      addLine('Used TNSNAMES adapter to resolve the alias');
      addLine(`Attempting to contact (DESCRIPTION = (ADDRESS = (PROTOCOL = TCP)(HOST = localhost)(PORT = 1521)) (CONNECT_DATA = (SERVER = DEDICATED) (SERVICE_NAME = ${db.getServiceName()})))`);
      const latency = Math.floor(Math.random() * 5) + 1;
      addLine(`OK (${latency} msec)`);
    } else {
      addLine('Used TNSNAMES adapter to resolve the alias');
      addLine(`Attempting to contact (DESCRIPTION = (ADDRESS = (PROTOCOL = TCP)(HOST = localhost)(PORT = 1521)) (CONNECT_DATA = (SERVER = DEDICATED) (SERVICE_NAME = ${db.getServiceName()})))`);
      addLine('TNS-12541: TNS:no listener');
      addLine(' TNS-12560: TNS:protocol adapter error');
    }
  } else {
    addLine('TNS-03505: Failed to resolve name');
  }
}
