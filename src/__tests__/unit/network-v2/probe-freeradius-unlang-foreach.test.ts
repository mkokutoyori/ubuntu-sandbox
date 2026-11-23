/*
 * Probe: `foreach` and `break` were refused ("The unlang construct foreach is not implemented"). Source of truth: FreeRADIUS v3.2.x
 * src/main/modcall.c (MOD_FOREACH: a copy of every instance of the attribute is iterated, so the body may change the list; each
 * pass exposes the value as Foreach-Variable-N, N being the nesting depth, usable as %{Foreach-Variable-0} and &Foreach-Variable-0; 8
 * levels at most, "foreach Nesting too deep!"; MOD_BREAK leaves the innermost loop; return unwinds everything; nothing to loop over
 * prints `foreach X {` and `} # foreach X = noop`; the trace prints `foreach X `, `# Foreach-Variable-N = VALUE` per pass and
 * `} # foreach X = RESULT`), do_compile_modforeach / do_compile_modbreak (the attribute must be written &attr, a block cannot be
 * empty, "'break' can only be used in a 'foreach' section"). The control list holds one value per name here, so a loop over it runs
 * once at most. A construct the simulator still lacks (map) stays refused naming it.
 *
 * Discriminated with git stash on src: 8 of 9 fall before the fix; the witness (an update reply in authorize is sent) passes either way.
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


const LIST = '\t\tupdate reply {\n\t\t\tReply-Message += "a"\n\t\t\tReply-Message += "b"\n\t\t\tReply-Message += "c"\n\t\t}\n';
const each = (inner: string) => `${LIST}\t\tforeach &reply:Reply-Message {\n${inner}\t\t}\n`;
const add = (value: string) => `\t\t\tupdate reply {\n\t\t\t\tFilter-Id += "${value}"\n\t\t\t}\n`;
const filters = (output: string) => [...output.matchAll(/Filter-Id = "([^"]*)"/g)].map((match) => match[1]);

describe('unlang foreach and break', () => {
  it('witness: an update reply written in authorize is sent', async () => {
    const { output } = await authorizing(LIST, 'alice', 'wonderland');
    expect(output).toContain('Reply-Message = "a"');
  });

  it('runs the body once per instance, with the value in %{Foreach-Variable-0}', async () => {
    const { output } = await authorizing(each(add('item-%{Foreach-Variable-0}')), 'alice', 'wonderland');
    expect(filters(output)).toEqual(['item-a', 'item-b', 'item-c']);
  });

  it('break leaves the loop: the instances after it are not visited', async () => {
    const inner = `\t\t\tif (&Foreach-Variable-0 == "b") {\n\t\t\t\tbreak\n\t\t\t}\n${add('%{Foreach-Variable-0}')}`;
    const { output } = await authorizing(each(inner), 'alice', 'wonderland');
    expect(filters(output)).toEqual(['a']);
  });

  it('&Foreach-Variable-0 is an attribute a condition can read', async () => {
    const inner = `\t\t\tif (&Foreach-Variable-0 == "c") {\n${add('found-c')}\t\t\t}\n`;
    const { output } = await authorizing(each(inner), 'alice', 'wonderland');
    expect(filters(output)).toEqual(['found-c']);
  });

  it('nested loops expose the inner value as Foreach-Variable-1 and break only the inner one', async () => {
    const inner = `\t\t\tforeach &reply:Reply-Message {\n\t\t\t\tbreak\n\t\t\t}\n${add('%{Foreach-Variable-0}')}`;
    const { output } = await authorizing(each(inner), 'alice', 'wonderland');
    expect(filters(output)).toEqual(['a', 'b', 'c']);
    const pair = `\t\t\tforeach &request:User-Name {\n\t\t\t\tupdate reply {\n\t\t\t\t\tFilter-Id += "%{Foreach-Variable-0}/%{Foreach-Variable-1}"\n\t\t\t\t}\n\t\t\t}\n`;
    expect(filters((await authorizing(each(pair), 'alice', 'wonderland')).output)).toEqual(['a/alice', 'b/alice', 'c/alice']);
  });

  it('return inside the loop leaves the whole section', async () => {
    const { output } = await authorizing(each(`${add('once')}\t\t\treturn\n`) + add('after'), 'alice', 'wonderland');
    expect(filters(output)).toEqual(['once']);
  });

  it('the trace prints the loop, one variable line per pass and the closing result', async () => {
    const { lines } = await authorizing(each(add('x')), 'alice', 'wonderland');
    expect(lines).toContain('foreach &reply:Reply-Message');
    expect(lines).toContain('# Foreach-Variable-0 = "a"');
    expect(lines).toContain('# Foreach-Variable-0 = "c"');
    expect(lines).toContain('} # foreach &reply:Reply-Message = noop');
  });

  it('a loop over an attribute that is not there prints the empty form and runs nothing', async () => {
    const { lines, output } = await authorizing('\t\tforeach &reply:Reply-Message {\n' + add('never') + '\t\t}\n', 'alice', 'wonderland');
    expect(lines).toContain('foreach &reply:Reply-Message {');
    expect(lines).toContain('} # foreach &reply:Reply-Message = noop');
    expect(output).not.toContain('Filter-Id');
  });

  it('refuses a break outside a loop, an empty loop and a loop over a bare word, in the words of the source', async () => {
    expect((await authorizing('\t\tbreak\n', 'alice', 'wonderland', '\t\tfiles\n', false)).restarted).toContain("'break' can only be used in a 'foreach' section");
    expect((await authorizing('\t\tforeach &Reply-Message {\n\t\t}\n', 'alice', 'wonderland', '\t\tfiles\n', false)).restarted).toContain("'foreach' blocks cannot be empty");
    expect((await authorizing('\t\tforeach Reply-Message {\n\t\t\tupdate reply {\n\t\t\t\tFilter-Id += "x"\n\t\t\t}\n\t\t}\n', 'alice', 'wonderland', '\t\tfiles\n', false)).restarted).toContain("MUST use attribute or list reference in 'foreach'");
  });
});
