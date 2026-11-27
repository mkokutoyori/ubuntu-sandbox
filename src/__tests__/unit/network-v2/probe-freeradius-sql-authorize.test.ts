/*
 * Probe: rlm_sql, authorize brick. `sql` in the authorize section was refused at load ("The module sql is not implemented in this simulator"), so a user kept in an Oracle
 * table could not authenticate. Source of truth: FreeRADIUS v3.2.x src/modules/rlm_sql/rlm_sql.c (sql_authorize: SQL-User-Name is the expansion of sql_user_name,
 * default %{User-Name}; authorize_check_query gives the check items of the user, authorize_reply_query its reply items; the group names come from group_membership_query
 * and, per group, authorize_group_check_query / authorize_group_reply_query with %{Sql-Group}; groups are read when read_groups is yes and the user has no matching entry
 * or its reply carries Fall-Through = Yes; the row layout is id, username, attribute, value, op; an operator outside the pair operators is an error; found is ok,
 * nothing is notfound), raddb/mods-config/sql/main/oracle/queries.conf. The rows are turned into the same users-file entries the files module applies (check items,
 * known good password, Fall-Through, reply), so one grammar answers both; they cross a real Oracle Net session to another host, counted on its port. Still refused where
 * used: sql in post-auth and session, map sql, read_clients.
 *
 * Startup failure added later: a database unreachable at start stops the service (1 of 15 falls on git stash of src/network; its witness passes either way).
 * Lazy group read added later: the last case (a broken group_membership_query is not sent for a user with its own entry and no Fall-Through) is the 1 case of 13 that falls on git stash of src/network.
 *
 * Discriminated with git stash on src/network: 7 of 12 fall before the fix (every case that needs a row of the database to be read, applied or refused for its operator). The five
 * that pass either way, with their reason: the witness (a users-file user, module not called); the wrong password, the unsatisfied check item, read_groups = no and the quoted
 * user name are REFUSALS, and before the fix every request to this site failed to load, so they were refused for the wrong reason; they only mean something read with their
 * positive twin (the same user accepted with the right password, the group read with Fall-Through, the escaped name that raises no SQL error).
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

const module = (extra = '') => [
  'sql {',
  '  driver = "rlm_sql_oracle"',
  '  dialect = "oracle"',
  '  radius_db = "//10.0.0.2/ORCL"',
  '  login = "system"',
  '  password = "oracle"',
  '  authorize_check_query = "SELECT id, username, attribute, value, op FROM system.radcheck WHERE username = \'%{SQL-User-Name}\' ORDER BY id"',
  '  authorize_reply_query = "SELECT id, username, attribute, value, op FROM system.radreply WHERE username = \'%{SQL-User-Name}\' ORDER BY id"',
  '  group_membership_query = "SELECT groupname FROM system.radusergroup WHERE username = \'%{SQL-User-Name}\' ORDER BY priority"',
  '  authorize_group_check_query = "SELECT id, groupname, attribute, value, op FROM system.radgroupcheck WHERE groupname = \'%{Sql-Group}\' ORDER BY id"',
  '  authorize_group_reply_query = "SELECT id, groupname, attribute, value, op FROM system.radgroupreply WHERE groupname = \'%{Sql-Group}\' ORDER BY id"',
  extra,
  '}',
  '',
].join('\n');

const ROWS = [
  "INSERT INTO system.radcheck VALUES (1, 'alice', 'Cleartext-Password', 'pw', ':=')",
  "INSERT INTO system.radreply VALUES (1, 'alice', 'Reply-Message', 'hello from sql', ':=')",
  "INSERT INTO system.radcheck VALUES (2, 'bob', 'Cleartext-Password', 'pw', ':=')",
  "INSERT INTO system.radcheck VALUES (3, 'bob', 'NAS-IP-Address', '10.9.9.9', '==')",
  "INSERT INTO system.radcheck VALUES (4, 'carl', 'Cleartext-Password', 'pw', ':=')",
  "INSERT INTO system.radreply VALUES (2, 'carl', 'Fall-Through', 'Yes', ':=')",
  "INSERT INTO system.radusergroup VALUES ('carl', 'staff', 1)",
  "INSERT INTO system.radgroupreply VALUES (1, 'staff', 'Reply-Message', 'staff group', ':=')",
  "INSERT INTO system.radusergroup VALUES ('dave', 'guests', 1)",
  "INSERT INTO system.radgroupcheck VALUES (1, 'guests', 'Cleartext-Password', 'grouppw', ':=')",
  "INSERT INTO system.radcheck VALUES (5, 'erin', 'Cleartext-Password', 'pw', 'xx')",
  "INSERT INTO system.radcheck VALUES (6, 'frank', 'Cleartext-Password', 'pw', ':=')",
  "INSERT INTO system.radusergroup VALUES ('frank', 'staff', 1)",
  "INSERT INTO system.radreply VALUES (3, 'frank', 'Reply-Message', 'frank only', ':=')",
];

async function lab(callSql = true, extra = '', users = 'zed Cleartext-Password := "pw"\n') {
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
  for (const table of ['radcheck', 'radreply', 'radgroupcheck', 'radgroupreply']) far.processLine(`CREATE TABLE system.${table} (id NUMBER, ${table.includes('group') ? 'groupname' : 'username'} VARCHAR2(64), attribute VARCHAR2(64), value VARCHAR2(253), op VARCHAR2(2));`);
  far.processLine('CREATE TABLE system.radusergroup (username VARCHAR2(64), groupname VARCHAR2(64), priority NUMBER);');
  for (const row of ROWS) far.processLine(`${row};`);
  far.processLine('COMMIT;');
  far.dispose();
  write(radius, CLIENTS_CONF_PATH, 'client lab {\n  ipaddr = 10.0.0.1\n  secret = shared\n}\n');
  write(radius, USERS_FILE_PATH, users);
  write(radius, SQL_MODULE, module(extra));
  if (callSql) write(radius, SITE, (vfsOf(radius).readFile(SITE) ?? '').replace('\t\tfiles\n', '\t\tfiles\n\t\tsql\n'));
  const started = await radius.executeCommand('systemctl restart freeradius');
  return { radius, dbhost, client, started };
}

const quoted = (text: string) => text.replace(/'/g, "'\\''");
const ask = (client: LinuxServer, user: string, password = 'pw') => client.executeCommand(`printf 'User-Name = "${quoted(user)}"\\nUser-Password = "${password}"\\nNAS-IP-Address = 10.0.0.1\\n' | radclient -x 10.0.0.3 auth shared`);
const accepted = (output: string) => output.includes('Received Access-Accept');
const message = (output: string) => /Reply-Message = "([^"]*)"/.exec(output)?.[1];

describe('rlm_sql: authorize', () => {
  it('witness: a user of the users file authenticates with the module loaded but not called', async () => {
    const { client, started } = await lab(false);
    expect(started).not.toContain('Failed');
    expect(accepted(await ask(client, 'zed'))).toBe(true);
  });

  it('a user kept in the Oracle table authenticates with its password, read over the wire', async () => {
    const { client, dbhost } = await lab();
    const port = dbhost.getPorts()[0];
    const before = port.getCounters().bytesIn;
    expect(accepted(await ask(client, 'alice'))).toBe(true);
    expect(port.getCounters().bytesIn).toBeGreaterThan(before);
  });

  it('a wrong password is refused', async () => {
    const { client } = await lab();
    expect(accepted(await ask(client, 'alice', 'nope'))).toBe(false);
  });

  it('the reply items of the user come back in the Access-Accept', async () => {
    const { client } = await lab();
    expect(message(await ask(client, 'alice'))).toBe('hello from sql');
  });

  it('a check item the request does not satisfy leaves the user without an entry: refused', async () => {
    const { client } = await lab();
    expect(accepted(await ask(client, 'bob'))).toBe(false);
  });

  it('Fall-Through = Yes in the user reply reads the groups: the group reply is added', async () => {
    const { client } = await lab();
    const output = await ask(client, 'carl');
    expect(accepted(output)).toBe(true);
    expect(message(output)).toBe('staff group');
  });

  it('a user with no row of its own takes the check items of its group', async () => {
    const { client } = await lab();
    expect(accepted(await ask(client, 'dave', 'grouppw'))).toBe(true);
  });

  it('without Fall-Through the groups of a user that has its own entry are not read', async () => {
    const { client } = await lab();
    const output = await ask(client, 'frank');
    expect(accepted(output)).toBe(true);
    expect(message(output)).toBe('frank only');
  });

  it('read_groups = no never reads the groups', async () => {
    const { client } = await lab(true, '  read_groups = no');
    expect(accepted(await ask(client, 'dave', 'grouppw'))).toBe(false);
  });

  it('sql_user_name decides the name looked up: an upper-case login finds the lower-case row', async () => {
    const { client } = await lab(true, '  sql_user_name = "%{tolower:%{User-Name}}"');
    expect(accepted(await ask(client, 'ALICE'))).toBe(true);
  });

  it('an operator outside the pair operators fails the module and is logged', async () => {
    const { client, radius } = await lab();
    expect(accepted(await ask(client, 'erin'))).toBe(false);
    expect(await radius.executeCommand('cat /var/log/freeradius/radius.log')).toContain('Invalid operator "xx"');
  });

  it('a quote in the user name is escaped: no SQL error, no entry', async () => {
    const { client, radius } = await lab();
    expect(accepted(await ask(client, "o'brien"))).toBe(false);
    expect(await radius.executeCommand('cat /var/log/freeradius/radius.log')).not.toContain('SQL query failed');
  });

  it('a group query that cannot run is never sent for a user with its own entry and no Fall-Through, and fails the module for one that falls through', async () => {
    const broken = '  group_membership_query = "SELECT groupname FROM system.no_such_table WHERE username = \'%{SQL-User-Name}\'"';
    const { client } = await lab(true, broken);
    expect(accepted(await ask(client, 'alice'))).toBe(true);
    expect(accepted(await ask(client, 'carl'))).toBe(false);
  });

  it('a database that cannot be reached at start refuses to instantiate the module: the service does not start, as FreeRADIUS refuses', async () => {
    const { radius, client } = await lab(true, '  radius_db = "//10.0.0.9/ORCL"');
    expect(await radius.executeCommand('systemctl is-active freeradius')).not.toMatch(/^active/);
    expect(accepted(await ask(client, 'zed'))).toBe(false);
  });

  it('witness for the case above: the same lab with the reachable database starts and answers', async () => {
    const { client, started } = await lab(true);
    expect(started).not.toContain('Failed');
    expect(accepted(await ask(client, 'zed'))).toBe(true);
  });
});
