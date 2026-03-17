/**
 * Database command handlers — manages Oracle instances per device.
 *
 * Each device that runs `sqlplus` gets a singleton OracleDatabase
 * automatically started (OPEN state) with demo schemas installed.
 */

import { OracleDatabase } from '@/database/oracle/OracleDatabase';
import { SQLPlusSession } from '@/database/oracle/commands/SQLPlusSession';
import { installAllDemoSchemas } from '@/database/oracle/demo/DemoSchemas';

/** Per-device Oracle database instances. */
const oracleInstances: Map<string, OracleDatabase> = new Map();

/**
 * Get or create an Oracle database for a device.
 * Automatically starts the instance and installs demo schemas on first access.
 */
export function getOracleDatabase(deviceId: string): OracleDatabase {
  let db = oracleInstances.get(deviceId);
  if (!db) {
    db = new OracleDatabase();
    // Auto-start the instance to OPEN state
    db.instance.startup('OPEN');
    // Install demo schemas
    installAllDemoSchemas(db);
    oracleInstances.set(deviceId, db);
  }
  return db;
}

/**
 * Create a SQL*Plus session for a device.
 * Parses the sqlplus command arguments to extract credentials.
 */
export function createSQLPlusSession(
  deviceId: string,
  args: string[]
): { session: SQLPlusSession; banner: string[]; loginOutput: string[] } {
  const db = getOracleDatabase(deviceId);
  const session = new SQLPlusSession(db);

  const banner = session.getBanner();
  let loginOutput: string[] = [];

  // Parse sqlplus arguments:
  //   sqlplus user/pass
  //   sqlplus user/pass@tns
  //   sqlplus / as sysdba
  //   sqlplus -s user/pass  (silent mode)
  //   sqlplus (no args — interactive login prompt, not supported yet)

  let username = '';
  let password = '';
  let asSysdba = false;

  const filtered = args.filter(a => !a.startsWith('-'));

  const asSysdbaIdx = filtered.findIndex(a => a.toUpperCase() === 'AS');
  if (asSysdbaIdx !== -1 && filtered[asSysdbaIdx + 1]?.toUpperCase() === 'SYSDBA') {
    asSysdba = true;
  }

  const connArg = filtered[0];
  if (connArg) {
    if (connArg === '/' && asSysdba) {
      // sqlplus / as sysdba
    } else if (connArg.includes('/')) {
      [username, password] = connArg.split('/', 2);
      password = password.replace(/@.*$/, ''); // strip @tns_alias
    } else if (connArg !== 'AS') {
      username = connArg;
      // Would need password prompt — default to empty for now
    }
  }

  if (asSysdba || (connArg === '/' && asSysdba)) {
    loginOutput = session.login('SYS', '', true);
  } else if (username) {
    loginOutput = session.login(username, password);
  } else {
    // No credentials — just show banner, user can CONNECT later
    loginOutput = ['Not connected.'];
  }

  return { session, banner, loginOutput };
}

/**
 * Remove the Oracle database for a device (cleanup).
 */
export function removeOracleDatabase(deviceId: string): void {
  oracleInstances.delete(deviceId);
}
