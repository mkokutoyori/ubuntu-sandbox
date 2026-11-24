/*
 * Probe: status_check = status-server of a home_server was refused as an unknown key, so a home server that came back was only noticed
 * when a real user request went to it. Source of truth: FreeRADIUS v3.2.x raddb/proxy.conf and src/main/realms.c (status_check none |
 * status-server | request; check_interval 30 [6..120], check_timeout 4 [1..10], num_answers_to_alive 3 [1..10]; the `request` form needs
 * username and password), src/main/process.c (a server that stops answering becomes zombie; Status-Server probes go out every
 * check_interval; num_answers_to_alive consecutive answers make it alive again; an unanswered probe resets the count), RFC 5997 (the
 * probe is a Status-Server carrying a Message-Authenticator, answered Access-Accept on the auth port). The probe is a real frame:
 * the home server counts it as a Status-Server request. `status_check = request` is refused naming what it needs.
 *
 * Discriminated with git stash on src: 5 of 6 fall before the fix; the one passing either way is the control (without status_check a
 * recovered server is not noticed until a user request reaches it).
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

async function outage(proxyConf: string) {
  const made = await withControl(proxyConf);
  await made.home.executeCommand('systemctl stop freeradius');
  await (getDefaultScheduler() as VirtualTimeScheduler).advanceUntilSettled(made.client.executeCommand(login('alice@example.com').replace('-r 1', '-r 1 -t 2')));
  return made;
}

describe('status_check = status-server', () => {
  it('control: without status_check a recovered server stays zombie until a user request reaches it', async () => {
    const { edge, home } = await outage(HOME_POOL('response_window = 1'));
    expect(await stateOf(edge)).toBe('zombie');
    await home.executeCommand('systemctl start freeradius');
    await pass(20);
    expect(await stateOf(edge)).not.toBe('alive');
  });

  it('a recovered server is made alive again by the probes alone, after num_answers_to_alive answers', async () => {
    const { edge, home } = await outage(CHECKED());
    expect(await stateOf(edge)).toBe('zombie');
    await home.executeCommand('systemctl start freeradius');
    await pass(20);
    expect(await stateOf(edge)).toBe('alive');
  });

  it('the probes are Status-Server frames that the home server receives', async () => {
    const { edge, home } = await outage(CHECKED());
    const seen: string[] = [];
    home.followRadiusDebug((line) => seen.push(line));
    await home.executeCommand('systemctl start freeradius');
    home.followRadiusDebug((line) => seen.push(line));
    await pass(20);
    expect(seen.filter((line) => /Received Status-Server Id/.test(line)).length).toBeGreaterThanOrEqual(2);
  });

  it('while the server stays down the probes do not make it alive, and it goes dead after zombie_period', async () => {
    const { edge } = await outage(CHECKED('zombie_period = 10'));
    await pass(20);
    expect(await stateOf(edge)).toBe('dead');
  });

  it('refuses status_check = request naming what it needs, and an unknown value', async () => {
    expect((await lab(HOME_POOL('status_check = request'))).started).toContain('status_check "request" is not implemented in this simulator');
    expect((await lab(HOME_POOL('status_check = ping'))).started).toContain('Invalid status_check "ping"');
  });

  it('refuses a check_interval outside its bounds, naming the variable', async () => {
    expect((await lab(HOME_POOL('status_check = status-server\n  check_interval = 5'))).started).toContain('Invalid value "5" for variable check_interval');
  });
});

