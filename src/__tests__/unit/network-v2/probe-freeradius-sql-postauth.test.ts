/*
 * Probe: rlm_sql, post-auth brick. `sql` in the post-auth section was refused at load, so no authentication, accepted or refused, could be logged to an Oracle table (the
 * radpostauth table of the stock schema). Source of truth: FreeRADIUS v3.2.x src/modules/rlm_sql/rlm_sql.c (sql_postauth: the `query` entries of the module's post-auth
 * section are tried in order, the first that affects a row ends it), raddb/mods-config/sql/main/oracle/queries.conf (post-auth { query = "INSERT INTO ${..postauth_table}
 * (username, pass, reply, authdate) VALUES ('%{User-Name}', '%{%{User-Password}:-%{Chap-Password}}', '%{reply:Packet-Type}', ...)" }, `${..name}` the setting of the module
 * one level up), raddb/sites-available/default (sql in post-auth for accepted requests and in Post-Auth-Type REJECT for refused ones: %{reply:Packet-Type} is Access-Accept in
 * the first, Access-Reject in the second). The INSERT crosses a real Oracle Net session to another host and is committed, counted on its port.
 *
 * Discriminated with git stash on src/network: 4 of 5 fall before the fix; the witness (module loaded, not called, nothing logged) passes either way.
 * The unlang request now carries the DECRYPTED User-Password (the resolver was handed the wire form, so %{User-Password} logged 32 hex digits), as radiusd does after decoding.
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
  '  postauth_table = "system.radpostauth"',
  '  post-auth {',
  '    query = "INSERT INTO ${..postauth_table} (username, pass, reply, authdate) VALUES (\'%{User-Name}\', \'%{%{User-Password}:-%{Chap-Password}}\', \'%{reply:Packet-Type}\', TO_DATE(\'%S\', \'YYYY-MM-DD HH24:MI:SS\'))"',
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
  far.processLine('CREATE TABLE system.radpostauth (username VARCHAR2(64), pass VARCHAR2(64), reply VARCHAR2(32), authdate DATE);');
  far.dispose();
  write(radius, CLIENTS_CONF_PATH, 'client lab {\n  ipaddr = 10.0.0.1\n  secret = shared\n}\n');
  write(radius, USERS_FILE_PATH, 'alice Cleartext-Password := "pw"\n');
  write(radius, SQL_MODULE, MODULE);
  if (callSql) write(radius, SITE, (vfsOf(radius).readFile(SITE) ?? '').replace('\t\tPost-Auth-Type REJECT {\n\t\t}\n', '\t\tsql\n\t\tPost-Auth-Type REJECT {\n\t\t\tsql\n\t\t}\n'));
  const started = await radius.executeCommand('systemctl restart freeradius');
  return { radius, dbhost, client, started };
}

const quoted = (text: string) => text.replace(/'/g, "'\\''");
const ask = (client: LinuxServer, user: string, password = 'pw') => client.executeCommand(`printf 'User-Name = "${quoted(user)}"\\nUser-Password = "${password}"\\n' | radclient -x 10.0.0.3 auth shared`);
const logged = (dbhost: LinuxServer, where = '1 = 1') => dbhost.executeCommand(`sqlplus -s / as sysdba <<'E'\nSELECT username || '|' || pass || '|' || reply || '|' || TO_CHAR(authdate, 'YYYY') AS line FROM system.radpostauth WHERE ${where} ORDER BY 1;\nE`);

describe('rlm_sql: post-auth', () => {
  it('witness: the module is loaded, not called, the user authenticates and nothing is logged', async () => {
    const { client, dbhost, started } = await lab(false);
    expect(started).not.toContain('Failed');
    expect((await ask(client, 'alice')).includes('Received Access-Accept')).toBe(true);
    expect(await logged(dbhost)).toContain('no rows selected');
  });

  it('an accepted request is logged with Access-Accept and the SQL-format date, read over the wire', async () => {
    const { client, dbhost } = await lab();
    const port = dbhost.getPorts()[0];
    const before = port.getCounters().bytesIn;
    expect((await ask(client, 'alice')).includes('Received Access-Accept')).toBe(true);
    expect(port.getCounters().bytesIn).toBeGreaterThan(before);
    expect(await logged(dbhost)).toMatch(/alice\|pw\|Access-Accept\|20\d\d/);
  });

  it('a refused request is logged by the Post-Auth-Type REJECT group with Access-Reject', async () => {
    const { client, dbhost } = await lab();
    expect((await ask(client, 'alice', 'wrong')).includes('Received Access-Reject')).toBe(true);
    expect(await logged(dbhost)).toMatch(/alice\|wrong\|Access-Reject\|20\d\d/);
  });

  it('an unknown user is refused and logged too', async () => {
    const { client, dbhost } = await lab();
    await ask(client, 'nobody', 'x');
    expect(await logged(dbhost, "username = 'nobody'")).toMatch(/nobody\|x\|Access-Reject\|20\d\d/);
  });

  it('a value with a quote is escaped: logged as =27, no SQL error', async () => {
    const { client, dbhost, radius } = await lab();
    await ask(client, "o'brien", 'x');
    expect(await logged(dbhost, "pass = 'x'")).toContain("o=27brien|x|Access-Reject");
    expect(await radius.executeCommand('cat /var/log/freeradius/radius.log')).not.toContain('SQL query failed');
  });
});
