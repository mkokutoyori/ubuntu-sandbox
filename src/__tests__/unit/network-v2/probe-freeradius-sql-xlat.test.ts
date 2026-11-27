/*
 * Probe: rlm_sql, first brick: the module section and the %{sql:...} expansion. Source of truth: FreeRADIUS v3.2.x src/modules/rlm_sql/rlm_sql.c (sql_xlat: for a
 * query starting with insert, update or delete the number of rows affected is returned, "SQL query affected no rows" otherwise empty; for a select the first value of
 * the first column, "SQL query returned no results" / "NULL value in first column of result" empty; sql_escape_func: every character outside safe_characters
 * (default "@abc...XYZ0123456789.-_: /") becomes =XX in hexadecimal, \n \r \t become backslash sequences, multi-byte UTF-8 passes), raddb/mods-available/sql
 * (driver, radius_db, login, password), rlm_sql_oracle.c (the connection is made with radius_db as the Oracle connect string). The driver is rlm_sql_oracle over a
 * real Oracle Net session to the simulator's Oracle instance on another host: the statement and its rows cross the wire, counted on the database host's port.
 * Every other driver is refused naming the limit; a setting the module does not have is refused. The queries.conf-driven parts of the module (authorize_check_query,
 * accounting, `sql` as a statement of authorize, `map sql`) are the next bricks and are still refused where they are used.
 *
 * Discriminated with git stash on src/network and src/adapters: 6 of 7 fall before the fix (the expansion was refused at parse time, the driver and the unknown setting
 * were never read); the witness passes either way: a section the old loader ignored still loads and a static reply is a static reply.
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

const SQL = (extra = '', driver = 'rlm_sql_oracle') => `sql {\n  driver = "${driver}"\n  dialect = "oracle"\n  radius_db = "//10.0.0.2/ORCL"\n  login = "system"\n  password = "oracle"\n${extra}}\n`;

async function lab(authorizeLines: string, module = SQL(), users = 'alice Cleartext-Password := "pw"\n') {
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
  far.processLine('CREATE TABLE system.remote_marker (city VARCHAR2(30));');
  far.processLine("INSERT INTO system.remote_marker VALUES ('YAOUNDE');");
  far.processLine('COMMIT;');
  far.dispose();
  write(radius, CLIENTS_CONF_PATH, 'client lab {\n  ipaddr = 10.0.0.1\n  secret = shared\n}\n');
  write(radius, USERS_FILE_PATH, users);
  write(radius, SQL_MODULE, module);
  write(radius, SITE, (vfsOf(radius).readFile(SITE) ?? '').replace('\t\tfiles\n', `\t\tfiles\n${authorizeLines}`));
  const started = await radius.executeCommand('systemctl restart freeradius');
  return { radius, dbhost, client, started };
}

const reply = (expansion: string) => `\t\tupdate reply {\n\t\t\tReply-Message := "${expansion}"\n\t\t}\n`;
const ask = (client: LinuxServer, user = 'alice') => client.executeCommand(`printf 'User-Name = "${user}"\\nUser-Password = "pw"\\n' | radclient -x 10.0.0.3 auth shared`);
const message = (output: string) => /Reply-Message = "([^"]*)"/.exec(output)?.[1];

describe('rlm_sql: the sql module and %{sql:...}', () => {
  it('witness: the sql section loads and a static reply is sent', async () => {
    const { client, started } = await lab(reply('static'));
    expect(started).not.toContain('Failed');
    expect(message(await ask(client))).toBe('static');
  });

  it('a select returns the first column of the first row, read from the Oracle instance over the wire', async () => {
    const { client, dbhost } = await lab(reply('%{sql:SELECT city FROM system.remote_marker}'));
    const port = dbhost.getPorts()[0];
    const before = port.getCounters().bytesIn;
    expect(message(await ask(client))).toBe('YAOUNDE');
    expect(port.getCounters().bytesIn).toBeGreaterThan(before);
  });

  it('an update returns the number of rows affected and the change is seen by the next expansion of the same request', async () => {
    const { client } = await lab(reply("%{sql:UPDATE system.remote_marker SET city = 'DOUALA'}-%{sql:SELECT city FROM system.remote_marker}"));
    expect(message(await ask(client))).toBe('1-DOUALA');
  });

  it('a select without a row expands to nothing, so the alternative applies', async () => {
    const { client } = await lab(reply('%{%{sql:SELECT city FROM system.remote_marker WHERE 1 = 0}:-none}'));
    expect(message(await ask(client))).toBe('none');
  });

  it('an attribute inside the query is escaped with the module safe characters', async () => {
    const { client } = await lab(reply("%{sql:SELECT '%{User-Name}' FROM dual}"), SQL(), 'alice;x Cleartext-Password := "pw"\n');
    expect(message(await ask(client, 'alice;x'))).toBe('alice=3Bx');
  });

  it('refuses a driver the simulator does not have, naming it', async () => {
    const { started } = await lab(reply('static'), SQL('', 'rlm_sql_mysql'));
    expect(started).toContain('The sql driver "rlm_sql_mysql" is not implemented in this simulator');
  });

  it('refuses a setting the module does not have', async () => {
    const { started } = await lab(reply('static'), SQL('  frobnicate = yes\n'));
    expect(started).toContain('Unknown sql setting "frobnicate"');
  });
});
