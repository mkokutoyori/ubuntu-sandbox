/*
 * Probe: the unlang of a site (update, if / elsif / else) was refused, so a site could not be programmed. Source of truth:
 * FreeRADIUS v3.2.x src/main/modcall.c (MOD_UPDATE: "update %s {", each map printed, "} # update %s = noop"; MOD_IF / MOD_ELSIF /
 * MOD_ELSE: "if %s{", "if %s -> TRUE|FALSE", the children only when TRUE, the closing line only when the branch was taken, an
 * elsif or else skipped once an earlier branch was taken; the default actions: reject, fail, userlock, invalid and handled end the
 * section, ok, noop, updated and notfound do not; the keywords ok, reject, noop... as statements), src/main/map.c (the operators
 * = := += on the request, control and reply lists: = adds when the attribute is absent, := replaces, += adds), src/main/evaluate.c
 * (conditions: ==, !=, <, >, <=, >=, =~ and !~ with /regex/, &&, ||, !, parentheses, an attribute alone as an existence test) and
 * doc/unlang. The list is the context of ONE request: the modules of the section read and write it in order (files puts the
 * known-good password and the reply items into it, pap needs a known-good password there, an update control can supply one).
 * The expansion %{...}, switch, case, foreach, redundant, group, load-balance, map, return and break are refused naming them.
 *
 * Discriminated with git stash on src: 10 of 12 fall before the fix; two pass either way and are named: the witness (a site with
 * no unlang behaves as before) and the refusal of switch (refused before as after).
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
const inAuthorize = (statements: string[], before = '\t\tpap') => (text: string) =>
  text.replace(`\tauthorize {\n`, (head) => head).replace(new RegExp(`(\\tauthorize \\{[\\s\\S]*?)(\\n${before.replace(/\t/g, '\\t')}\\n)`), (_all, start: string, tail: string) => `${start}\n${statements.join('\n')}${tail}`);

async function labWith(users: string, edit: (text: string) => string = (text) => text) {
  const made = await lab('10.0.0.1', users);
  write(made.target, SITES, edit(site(made.target)));
  await made.target.executeCommand('systemctl restart freeradius');
  return made;
}

describe('unlang: update and if', () => {
  it('witness: a site without unlang behaves as before', async () => {
    const { client } = await labWith('alice Cleartext-Password := "wonderland"\n');
    expect(await client.executeCommand(request('alice', 'wonderland'))).toContain('Received Access-Accept');
  });

  it('update control supplies the known-good password: a user absent from the users file logs in with it', async () => {
    const { client } = await labWith('', inAuthorize(['\t\tupdate control {', '\t\t\tCleartext-Password := "hello"', '\t\t}']));
    expect(await client.executeCommand(request('bob', 'hello'))).toContain('Received Access-Accept');
    expect(await client.executeCommand(request('bob', 'wrong'))).toContain('Received Access-Reject');
  });

  it('if on the user name puts a reply item in the reply of that user only', async () => {
    const users = 'alice Cleartext-Password := "wonderland"\nzed Cleartext-Password := "pppsecret"\n';
    const { client } = await labWith(users, inAuthorize(['\t\tif (&User-Name == "alice") {', '\t\t\tupdate reply {', '\t\t\t\tReply-Message := "hi alice"', '\t\t\t}', '\t\t}']));
    expect(await client.executeCommand(request('alice', 'wonderland'))).toContain('Reply-Message = "hi alice"');
    expect(await client.executeCommand(request('zed', 'pppsecret'))).not.toContain('hi alice');
  });

  it('elsif and else: only the first branch whose condition holds is taken', async () => {
    const users = 'alice Cleartext-Password := "wonderland"\nzed Cleartext-Password := "pppsecret"\nbob Cleartext-Password := "builder"\n';
    const branches = ['\t\tif (&User-Name == "alice") {', '\t\t\tupdate reply {', '\t\t\t\tReply-Message := "A"', '\t\t\t}', '\t\t}', '\t\telsif (&User-Name == "zed") {', '\t\t\tupdate reply {', '\t\t\t\tReply-Message := "Z"', '\t\t\t}', '\t\t}', '\t\telse {', '\t\t\tupdate reply {', '\t\t\t\tReply-Message := "E"', '\t\t\t}', '\t\t}'];
    const { client } = await labWith(users, inAuthorize(branches));
    expect(await client.executeCommand(request('alice', 'wonderland'))).toContain('Reply-Message = "A"');
    expect(await client.executeCommand(request('zed', 'pppsecret'))).toContain('Reply-Message = "Z"');
    const other = await client.executeCommand(request('bob', 'builder'));
    expect(other).toContain('Reply-Message = "E"');
    expect(other).not.toContain('Reply-Message = "A"');
  });

  it('conditions: && || ! parentheses, a regular expression, an existence test and a numeric comparison', async () => {
    const users = 'alice Cleartext-Password := "wonderland"\n';
    const reply = (condition: string) => inAuthorize([`\t\tif (${condition}) {`, '\t\t\tupdate reply {', '\t\t\t\tReply-Message := "yes"', '\t\t\t}', '\t\t}']);
    const holds = async (condition: string) => (await (await labWith(users, reply(condition))).client.executeCommand(request('alice', 'wonderland', 'NAS-Port = 7\\n'))).includes('Reply-Message = "yes"');
    expect(await holds('&User-Name == "alice" && &NAS-Port == 7')).toBe(true);
    expect(await holds('&User-Name == "zed" || &NAS-Port == 7')).toBe(true);
    expect(await holds('!(&User-Name == "alice")')).toBe(false);
    expect(await holds('&User-Name =~ /^al/')).toBe(true);
    expect(await holds('&User-Name !~ /^al/')).toBe(false);
    expect(await holds('&NAS-Port')).toBe(true);
    expect(await holds('&Calling-Station-Id')).toBe(false);
    expect(await holds('&NAS-Port > 5 && &NAS-Port <= 7')).toBe(true);
  });

  it('update control Auth-Type := Reject in a taken branch rejects the user, and the reject keyword ends the section', async () => {
    const users = 'alice Cleartext-Password := "wonderland"\nzed Cleartext-Password := "pppsecret"\n';
    const rejectAuthType = inAuthorize(['\t\tif (&User-Name == "alice") {', '\t\t\tupdate control {', '\t\t\t\tAuth-Type := Reject', '\t\t\t}', '\t\t}']);
    const first = await labWith(users, rejectAuthType);
    expect(await first.client.executeCommand(request('alice', 'wonderland'))).toContain('Received Access-Reject');
    expect(await first.client.executeCommand(request('zed', 'pppsecret'))).toContain('Received Access-Accept');
    const keyword = await labWith(users, inAuthorize(['\t\tif (&User-Name == "zed") {', '\t\t\treject', '\t\t}']));
    expect(await keyword.client.executeCommand(request('zed', 'pppsecret'))).toContain('Received Access-Reject');
    expect(await keyword.client.executeCommand(request('alice', 'wonderland'))).toContain('Received Access-Accept');
  });

  it('update request adds an attribute the modules after it read: the users file matches on it', async () => {
    const users = 'DEFAULT Service-Type == Framed-User, Cleartext-Password := "framed"\n';
    const { client } = await labWith(users, (text) => text.replace('\t\tpreprocess\n', '\t\tpreprocess\n\t\tupdate request {\n\t\t\tService-Type := Framed-User\n\t\t}\n'));
    expect(await client.executeCommand(request('anyone', 'framed'))).toContain('Received Access-Accept');
  });

  it('the -X trace shows the statements: the if with its truth, the update with its items, the closing lines of a taken branch only', async () => {
    const made = await labWith('alice Cleartext-Password := "wonderland"\n', inAuthorize(['\t\tif (&User-Name == "alice") {', '\t\t\tupdate reply {', '\t\t\t\tReply-Message := "hi alice"', '\t\t\t}', '\t\t}', '\t\tif (&User-Name == "zed") {', '\t\t\treject', '\t\t}']));
    const lines: string[] = [];
    made.target.followRadiusDebug((line) => lines.push(line.replace(/^\(\d+\) /, '').trim()));
    await made.client.executeCommand(request('alice', 'wonderland'));
    const at = (text: string) => lines.indexOf(text);
    expect(at('if (&User-Name == "alice") {')).toBeGreaterThan(-1);
    expect(at('if (&User-Name == "alice")  -> TRUE')).toBeGreaterThan(at('if (&User-Name == "alice") {'));
    expect(at('update reply {')).toBeGreaterThan(at('if (&User-Name == "alice")  -> TRUE'));
    expect(lines).toContain('&reply:Reply-Message := "hi alice"');
    expect(lines).toContain('} # update reply = noop');
    expect(lines).toContain('} # if (&User-Name == "alice") = noop');
    expect(lines).toContain('if (&User-Name == "zed")  -> FALSE');
    expect(lines).not.toContain('} # if (&User-Name == "zed") = reject');
  });

  it('an expansion is refused naming it, with file and line', async () => {
    const { target } = await lab();
    write(target, SITES, inAuthorize(['\t\tupdate reply {', '\t\t\tReply-Message := "hello %{User-Name}"', '\t\t}'])(site(target)));
    expect((target.getRadiusd().checkConfig() as { error: string }).error).toMatch(/\[\d+\]: The expansion "%\{\.\.\.\}" is not implemented in this simulator$/);
  });

  it('an unknown attribute in update, an operator the simulator has not and a syntax error in a condition are refused with file and line', async () => {
    const { target } = await lab();
    const errorOf = (statements: string[]) => {
      write(target, SITES, inAuthorize(statements)(vfsOf(target).readFile('/etc/freeradius/3.0/sites-available/default') ?? ''));
      const error = (target.getRadiusd().checkConfig() as { error: string }).error;
      write(target, SITES, vfsOf(target).readFile(SITES)?.replace(statements.join('\n'), '') ?? '');
      return error;
    };
    expect(errorOf(['\t\tupdate reply {', '\t\t\tNo-Such-Attribute := "x"', '\t\t}'])).toMatch(/\[\d+\]: Unknown attribute "No-Such-Attribute"$/);
    expect(errorOf(['\t\tupdate reply {', '\t\t\tReply-Message -= "x"', '\t\t}'])).toMatch(/The operator "-=" in update is not implemented in this simulator$/);
    expect(errorOf(['\t\tif (&User-Name == ) {', '\t\t}'])).toMatch(/\[\d+\]: Syntax error in condition/);
  });

  it('elsif without an if, and the lists the simulator has not (session-state), are refused', async () => {
    const { target } = await lab();
    write(target, SITES, inAuthorize(['\t\telsif (&User-Name == "a") {', '\t\t}'])(site(target)));
    expect((target.getRadiusd().checkConfig() as { error: string }).error).toMatch(/"elsif" without a preceding "if"$/);
    write(target, SITES, inAuthorize(['\t\tupdate session-state {', '\t\t}'])(vfsOf(target).readFile('/etc/freeradius/3.0/sites-available/default')!.replace(/\t\telsif[\s\S]*?\t\t\}\n/, '')));
    expect((target.getRadiusd().checkConfig() as { error: string }).error).toMatch(/The attribute list "session-state" in update is not implemented in this simulator$/);
  });

  it('switch is still refused naming it', async () => {
    const { target } = await lab();
    write(target, SITES, inAuthorize(['\t\tswitch {', '\t\t}'])(site(target)));
    expect((target.getRadiusd().checkConfig() as { error: string }).error).toMatch(/The unlang construct "switch" is not implemented in this simulator$/);
  });
});
