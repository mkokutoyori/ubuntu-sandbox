/*
 * Probe: a condition on a return code (`if (ok)`, `if (notfound)`, `if (!ok)`) was not understood: the bare word was read as a literal
 * that always exists, so `if (ok)` was true whatever the previous module answered. Source of truth: FreeRADIUS v3.2.x doc/unlang/condition
 * and src/main/evaluate.c / modcall.c (a bare rcode name is true when the previous module call returned that code; combined with !, && and
 * ||, and an else branch). The rcode is the one of the last module call or rcode keyword statement, as printed in the trace's
 * `[module] = code` line.
 *
 * Discriminated with git stash on src: only 2 of 6 fall before the fix, because the bare word was always true: the two cases that need a
 * FALSE verdict (the else branch after a user the files do not know, and `if (noop)` / `if (!ok)` for the same user). The four others pass
 * either way and are named: the witness (an attribute condition), `if (ok)` for a known user, the combination with a comparison and the
 * rcode keyword statement; they are the non-regression of the true side, not proofs of the new reading.
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

async function authorizing(extra: string, user: string, password: string) {
  const made = await lab();
  write(made.target, SITE_FILE, (vfsOf(made.target).readFile(SITE_FILE) ?? '').replace('\t\tfiles\n', `\t\tfiles\n${extra}`));
  const restarted = await made.target.executeCommand('systemctl restart freeradius');
  const lines: string[] = [];
  made.target.followRadiusDebug((line) => lines.push(line.replace(/^\(\d+\) /, '').trim()));
  const output = await made.client.executeCommand(`printf 'User-Name = "${user}"\\nUser-Password = "${password}"\\n' | radclient -x -r 1 10.0.0.2 auth shared`);
  return { ...made, lines, output, restarted };
}
const reply = (message: string) => `\t\t\tupdate reply {\n\t\t\t\tReply-Message := "${message}"\n\t\t\t}\n`;
const accept = '\t\t\tupdate control {\n\t\t\t\tAuth-Type := Accept\n\t\t\t}\n';

describe('conditions on a return code', () => {
  it('witness: a condition on an attribute of the request still decides', async () => {
    const { output } = await authorizing(`\t\tif (&User-Name == "alice") {\n${reply('attribute')}\t\t}\n`, 'alice', 'wonderland');
    expect(output).toContain('Reply-Message = "attribute"');
  });

  it('if (ok) is true after files found the user', async () => {
    const { output } = await authorizing(`\t\tif (ok) {\n${reply('known')}\t\t}\n`, 'alice', 'wonderland');
    expect(output).toContain('Reply-Message = "known"');
  });

  it('if (ok) is false after files found nobody: the else branch runs', async () => {
    const { output } = await authorizing(`\t\tif (ok) {\n${reply('known')}\t\t}\n\t\telse {\n${reply('unknown')}${accept}\t\t}\n`, 'zed', 'anything');
    expect(output).toContain('Reply-Message = "unknown"');
    expect(output).not.toContain('Reply-Message = "known"');
  });

  it('if (noop) and if (!ok) are true for a user the files do not know', async () => {
    const noop = await authorizing(`\t\tif (noop) {\n${reply('noop')}${accept}\t\t}\n`, 'zed', 'anything');
    expect(noop.output).toContain('Reply-Message = "noop"');
    const negated = await authorizing(`\t\tif (!ok) {\n${reply('negated')}${accept}\t\t}\n`, 'zed', 'anything');
    expect(negated.output).toContain('Reply-Message = "negated"');
  });

  it('a return code can be combined with a comparison, and the trace prints the condition and its verdict', async () => {
    const { output, lines } = await authorizing(`\t\tif (ok && &User-Name == "alice") {\n${reply('both')}\t\t}\n`, 'alice', 'wonderland');
    expect(output).toContain('Reply-Message = "both"');
    expect(lines.some((line) => line.includes('if (ok && &User-Name == "alice")') && line.includes('TRUE'))).toBe(true);
  });

  it('an rcode keyword statement sets the code the next condition sees', async () => {
    const { output } = await authorizing(`\t\tnoop\n\t\tif (noop) {\n${reply('after-noop')}\t\t}\n`, 'alice', 'wonderland');
    expect(output).toContain('Reply-Message = "after-noop"');
  });
});
