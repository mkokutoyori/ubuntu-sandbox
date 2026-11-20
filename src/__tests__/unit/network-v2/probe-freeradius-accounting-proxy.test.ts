/*
 * Probe: an Accounting-Request for a realm was always accounted locally; `acct_pool` of proxy.conf was not read. Source of truth:
 * FreeRADIUS v3.2.x raddb/proxy.conf and src/main/realms.c (acct_pool / accthost), rlm_realm.c in preacct (the suffix module
 * decides the destination realm for accounting with the realm's acct pool; a realm without one is LOCAL for accounting),
 * RFC 2866 §3 (the Request Authenticator is recomputed for the next hop with its shared secret, the Accounting-Response
 * authenticator is recomputed back for the NAS). A proxied request is not accounted on the proxy: its sections run only up to
 * preacct. The Accounting-Request crosses a real UDP exchange to the home server, which records the session under the name it
 * receives (stripped unless nostrip).
 *
 * Discriminated with git stash on src: 7 of 8 fall before the fix, the witness included (proxy.conf with acct_pool is refused, so the
 * daemon does not start); the one passing either way is the realm without acct_pool, which is accounted locally before and after.
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

const start = (user: string, port = 1) =>
  `printf 'User-Name = "${user}"\\nAcct-Status-Type = Start\\nAcct-Session-Id = "s-${port}"\\nNAS-IP-Address = 10.0.0.1\\nNAS-Port = ${port}\\n' | radclient -r 1 10.0.0.2 acct shared`;

describe('accounting through acct_pool', () => {
  it('witness: a name outside any realm is accounted on the edge and answered', async () => {
    const { client, edge } = await lab(HOME_POOL());
    expect(await client.executeCommand(start('bob'))).toContain('Received Accounting-Response');
    expect(await edge.executeCommand('radwho')).toContain('bob');
  });

  it('forwards the Accounting-Request of a realm to the home server and relays its Accounting-Response', async () => {
    const { client } = await lab(HOME_POOL());
    expect(await client.executeCommand(start('alice@example.com'))).toContain('Received Accounting-Response');
  });

  it('the home server records the session under the stripped name and the edge does not account it', async () => {
    const { client, edge, home } = await lab(HOME_POOL());
    await client.executeCommand(start('alice@example.com'));
    const homeWho = await home.executeCommand('radwho');
    expect(homeWho).toContain('alice');
    expect(homeWho).not.toContain('example.com');
    expect(await edge.executeCommand('radwho')).not.toContain('alice');
  });

  it('nostrip sends the full name to the home server', async () => {
    const { client, home } = await lab(HOME_POOL('', '  acct_pool = pool1\n  nostrip\n'));
    await client.executeCommand(start('alice@example.com'));
    expect(await home.executeCommand('radwho')).toContain('alice@example.com');
  });

  it('a realm without acct_pool is LOCAL for accounting: the edge accounts it', async () => {
    const { client, edge, home } = await lab(HOME_POOL('', ''));
    expect(await client.executeCommand(start('alice@example.com'))).toContain('Received Accounting-Response');
    expect(await edge.executeCommand('radwho')).toContain('alice@example.com');
    expect(await home.executeCommand('radwho')).not.toContain('alice');
  });

  it('fail-over: a dead first home server is replaced by the next after response_window', async () => {
    const dead = 'home_server dead {\n  ipaddr = 10.0.0.9\n  secret = x\n  response_window = 1\n}\n';
    const { client, home } = await lab(dead + HOME_POOL().replace('home_server = home1', 'home_server = dead\n  home_server = home1'));
    const output = await client.executeCommand(start('alice@example.com').replace('-r 1', '-r 3 -t 2'));
    expect(output).toContain('Received Accounting-Response');
    expect(await home.executeCommand('radwho')).toContain('alice');
  });

  it('refuses an acct_pool that names no home_server_pool', async () => {
    const { started } = await lab(HOME_POOL('', '  acct_pool = nowhere\n'));
    expect(started).toContain('Failed to find home_server_pool "nowhere"');
  });

  it('refuses a home server of type auth in an acct_pool, naming it', async () => {
    const { started } = await lab(HOME_POOL('type = auth'));
    expect(started).toContain('Home server "home1" of type auth cannot be used in an acct_pool');
  });
});
