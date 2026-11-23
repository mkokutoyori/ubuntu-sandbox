/*
 * Probe: the site's `Autz-Type Status-Server` group (and `Acct-Type Status-Server` on the accounting port) was never run: every
 * Status-Server got an unconditional Access-Accept. Source of truth: FreeRADIUS v3.2.x src/main/listen.c rad_status_server (the group
 * of that name runs as a program: ok / updated -> Access-Accept, fail / handled -> no reply, anything else -> Access-Reject; without
 * the group the answer is the accept; what the group puts in the reply list is sent) and raddb/sites-available/status. On the accounting
 * port the reply is an Accounting-Response, and a result that is not ok is simply not answered.
 *
 * Discriminated with git stash on src: 5 of 7 fall before the fix; two pass either way and are named: the witness (no group, the
 * accept) and the explicit group with ok (the accept the base always gave).
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
import { CLIENTS_CONF_PATH, USERS_FILE_PATH, RADIUSD_CONF_PATH } from '@/network/devices/linux/freeradius/RadiusdService';
import { DEFAULT_RADIUSD_CONF } from '@/network/devices/linux/freeradius/DefaultRadiusdConf';

beforeEach(() => { resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset(); });

const vfsOf = (server: LinuxServer) => (server as unknown as { executor: { vfs: VirtualFileSystem } }).executor.vfs;
const write = (server: LinuxServer, path: string, content: string) => { vfsOf(server).writeFile(path, content, 0, 0, 0o022); };

async function lab(clientIp = '10.0.0.1') {
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
  write(target, USERS_FILE_PATH, 'alice Cleartext-Password := "wonderland"\n');
  await target.executeCommand('systemctl reload freeradius');
  return { client, target };
}

async function run(server: LinuxServer, command: string) {
  const output = await server.executeCommand(command);
  const code = (await server.executeCommand('echo $?')).trim();
  return { output: output.trim(), code };
}

const SITE_FILE = '/etc/freeradius/3.0/sites-available/default';
const PING = `printf 'Message-Authenticator = 0x00\\n'`;

async function withGroup(authorize: string, accounting = '') {
  const made = await lab();
  let text = vfsOf(made.target).readFile(SITE_FILE) ?? '';
  if (authorize !== '') text = text.replace('\tauthorize {\n', `\tauthorize {\n\t\tAutz-Type Status-Server {\n${authorize}\t\t}\n`);
  if (accounting !== '') text = text.replace('\taccounting {\n', `\taccounting {\n\t\tAcct-Type Status-Server {\n${accounting}\t\t}\n`);
  write(made.target, SITE_FILE, text);
  await made.target.executeCommand('systemctl restart freeradius');
  const lines: string[] = [];
  made.target.followRadiusDebug((line) => lines.push(line.replace(/^\(\d+\) /, '').trim()));
  return { ...made, lines };
}
const ask = (client: LinuxServer, port = '') => client.executeCommand(`${PING} | radclient -x -r 1 10.0.0.2${port} status shared`);

describe('Status-Server through its group', () => {
  it('witness: without a group the server answers Access-Accept', async () => {
    const { client } = await withGroup('');
    expect(await ask(client)).toContain('Received Access-Accept');
  });

  it('a group with ok answers Access-Accept', async () => {
    const { client } = await withGroup('\t\t\tok\n');
    expect(await ask(client)).toContain('Received Access-Accept');
  });

  it('what the group puts in the reply list is sent', async () => {
    const { client } = await withGroup('\t\t\tupdate reply {\n\t\t\t\tReply-Message := "alive"\n\t\t\t}\n\t\t\tupdate control {\n\t\t\t}\n\t\t\tok\n');
    expect(await ask(client)).toContain('Reply-Message = "alive"');
  });

  it('a group that rejects answers Access-Reject', async () => {
    const { client } = await withGroup('\t\t\treject\n');
    expect(await ask(client)).toContain('Received Access-Reject');
  });

  it('a group that answers fail is not answered at all', async () => {
    const { client } = await withGroup('\t\t\tfail\n');
    expect(await ask(client)).toContain('No reply from server');
  });

  it('the -X trace prints the group with its result', async () => {
    const { client, lines } = await withGroup('\t\t\tok\n');
    await ask(client);
    expect(lines).toContain('Autz-Type Status-Server {');
    expect(lines).toContain('} # Autz-Type Status-Server = ok');
  });

  it('on the accounting port Acct-Type Status-Server answers an Accounting-Response, and fail is not answered', async () => {
    const accepted = await withGroup('', '\t\t\tok\n');
    expect(await ask(accepted.client, ':1813')).toContain('Received Accounting-Response');
    const silent = await withGroup('', '\t\t\tfail\n');
    expect(await ask(silent.client, ':1813')).toContain('No reply from server');
  });
});
