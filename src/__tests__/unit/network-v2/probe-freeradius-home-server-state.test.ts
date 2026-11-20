/*
 * Probe: radmin had no `show home_server list`, and a home server that stopped answering was tried first again by every request.
 * Source of truth: FreeRADIUS v3.2.x src/main/command.c command_show_home_servers (one line per home server:
 * `ip<TAB>port<TAB>udp<TAB>type<TAB>state<TAB>outstanding`, `(name=..., dynamic=no)` with `all`), src/main/realms.c (a home server of type
 * auth+acct is listed twice: the auth+acct entry on its port and an acct entry on port + 1; defaults ping_interval 30, zombie_period 40,
 * revive_interval 120, bounds checked), src/main/process.c (no answer within response_window: the server becomes zombie, dead after
 * zombie_period, tried again after revive_interval; a fail-over pool skips a dead server). The state is the one the proxy measured:
 * unknown until a reply, alive within ping_interval of the last reply.
 *
 * `show home_server state <ip> <port>` prints the state word; `set home_server state <ip> <port> alive|dead|down` forces it (command.c
 * command_set_home_server_state: alive revives, dead marks it dead for revive_interval, down keeps it down until set alive), and the
 * socket's `mode` decides who may write (command.c: default read-only; ro, read-only, rw, read-write; refusal text quoted; an unknown mode name
 * is a configuration error).
 *
 * Discriminated with git stash on src, in two steps: the first 9 cases fall 8 of 9 before the commit that added the states (the one passing either way
 * is the witness that the lab proxies a user to the home server); the 8 cases for show/set state and the socket mode all fall on the
 * commit that precedes them, and the 9 earlier cases pass there.
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

describe('radmin show home_server list and the zombie / dead states', () => {
  it('witness: the realm user is proxied to the home server', async () => {
    const { client } = await withControl(HOME_POOL());
    expect(await client.executeCommand(login('alice@example.com'))).toContain('Access-Accept');
  });

  it('lists an auth+acct home server twice, the second on port + 1, as unknown before any reply', async () => {
    const { edge } = await withControl(HOME_POOL());
    expect(await listing(edge)).toEqual(['10.0.0.3\t1812\tudp\tauth+acct\tunknown\t0', '10.0.0.3\t1813\tudp\tacct\tunknown\t0']);
  });

  it('a type auth home server is listed once, and all adds the name and the dynamic flag', async () => {
    const { edge } = await withControl(HOME_POOL('type = auth').replace('acct_pool = pool1\n', ''));
    expect(await listing(edge, true)).toEqual(['10.0.0.3\t1812\tudp\tauth\tunknown\t0\t(name=home1, dynamic=no)']);
  });

  it('the server answering a proxied request is alive on the port it was asked on', async () => {
    const { client, edge } = await withControl(HOME_POOL());
    await client.executeCommand(login('alice@example.com'));
    expect(await listing(edge)).toEqual(['10.0.0.3\t1812\tudp\tauth+acct\talive\t0', '10.0.0.3\t1813\tudp\tacct\tunknown\t0']);
  });

  it('alive falls back to unknown after ping_interval without a reply', async () => {
    const { client, edge } = await withControl(HOME_POOL('ping_interval = 6'));
    await client.executeCommand(login('alice@example.com'));
    await edge.executeCommand('sleep 8');
    expect((await listing(edge))[0]).toContain('\tunknown\t');
  });

  it('a server that never answers is zombie right after the timeout, then dead after zombie_period', async () => {
    const dead = 'home_server dead {\n  ipaddr = 10.0.0.9\n  secret = x\n  response_window = 1\n  zombie_period = 1\n}\n';
    const { client, edge } = await withControl(dead + HOME_POOL().replace('home_server = home1', 'home_server = dead\n  home_server = home1'));
    await client.executeCommand(login('alice@example.com').replace('-r 1', '-r 3 -t 2'));
    expect((await listing(edge)).find((line) => line.startsWith('10.0.0.9\t1812'))).toContain('\tzombie\t');
    await edge.executeCommand('sleep 2');
    expect((await listing(edge)).find((line) => line.startsWith('10.0.0.9\t1812'))).toContain('\tdead\t');
  });

  it('a fail-over pool skips the dead server: the next request is answered without waiting for response_window', async () => {
    const dead = 'home_server dead {\n  ipaddr = 10.0.0.9\n  secret = x\n  response_window = 1\n  zombie_period = 1\n}\n';
    const { client, edge } = await withControl(dead + HOME_POOL().replace('home_server = home1', 'home_server = dead\n  home_server = home1'));
    await client.executeCommand(login('alice@example.com').replace('-r 1', '-r 3 -t 2'));
    await edge.executeCommand('sleep 2');
    const output = await client.executeCommand(`t0=$(date +%s); ${login('alice@example.com')}; t1=$(date +%s); echo elapsed=$((t1-t0))`);
    expect(output).toContain('Access-Accept');
    expect(output).toContain('elapsed=0');
  });

  it('refuses a zombie_period outside its bounds, naming the variable', async () => {
    const { started } = await withControl(HOME_POOL('zombie_period = 0'));
    expect(started).toContain('Invalid value "0" for variable zombie_period');
  });

  it('refuses a ping_interval outside its bounds, naming the variable', async () => {
    const { started } = await withControl(HOME_POOL('ping_interval = 5'));
    expect(started).toContain('Invalid value "5" for variable ping_interval');
  });

  const dead = 'home_server dead {\n  ipaddr = 10.0.0.9\n  secret = x\n  response_window = 1\n}\n';
  const failOver = () => dead + HOME_POOL().replace('home_server = home1', 'home_server = dead\n  home_server = home1');
  const radmin = async (edge: LinuxServer, command: string) => (await edge.executeCommand(`radmin -f ${SOCKET} -e "${command}"`)).trim();

  it('show home_server state prints the state word of the server on that port', async () => {
    const { client, edge } = await withControl(HOME_POOL());
    expect(await radmin(edge, 'show home_server state 10.0.0.3 1812')).toBe('unknown');
    await client.executeCommand(login('alice@example.com'));
    expect(await radmin(edge, 'show home_server state 10.0.0.3 1812')).toBe('alive');
    expect(await radmin(edge, 'show home_server state 10.0.0.3 1813')).toBe('unknown');
  });

  it('answers the source error for a home server that does not exist, and for a bad state', async () => {
    const { edge } = await withControl(HOME_POOL());
    expect(await radmin(edge, 'show home_server state 10.0.0.77 1812')).toBe('ERROR: No such home server - 10.0.0.77 1812');
    expect(await radmin(edge, 'set home_server state 10.0.0.3 1812 sleepy')).toBe("ERROR: Unknown state 'sleepy'");
    expect(await radmin(edge, 'set home_server state 10.0.0.3')).toBe('ERROR: Must specify <ipaddr> <port> [udp|tcp] <state>');
  });

  it('set home_server state dead marks it dead, and alive revives it', async () => {
    const { edge } = await withControl(HOME_POOL());
    await radmin(edge, 'set home_server state 10.0.0.3 1812 dead');
    expect(await radmin(edge, 'show home_server state 10.0.0.3 1812')).toBe('dead');
    await radmin(edge, 'set home_server state 10.0.0.3 1812 alive');
    expect(await radmin(edge, 'show home_server state 10.0.0.3 1812')).toBe('alive');
  });

  it('a server set down is listed down and a fail-over pool skips it at once', async () => {
    const { client, edge } = await withControl(failOver());
    await radmin(edge, 'set home_server state 10.0.0.9 1812 down');
    expect((await listing(edge)).find((line) => line.startsWith('10.0.0.9\t1812'))).toContain('\tdown\t');
    const output = await client.executeCommand(`t0=$(date +%s); ${login('alice@example.com')}; t1=$(date +%s); echo elapsed=$((t1-t0))`);
    expect(output).toContain('Access-Accept');
    expect(output).toContain('elapsed=0');
  });

  it('a down server stays down however long the silence, until it is set alive', async () => {
    const { edge } = await withControl(failOver());
    await radmin(edge, 'set home_server state 10.0.0.9 1812 down');
    await edge.executeCommand('sleep 200');
    expect(await radmin(edge, 'show home_server state 10.0.0.9 1812')).toBe('down');
    await radmin(edge, 'set home_server state 10.0.0.9 1812 alive');
    expect(await radmin(edge, 'show home_server state 10.0.0.9 1812')).toBe('alive');
  });

  it('a socket without mode is read-only: set is refused with the source wording, show still works', async () => {
    const { edge } = await withControl(HOME_POOL(), 'ro');
    expect(await radmin(edge, 'set home_server state 10.0.0.3 1812 dead')).toBe("ERROR: You do not have write permission.  See 'mode = rw' in the 'listen' section for this socket.");
    expect(await radmin(edge, 'show home_server state 10.0.0.3 1812')).toBe('unknown');
  });

  it('the default mode of the shipped control-socket site is read-only too', async () => {
    const made = await lab(HOME_POOL());
    write(made.edge, CONTROL, 'listen {\n  type = control\n  socket = ${run_dir}/${name}.sock\n}\n');
    await made.edge.executeCommand('systemctl restart freeradius');
    expect(await radmin(made.edge, 'set home_server state 10.0.0.3 1812 dead')).toContain('You do not have write permission');
  });

  it('read-write is accepted as a mode name, an unknown mode name is refused', async () => {
    const accepted = await withControl(HOME_POOL(), 'read-write');
    expect(await radmin(accepted.edge, 'set home_server state 10.0.0.3 1812 dead')).toBe('');
    const refused = await lab(HOME_POOL());
    write(refused.edge, CONTROL, 'listen {\n  type = control\n  socket = /tmp/x.sock\n  mode = sometimes\n}\n');
    expect(await refused.edge.executeCommand('systemctl restart freeradius')).toContain("Invalid mode name 'sometimes'");
  });
});
