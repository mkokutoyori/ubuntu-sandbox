/*
 * Probe: Proxy-State was neither echoed by the server nor managed by the proxy. Source of truth: RFC 2865 §5.33 (a server MUST copy
 * every Proxy-State of the request into its response, in order) and §2.3 (a proxy appends its own Proxy-State to the request it forwards
 * and removes it again from the reply it relays, the ones that were there before staying), FreeRADIUS v3.2.x src/main/process.c
 * (proxy_state added on forwarding, stripped on the reply). The home server's reply shows what it received; the NAS sees only its own.
 *
 * Discriminated with git stash on src: 3 of 5 fall before the fix; two pass either way and are named: the witness (no Proxy-State in, none out)
 * and the last case, where nothing was added and nothing had to be removed.
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

const state = (value: string) => `Proxy-State = 0x${value}`;
const send = (extra: string) => `printf 'User-Name = "alice@example.com"\\nUser-Password = "wonderland"\\n${extra}' | radclient -x -r 1 10.0.0.2 auth shared`;
const replyPart = (output: string) => output.slice(output.indexOf('Received Access-'));

describe('Proxy-State', () => {
  it('witness: a reply to a request without Proxy-State carries none', async () => {
    const { client } = await lab(HOME_POOL());
    expect(replyPart(await client.executeCommand(send('')))).not.toContain('Proxy-State');
  });

  it('the server echoes the Proxy-State of a request into its Access-Accept', async () => {
    const { client } = await lab(HOME_POOL());
    const output = await client.executeCommand(`printf 'User-Name = "bob"\\nUser-Password = "local"\\nProxy-State = 0xabcd\\n' | radclient -x -r 1 10.0.0.2 auth shared`);
    expect(replyPart(output)).toContain(state('abcd'));
  });

  it('the proxy appends its own Proxy-State after the NAS one in the request the home server receives', async () => {
    const { client, home } = await lab(HOME_POOL());
    const seen: string[] = [];
    home.followRadiusDebug((line) => seen.push(line.replace(/^\(\d+\) /, '').trim()));
    await client.executeCommand(send('Proxy-State = 0xabcd\\n'));
    const received = seen.filter((line) => line.startsWith('Proxy-State = '));
    expect(received.length).toBeGreaterThanOrEqual(2);
    expect(received[0]).toBe(state('abcd'));
    expect(received[1]).not.toBe(state('abcd'));
  });

  it('the reply the NAS gets carries its own Proxy-State once and not the one of the proxy', async () => {
    const { client } = await lab(HOME_POOL());
    const reply = replyPart(await client.executeCommand(send('Proxy-State = 0xabcd\\n')));
    expect(reply.match(/Proxy-State = /g)).toHaveLength(1);
    expect(reply).toContain(state('abcd'));
  });

  it('with no Proxy-State from the NAS the reply carries none: the proxy removed its own', async () => {
    const { client } = await lab(HOME_POOL());
    expect(replyPart(await client.executeCommand(send('')))).not.toContain('Proxy-State');
  });
});
