/*
 * Probe: the authenticate section was a list of module names: a statement written in an Auth-Type group was refused, and no group could
 * carry unlang or a custom Auth-Type. Source of truth: FreeRADIUS v3.2.x src/main/auth.c (rad_check_password: the Auth-Type found in the
 * control list names the `Auth-Type <name>` group of authenticate, which runs as a program; only ok / handled (and updated) authenticate,
 * anything else is "Failed to authenticate the user"), raddb/sites-available/default (Auth-Type PAP { pap } ...), doc/unlang.
 * The built-in pap and chap modules answer with the credential verdict of the request, any unlang around them (update reply, if on an
 * attribute) runs in the group, `update control { Auth-Type := Name }` selects a group of the operator's own, `ok` and `reject` are
 * modules, and the trace prints the group with its module lines and its result. A statement directly in authenticate is refused.
 *
 * Discriminated with git stash on src: 6 of 9 fall before the fix; three pass either way and are named: the witness (the default site
 * accepts and rejects as before), the group file and line of the trace (printed before) and the refusal of an unknown module in a group
 * (the same message on the base).
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

async function withAuthenticate(authorizeExtra: string, authenticate: string, password = 'wonderland') {
  const made = await lab();
  const text = vfsOf(made.target).readFile(SITE_FILE) ?? '';
  const edited = text
    .replace(/\tauthenticate \{[\s\S]*?\n\t\}\n/, `\tauthenticate {\n${authenticate}\t}\n`)
    .replace('\tauthorize {\n', `\tauthorize {\n${authorizeExtra}`);
  write(made.target, SITE_FILE, edited);
  const restarted = await made.target.executeCommand('systemctl restart freeradius');
  const lines: string[] = [];
  made.target.followRadiusDebug((line) => lines.push(line.replace(/^\(\d+\) /, '').trim()));
  const output = await made.client.executeCommand(`printf 'User-Name = "alice"\\nUser-Password = "${password}"\\n' | radclient -x -r 1 10.0.0.2 auth shared`);
  return { ...made, lines, output, restarted };
}
const group = (name: string, body: string) => `\t\tAuth-Type ${name} {\n${body}\t\t}\n`;
const DEFAULT_PAP = group('PAP', '\t\t\tpap\n');

describe('unlang in the authenticate section', () => {
  it('witness: the default group accepts the right password and rejects the wrong one, tracing the pap lines', async () => {
    const right = await withAuthenticate('', DEFAULT_PAP);
    expect(right.output).toContain('Received Access-Accept');
    expect(right.lines).toContain('pap: User authenticated successfully');
    expect((await withAuthenticate('', DEFAULT_PAP, 'wrong')).output).toContain('Received Access-Reject');
  });

  it('an update reply written after pap in the group is sent with the accept', async () => {
    const { output } = await withAuthenticate('', group('PAP', '\t\t\tpap\n\t\t\tupdate reply {\n\t\t\t\tReply-Message := "welcome"\n\t\t\t}\n'));
    expect(output).toContain('Reply-Message = "welcome"');
  });

  it('an if on an attribute of the request chooses the statement that runs', async () => {
    const body = '\t\t\tpap\n\t\t\tif (&User-Name == "alice") {\n\t\t\t\tupdate reply {\n\t\t\t\t\tReply-Message := "hello alice"\n\t\t\t\t}\n\t\t\t}\n\t\t\telse {\n\t\t\t\tupdate reply {\n\t\t\t\t\tReply-Message := "stranger"\n\t\t\t\t}\n\t\t\t}\n';
    const { output } = await withAuthenticate('', group('PAP', body));
    expect(output).toContain('Reply-Message = "hello alice"');
    expect(output).not.toContain('stranger');
  });

  it('a reject in the group refuses the right password, the trace shows the result and the failure line', async () => {
    const { output, lines } = await withAuthenticate('', group('PAP', '\t\t\treject\n'));
    expect(output).toContain('Received Access-Reject');
    expect(lines).toContain('[reject] = reject');
    expect(lines).toContain('} # Auth-Type PAP = reject');
    expect(lines).toContain('Failed to authenticate the user');
  });

  it('a custom Auth-Type selected by authorize runs its own group: ok accepts any password', async () => {
    const { output, lines } = await withAuthenticate('\t\tupdate control {\n\t\t\tAuth-Type := Strict\n\t\t}\n', DEFAULT_PAP + group('Strict', '\t\t\tok\n'), 'anything');
    expect(output).toContain('Received Access-Accept');
    expect(lines).toContain('Found Auth-Type = Strict');
    expect(lines).toContain('Auth-Type Strict {');
    expect(lines).toContain('[ok] = ok');
    expect(lines).toContain('} # Auth-Type Strict = ok');
  });

  it('a custom group that ends on noop does not authenticate', async () => {
    const { output } = await withAuthenticate('\t\tupdate control {\n\t\t\tAuth-Type := Silent\n\t\t}\n', DEFAULT_PAP + group('Silent', '\t\t\tnoop\n'));
    expect(output).toContain('Received Access-Reject');
  });

  it('the trace names the group file and line', async () => {
    const { lines, target } = await withAuthenticate('', DEFAULT_PAP);
    const line = (vfsOf(target).readFile(SITE_FILE) ?? '').split('\n').findIndex((text) => text.includes('Auth-Type PAP')) + 1;
    expect(lines.some((text) => text.startsWith('# Executing group from file') && text.endsWith(` line ${line}`))).toBe(true);
  });

  it('refuses an unlang statement written directly in authenticate, naming it', async () => {
    const { restarted } = await withAuthenticate('', DEFAULT_PAP + '\t\tif (&User-Name == "x") {\n\t\t\tok\n\t\t}\n');
    expect(restarted).toContain('The unlang construct "if" directly in authenticate is not implemented in this simulator');
  });

  it('refuses a module that does not exist in a group, as everywhere else', async () => {
    const { restarted } = await withAuthenticate('', group('PAP', '\t\t\tfrobnicate\n'));
    expect(restarted).toContain('Failed to find module "frobnicate"');
  });
});
