/*
 * Probe: only `suffix` and `ntdomain` could be called as realm modules, `mods-enabled/realm` was not shipped, and its keys were
 * read without being evaluated. Source of truth: FreeRADIUS v3.2.x raddb/mods-available/realm (the five instances: IPASS prefix "/",
 * suffix "@" with return_notfound = no, bangpath prefix "!", realmpercent suffix "%", ntdomain prefix "\\"), rlm_realm.c
 * (every `realm NAME { }` of modules is a module callable by that name; ignore_default, ignore_null, return_notfound), the rule that a
 * name no instance defines is "Failed to find module". An instance defined by the operator is callable like the shipped ones; a key the
 * simulator does not evaluate is refused naming it.
 *
 * Discriminated with git stash on src: 8 of 9 fall before the fix; the one passing either way is the witness that the shipped
 * suffix instance still proxies.
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

async function lab(proxyConf: string, authorizeModule = '', realmModule = '') {
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
  if (realmModule !== '') write(edge, '/etc/freeradius/3.0/mods-enabled/realm', (vfsOf(edge).readFile('/etc/freeradius/3.0/mods-enabled/realm') ?? '') + realmModule);
  if (authorizeModule !== '') write(edge, SITE, (vfsOf(edge).readFile(SITE) ?? '').replace('\tauthorize {\n\t\tpreprocess\n', `\tauthorize {\n\t\tpreprocess\n\t\t${authorizeModule}\n`));
  await home.executeCommand('systemctl restart freeradius');
  const started = await edge.executeCommand('systemctl restart freeradius');
  return { client, edge, home, started };
}

const request = (user: string, password: string) =>
  `printf 'User-Name = "${user}"\\nUser-Password = "${password}"\\n' | radclient -r 1 10.0.0.2 auth shared`;

const login = (user: string) => `printf 'User-Name = "${user}"\\nUser-Password = "wonderland"\\n' | radclient -r 1 10.0.0.2 auth shared`;

describe('realm module instances', () => {
  it('witness: the shipped suffix instance proxies alice@example.com', async () => {
    const { client } = await lab(HOME_POOL());
    expect(await client.executeCommand(login('alice@example.com'))).toContain('Received Access-Accept');
  });

  it('IPASS reads example.com/alice (prefix, "/")', async () => {
    const { client } = await lab(HOME_POOL(), 'IPASS');
    expect(await client.executeCommand(login('example.com/alice'))).toContain('Received Access-Accept');
  });

  it('realmpercent reads alice%example.com (suffix, "%")', async () => {
    const { client } = await lab(HOME_POOL(), 'realmpercent');
    expect(await client.executeCommand(login('alice%%example.com'))).toContain('Received Access-Accept');
  });

  it('bangpath reads example.com!alice (prefix, "!")', async () => {
    const { client } = await lab(HOME_POOL(), 'bangpath');
    expect(await client.executeCommand(login('example.com!alice'))).toContain('Received Access-Accept');
  });

  it('an instance defined by the operator is callable by its name', async () => {
    const { client } = await lab(HOME_POOL(), 'hashrealm', 'realm hashrealm {\n  format = suffix\n  delimiter = "#"\n}\n');
    expect(await client.executeCommand(login('alice#example.com'))).toContain('Received Access-Accept');
  });

  it('a bare realm module is refused unless an instance of that name is defined', async () => {
    expect((await lab(HOME_POOL(), 'realm')).started).toContain('Failed to find module "realm"');
    const { client } = await lab(HOME_POOL(), 'realm', 'realm realm {\n  format = suffix\n  delimiter = "@"\n}\n');
    expect(await client.executeCommand(login('alice@example.com'))).toContain('Received Access-Accept');
  });

  it('return_notfound = yes makes the module answer notfound for an unknown realm; the default answers noop', async () => {
    const strict = await lab(HOME_POOL(), 'strict', 'realm strict {\n  format = suffix\n  delimiter = "@"\n  return_notfound = yes\n}\n');
    const lines: string[] = [];
    strict.edge.followRadiusDebug((line) => lines.push(line.replace(/^\(\d+\) /, '').trim()));
    await strict.client.executeCommand(login('alice@unknown.org'));
    expect(lines).toContain('[strict] = notfound');
    const plain = await lab(HOME_POOL());
    const plainLines: string[] = [];
    plain.edge.followRadiusDebug((line) => plainLines.push(line.replace(/^\(\d+\) /, '').trim()));
    await plain.client.executeCommand(login('alice@unknown.org'));
    expect(plainLines).toContain('[suffix] = noop');
  });

  it('ignore_default = yes does not fall back to the DEFAULT realm', async () => {
    const conf = HOME_POOL() + 'realm DEFAULT {\n  auth_pool = pool1\n}\n';
    const used = await lab(conf);
    expect(await used.client.executeCommand(login('alice@unknown.org'))).toContain('Received Access-Accept');
    const ignored = await lab(conf, '', 'realm suffix {\n  format = suffix\n  delimiter = "@"\n  ignore_default = yes\n}\n');
    expect(await ignored.client.executeCommand(login('alice@unknown.org'))).toContain('Received Access-Reject');
  });

  it('refuses a realm module key it does not evaluate, naming it', async () => {
    const { started } = await lab(HOME_POOL(), '', 'realm odd {\n  format = suffix\n  default_community = x\n}\n');
    expect(started).toContain('The realm module setting "default_community" is not implemented in this simulator');
  });
});

