/*
 * Probe: a home_server written `ipv6addr` (or ipaddr with an IPv6 address) was refused, so a realm could not be proxied to a server reachable
 * over IPv6. Source of truth: FreeRADIUS v3.2.x src/main/realms.c (home_server { ipaddr | ipv4addr | ipv6addr, port, secret ... }; the proxy sends from a
 * socket of the home server's family and the answer comes back to that socket, not to the listener the NAS used). The proxy now sends the
 * request over IPv6 from a proxy socket it binds on an ephemeral port, matches the answer by identifier, authenticator and source, counts it
 * like an IPv4 one (stats home_server, show home_server list, status_check probes), and radmin accepts an IPv6 address for the home server commands.
 * The home server itself is a second simulated machine with an `ipv6addr` listener and an `ipv6addr` client for the proxy. The IPv4 NAS side is unchanged.
 *
 * Discriminated with git stash on src: 5 of 6 fall before the fix; the witness (the same realm proxied to an IPv4 home server) passes either way.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { EventBus } from '@/events/EventBus';
import { MACAddress, IPAddress, IPv6Address, SubnetMask, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import type { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';
import { CLIENTS_CONF_PATH, USERS_FILE_PATH } from '@/network/devices/linux/freeradius/RadiusdService';

beforeEach(() => { resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset(); });

const vfsOf = (server: LinuxServer) => (server as unknown as { executor: { vfs: VirtualFileSystem } }).executor.vfs;
const write = (server: LinuxServer, path: string, content: string) => { vfsOf(server).writeFile(path, content, 0, 0, 0o022); };
const SITE = '/etc/freeradius/3.0/sites-available/default';
const PROXY = '/etc/freeradius/3.0/proxy.conf';



const V6 = `home_server home1 {\n  ipv6addr = fd00::3\n  port = 1812\n  secret = homesecret\n  response_window = 2\n}\nhome_server_pool pool1 {\n  home_server = home1\n}\nrealm example.com {\n  auth_pool = pool1\n  acct_pool = pool1\n}\n`;
const V4 = V6.replace('ipv6addr = fd00::3', 'ipaddr = 10.0.0.3');

async function lab6(proxyConf: string) {
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
  edge.configureIPv6Interface('eth0', new IPv6Address('fd00::2'), 64);
  home.configureIPv6Interface('eth0', new IPv6Address('fd00::3'), 64);
  write(edge, CLIENTS_CONF_PATH, 'client lab {\n  ipaddr = 10.0.0.1\n  secret = shared\n}\n');
  write(edge, USERS_FILE_PATH, 'bob Cleartext-Password := "local"\n');
  write(home, CLIENTS_CONF_PATH, 'client edge6 {\n  ipv6addr = fd00::2\n  secret = homesecret\n}\nclient edge4 {\n  ipaddr = 10.0.0.2\n  secret = homesecret\n}\n');
  write(home, USERS_FILE_PATH, 'alice Cleartext-Password := "wonderland"\n');
  write(home, SITE, (vfsOf(home).readFile(SITE) ?? '').replace('server default {\n', 'server default {\n\tlisten {\n\t\ttype = auth\n\t\tipv6addr = ::\n\t\tport = 1812\n\t}\n'));
  write(edge, PROXY, proxyConf);
  write(edge, '/etc/freeradius/3.0/sites-enabled/control-socket', 'listen {\n  type = control\n  socket = ${run_dir}/${name}.sock\n}\n');
  await home.executeCommand('systemctl restart freeradius');
  const started = await edge.executeCommand('systemctl restart freeradius');
  await edge.executeCommand('ping -6 -c 1 fd00::3');
  return { client, edge, home, started };
}

const login = (user: string, password = 'wonderland') => `printf 'User-Name = "${user}"\\nUser-Password = "${password}"\\n' | radclient -r 1 -t 3 10.0.0.2 auth shared`;
const SOCKET = '/var/run/freeradius/freeradius.sock';

describe('home_server over IPv6', () => {
  it('witness: the same realm proxied to an IPv4 home server is answered', async () => {
    const { client } = await lab6(V4);
    expect(await client.executeCommand(login('alice@example.com'))).toContain('Received Access-Accept');
  });

  it('proxies a realm to an ipv6addr home server and returns its Access-Accept to the IPv4 NAS', async () => {
    const { client, home, started } = await lab6(V6);
    expect(started).not.toContain('Failed');
    expect(await client.executeCommand(login('alice@example.com'))).toContain('Received Access-Accept');
    expect(home.getRadiusServer().clientStatistics('auth', 'fd00::2').requests).toBeGreaterThanOrEqual(1);
  });

  it('returns the home server Access-Reject for a wrong password', async () => {
    const { client } = await lab6(V6);
    expect(await client.executeCommand(login('alice@example.com', 'wrong'))).toContain('Access-Reject');
  });

  it('counts the proxied request in stats home_server, per address and port', async () => {
    const { client, edge } = await lab6(V6);
    await client.executeCommand(login('alice@example.com'));
    const text = (await edge.executeCommand(`radmin -f ${SOCKET} -e "stats home_server fd00::3 1812"`)).trim();
    expect(/^requests\t+(\d+)$/m.exec(text)?.[1]).toBeDefined();
    expect(Number(/^accepts\t+(\d+)$/m.exec(text)?.[1])).toBeGreaterThanOrEqual(1);
  });

  it('show home_server list and state name the IPv6 home server', async () => {
    const { client, edge } = await lab6(V6);
    expect((await edge.executeCommand(`radmin -f ${SOCKET} -e "show home_server list"`)).trim()).toContain('fd00::3\t1812\tudp\tauth+acct');
    expect((await edge.executeCommand(`radmin -f ${SOCKET} -e "show home_server state fd00::3 1812"`)).trim()).toBe('unknown');
    await client.executeCommand(login('alice@example.com'));
    expect((await edge.executeCommand(`radmin -f ${SOCKET} -e "show home_server state fd00::3 1812"`)).trim()).toBe('alive');
  });

  it('refuses an ipv4addr that is an IPv6 address, and an ipv6addr that is IPv4, in the words of the source', async () => {
    expect((await lab6(V6.replace('ipv6addr = fd00::3', 'ipv4addr = fd00::3'))).started).toContain('No valid ipaddr found for home server home1');
    expect((await lab6(V6.replace('ipv6addr = fd00::3', 'ipv6addr = 10.0.0.3'))).started).toContain('No valid ipaddr found for home server home1');
  });
});
