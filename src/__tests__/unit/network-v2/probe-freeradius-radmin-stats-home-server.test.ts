/*
 * Probe: `stats home_server` answered "not implemented in this simulator" and no counter was kept for what the proxy sent to a home
 * server. Source of truth: FreeRADIUS v3.2.x src/main/command.c (command_stats_home_server: no argument -> "Must specify
 * [auth|acct|coa|disconnect] OR <ipaddr> <port>", one word -> the global proxy statistics or "Should specify [auth|acct|coa|disconnect]",
 * otherwise the statistics of the home server found by address and port, "No such home server - ..." when none; command_print_stats with
 * server = 1: requests, responses, accepts / rejects / challenges for auth, dup, invalid, malformed, bad_authenticator, dropped,
 * unknown_types, no_records, timeouts, last_packet, elapsed.*; a per-home-server answer ends with outstanding). Requests are counted when
 * the proxy forwards, responses with their code when the home server answers, timeouts when the response window passes silent;
 * outstanding is the number of forwarded requests still waiting.
 *
 * Discriminated with git stash on src: 6 of 7 fall before the fix, the witness too (the command was refused); the one case passing either
 * way is the error for an unknown radmin word, named here.
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

describe('radmin stats home_server', () => {
  it('witness: before any forwarded request the counters are 0 and the command answers', async () => {
    const { edge } = await ready();
    const text = await stats(edge, 'auth');
    expect(value(text, 'requests')).toBe(0);
    expect(value(text, 'responses')).toBe(0);
  });

  it('counts a forwarded request and its accept, globally and for the home server', async () => {
    const { client, edge } = await ready();
    await client.executeCommand(login('alice@example.com'));
    for (const text of [await stats(edge, 'auth'), await stats(edge, '10.0.0.3 1812')]) {
      expect(value(text, 'requests')).toBe(1);
      expect(value(text, 'responses')).toBe(1);
      expect(value(text, 'accepts')).toBe(1);
      expect(value(text, 'rejects')).toBe(0);
    }
    expect(value(await stats(edge, '10.0.0.3 1812'), 'outstanding')).toBe(0);
    expect(await stats(edge, 'auth')).not.toContain('outstanding');
  });

  it('counts a reject apart from an accept', async () => {
    const { client, edge } = await ready();
    await client.executeCommand(login('alice@example.com').replace('wonderland', 'wrong'));
    const text = await stats(edge, '10.0.0.3 1812');
    expect(value(text, 'rejects')).toBe(1);
    expect(value(text, 'accepts')).toBe(0);
  });

  it('counts a timeout when the home server stays silent, with a request and no response', async () => {
    const { client, edge, home } = await ready();
    await home.executeCommand('systemctl stop freeradius');
    await (getDefaultScheduler() as VirtualTimeScheduler).advanceUntilSettled(client.executeCommand(login('alice@example.com').replace('-r 1', '-r 1 -t 2')));
    const text = await stats(edge, '10.0.0.3 1812');
    expect(value(text, 'requests')).toBeGreaterThanOrEqual(1);
    expect(value(text, 'responses')).toBe(0);
    expect(value(text, 'timeouts')).toBe(value(text, 'requests'));
  });

  it('keeps accounting apart: acct statistics have no accepts line and count the accounting port', async () => {
    const { client, edge } = await ready();
    expect(await client.executeCommand(acct('alice@example.com'))).toContain('Received Accounting-Response');
    const text = await stats(edge, 'acct');
    expect(value(text, 'requests')).toBe(1);
    expect(value(text, 'responses')).toBe(1);
    expect(text).not.toContain('accepts');
    expect(value(await stats(edge, 'auth'), 'requests')).toBe(0);
  });

  it('refuses a missing argument, an unknown kind word and an unknown home server in the words of the source', async () => {
    const { edge } = await ready();
    expect(await stats(edge, '')).toBe('ERROR: Must specify [auth|acct|coa|disconnect] OR <ipaddr> <port>');
    expect(await stats(edge, 'nope')).toBe('ERROR: Should specify [auth|acct|coa|disconnect]');
    expect(await stats(edge, '10.9.9.9 1812')).toBe('ERROR: No such home server - 10.9.9.9 1812');
  });

  it('an unknown radmin word still gets the source wording', async () => {
    const { edge } = await ready();
    expect((await edge.executeCommand(`radmin -f ${SOCKET} -e "nonsense"`)).trim()).toBe("ERROR: Unknown command 'nonsense'");
  });
});
