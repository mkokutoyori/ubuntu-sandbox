/*
 * Probe: an `Auth-Type eap` group written by the operator in authenticate was not run for an EAP conversation: the conversation was
 * decided by the engine's module alone. Source of truth: FreeRADIUS v3.2.x src/main/auth.c (the eap module sets Auth-Type = eap and the group of
 * that name runs as a program; only ok / handled authenticate; the rest is a reject), raddb/sites-available/default (the bare
 * `eap` of authenticate is the implicit group of that name), rlm_eap (the module's own lines come first). Without an explicit group the
 * bare eap of the default site behaves and traces as before (probe-freeradius-eap-trace). The group wraps the final decision of an
 * EAP-MD5 exchange: update reply adds items to the Access-Accept, a reject after eap refuses the exchange.
 *
 * Discriminated with git stash on src: 2 of 4 fall before the fix; two pass either way and are named: the witness (the exchange with an
 * explicit group that only calls eap is accepted) and the wrong password (rejected by the engine either way).
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
import { computeEapMd5Response, eapPacketFromWireHex } from '@/network/radius/eap';
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

const hexOf = (output: string, name: string) => Array.from(output.matchAll(new RegExp(`${name} = 0x([0-9a-f]+)`, 'g'))).pop()?.[1] ?? '';
const identityHex = (name: string) => `020000${(5 + name.length).toString(16).padStart(2, '0')}01${Buffer.from(name).toString('hex')}`;

async function exchange(password: string) {
  const made = await lab();
  write(made.target, SITES, (vfsOf(made.target).readFile(SITES) ?? '').replace(/(\tauthenticate \{[\s\S]*?)\t\teap\n/, (_all, before) => `${before}${EAP_GROUP.value}`));
  await made.target.executeCommand('systemctl restart freeradius');
  const lines: string[] = [];
  made.target.followRadiusDebug((line) => lines.push(line.replace(/^\(\d+\) /, '')));
  const first = await made.client.executeCommand(`printf 'User-Name = "alice"\\nEAP-Message = 0x${identityHex('alice')}\\n' | radclient -x -r 1 10.0.0.2 auth shared`);
  const request = eapPacketFromWireHex(hexOf(first, 'EAP-Message'));
  const state = hexOf(first, 'State');
  let second = '';
  if (request?.eapType === 'md5-challenge' && request.md5Challenge !== undefined) {
    const response = computeEapMd5Response(request.identifier, password, request.md5Challenge);
    const body = `02${request.identifier.toString(16).padStart(2, '0')}001604 10${response}`.replace(' ', '');
    second = await made.client.executeCommand(`printf 'User-Name = "alice"\\nState = 0x${state}\\nEAP-Message = 0x${body}\\n' | radclient -x -r 1 10.0.0.2 auth shared; echo rc=$?`);
  }
  return { ...made, lines, first, second, state };
}

const SITES = '/etc/freeradius/3.0/sites-available/default';
const POST_AUTH_UNUSED = '\tpost-auth {\n\t\tupdate reply {\n\t\t\tReply-Message := "via post-auth"\n\t\t}\n\t\tPost-Auth-Type REJECT {\n\t\t\tupdate reply {\n\t\t\t\tReply-Message := "denied by post-auth"\n\t\t\t}\n\t\t}\n\t}\n';

const EAP_GROUP = { value: '' };
const sent = (lines: string[]) => lines.slice(lines.map((line) => line.startsWith('Sent Access-')).lastIndexOf(true)).map((line) => line.trim());

async function withGroup(body: string, password: string) {
  EAP_GROUP.value = `\t\tAuth-Type eap {\n${body}\t\t}\n`;
  return exchange(password);
}

describe('an Auth-Type eap group', () => {
  it('witness: a group that only calls eap authenticates the right password', async () => {
    const { second } = await withGroup('\t\t\teap\n', 'wonderland');
    expect(second).toContain('Received Access-Accept');
  });

  it('an update reply after eap is sent with the final Access-Accept', async () => {
    const { lines, second } = await withGroup('\t\t\teap\n\t\t\tupdate reply {\n\t\t\t\tReply-Message := "eap group"\n\t\t\t}\n', 'wonderland');
    expect(second).toContain('Received Access-Accept');
    expect(sent(lines)).toContain('Reply-Message = "eap group"');
  });

  it('a reject after eap refuses an exchange the engine would accept', async () => {
    const { second } = await withGroup('\t\t\teap\n\t\t\treject\n', 'wonderland');
    expect(second).toContain('Received Access-Reject');
  });

  it('the wrong password is rejected and the trace shows the group, its eap lines and its result', async () => {
    const { second, lines } = await withGroup('\t\t\teap\n', 'wrong');
    expect(second).toContain('Received Access-Reject');
    const text = lines.map((line) => line.trim());
    expect(text).toContain('Auth-Type eap {');
    expect(text).toContain('} # Auth-Type eap = reject');
  });
});
