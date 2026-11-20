/*
 * Probe: post-auth was a name list and the expansion %{...} was refused. Source of truth: FreeRADIUS v3.2.x src/main/auth.c
 * rad_postauth (the post-auth section runs after the decision: for an accepted request the section itself, with its
 * Post-Auth-Type sub-sections skipped; for a rejected one "Using Post-Auth-Type Reject" and ONLY the Post-Auth-Type REJECT group;
 * either may change the reply list, which is what is sent; "# Executing section post-auth ...", "# Executing group from file ..."),
 * src/main/xlat.c (%{Attr}, %{list:Attr}, the alternative %{%{A}:-B}; the functions %{md5:...} are separate modules), the
 * expansion already used by the detail module (one expander, Xlat.ts, shared). The expansion is run for the quoted values of update
 * and of conditions, at run time, on the request context.
 *
 * Discriminated with git stash on src: 10 of 11 fall before the fix; the one that passes either way is the accepted-request case
 * with no post-auth statement (the reply is the users file's, before as after).
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
const request = (user: string, password: string, extra = '') => `printf 'User-Name = "${user}"\\nUser-Password = "${password}"\\n${extra}' | radclient -x 10.0.0.2 auth shared`;
const site = (target: LinuxServer) => vfsOf(target).readFile(SITES) ?? '';
const POST = '\tpost-auth {\n\t\tPost-Auth-Type REJECT {\n\t\t}\n\t}';
const postAuth = (body: string[]) => (text: string) => text.replace(POST, ['\tpost-auth {', ...body, '\t}'].join('\n'));
const inAuthorize = (statements: string[]) => (text: string) => text.replace('\t\tpap\n\t}', `${statements.join('\n')}\n\t\tpap\n\t}`);
const USERS = 'alice Cleartext-Password := "wonderland"\n\tReply-Message = "hi"\n';

async function labWith(users: string, edit: (text: string) => string = (text) => text) {
  const made = await lab('10.0.0.1', users);
  write(made.target, SITES, edit(site(made.target)));
  await made.target.executeCommand('systemctl restart freeradius');
  return made;
}

describe('expansions and the post-auth program', () => {
  it('witness: a request with no post-auth statement gets the reply of the users file', async () => {
    const { client } = await labWith(USERS);
    expect(await client.executeCommand(request('alice', 'wonderland'))).toContain('Reply-Message = "hi"');
  });

  it('%{User-Name} in an update value is expanded at run time', async () => {
    const { client } = await labWith(USERS, inAuthorize(['\t\tupdate reply {', '\t\t\tReply-Message := "hello %{User-Name}"', '\t\t}']));
    expect(await client.executeCommand(request('alice', 'wonderland'))).toContain('Reply-Message = "hello alice"');
  });

  it('the alternative %{%{A}:-B} and a list-qualified attribute %{request:NAS-Port}', async () => {
    const { client } = await labWith(USERS, inAuthorize(['\t\tupdate reply {', '\t\t\tReply-Message := "%{%{Calling-Station-Id}:-nobody} on %{request:NAS-Port}"', '\t\t}']));
    expect(await client.executeCommand(request('alice', 'wonderland', 'NAS-Port = 7\\n'))).toContain('Reply-Message = "nobody on 7"');
  });

  it('an expansion in a condition string is expanded before the comparison', async () => {
    const { client } = await labWith(USERS, inAuthorize(['\t\tif (&User-Name == "%{User-Name}") {', '\t\t\tupdate reply {', '\t\t\t\tFilter-Id := "same"', '\t\t\t}', '\t\t}']));
    expect(await client.executeCommand(request('alice', 'wonderland'))).toContain('Filter-Id = "same"');
  });

  it('post-auth runs after the decision on an accepted request and changes the reply that is sent', async () => {
    const { client } = await labWith(USERS, postAuth(['\t\tupdate reply {', '\t\t\tReply-Message := "welcome %{User-Name}"', '\t\t}', '\t\tPost-Auth-Type REJECT {', '\t\t}']));
    const out = await client.executeCommand(request('alice', 'wonderland'));
    expect(out).toContain('Received Access-Accept');
    expect(out).toContain('Reply-Message = "welcome alice"');
    expect(out).not.toContain('Reply-Message = "hi"');
  });

  it('post-auth sees the reply list the earlier sections built', async () => {
    const { client } = await labWith(USERS, postAuth(['\t\tif (&reply:Reply-Message == "hi") {', '\t\t\tupdate reply {', '\t\t\t\tFilter-Id := "saw hi"', '\t\t\t}', '\t\t}']));
    expect(await client.executeCommand(request('alice', 'wonderland'))).toContain('Filter-Id = "saw hi"');
  });

  it('a rejected request runs only the Post-Auth-Type REJECT group, and its reply items are sent with the Access-Reject', async () => {
    const edit = postAuth(['\t\tupdate reply {', '\t\t\tFilter-Id := "accepted only"', '\t\t}', '\t\tPost-Auth-Type REJECT {', '\t\t\tupdate reply {', '\t\t\t\tReply-Message := "denied %{User-Name}"', '\t\t\t}', '\t\t}']);
    const { client } = await labWith(USERS, edit);
    const rejected = await client.executeCommand(request('alice', 'nope'));
    expect(rejected).toContain('Received Access-Reject');
    expect(rejected).toContain('Reply-Message = "denied alice"');
    expect(rejected).not.toContain('accepted only');
    const accepted = await client.executeCommand(request('alice', 'wonderland'));
    expect(accepted).toContain('Filter-Id = "accepted only"');
    expect(accepted).not.toContain('denied');
  });

  it('the -X trace shows the post-auth section of an accepted request and the REJECT group of a rejected one', async () => {
    const edit = postAuth(['\t\tupdate reply {', '\t\t\tFilter-Id := "x"', '\t\t}', '\t\tPost-Auth-Type REJECT {', '\t\t\tupdate reply {', '\t\t\t\tReply-Message := "no"', '\t\t\t}', '\t\t}']);
    const made = await labWith(USERS, edit);
    const lines: string[] = [];
    made.target.followRadiusDebug((line) => lines.push(line.replace(/^\(\d+\) /, '').trim()));
    await made.client.executeCommand(request('alice', 'wonderland'));
    expect(lines.some((line) => line.startsWith('# Executing section post-auth from file /etc/freeradius/3.0/sites-enabled/default line '))).toBe(true);
    expect(lines).toContain('post-auth {');
    expect(lines).toContain('} # post-auth = noop');
    expect(lines).toContain('&reply:Filter-Id := "x"');
    lines.length = 0;
    await made.client.executeCommand(request('alice', 'nope'));
    expect(lines).toContain('Using Post-Auth-Type Reject');
    expect(lines).toContain('Post-Auth-Type REJECT {');
    expect(lines).toContain('&reply:Reply-Message := "no"');
    expect(lines).toContain('} # Post-Auth-Type REJECT = noop');
    expect(lines).not.toContain('post-auth {');
  });

  it('a module in post-auth the simulator has not (reply_log) is refused naming it', async () => {
    const { target } = await lab();
    write(target, SITES, postAuth(['\t\treply_log'])(site(target)));
    expect((target.getRadiusd().checkConfig() as { error: string }).error).toMatch(/The module "reply_log" is not implemented in this simulator$/);
  });

  it('the shipped site has a post-auth section with an empty Post-Auth-Type REJECT, as the distribution does', async () => {
    const { target } = await lab();
    expect(site(target)).toContain(POST);
    expect(target.getRadiusd().checkConfig()).toEqual({ ok: true });
  });

  it('an expansion outside a string is refused naming it', async () => {
    const { target } = await lab();
    write(target, SITES, inAuthorize(['\t\tif (%{User-Name} == "a") {', '\t\t}'])(site(target)));
    expect((target.getRadiusd().checkConfig() as { error: string }).error).toMatch(/An expansion outside a string is not implemented in this simulator$/);
  });
});
