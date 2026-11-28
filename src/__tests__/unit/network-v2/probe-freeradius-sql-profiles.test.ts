/*
 * Probe: rlm_sql profiles. read_profiles and default_user_profile were accepted and ignored, and the User-Profile attribute meant nothing. Source of truth: FreeRADIUS v3.2.x
 * src/modules/rlm_sql/rlm_sql.c (mod_authorize and rlm_sql_process_groups, read from the source): the groups are read when the user reply carries Fall-Through = Yes, or read_groups
 * is yes and no Fall-Through was given; a group reply sets the state again (its Fall-Through, else the default) and the loop goes on only while it is Yes; then the profile is read
 * when the state is Yes, or read_profiles is yes and it is the default. The profile is the User-Profile of the check items, else default_user_profile; it is processed as a USER
 * NAME: SQL-User-Name becomes the profile, group_membership_query lists the groups of that name, and each group is read with authorize_group_check_query and
 * authorize_group_reply_query. raddb/mods-available/sql (read_profiles = yes, default_user_profile = ""). The rows become the same users-file entries, chained so that every
 * one the module decided to read is applied.
 *
 * Discriminated with git stash on src/network (authorize and profiles files together): 5 of 24 fall, among them the profile read as a user name, default_user_profile through the
 * membership table and the profile reached without Fall-Through.
 *
 * Earlier revisions of this probe read the profile as a group name and stopped the chain without Fall-Through: both premises were wrong against the source, fixed with it.
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
  "INSERT INTO system.radcheck VALUES (1, 'plain', 'Cleartext-Password', 'pw', ':=')",
  "INSERT INTO system.radcheck VALUES (2, 'erin', 'Cleartext-Password', 'pw', ':=')",
  "INSERT INTO system.radcheck VALUES (3, 'erin', 'User-Profile', 'gold', ':=')",
  "INSERT INTO system.radreply VALUES (1, 'erin', 'Fall-Through', 'Yes', ':=')",
  "INSERT INTO system.radcheck VALUES (4, 'frank', 'Cleartext-Password', 'pw', ':=')",
  "INSERT INTO system.radcheck VALUES (5, 'frank', 'User-Profile', 'gold', ':=')",
  "INSERT INTO system.radreply VALUES (2, 'frank', 'Fall-Through', 'No', ':=')",
  "INSERT INTO system.radcheck VALUES (6, 'gina', 'Cleartext-Password', 'pw', ':=')",
  "INSERT INTO system.radcheck VALUES (7, 'gina', 'User-Profile', 'gold', ':=')",
  "INSERT INTO system.radusergroup VALUES ('gold', 'goldgrp', 1)",
  "INSERT INTO system.radgroupreply VALUES (1, 'goldgrp', 'Reply-Message', 'gold profile', ':=')",
  "INSERT INTO system.radusergroup VALUES ('silver', 'silvergrp', 1)",
  "INSERT INTO system.radgroupcheck VALUES (1, 'silvergrp', 'Cleartext-Password', 'silverpw', ':=')",
  "INSERT INTO system.radgroupreply VALUES (2, 'silvergrp', 'Reply-Message', 'silver default', ':=')",
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

describe('rlm_sql: profiles', () => {
  it('witness: a user with no profile authenticates', async () => {
    const { client, started } = await lab();
    expect(started).not.toContain('Failed');
    expect(accepted(await ask(client, 'plain'))).toBe(true);
  });

  it('the User-Profile of the check items names a profile: the groups of that name are read', async () => {
    const { client } = await lab();
    const output = await ask(client, 'erin');
    expect(accepted(output)).toBe(true);
    expect(message(output)).toBe('gold profile');
  });

  it('Fall-Through = No in the user reply ends the chain: the profile is not read', async () => {
    const { client } = await lab();
    const output = await ask(client, 'frank');
    expect(accepted(output)).toBe(true);
    expect(message(output)).toBeUndefined();
  });

  it('default_user_profile applies to a user with no entry: its check items authenticate and its reply is returned', async () => {
    const { client } = await lab(true, '  default_user_profile = "silver"');
    const output = await ask(client, 'newcomer', 'silverpw');
    expect(accepted(output)).toBe(true);
    expect(message(output)).toBe('silver default');
  });

  it('without default_user_profile the same newcomer is unknown: refused', async () => {
    const { client } = await lab();
    expect(accepted(await ask(client, 'newcomer', 'silverpw'))).toBe(false);
  });

  it('read_profiles = no ignores the User-Profile and the default of a user without Fall-Through', async () => {
    const { client } = await lab(true, '  read_profiles = no\n  default_user_profile = "silver"');
    expect(accepted(await ask(client, 'newcomer', 'silverpw'))).toBe(false);
    expect(message(await ask(client, 'gina'))).toBeUndefined();
  });

  it('Fall-Through = Yes whose group step finds no group falls back to the default state: read_profiles = no then ends the chain', async () => {
    const { client } = await lab(true, '  read_profiles = no');
    expect(message(await ask(client, 'erin'))).toBeUndefined();
  });

  it('a user without Fall-Through reads its profile by default, as read_profiles is yes', async () => {
    const { client } = await lab();
    expect(message(await ask(client, 'gina'))).toBe('gold profile');
  });
});
