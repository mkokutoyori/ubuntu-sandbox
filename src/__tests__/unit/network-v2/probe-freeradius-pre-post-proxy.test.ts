/*
 * Probe: the pre-proxy and post-proxy sections of a site were not run: a site that wrote unlang in them was refused, and nothing
 * could rewrite a request on its way to the home server or the reply on its way back. Source of truth: FreeRADIUS v3.2.x
 * raddb/sites-available/default (pre-proxy and post-proxy sections), src/main/process.c (pre-proxy runs once the request is
 * proxied, before it leaves; post-proxy runs on the home server's reply, before it goes back to the NAS; `reject`/`fail` in
 * pre-proxy refuses the request, in post-proxy turns the answer into a reject), doc/unlang/update (the proxy-request and
 * proxy-reply lists). `update proxy-request` edits the outgoing attribute list; `update proxy-reply` edits the relayed reply; the
 * request list is the NAS's and is not touched. An Accounting-Request goes through the same two sections.
 *
 * Discriminated with git stash on src: 7 of 8 fall before the fix (the site is refused); the one passing either way is the witness
 * that an empty pre-proxy and post-proxy leave the proxied exchange as it was.
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

const SITE_FILE = '/etc/freeradius/3.0/sites-available/default';
const login = (user: string, password = 'wonderland') => `printf 'User-Name = "${user}"\\nUser-Password = "${password}"\\n' | radclient -x -r 1 10.0.0.2 auth shared`;

async function withSections(pre: string, post: string) {
  const made = await lab(HOME_POOL());
  const text = vfsOf(made.edge).readFile(SITE_FILE) ?? '';
  write(made.edge, SITE_FILE, text.replace('\tpre-proxy {\n\t}', `\tpre-proxy {\n${pre}\t}`).replace('\tpost-proxy {\n\t}', `\tpost-proxy {\n${post}\t}`));
  const restarted = await made.edge.executeCommand('systemctl restart freeradius');
  return { ...made, restarted };
}
const update = (list: string, pairs: string) => `\t\tupdate ${list} {\n${pairs.split(';').map((pair) => `\t\t\t${pair.trim()}\n`).join('')}\t\t}\n`;

describe('pre-proxy and post-proxy', () => {
  it('witness: empty sections leave the proxied exchange as it was', async () => {
    const { client } = await withSections('', '');
    expect(await client.executeCommand(login('alice@example.com'))).toContain('Received Access-Accept');
  });

  it('update proxy-request adds an attribute the home server receives', async () => {
    const { client, home } = await withSections(update('proxy-request', 'Called-Station-Id := "edge-1"'), '');
    const seen: string[] = [];
    home.followRadiusDebug((line) => seen.push(line));
    await client.executeCommand(login('alice@example.com'));
    expect(seen.some((line) => line.includes('Called-Station-Id = "edge-1"'))).toBe(true);
  });

  it('update proxy-request can rewrite the name: the home server then knows the user', async () => {
    const { client } = await withSections(update('proxy-request', 'User-Name := "alice"'), '');
    expect(await client.executeCommand(login('al@example.com'))).toContain('Received Access-Accept');
  });

  it('a reject in pre-proxy refuses the request: the NAS gets an Access-Reject and the home server sees nothing', async () => {
    const { client, home } = await withSections('\t\treject\n', '');
    const seen: string[] = [];
    home.followRadiusDebug((line) => seen.push(line));
    expect(await client.executeCommand(login('alice@example.com'))).toContain('Access-Reject');
    expect(seen.some((line) => line.includes('Received Access-Request'))).toBe(false);
  });

  it('update proxy-reply adds an attribute to the reply the NAS receives', async () => {
    const { client } = await withSections('', update('proxy-reply', 'Reply-Message := "relayed by edge"'));
    expect(await client.executeCommand(login('alice@example.com'))).toContain('Reply-Message = "relayed by edge"');
  });

  it('a reject in post-proxy turns the home server accept into a reject', async () => {
    const { client } = await withSections('', '\t\treject\n');
    expect(await client.executeCommand(login('alice@example.com'))).toContain('Access-Reject');
  });

  it('the Accounting-Request of a realm goes through pre-proxy too: a reject drops it', async () => {
    const { client } = await withSections('\t\treject\n', '');
    const output = await client.executeCommand(`printf 'User-Name = "alice@example.com"\\nAcct-Status-Type = Start\\nAcct-Session-Id = "s1"\\nNAS-IP-Address = 10.0.0.1\\nNAS-Port = 1\\n' | radclient -r 1 10.0.0.2 acct shared`);
    expect(output).toContain('No reply from server');
  });

  it('the -X trace shows the sections with their update lines', async () => {
    const { client, edge } = await withSections(update('proxy-request', 'Called-Station-Id := "edge-1"'), update('proxy-reply', 'Reply-Message := "x"'));
    const lines: string[] = [];
    edge.followRadiusDebug((line) => lines.push(line.replace(/^\(\d+\) /, '').trim()));
    await client.executeCommand(login('alice@example.com'));
    expect(lines.some((line) => line.startsWith('# Executing section pre-proxy from file'))).toBe(true);
    expect(lines).toContain('&proxy-request:Called-Station-Id := "edge-1"');
    expect(lines).toContain('} # pre-proxy = noop');
    expect(lines.some((line) => line.startsWith('# Executing section post-proxy from file'))).toBe(true);
  });
});

