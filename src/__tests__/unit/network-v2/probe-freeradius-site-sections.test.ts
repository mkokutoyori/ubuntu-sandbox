/*
 * Probe: the processing sections of a site were not read, so a request went through one fixed chain whatever the site said. Source of
 * truth: FreeRADIUS v3.2.x raddb/sites-available/default (the sections authorize, authenticate, preacct, accounting, session and the
 * modules each lists), src/main/auth.c (no Auth-Type found: the request is rejected; the Auth-Type is set by the pap, chap, mschap
 * and eap modules from the request, then looked up in authenticate), src/main/modules.c (process_checksimul runs the session section:
 * without radutmp there it counts nothing and lets the login in), rlm_files (the users file is read only if `files` is called in
 * authorize), rlm_logintime and rlm_preprocess (only if listed), rlm_detail and rlm_radutmp (in accounting), policy.d/accounting
 * (acct_unique in preacct is what adds Acct-Unique-Session-Id), and src/main/modules.c for the refusals ("Failed to find module").
 * The simulator reads the module NAMES of each section (and of an Auth-Type subsection); a module left out is not run. The unlang
 * constructs (update, if, switch, redundant...) and the modules the simulator does not have are refused naming them, never ignored.
 *
 * Discriminated with git stash on src: 12 of 14 fall before the fix; two pass either way and are named: the witness (the default site,
 * whose sections list every module the simulator runs, behaves as before) and the shipped status site (its authorize with an
 * Autz-Type loads before as after).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { EventBus } from '@/events/EventBus';
import { MACAddress, IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import type { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';
import { CLIENTS_CONF_PATH, USERS_FILE_PATH } from '@/network/devices/linux/freeradius/RadiusdService';

beforeEach(() => { resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset(); });

const vfsOf = (server: LinuxServer) => (server as unknown as { executor: { vfs: VirtualFileSystem } }).executor.vfs;
const write = (server: LinuxServer, path: string, content: string) => { vfsOf(server).writeFile(path, content, 0, 0, 0o022); };

async function lab(clientIp = '10.0.0.1', users = 'alice Cleartext-Password := "wonderland"\n') {
  const bus = new EventBus();
  const client = new LinuxServer('linux-server', 'CLIENT');
  const target = new LinuxServer('linux-server', 'TARGET');
  const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
  client.setEventBus(bus); target.setEventBus(bus); sw.setEventBus(bus);
  new Cable('a').connect(client.getPort('eth0')!, sw.getPort('FastEthernet0/1')!);
  new Cable('b').connect(target.getPort('eth0')!, sw.getPort('FastEthernet0/2')!);
  client.configureInterface('eth0', new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
  target.configureInterface('eth0', new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));
  write(target, CLIENTS_CONF_PATH, `client lab {\n  ipaddr = ${clientIp}\n  secret = shared\n}\n`);
  write(target, USERS_FILE_PATH, users);
  await target.executeCommand('systemctl reload freeradius');
  return { client, target };
}

async function run(server: LinuxServer, command: string) {
  const output = await server.executeCommand(command);
  const code = (await server.executeCommand('echo $?')).trim();
  return { output: output.trim(), code };
}

const SITES = '/etc/freeradius/3.0/sites-available/default';
const PRE = '/etc/freeradius/3.0/mods-config/preprocess';
const ALICE = `printf 'User-Name = "alice"\\nUser-Password = "wonderland"\\n' | radclient 10.0.0.2 auth shared`;
const ALICE_CHAP = `printf 'User-Name = "alice"\\nCHAP-Password = "wonderland"\\n' | radclient 10.0.0.2 auth shared`;
const ZED = `printf 'User-Name = "zed"\\nUser-Password = "pppsecret"\\n' | radclient 10.0.0.2 auth shared`;
const ACCT = (user: string, session: string) => `printf 'User-Name = "${user}"\\nAcct-Status-Type = Start\\nAcct-Session-Id = "${session}"\\nNAS-IP-Address = 10.0.0.1\\nNAS-Port = 1\\n' | radclient 10.0.0.2 acct shared`;
const site = (target: LinuxServer) => vfsOf(target).readFile(SITES) ?? '';
const without = (module: string, section: string) => (text: string) =>
  text.replace(new RegExp(`(\\t${section} \\{[\\s\\S]*?\\n\\t\\})`), (block) => block.split('\n').filter((line) => line.trim() !== module).join('\n'));

async function labWith(users: string, edit: (text: string) => string = (text) => text, extra: (target: LinuxServer) => void = () => undefined) {
  const made = await lab('10.0.0.1', users);
  write(made.target, SITES, edit(site(made.target)));
  extra(made.target);
  await made.target.executeCommand('systemctl restart freeradius');
  return made;
}

const ALICE_USER = 'alice Cleartext-Password := "wonderland"\n';

describe('the processing sections of a site', () => {
  it('witness: the default site runs every module the simulator has: a login is accepted by pap and chap', async () => {
    const { client } = await labWith(ALICE_USER);
    expect(await client.executeCommand(ALICE)).toContain('Received Access-Accept');
    expect(await client.executeCommand(ALICE_CHAP)).toContain('Received Access-Accept');
  });

  it('without files in authorize the users file is not read: the right login is rejected', async () => {
    const { client } = await labWith(ALICE_USER, without('files', 'authorize'));
    expect(await client.executeCommand(ALICE)).toContain('Received Access-Reject');
  });

  it('without pap in authorize, or without the PAP Auth-Type in authenticate, PAP is rejected', async () => {
    const noAuthorize = await labWith(ALICE_USER, without('pap', 'authorize'));
    expect(await noAuthorize.client.executeCommand(ALICE)).toContain('Received Access-Reject');
    const noAuthenticate = await labWith(ALICE_USER, (text) => text.replace('\t\tAuth-Type PAP {\n\t\t\tpap\n\t\t}\n', ''));
    expect(await noAuthenticate.client.executeCommand(ALICE)).toContain('Received Access-Reject');
  });

  it('without chap CHAP is rejected and PAP is not affected', async () => {
    const { client } = await labWith(ALICE_USER, without('chap', 'authorize'));
    expect(await client.executeCommand(ALICE_CHAP)).toContain('Received Access-Reject');
    expect(await client.executeCommand(ALICE)).toContain('Received Access-Accept');
  });

  it('without logintime a Login-Time of the users file is not enforced', async () => {
    const users = 'alice Cleartext-Password := "wonderland", Login-Time := "Wk0900-1700"\n';
    const setClock = (target: LinuxServer) => { void target.executeCommand('date -s "2030-01-02 20:00:00" >/dev/null'); };
    const enforced = await labWith(users, (text) => text, setClock);
    await enforced.target.executeCommand('date -s "2030-01-02 20:00:00" >/dev/null');
    expect(await enforced.client.executeCommand(ALICE)).toContain('Received Access-Reject');
    const ignored = await labWith(users, without('logintime', 'authorize'));
    await ignored.target.executeCommand('date -s "2030-01-02 20:00:00" >/dev/null');
    expect(await ignored.client.executeCommand(ALICE)).toContain('Received Access-Accept');
  });

  it('without preprocess in authorize the hints file does not apply', async () => {
    const users = 'DEFAULT Hint == "PPP", Cleartext-Password := "pppsecret"\n';
    const hints = (target: LinuxServer) => write(target, `${PRE}/hints`, 'DEFAULT NAS-IP-Address == 10.0.0.1\n\tHint = "PPP"\n');
    const applied = await labWith(users, (text) => text, hints);
    expect(await applied.client.executeCommand(ZED)).toContain('Received Access-Accept');
    const skipped = await labWith(users, without('preprocess', 'authorize'), hints);
    expect(await skipped.client.executeCommand(ZED)).toContain('Received Access-Reject');
  });

  it('without radutmp in session Simultaneous-Use lets the login in; without it in accounting no session is recorded', async () => {
    const users = 'alice Cleartext-Password := "wonderland", Simultaneous-Use := 1\n';
    const enforced = await labWith(users);
    await enforced.client.executeCommand(ACCT('alice', 's1'));
    expect(await enforced.client.executeCommand(ALICE)).toContain('Received Access-Reject');
    const noSession = await labWith(users, without('radutmp', 'session'));
    await noSession.client.executeCommand(ACCT('alice', 's1'));
    expect(await noSession.client.executeCommand(ALICE)).toContain('Received Access-Accept');
    const noAccounting = await labWith(users, without('radutmp', 'accounting'));
    await noAccounting.client.executeCommand(ACCT('alice', 's1'));
    expect(await noAccounting.client.executeCommand(ALICE)).toContain('Received Access-Accept');
    expect(await noAccounting.target.executeCommand('radwho')).not.toContain('alice');
  });

  it('without detail in accounting no detail file is written', async () => {
    const { client, target } = await labWith(ALICE_USER, without('detail', 'accounting'));
    await client.executeCommand(ACCT('alice', 's1'));
    expect(await target.executeCommand('ls /var/log/freeradius/radacct 2>&1')).not.toContain('10.0.0.1');
  });

  it('without acct_unique in preacct the detail entry has no Acct-Unique-Session-Id', async () => {
    const { client, target } = await labWith(ALICE_USER, without('acct_unique', 'preacct'));
    await client.executeCommand(ACCT('alice', 's1'));
    const dir = '/var/log/freeradius/radacct/10.0.0.1';
    const name = (await target.executeCommand(`ls ${dir}`)).trim().split(/\s+/).find((entry) => entry.startsWith('detail-')) ?? '';
    const text = vfsOf(target).readFile(`${dir}/${name}`) ?? '';
    expect(text).toContain('Acct-Session-Id = "s1"');
    expect(text).not.toContain('Acct-Unique-Session-Id');
  });

  it('reject in authorize rejects every request', async () => {
    const { client } = await labWith(ALICE_USER, (text) => text.replace('\t\tpap\n\t}\n\n\tauthenticate', '\t\tpap\n\t\treject\n\t}\n\n\tauthenticate'));
    expect(await client.executeCommand(ALICE)).toContain('Received Access-Reject');
  });

  it('an unlang construct is refused naming it, with its file and line', async () => {
    const { target } = await lab();
    write(target, SITES, site(target).replace('\tauthorize {\n', '\tauthorize {\n\t\tupdate control {\n\t\t}\n'));
    const error = (target.getRadiusd().checkConfig() as { error: string }).error;
    expect(error).toMatch(/^\/etc\/freeradius\/3\.0\/sites-enabled\/default\[\d+\]: The unlang construct "update" is not implemented in this simulator$/);
  });

  it('a module the real server has and this one has not is refused naming it; an optional one (-ldap) is skipped', async () => {
    const { target } = await lab();
    write(target, SITES, site(target).replace('\t\tpreprocess\n\t\tchap', '\t\tpreprocess\n\t\tsql\n\t\tchap'));
    expect((target.getRadiusd().checkConfig() as { error: string }).error).toMatch(/The module "sql" is not implemented in this simulator$/);
    write(target, SITES, site(target).replace('\t\tsql\n', '\t\t-ldap\n'));
    expect(target.getRadiusd().checkConfig()).toEqual({ ok: true });
  });

  it('a module that exists nowhere is refused in the words of the server', async () => {
    const { target } = await lab();
    write(target, SITES, site(target).replace('\t\tpreprocess\n\t\tchap', '\t\tpreprocess\n\t\tbogus\n\t\tchap'));
    expect((target.getRadiusd().checkConfig() as { error: string }).error).toMatch(/\[\d+\]: Failed to find module "bogus"\.$/);
  });

  it('the shipped status site, whose authorize holds an Autz-Type with ok, loads', async () => {
    const { target } = await lab();
    await target.executeCommand('ln -s ../sites-available/status /etc/freeradius/3.0/sites-enabled/status');
    expect(target.getRadiusd().checkConfig()).toEqual({ ok: true });
  });
});
