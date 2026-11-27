/*
 * Probe: unlang `map sql`. The construct was refused at load ("The unlang construct map is not implemented in this simulator"). Source of truth: FreeRADIUS v3.2.x unlang(5) map and
 * src/modules/rlm_sql/rlm_sql.c (mod_map_proc: the query is expanded with the module escape, only the FIRST row is used, each line of the block `&list:Attribute op 'column'` assigns
 * the value of the named column of that row to the attribute, a NULL or missing column is skipped, no row is noop, a query error is fail, at least one attribute written is
 * updated). The assignments go through the same code as `update` (operators, lists reply and control, attribute parsing), so one grammar answers both; the query crosses a real
 * Oracle Net session to another host. map sql is accepted in every processing section, with the name of a loaded sql module.
 *
 * Later extension to preacct, pre-proxy and post-proxy: the two cases covering them (pre-proxy loads, preacct runs) are the 2 of 12 that fall on git stash of src/network; the map-in-proxy host is wired the same way, only the load is observable without a proxy.
 *
 * Discriminated with git stash on src/network and src/adapters: 7 of 10 fall before the fix; the three that pass either way, with their reason: the witness (a users-file login with the
 * module loaded, no map) and two NEGATIVE assertions (the second row does not appear, a quote raises no SQL error), which hold when nothing is served; they only mean something next to
 * their positive twins.
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
const MODULE = ['sql {', '  driver = "rlm_sql_oracle"', '  dialect = "oracle"', '  radius_db = "//10.0.0.2/ORCL"', '  login = "system"', '  password = "oracle"', '}', ''].join('\n');

const ROWS = [
  "'alice', 'hello from the table', '10.9.8.7', NULL",
  "'alice', 'second row', '10.1.1.1', NULL",
  "'bob', 'bob only', NULL, NULL",
  "'carl', 'with password', NULL, 'carlpw'",
];

async function lab(block: string, users = 'alice Cleartext-Password := "pw"\nbob Cleartext-Password := "pw"\n', rewrite: (site: string) => string = (site) => site.replace('\t\tfiles\n', `\t\tfiles\n${block}`)) {
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
  far.processLine('CREATE TABLE system.profile (username VARCHAR2(64), msg VARCHAR2(64), framed_ip VARCHAR2(15), pw VARCHAR2(64));');
  for (const row of ROWS) far.processLine(`INSERT INTO system.profile VALUES (${row});`);
  far.processLine('COMMIT;');
  far.dispose();
  write(radius, CLIENTS_CONF_PATH, 'client lab {\n  ipaddr = 10.0.0.1\n  secret = shared\n}\n');
  write(radius, USERS_FILE_PATH, users);
  write(radius, SQL_MODULE, MODULE);
  write(radius, SITE, rewrite(vfsOf(radius).readFile(SITE) ?? ''));
  const started = await radius.executeCommand('systemctl restart freeradius');
  return { radius, dbhost, client, started };
}

const MAP = (extra = '') => `\t\tmap sql "SELECT msg, framed_ip, pw FROM system.profile WHERE username = '%{User-Name}'" {\n\t\t\t&reply:Reply-Message := 'msg'\n\t\t\t&reply:Framed-IP-Address := 'framed_ip'\n${extra}\t\t}\n`;
const ask = (client: LinuxServer, user = 'alice', password = 'pw') => client.executeCommand(`printf 'User-Name = "${user.replace(/'/g, "'\\''")}"\\nUser-Password = "${password}"\\n' | radclient -x 10.0.0.3 auth shared`);
const accepted = (output: string) => output.includes('Received Access-Accept');
const field = (output: string, name: string) => new RegExp(`${name} = "?([^"\\n]*)"?`).exec(output)?.[1];

describe('unlang: map sql', () => {
  it('witness: a users-file login works with the sql module loaded and no map', async () => {
    const { client, started } = await lab('');
    expect(started).not.toContain('Failed');
    expect(accepted(await ask(client))).toBe(true);
  });

  it('the first row sets the reply attributes named by its columns, read over the wire', async () => {
    const { client, dbhost } = await lab(MAP());
    const port = dbhost.getPorts()[0];
    const before = port.getCounters().bytesIn;
    const output = await ask(client);
    expect(accepted(output)).toBe(true);
    expect(port.getCounters().bytesIn).toBeGreaterThan(before);
    expect(field(output, 'Reply-Message')).toBe('hello from the table');
    expect(field(output, 'Framed-IP-Address')).toBe('10.9.8.7');
  });

  it('only the first row is used: the second row does not appear', async () => {
    const { client } = await lab(MAP());
    const output = await ask(client);
    expect(output).not.toContain('second row');
    expect(output).not.toContain('10.1.1.1');
  });

  it('a NULL column is skipped: the other attribute is still set', async () => {
    const { client } = await lab(MAP());
    const output = await ask(client, 'bob');
    expect(field(output, 'Reply-Message')).toBe('bob only');
    expect(output).not.toContain('Framed-IP-Address');
  });

  it('no row is a noop: the login succeeds without the attributes', async () => {
    const { client } = await lab(MAP(), 'zed Cleartext-Password := "pw"\n');
    const output = await ask(client, 'zed');
    expect(accepted(output)).toBe(true);
    expect(output).not.toContain('Reply-Message');
  });

  it('a column name is matched without regard to case', async () => {
    const { client } = await lab("\t\tmap sql \"SELECT msg FROM system.profile WHERE username = '%{User-Name}'\" {\n\t\t\t&reply:Reply-Message := 'MSG'\n\t\t}\n");
    expect(field(await ask(client), 'Reply-Message')).toBe('hello from the table');
  });

  it('the control list takes a column too: a password kept in the table authenticates', async () => {
    const { client } = await lab(MAP("\t\t\t&control:Cleartext-Password := 'pw'\n"), 'zed Cleartext-Password := "pw"\n');
    expect(accepted(await ask(client, 'carl', 'carlpw'))).toBe(true);
    expect(accepted(await ask(client, 'carl', 'wrong'))).toBe(false);
  });

  it('a quote in the user name is escaped: no SQL error', async () => {
    const { client, radius } = await lab(MAP(), 'zed Cleartext-Password := "pw"\n');
    await ask(client, "o'brien");
    expect(await radius.executeCommand('cat /var/log/freeradius/radius.log')).not.toContain('SQL query failed');
  });

  it('a query error is a failure, logged: the request is refused', async () => {
    const { client, radius } = await lab("\t\tmap sql \"SELECT msg FROM system.no_such_table\" {\n\t\t\t&reply:Reply-Message := 'msg'\n\t\t}\n");
    expect(accepted(await ask(client))).toBe(false);
    expect(await radius.executeCommand('cat /var/log/freeradius/radius.log')).toContain('SQL query failed');
  });

  it('an unknown processor is refused at load', async () => {
    const unknown = await lab("\t\tmap nosuch \"SELECT 1 FROM dual\" {\n\t\t\t&reply:Reply-Message := 'x'\n\t\t}\n");
    expect(unknown.started).toContain('Unknown map processor "nosuch"');
  });

  it('map sql loads in pre-proxy, where no sql module is called', async () => {
    const { started } = await lab('', undefined, (site) => site.replace('\tpre-proxy {\n\t}\n', `\tpre-proxy {\n${MAP()}\t}\n`));
    expect(started).not.toContain('Unknown map processor');
  });

  it('map sql runs in preacct: a failing query refuses the accounting request, a good one answers it', async () => {
    const acct = (client: LinuxServer) => client.executeCommand(`printf 'User-Name = "alice"\\nAcct-Session-Id = "S1"\\nAcct-Status-Type = Start\\nNAS-IP-Address = 10.0.0.1\\n' | radclient 10.0.0.3 acct shared`);
    const inPreacct = (block: string) => (site: string) => site.replace('\tpreacct {\n', `\tpreacct {\n${block}`);
    const bad = await lab('', undefined, inPreacct("\t\tmap sql \"SELECT msg FROM system.no_such_table\" {\n\t\t\t&control:Reply-Message := 'msg'\n\t\t}\n"));
    expect(await acct(bad.client)).not.toContain('Received Accounting-Response');
    const good = await lab('', undefined, inPreacct("\t\tmap sql \"SELECT msg FROM system.profile WHERE username = 'alice'\" {\n\t\t\t&control:Reply-Message := 'msg'\n\t\t}\n"));
    expect(await acct(good.client)).toContain('Received Accounting-Response');
  });
});
