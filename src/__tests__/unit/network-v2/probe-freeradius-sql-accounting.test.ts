/*
 * Probe: rlm_sql, accounting brick. The module section declared `accounting { type { start { query = ... } } }` and the loader read and DROPPED it: `sql` listed in the
 * accounting section ran as a no-op, so an Accounting-Request was acknowledged and nothing reached the database (a query stored and never evaluated). Source of truth:
 * FreeRADIUS v3.2.x src/modules/rlm_sql/rlm_sql.c (sql_accounting: the section is chosen from Acct-Status-Type, Start, Stop, Interim-Update, Accounting-On, Accounting-Off;
 * its `query` entries are tried in order and the first that affects a row ends the work, which is how an UPDATE falls back to an INSERT when the Start was never seen; no
 * query for the type is a noop; every attribute expanded in a query is escaped with the module safe characters), raddb/mods-config/sql/main/oracle/queries.conf (the
 * accounting section, `${....acct_table1}` relative references, `%S` the request timestamp in SQL format, documented in unlang(5)). The statements cross a real Oracle Net
 * session to the Oracle instance of another host, counted on its port. The queries.conf-driven parts that remain refused where used are authorize_check_query, `map sql`
 * and `read_clients`.
 *
 * Discriminated with git stash on src/network: 7 of 7 fall before the fix, the witness included (with `sql` in the accounting section the old loader refused the
 * module: "The module sql is not implemented in this simulator" there; the witness keeps `sql` out of the section and still falls, because the module's accounting subsection
 * was not read).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { MACAddress, IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { resetAllOracleInstances } from '@/terminal/commands/database';
import { SqlPlusSubShell } from '@/terminal/subshells/SqlPlusSubShell';
import type { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';
import { CLIENTS_CONF_PATH, USERS_FILE_PATH } from '@/network/devices/linux/freeradius/RadiusdService';

beforeEach(() => { resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); resetAllOracleInstances(); Logger.reset(); });

const vfsOf = (server: LinuxServer) => (server as unknown as { executor: { vfs: VirtualFileSystem } }).executor.vfs;
const write = (server: LinuxServer, path: string, content: string) => { vfsOf(server).writeFile(path, content, 0, 0, 0o022); };
const SITE = '/etc/freeradius/3.0/sites-available/default';
const SQL_MODULE = '/etc/freeradius/3.0/mods-enabled/sql';

const MODULE = [
  'sql {',
  '  driver = "rlm_sql_oracle"',
  '  dialect = "oracle"',
  '  radius_db = "//10.0.0.2/ORCL"',
  '  login = "system"',
  '  password = "oracle"',
  '  acct_table1 = "system.radacct"',
  '  acct_table2 = "system.radacct_off"',
  '  accounting {',
  '    type {',
  '      accounting-off {',
  '        query = "INSERT INTO ${....acct_table2} (acctsessionid, username, nasipaddress, acctstoptime) VALUES (\'%{Acct-Session-Id}\', \'%{User-Name}\', \'%{NAS-IP-Address}\', TO_DATE(\'%S\', \'YYYY-MM-DD HH24:MI:SS\'))"',
  '      }',
  '      start {',
  '        query = "INSERT INTO ${....acct_table1} (acctsessionid, username, nasipaddress, acctstarttime) VALUES (\'%{Acct-Session-Id}\', \'%{User-Name}\', \'%{NAS-IP-Address}\', TO_DATE(\'%S\', \'YYYY-MM-DD HH24:MI:SS\'))"',
  '      }',
  '      stop {',
  '        query = "UPDATE ${....acct_table1} SET acctstoptime = TO_DATE(\'%S\', \'YYYY-MM-DD HH24:MI:SS\'), acctsessiontime = \'%{Acct-Session-Time}\' WHERE acctsessionid = \'%{Acct-Session-Id}\' AND username = \'%{User-Name}\'"',
  '        query = "INSERT INTO ${....acct_table1} (acctsessionid, username, nasipaddress, acctstoptime, acctsessiontime) VALUES (\'%{Acct-Session-Id}\', \'%{User-Name}\', \'%{NAS-IP-Address}\', TO_DATE(\'%S\', \'YYYY-MM-DD HH24:MI:SS\'), \'%{Acct-Session-Time}\')"',
  '      }',
  '    }',
  '  }',
  '}',
  '',
].join('\n');

async function lab(callSql = true) {
  const radius = new LinuxServer('linux-server', 'AAA', 0, 0);
  const dbhost = new LinuxServer('linux-server', 'dbhost', 0, 0);
  const client = new LinuxServer('linux-server', 'CLIENT', 0, 0);
  const sw = new GenericSwitch('switch-generic', 'sw1', 8, 0, 0);
  new Cable('c1').connect(client.getPorts()[0], sw.getPorts()[0]);
  new Cable('c2').connect(radius.getPorts()[0], sw.getPorts()[1]);
  new Cable('c3').connect(dbhost.getPorts()[0], sw.getPorts()[2]);
  const mask = new SubnetMask('255.255.255.0');
  client.getPorts()[0].configureIP(new IPAddress('10.0.0.1'), mask);
  radius.getPorts()[0].configureIP(new IPAddress('10.0.0.3'), mask);
  dbhost.getPorts()[0].configureIP(new IPAddress('10.0.0.2'), mask);
  const far = SqlPlusSubShell.create(dbhost, ['/', 'as', 'sysdba']).subShell;
  far.processLine('CREATE TABLE system.radacct_off (acctsessionid VARCHAR2(64), username VARCHAR2(64), nasipaddress VARCHAR2(15), acctstoptime DATE);');
  far.processLine('CREATE TABLE system.radacct (acctsessionid VARCHAR2(64), username VARCHAR2(64), nasipaddress VARCHAR2(15), acctstarttime DATE, acctstoptime DATE, acctsessiontime VARCHAR2(12));');
  far.dispose();
  write(radius, CLIENTS_CONF_PATH, 'client lab {\n  ipaddr = 10.0.0.1\n  secret = shared\n}\n');
  write(radius, SQL_MODULE, MODULE);
  if (callSql) write(radius, SITE, (vfsOf(radius).readFile(SITE) ?? '').replace('\t\tdetail\n\t\tradutmp\n', '\t\tdetail\n\t\tradutmp\n\t\tsql\n'));
  const started = await radius.executeCommand('systemctl restart freeradius');
  return { radius, dbhost, client, started };
}

const account = (client: LinuxServer, status: string, session = 'S1', user = 'alice', extra = '') =>
  client.executeCommand(`printf 'User-Name = "${user}"\\nAcct-Session-Id = "${session}"\\nAcct-Status-Type = ${status}\\nNAS-IP-Address = 10.0.0.1\\n${extra}' | radclient 10.0.0.3 acct shared`);
const rows = (dbhost: LinuxServer, where = '1 = 1') => dbhost.executeCommand(`sqlplus -s / as sysdba <<'E'\nSELECT acctsessionid || '|' || username || '|' || nasipaddress || '|' || NVL(TO_CHAR(acctstarttime, 'YYYY'), '-') || '|' || NVL(TO_CHAR(acctstoptime, 'YYYY'), '-') || '|' || NVL(acctsessiontime, '-') AS line FROM system.radacct WHERE ${where} ORDER BY 1;\nE`);
const count = async (dbhost: LinuxServer) => Number(/^\s*(\d+)\s*$/m.exec(await dbhost.executeCommand("sqlplus -s / as sysdba <<'E'\nSELECT COUNT(*) AS n FROM system.radacct;\nE"))?.[1] ?? -1);

describe('rlm_sql: accounting', () => {
  it('witness: the module is loaded, not called, the packet is acknowledged and nothing is written', async () => {
    const { client, dbhost, started } = await lab(false);
    expect(started).not.toContain('Failed');
    expect(await account(client, 'Start')).toContain('Received Accounting-Response');
    expect(await count(dbhost)).toBe(0);
  });

  it('a Start inserts a row, read from the Oracle instance over the wire, with the SQL-format timestamp', async () => {
    const { client, dbhost } = await lab();
    const port = dbhost.getPorts()[0];
    const before = port.getCounters().bytesIn;
    expect(await account(client, 'Start')).toContain('Received Accounting-Response');
    expect(port.getCounters().bytesIn).toBeGreaterThan(before);
    expect(await rows(dbhost)).toMatch(/S1\|alice\|10\.0\.0\.1\|20\d\d\|-\|-/);
  });

  it('a Stop updates the row of the Start (one row, stop time and session time set)', async () => {
    const { client, dbhost } = await lab();
    await account(client, 'Start');
    await account(client, 'Stop', 'S1', 'alice', 'Acct-Session-Time = 120\\n');
    expect(await count(dbhost)).toBe(1);
    expect(await rows(dbhost)).toMatch(/S1\|alice\|10\.0\.0\.1\|20\d\d\|20\d\d\|120/);
  });

  it('a Stop without a Start falls back to the second query: the row is inserted', async () => {
    const { client, dbhost } = await lab();
    await account(client, 'Stop', 'S9', 'bob', 'Acct-Session-Time = 5\\n');
    expect(await rows(dbhost, "acctsessionid = 'S9'")).toMatch(/S9\|bob\|10\.0\.0\.1\|-\|20\d\d\|5/);
  });

  it('a type with no query (Interim-Update here) writes nothing and is still acknowledged', async () => {
    const { client, dbhost } = await lab();
    expect(await account(client, 'Interim-Update')).toContain('Received Accounting-Response');
    expect(await count(dbhost)).toBe(0);
  });

  it('an attribute inside the query is escaped with the safe characters', async () => {
    const { client, dbhost } = await lab();
    await account(client, 'Start', 'S2', 'alice;x');
    expect(await rows(dbhost, "acctsessionid = 'S2'")).toContain('S2|alice=3Bx|');
  });

  it('a relative ${....name} reference in a query reads the module setting, not a literal', async () => {
    const { client, dbhost } = await lab();
    await account(client, 'Start', 'S3');
    expect(await rows(dbhost, "acctsessionid = 'S3'")).toContain('S3|alice|');
  });

  it('acct_table2 is a module setting the queries read through ${....acct_table2}: the row lands in the second table, not the first', async () => {
    const { client, dbhost } = await lab();
    await account(client, 'Accounting-Off', 'S7');
    const second = await dbhost.executeCommand("sqlplus -s / as sysdba <<'E'\nSELECT acctsessionid AS line FROM system.radacct_off;\nE");
    expect(second).toContain('S7');
    expect(await count(dbhost)).toBe(0);
  });
});
