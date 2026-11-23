/*
 * Probe: `switch`/`case`, `return`, `group`, `redundant`, `load-balance`, `redundant-load-balance`, the action table of a module call
 * (`files { notfound = return }`) and the expansion functions %{toupper:}, %{tolower:}, %{strlen:}, %{md5:}, %{sha1:} were refused or
 * rendered as nothing. Source of truth: FreeRADIUS v3.2.x doc/unlang (switch/case with a default case; return leaves the section;
 * group runs its statements; redundant takes the first child that does not fail; load-balance picks ONE child per request, here in
 * rotation; the default actions of modcall.c and the `rcode = return|continue|reject|N` override), doc/xlat. The simulator implements
 * return, continue and reject as actions; a numeric priority, `foreach`, `break` and `map` are refused naming them. The trace prints
 * `switch EXPR {`, `case VALUE {` (`case {` for the default) and the group keywords; their exact text was read from the docs, not from a capture.
 *
 * Discriminated with git stash on src: 10 of 11 fall before the fix; the one passing either way is the witness that an update still
 * works in the default site.
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
const ENABLED = '/etc/freeradius/3.0/sites-enabled/default';
const ALICE = (password: string) => `printf 'User-Name = "alice"\\nUser-Password = "${password}"\\n' | radclient 10.0.0.2 auth shared`;
const site = (target: LinuxServer) => vfsOf(target).readFile(SITES) ?? '';
const lineOf = (target: LinuxServer, text: string) => site(target).split('\n').findIndex((line) => line.trim() === text) + 1;

async function traced(users: string, command: (c: string) => string, edit: (text: string) => string = (text) => text) {
  const made = await lab('10.0.0.1', users);
  write(made.target, SITES, edit(site(made.target)));
  await made.target.executeCommand('systemctl restart freeradius');
  const lines: string[] = [];
  made.target.followRadiusDebug((line) => lines.push(line.replace(/^\(\d+\) /, '')));
  await made.client.executeCommand(command('x'));
  return { ...made, lines };
}

const trim = (lines: string[]) => lines.map((line) => line.trim());
const indexOfTrimmed = (lines: string[], text: string) => trim(lines).indexOf(text);

const SITE_FILE = '/etc/freeradius/3.0/sites-available/default';

async function authorizing(extra: string, user: string, password: string, filesBlock = '\t\tfiles\n', send = true) {
  const made = await lab();
  write(made.target, SITE_FILE, (vfsOf(made.target).readFile(SITE_FILE) ?? '').replace('\t\tfiles\n', `${filesBlock}${extra}`));
  const restarted = await made.target.executeCommand('systemctl restart freeradius');
  const lines: string[] = [];
  made.target.followRadiusDebug((line) => lines.push(line.replace(/^\(\d+\) /, '').trim()));
  const output = send ? await made.client.executeCommand(`printf 'User-Name = "${user}"\\nUser-Password = "${password}"\\n' | radclient -x -r 1 10.0.0.2 auth shared`) : '';
  return { ...made, lines, output, restarted };
}
const reply = (message: string) => `\t\t\tupdate reply {\n\t\t\t\tReply-Message := "${message}"\n\t\t\t}\n`;
const accept = '\t\t\tupdate control {\n\t\t\t\tAuth-Type := Accept\n\t\t\t}\n';

describe('unlang constructs', () => {
  it('witness: an update reply written in authorize is sent', async () => {
    const { output } = await authorizing(`\t\tupdate reply {\n\t\t\tReply-Message := "plain"\n\t\t}\n`, 'alice', 'wonderland');
    expect(output).toContain('Reply-Message = "plain"');
  });

  it('return leaves the section: what follows it does not run', async () => {
    const { output } = await authorizing(`${reply('first')}\t\treturn\n${reply('second')}`, 'alice', 'wonderland');
    expect(output).toContain('Reply-Message = "first"');
    expect(output).not.toContain('Reply-Message = "second"');
  });

  it('return inside an if leaves the whole section', async () => {
    const { output } = await authorizing(`\t\tif (&User-Name == "alice") {\n${reply('inner')}\t\t\treturn\n\t\t}\n${reply('after')}`, 'alice', 'wonderland');
    expect(output).toContain('Reply-Message = "inner"');
    expect(output).not.toContain('"after"');
  });

  it('switch runs the case whose value equals the expression, else the default case', async () => {
    const block = (name: string) => `\t\tswitch &User-Name {\n\t\t\tcase "alice" {\n${reply('is-alice')}\t\t\t}\n\t\t\tcase "bob" {\n${reply('is-bob')}\t\t\t}\n\t\t\tcase {\n${reply('is-other')}${accept}\t\t\t}\n\t\t}\n`;
    expect((await authorizing(block('alice'), 'alice', 'wonderland')).output).toContain('Reply-Message = "is-alice"');
    expect((await authorizing(block('zed'), 'zed', 'x')).output).toContain('Reply-Message = "is-other"');
  });

  it('the trace prints the switch, the case taken and their results', async () => {
    const { lines } = await authorizing(`\t\tswitch &User-Name {\n\t\t\tcase "alice" {\n${reply('x')}\t\t\t}\n\t\t}\n`, 'alice', 'wonderland');
    expect(lines).toContain('switch &User-Name {');
    expect(lines).toContain('case alice {');
    expect(lines).toContain('} # case alice');
    expect(lines.some((line) => line.startsWith('} # switch &User-Name = '))).toBe(true);
  });

  it('group runs its statements in order', async () => {
    const { output } = await authorizing(`\t\tgroup {\n${reply('grouped')}\t\t}\n`, 'alice', 'wonderland');
    expect(output).toContain('Reply-Message = "grouped"');
  });

  it('redundant takes the first child that does not fail', async () => {
    const { output } = await authorizing(`\t\tredundant {\n\t\t\tfail\n\t\t\tok\n\t\t}\n\t\tif (ok) {\n${reply('second-child')}\t\t}\n`, 'alice', 'wonderland');
    expect(output).toContain('Reply-Message = "second-child"');
  });

  it('load-balance runs one child per request, in rotation', async () => {
    const made = await authorizing(`\t\tload-balance {\n\t\t\tupdate reply {\n\t\t\t\tReply-Message := "A"\n\t\t\t}\n\t\t\tupdate reply {\n\t\t\t\tReply-Message := "B"\n\t\t\t}\n\t\t}\n`, 'alice', 'wonderland');
    const second = await made.client.executeCommand(`printf 'User-Name = "alice"\\nUser-Password = "wonderland"\\n' | radclient -x -r 1 10.0.0.2 auth shared`);
    expect(made.output).toContain('Reply-Message = "A"');
    expect(made.output).not.toContain('Reply-Message = "B"');
    expect(second).toContain('Reply-Message = "B"');
  });

  it('an action table changes what a module result does: noop = return stops the section for a user the files do not know', async () => {
    const { output } = await authorizing(`${reply('reached')}${accept}`, 'zed', 'x', '\t\tfiles {\n\t\t\tnoop = return\n\t\t}\n');
    expect(output).not.toContain('"reached"');
    const withoutTable = await authorizing(`${reply('reached')}${accept}`, 'zed', 'x');
    expect(withoutTable.output).toContain('Reply-Message = "reached"');
  });

  it('the expansion functions toupper, tolower, strlen and md5 apply to what they wrap', async () => {
    const { output } = await authorizing(`\t\tupdate reply {\n\t\t\tReply-Message := "%{toupper:%{User-Name}}-%{tolower:ABC}-%{strlen:%{User-Name}}-%{md5:alice}"\n\t\t}\n`, 'alice', 'wonderland');
    expect(output).toContain('Reply-Message = "ALICE-abc-5-6384e2b2184bcbf58eccf10ca7a6563c"');
  });

  it('refuses a numeric action, an unknown rcode in the table and foreach, naming them', async () => {
    expect((await authorizing('', 'alice', 'x', '\t\tfiles {\n\t\t\tok = 2\n\t\t}\n', false)).restarted).toContain('The action "2" for "ok" is not implemented in this simulator');
    expect((await authorizing('', 'alice', 'x', '\t\tfiles {\n\t\t\tmaybe = return\n\t\t}\n', false)).restarted).toContain('Unknown return code "maybe"');
    expect((await authorizing('\t\tforeach &Reply-Message {\n\t\t}\n', 'alice', 'x', '\t\tfiles\n', false)).restarted).toContain('"foreach" is not implemented in this simulator');
  });
});
