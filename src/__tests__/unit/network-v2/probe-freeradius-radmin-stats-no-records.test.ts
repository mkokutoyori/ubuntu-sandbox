/*
 * Probe: the no_records counter of `stats home_server`. Source of truth: FreeRADIUS v3.2.x src/main/process.c (request_proxy_reply: a reply for which
 * fr_packet_list_find_byreply finds no outstanding request, or whose request already left the waiting state, logs "No outstanding request was found for ...
 * packet from host ..." and FR_PROXY_STATS_INC(listener, home, total_no_records)), src/main/listen.c (proxy_stats: the counter is added to the global proxy statistics,
 * to the listener and, only when the socket belongs to one home server or unauth_proxy_responses is set, to that home server), src/main/command.c
 * (no_records is printed with the other per-server counters). It was documented as needing a detail-file reader; that was a misreading: the counter belongs to the
 * proxy. A reply is counted when it comes from an address and port the proxy has forwarded to and matches no outstanding request (late, or never solicited); a
 * reply from an address the proxy never talked to is not counted, as the real server cannot attribute it. A reply that matches a pending request but fails
 * its authenticator is counted in bad_authenticator instead.
 *
 * Discriminated with git stash on src/network: 2 of 3 fall before the fix; the witness (a normal exchange leaves no_records at 0) and the unknown-sender case pass either way.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { VirtualTimeScheduler, __setDefaultScheduler, getDefaultScheduler } from '@/events/Scheduler';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { EventBus } from '@/events/EventBus';
import { MACAddress, IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import type { RadiusPacket } from '@/network/radius/types';
import type { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';
import { CLIENTS_CONF_PATH, USERS_FILE_PATH } from '@/network/devices/linux/freeradius/RadiusdService';

beforeEach(() => { __setDefaultScheduler(new VirtualTimeScheduler()); resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset(); });

const vfsOf = (server: LinuxServer) => (server as unknown as { executor: { vfs: VirtualFileSystem } }).executor.vfs;
const write = (server: LinuxServer, path: string, content: string) => { vfsOf(server).writeFile(path, content, 0, 0, 0o022); };
const SITE = '/etc/freeradius/3.0/sites-available/default';
const PROXY = '/etc/freeradius/3.0/proxy.conf';

const HOME_POOL = (extra = '', realmExtra = '  acct_pool = pool1\n') => `home_server home1 {\n  ipaddr = 10.0.0.3\n  port = 1812\n  secret = homesecret\n  ${extra}\n}\nhome_server_pool pool1 {\n  home_server = home1\n}\nrealm example.com {\n  auth_pool = pool1\n${realmExtra}}\nrealm LOCAL {\n}\n`;

async function lab(proxyConf: string, authorizeModule = '') {
  const bus = new EventBus();
  const client = new LinuxServer('linux-server', 'CLIENT');
  const edge = new LinuxServer('linux-server', 'EDGE');
  const home = new LinuxServer('linux-server', 'HOME');
  const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
  for (const device of [client, edge, home, sw]) device.setEventBus(bus);
  new Cable('a').connect(client.getPort('eth0')!, sw.getPort('FastEthernet0/1')!);
  new Cable('b').connect(edge.getPort('eth0')!, sw.getPort('FastEthernet0/2')!);
  new Cable('c').connect(home.getPort('eth0')!, sw.getPort('FastEthernet0/3')!);
  client.configureInterface('eth0', new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
  edge.configureInterface('eth0', new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));
  home.configureInterface('eth0', new IPAddress('10.0.0.3'), new SubnetMask('255.255.255.0'));
  write(edge, CLIENTS_CONF_PATH, 'client lab {\n  ipaddr = 10.0.0.1\n  secret = shared\n}\n');
  write(edge, USERS_FILE_PATH, 'bob Cleartext-Password := "local"\n');
  write(home, CLIENTS_CONF_PATH, 'client edge {\n  ipaddr = 10.0.0.2\n  secret = homesecret\n}\n');
  write(home, USERS_FILE_PATH, 'alice Cleartext-Password := "wonderland"\nbob Cleartext-Password := "homebob"\n');
  write(edge, PROXY, proxyConf);
  if (authorizeModule !== '') write(edge, SITE, (vfsOf(edge).readFile(SITE) ?? '').replace('\tauthorize {\n\t\tpreprocess\n', `\tauthorize {\n\t\tpreprocess\n\t\t${authorizeModule}\n`));
  await home.executeCommand('systemctl restart freeradius');
  const started = await edge.executeCommand('systemctl restart freeradius');
  return { client, edge, home, started };
}

const request = (user: string, password: string) =>
  `printf 'User-Name = "${user}"\\nUser-Password = "${password}"\\n' | radclient -r 1 10.0.0.2 auth shared`;

const SOCKET = '/var/run/freeradius/freeradius.sock';
const CONTROL = '/etc/freeradius/3.0/sites-enabled/control-socket';
const login = (user: string) => `printf 'User-Name = "${user}"\\nUser-Password = "wonderland"\\n' | radclient -r 1 10.0.0.2 auth shared`;

async function withControl(proxyConf: string, mode = 'rw') {
  const made = await lab(proxyConf);
  write(made.edge, CONTROL, `listen {\n  type = control\n  socket = \${run_dir}/\${name}.sock\n  mode = ${mode}\n}\n`);
  await made.edge.executeCommand('systemctl restart freeradius');
  return made;
}
const listing = async (edge: LinuxServer, all = false) =>
  (await edge.executeCommand(`radmin -f ${SOCKET} -e "show home_server list${all ? ' all' : ''}"`)).trim().split('\n');

const pass = (seconds: number) => (getDefaultScheduler() as VirtualTimeScheduler).advanceBy(seconds * 1000);
const stateOf = async (edge: LinuxServer) => (await edge.executeCommand(`radmin -f ${SOCKET} -e "show home_server state 10.0.0.3 1812"`)).trim();
const CHECKED = (extra = '') => HOME_POOL(`response_window = 1\n  status_check = status-server\n  check_interval = 6\n  num_answers_to_alive = 2\n  ${extra}`);


const stats = async (edge: LinuxServer, args: string) => (await edge.executeCommand(`radmin -f ${SOCKET} -e "stats home_server ${args}"`)).trim();
const value = (text: string, name: string) => Number(new RegExp(`^${name}\\t+(\\d+)$`, 'm').exec(text)?.[1] ?? NaN);
const acct = (user: string) => `printf 'User-Name = "${user}"\\nAcct-Status-Type = Start\\nAcct-Session-Id = "s1"\\nNAS-IP-Address = 10.0.0.1\\nNAS-Port = 1\\n' | radclient -r 1 10.0.0.2 acct shared`;

async function ready(proxyConf = HOME_POOL('response_window = 1')) {
  const made = await lab(proxyConf);
  write(made.edge, CONTROL, 'listen {\n  type = control\n  socket = ${run_dir}/${name}.sock\n}\n');
  await made.edge.executeCommand('systemctl restart freeradius');
  return made;
}

const strayAccept = (identifier: number): RadiusPacket => ({
  type: 'radius', code: 'access-accept', identifier, authenticator: '00'.repeat(16), attributes: [],
});

describe('radmin stats home_server no_records', () => {
  it('witness: a normal proxied exchange leaves no_records at 0', async () => {
    const { client, edge } = await ready();
    await client.executeCommand(login('alice@example.com'));
    expect(value(await stats(edge, 'auth'), 'no_records')).toBe(0);
  });

  it('a reply from the home server that matches no outstanding request is counted', async () => {
    const { client, edge, home } = await ready();
    await client.executeCommand(login('alice@example.com'));
    home.sendUdpDatagramTo(new IPAddress('10.0.0.2'), 1812, 1812, strayAccept(201), 20);
    home.sendUdpDatagramTo(new IPAddress('10.0.0.2'), 1812, 1812, strayAccept(202), 20);
    expect(value(await stats(edge, 'auth'), 'no_records')).toBe(2);
    expect(value(await stats(edge, 'acct'), 'no_records')).toBe(0);
  });

  it('an accounting reply with no outstanding request is counted in the accounting statistics', async () => {
    const { client, edge, home } = await ready();
    await client.executeCommand(acct('alice@example.com'));
    home.sendUdpDatagramTo(new IPAddress('10.0.0.2'), 1813, 1813, { ...strayAccept(203), code: 'accounting-response' }, 20);
    expect(value(await stats(edge, 'acct'), 'no_records')).toBe(1);
    expect(value(await stats(edge, 'auth'), 'no_records')).toBe(0);
  });

  it('a reply from an address the proxy never forwarded to is not counted', async () => {
    const { client, edge } = await ready();
    await client.executeCommand(login('alice@example.com'));
    client.sendUdpDatagramTo(new IPAddress('10.0.0.2'), 1812, 1812, strayAccept(204), 20);
    expect(value(await stats(edge, 'auth'), 'no_records')).toBe(0);
  });
});
