/*
 * Probe: proxy.conf (home_server, home_server_pool, realm) and the suffix / ntdomain instances of rlm_realm were absent, so only the
 * legacy programmatic addRealm() could proxy. Source of truth: FreeRADIUS v3.2.x raddb/proxy.conf, src/modules/rlm_realm/rlm_realm.c
 * (check_for_realm: format suffix uses the last delimiter, prefix the first; "Looking up realm", "Found realm", "Adding
 * Stripped-User-Name", "Adding Realm", "Proxying request from user X to realm Y", "Authentication realm is LOCAL"; nostrip keeps the
 * name; DEFAULT and regular-expression realms), src/main/realms.c (pool types, missing home_server / secret refusals).
 * The Access-Request is relayed over a real UDP exchange to the home server, which authenticates with its own clients.conf secret.
 * Keys the simulator cannot honour (proto tcp, max_outstanding, ...) are refused naming them, never ignored.
 *
 * Discriminated with git stash on src: the first 10 cases fall before the realm change, the witness included; the fail-over case and the default-site case each fall on the commit before theirs; because proxy.conf is never read
 * and the shipped default site (which now calls suffix after mschap, as the 3.2 site does) refuses nothing but resolves no realm. The witness still proves
 * the lab is sound after the fix: a LOCAL realm authenticates on the edge and the home server is not asked.
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

const HOME_POOL = (extra = '') => `home_server home1 {\n  ipaddr = 10.0.0.3\n  port = 1812\n  secret = homesecret\n  ${extra}\n}\nhome_server_pool pool1 {\n  home_server = home1\n}\nrealm example.com {\n  auth_pool = pool1\n}\nrealm LOCAL {\n}\n`;

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

describe('proxy.conf and the realm modules', () => {
  it('the shipped default site calls suffix after mschap, so no edit of the site is needed to proxy', async () => {
    const { edge } = await lab(HOME_POOL());
    const text = await edge.executeCommand('cat /etc/freeradius/3.0/sites-available/default');
    expect(text.indexOf('\t\tsuffix')).toBeGreaterThan(text.indexOf('\t\tmschap'));
    expect(text.indexOf('\t\tsuffix')).toBeLessThan(text.indexOf('\t\teap'));
  });

  it('witness: a name in the LOCAL realm is authenticated by the edge itself', async () => {
    const { client } = await lab(HOME_POOL());
    expect(await client.executeCommand(request('bob@local.test', 'local'))).toContain('Access-Reject');
    expect(await client.executeCommand(request('bob', 'local'))).toContain('Received Access-Accept');
  });

  it('proxies a user of a realm with an auth_pool to the home server, which answers with its own user table', async () => {
    const { client } = await lab(HOME_POOL());
    expect(await client.executeCommand(request('alice@example.com', 'wonderland'))).toContain('Received Access-Accept');
    expect(await client.executeCommand(request('alice@example.com', 'wrong'))).toContain('Access-Reject');
  });

  it('strips the realm from the name sent to the home server (default), so the home server finds alice', async () => {
    const { client, home } = await lab(HOME_POOL());
    const seen: string[] = [];
    const stop = home.followRadiusDebug((line) => seen.push(line));
    await client.executeCommand(request('alice@example.com', 'wonderland'));
    stop();
    expect(seen.join('\n')).toContain('User-Name = "alice"');
  });

  it('nostrip keeps the full name: the home server does not know alice@example.com', async () => {
    const { client } = await lab(HOME_POOL().replace('auth_pool = pool1', 'auth_pool = pool1\n  nostrip'));
    expect(await client.executeCommand(request('alice@example.com', 'wonderland'))).toContain('Access-Reject');
  });

  it('a realm absent from proxy.conf is not proxied and falls through to the local users file', async () => {
    const { client } = await lab(HOME_POOL());
    expect(await client.executeCommand(request('alice@unknown.org', 'wonderland'))).toContain('Access-Reject');
  });

  it('the ntdomain instance reads DOMAIN\\user with the first backslash as delimiter', async () => {
    const { client } = await lab(HOME_POOL().replace('realm example.com', 'realm EXAMPLE'), 'ntdomain');
    write(client, '/tmp/ntdomain.pkt', 'User-Name = "EXAMPLE\\\\alice"\nUser-Password = "wonderland"\n');
    expect(await client.executeCommand('radclient -r 1 -f /tmp/ntdomain.pkt 10.0.0.2 auth shared')).toContain('Received Access-Accept');
  });

  it('a regular-expression realm matches', async () => {
    const { client } = await lab(HOME_POOL().replace('realm example.com', 'realm ~.*\\.com$'));
    expect(await client.executeCommand(request('alice@anything.com', 'wonderland'))).toContain('Received Access-Accept');
  });

  it('refuses a home_server key the simulator cannot honour, naming it and its line', async () => {
    const { started } = await lab(HOME_POOL('max_outstanding = 5'));
    expect(started).toContain('The home_server setting "max_outstanding" is not implemented in this simulator');
  });

  it('refuses a pool naming an unknown home_server', async () => {
    const { started } = await lab(HOME_POOL().replace('home_server = home1', 'home_server = nowhere'));
    expect(started).toContain('Unknown home_server "nowhere"');
  });

  it('refuses a home_server without a secret', async () => {
    const { started } = await lab(HOME_POOL().replace('secret = homesecret', ''));
    expect(started).toContain('No shared secret defined for home server home1');
  });

  it('fail-over: a home server that never answers is replaced by the next of the pool after response_window', async () => {
    const dead = 'home_server dead {\n  ipaddr = 10.0.0.9\n  secret = x\n  response_window = 1\n}\n';
    const { client } = await lab(dead + HOME_POOL().replace('home_server = home1', 'home_server = dead\n  home_server = home1'));
    expect(await client.executeCommand(`printf 'User-Name = "alice@example.com"\\nUser-Password = "wonderland"\\n' | radclient -r 3 -t 2 10.0.0.2 auth shared`)).toContain('Received Access-Accept');
  });
});
