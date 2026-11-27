/*
 * Probe: rlm_sql, session brick. `sql` in the session section was refused at load, so the simultaneous-use limit could only be counted from the local radutmp file, never from
 * the accounting table a real deployment keeps. Source of truth: FreeRADIUS v3.2.x src/modules/rlm_sql/rlm_sql.c (sql_checksimul: SQL-User-Name is the expansion of
 * sql_user_name, simul_count_query returns the number of open sessions of the user in its first column; the server compares it to Simultaneous-Use and refuses the login with
 * "Multiple logins (max n)" when the count reaches the limit; no simul_count_query is a noop), raddb/mods-config/sql/main/oracle/queries.conf (simul_count_query = "SELECT COUNT(*)
 * FROM radacct WHERE UserName = '%{SQL-User-Name}' AND AcctStopTime IS NULL"). The count is read over a real Oracle Net session to another host, counted on its port. Limit
 * recorded in TODO.md: simul_verify_query (the per-session check of the NAS) and delete_stale_sessions are accepted and not evaluated; a NAS declared as type other, the only
 * one the server already supports for the radutmp count, is trusted as the real server trusts it.
 *
 * Discriminated with git stash on src/network: 4 of 6 fall before the fix, the witness included (with `sql` in the session section the old loader refused the site, so every
 * request failed). The two that pass either way, with their reason: the limit of 2 with two open sessions (refused, but because nothing was served) and the run without
 * sql in the session section (accepted by the old code too); they only mean something next to their twins. That the count comes from the other host is shown by the refusal
 * itself: the open session exists only in the Oracle instance of the database host.
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

const MODULE = (extra = '') => [
  'sql {',
  '  driver = "rlm_sql_oracle"',
  '  dialect = "oracle"',
  '  radius_db = "//10.0.0.2/ORCL"',
  '  login = "system"',
  '  password = "oracle"',
  '  simul_count_query = "SELECT COUNT(*) FROM system.radacct WHERE username = \'%{SQL-User-Name}\' AND acctstoptime IS NULL"',
  extra,
  '}',
  '',
].join('\n');

async function lab(open: string[], limit = 1, callSql = true, extra = '') {
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
  far.processLine('CREATE TABLE system.radacct (username VARCHAR2(64), acctsessionid VARCHAR2(64), acctstoptime DATE);');
  open.forEach((row, index) => far.processLine(`INSERT INTO system.radacct VALUES ('${row}', 'S${index}', NULL);`));
  far.processLine('COMMIT;');
  far.dispose();
  write(radius, CLIENTS_CONF_PATH, 'client lab {\n  ipaddr = 10.0.0.1\n  secret = shared\n}\n');
  write(radius, USERS_FILE_PATH, `alice Cleartext-Password := "pw", Simultaneous-Use := ${limit}\nbob Cleartext-Password := "pw", Simultaneous-Use := ${limit}\n`);
  write(radius, SQL_MODULE, MODULE(extra));
  if (callSql) write(radius, SITE, (vfsOf(radius).readFile(SITE) ?? '').replace('\tsession {\n\t\tradutmp\n\t}\n', '\tsession {\n\t\tsql\n\t}\n'));
  const started = await radius.executeCommand('systemctl restart freeradius');
  return { radius, dbhost, client, started };
}

const ask = (client: LinuxServer, user = 'alice') => client.executeCommand(`printf 'User-Name = "${user}"\\nUser-Password = "pw"\\n' | radclient -x 10.0.0.3 auth shared`);
const accepted = (output: string) => output.includes('Received Access-Accept');

describe('rlm_sql: session (simultaneous use)', () => {
  it('witness: limit 1, no open session anywhere: the login is accepted', async () => {
    const { client, started } = await lab([]);
    expect(started).not.toContain('Failed');
    expect(accepted(await ask(client))).toBe(true);
  });

  it('an open session in the accounting table reaches the limit: the login is refused with the Multiple logins message', async () => {
    const { client } = await lab(['alice']);
    const output = await ask(client);
    expect(accepted(output)).toBe(false);
    expect(output).toContain('You are already logged in - access denied');
  });

  it('a limit of 2 with one open session still accepts', async () => {
    const { client } = await lab(['alice'], 2);
    expect(accepted(await ask(client))).toBe(true);
  });

  it('a limit of 2 with two open sessions refuses', async () => {
    const { client } = await lab(['alice', 'alice'], 2);
    expect(accepted(await ask(client))).toBe(false);
  });

  it('the sessions of another user are not counted', async () => {
    const { client } = await lab(['bob']);
    expect(accepted(await ask(client, 'alice'))).toBe(true);
    expect(accepted(await ask(client, 'bob'))).toBe(false);
  });

  it('without sql in the session section the table is not read: the same open session does not refuse', async () => {
    const { client } = await lab(['alice'], 1, false);
    expect(accepted(await ask(client))).toBe(true);
  });
});
