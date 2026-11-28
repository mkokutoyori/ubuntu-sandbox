/*
 * Probe: rlm_sql, read_clients. `read_clients = yes` was accepted and ignored: a NAS kept in the `nas` table of the database was unknown to the server, which dropped its
 * requests as coming from an unknown client. Source of truth: FreeRADIUS v3.2.x src/modules/rlm_sql/rlm_sql.c (generate_sql_clients: when the module starts, client_query returns
 * id, nasname, shortname, type, secret, server; each row becomes a client with ipaddr = nasname (a CIDR is a network), shortname, nas_type = type and the row's secret; a row
 * the client grammar refuses is an error and is skipped; read_clients without client_query is a configuration error), raddb/mods-config/sql/main/oracle/queries.conf (client_query =
 * "SELECT id, nasname, shortname, type, secret, server FROM ${client_table}"). The rows go through the same grammar as clients.conf (readClientSections): one answer to "what is
 * a client", not two. They are read over a real Oracle Net session to another host. A hostname in nasname goes through the same grammar as clients.conf, so the machine's resolver answers it (probe-freeradius-client-hostname);
 * the virtual server column is read and not used (TODO.md).
 *
 * The server column (rlm_sql.c generate_sql_clients row[5], main/client.c client_add): a virtual server that does not exist refuses the client with the message above; an existing one adds it to the global list (the listener `clients =` list is not modelled, see TODO). Of the 9 cases, the one with the unknown server falls on git stash of src/network; the existing-server case is a witness that passes either way.
 *
 * Discriminated with git stash on src/network: 4 of 7 fall before the fix; the witness (a client of clients.conf still works) and the two refusals (a wrong secret, and the run without
 * read_clients) pass either way: the requests are not served for the wrong reason, and they only mean something next to their positive twins.
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
const SQL_MODULE = '/etc/freeradius/3.0/mods-enabled/sql';

const MODULE = (extra: string[]) => ['sql {', '  driver = "rlm_sql_oracle"', '  dialect = "oracle"', '  radius_db = "//10.0.0.2/ORCL"', '  login = "system"', '  password = "oracle"', ...extra, '}', ''].join('\n');
const QUERY = '  client_query = "SELECT id, nasname, shortname, type, secret, server FROM system.nas"';

async function lab(rows: string[], extra = ['  read_clients = yes', QUERY]) {
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
  far.processLine('CREATE TABLE system.nas (id NUMBER, nasname VARCHAR2(128), shortname VARCHAR2(32), type VARCHAR2(30), secret VARCHAR2(60), server VARCHAR2(64));');
  rows.forEach((row, index) => far.processLine(`INSERT INTO system.nas VALUES (${index + 1}, ${row});`));
  far.processLine('COMMIT;');
  far.dispose();
  write(radius, USERS_FILE_PATH, 'alice Cleartext-Password := "pw"\n');
  write(radius, SQL_MODULE, MODULE(extra));
  const started = await radius.executeCommand('systemctl restart freeradius');
  return { radius, dbhost, client, started };
}

const ask = (client: LinuxServer, secret: string) => client.executeCommand(`printf 'User-Name = "alice"\\nUser-Password = "pw"\\n' | radclient -x 10.0.0.3 auth ${secret}`);
const accepted = (output: string) => output.includes('Received Access-Accept');

describe('rlm_sql: read_clients', () => {
  it('witness: a client of clients.conf (localhost) is still known with the module loaded', async () => {
    const { radius, started } = await lab(["'10.0.0.1', 'lab', 'other', 'sqlsecret', ''"]);
    expect(started).not.toContain('Failed');
    expect(await radius.executeCommand("printf 'User-Name = \"alice\"\\nUser-Password = \"pw\"\\n' | radclient -x 127.0.0.1 auth testing123")).toContain('Received Access-Accept');
  });

  it('a NAS of the nas table is a client: its request is served with the row secret', async () => {
    const { client } = await lab(["'10.0.0.1', 'lab', 'other', 'sqlsecret', ''"]);
    expect(accepted(await ask(client, 'sqlsecret'))).toBe(true);
  });

  it('with another secret the request is refused: the row secret decides', async () => {
    const { client } = await lab(["'10.0.0.1', 'lab', 'other', 'sqlsecret', ''"]);
    expect(accepted(await ask(client, 'wrong'))).toBe(false);
  });

  it('a CIDR nasname is a network of clients', async () => {
    const { client } = await lab(["'10.0.0.0/24', 'lan', 'other', 'netsecret', ''"]);
    expect(accepted(await ask(client, 'netsecret'))).toBe(true);
  });

  it('without read_clients the table is not read: the same NAS is unknown', async () => {
    const { client } = await lab(["'10.0.0.1', 'lab', 'other', 'sqlsecret', ''"], [QUERY]);
    expect(accepted(await ask(client, 'sqlsecret'))).toBe(false);
  });

  it('a row with an address the grammar refuses is logged and skipped, the others are kept', async () => {
    const { client, radius } = await lab(["'not-an-address', 'bad', 'other', 'x', ''", "'10.0.0.1', 'lab', 'other', 'sqlsecret', ''"]);
    expect(accepted(await ask(client, 'sqlsecret'))).toBe(true);
    expect(await radius.executeCommand('cat /var/log/freeradius/radius.log')).toContain('Failed parsing client address "not-an-address"');
  });

  it('read_clients without a client_query is a configuration error', async () => {
    const { started } = await lab([], ['  read_clients = yes']);
    expect(started).toContain('read_clients is set but no client_query is configured');
  });

  it('a row naming an existing virtual server is a client', async () => {
    const { client } = await lab(["'10.0.0.1', 'lab', 'other', 'sqlsecret', 'default'"]);
    expect(accepted(await ask(client, 'sqlsecret'))).toBe(true);
  });

  it('a row naming a virtual server that does not exist is logged and the client is not added', async () => {
    const { client, radius } = await lab(["'10.0.0.1', 'lab', 'other', 'sqlsecret', 'ghost'"]);
    expect(accepted(await ask(client, 'sqlsecret'))).toBe(false);
    expect(await radius.executeCommand('cat /var/log/freeradius/radius.log')).toContain('Cannot add client - virtual server ghost does not exist');
  });
});
