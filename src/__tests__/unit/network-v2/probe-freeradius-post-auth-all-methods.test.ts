/*
 * Probe: the post-auth section ran only for PAP and CHAP; an MS-CHAP or EAP exchange got the user's reply items and nothing from the
 * site. Source of truth: FreeRADIUS v3.2.x src/main/auth.c / process.c (rad_postauth runs after the decision for every authentication
 * method: the post-auth section on an accept, Post-Auth-Type REJECT on a reject; what the section puts in the reply list is what is
 * sent; an Access-Challenge is not an authentication result and does not run it). The same program as for PAP now runs after an
 * MS-CHAPv2 and an EAP-MD5 decision.
 *
 * Discriminated with git stash on src: 4 of 6 fall before the fix; two pass either way and are named: the witness that the PAP path
 * still runs the section, and the absence of post-auth on the Access-Challenge, vacuous on the base where no section ran for EAP at all.
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
  write(made.target, SITES, (vfsOf(made.target).readFile(SITES) ?? '').replace(/\tpost-auth \{[\s\S]*?\n\t\}\n/, POST_AUTH));
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
const POST_AUTH = '\tpost-auth {\n\t\tupdate reply {\n\t\t\tReply-Message := "via post-auth"\n\t\t}\n\t\tPost-Auth-Type REJECT {\n\t\t\tupdate reply {\n\t\t\t\tReply-Message := "denied by post-auth"\n\t\t\t}\n\t\t}\n\t}\n';

async function traced(command: string) {
  const made = await lab();
  write(made.target, SITES, (vfsOf(made.target).readFile(SITES) ?? '').replace(/\tpost-auth \{[\s\S]*?\n\t\}\n/, POST_AUTH));
  await made.target.executeCommand('systemctl restart freeradius');
  const lines: string[] = [];
  made.target.followRadiusDebug((line) => lines.push(line.replace(/^\(\d+\) /, '').trim()));
  const output = await made.client.executeCommand(command);
  return { ...made, lines, output };
}
const sent = (lines: string[]) => lines.slice(lines.map((line) => line.startsWith('Sent Access-')).lastIndexOf(true)).map((line) => line.trim());

describe('post-auth after every authentication method', () => {
  it('witness: PAP gets the reply item of the section', async () => {
    const { lines } = await traced(`printf 'User-Name = "alice"\\nUser-Password = "wonderland"\\n' | radclient -r 1 10.0.0.2 auth shared`);
    expect(sent(lines)).toContain('Reply-Message = "via post-auth"');
  });

  it('MS-CHAPv2 accept carries it, and the trace runs the section', async () => {
    const { lines, output } = await traced('radtest -t mschap alice wonderland 10.0.0.2 10 shared');
    expect(output).toContain('Received Access-Accept');
    expect(sent(lines)).toContain('Reply-Message = "via post-auth"');
    expect(lines.some((line) => line.startsWith('# Executing section post-auth'))).toBe(true);
  });

  it('MS-CHAPv2 reject runs Post-Auth-Type REJECT', async () => {
    const { lines } = await traced('radtest -t mschap alice wrong 10.0.0.2 10 shared');
    expect(sent(lines)).toContain('Reply-Message = "denied by post-auth"');
    expect(lines).toContain('Using Post-Auth-Type Reject');
  });

  it('an EAP-MD5 accept carries it', async () => {
    const { lines, second } = await exchange('wonderland');
    expect(second).toContain('Received Access-Accept');
    expect(sent(lines)).toContain('Reply-Message = "via post-auth"');
  });

  it('an EAP-MD5 reject runs Post-Auth-Type REJECT', async () => {
    const { lines } = await exchange('wrong');
    expect(sent(lines)).toContain('Reply-Message = "denied by post-auth"');
  });

  it('the Access-Challenge of the EAP identity round does not run the section', async () => {
    const { lines } = await exchange('wonderland');
    const challenge = lines.findIndex((line) => line.startsWith('Sent Access-Challenge'));
    const firstPostAuth = lines.findIndex((line) => line.startsWith('# Executing section post-auth'));
    expect(challenge).toBeGreaterThan(-1);
    expect(firstPostAuth === -1 || firstPostAuth > challenge).toBe(true);
  });
});

