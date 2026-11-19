/*
 * Probe: a request from a client absent from clients.conf was dropped without a trace in radius.log. Source of truth: FreeRADIUS
 * v3.2.x src/main/listen.c client_listener_find ("Ignoring request to %s from unknown client %s port %d proto %s", the listener
 * named by common_socket_print: "auth address * port 1812 bound to server default"; one line per second in daemon mode, every
 * packet in debug mode), src/main/log.c (": Error: " prefix), and the order of auth_socket_recv/acct_socket_recv, which look the
 * client up before anything else is checked, so a bad Request Authenticator from an unknown client gives the unknown-client line.
 *
 * Discriminated with git stash on src: 4 of 5 fall before the fix; the witness (a known client writes no such line) passes either way.
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

async function lab(clientIp = '10.0.0.1') {
  const bus = new EventBus();
  const client = new LinuxServer('linux-server', 'CLIENT');
  const target = new LinuxServer('linux-server', 'TARGET');
  const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
  client.setEventBus(bus); target.setEventBus(bus); sw.setEventBus(bus);
  new Cable('a').connect(client.getPort('eth0')!, sw.getPort('FastEthernet0/1')!);
  new Cable('b').connect(target.getPort('eth0')!, sw.getPort('FastEthernet0/2')!);
  client.configureInterface('eth0', new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
  target.configureInterface('eth0', new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));
  write(target, CLIENTS_CONF_PATH, `client lab {\n  ipaddr = ${clientIp}\n  secret = shared\n}\n`);
  write(target, USERS_FILE_PATH, 'alice Cleartext-Password := "wonderland"\n');
  await target.executeCommand('systemctl reload freeradius');
  return { client, target };
}

async function run(server: LinuxServer, command: string) {
  const output = await server.executeCommand(command);
  const code = (await server.executeCommand('echo $?')).trim();
  return { output: output.trim(), code };
}

const LOG = '/var/log/freeradius/radius.log';
const PING = `printf 'Message-Authenticator = 0x00\\n'`;
const unknownLines = (server: LinuxServer) => (vfsOf(server).readFile(LOG) ?? '').split('\n').filter((line) => line.includes('unknown client'));

describe('unknown client', () => {
  it('witness: a known client leaves no unknown-client line', async () => {
    const { client, target } = await lab('10.0.0.1');
    expect(await client.executeCommand(`${PING} | radclient -t 1 -r 1 10.0.0.2 status shared`)).toContain('Received Access-Accept');
    expect(unknownLines(target)).toEqual([]);
  });

  it('an Access-Request from an unknown client writes the listener line of listen.c', async () => {
    const { client, target } = await lab('10.0.0.9');
    await client.executeCommand(`printf 'User-Name = "alice"\\nUser-Password = "wonderland"\\n' | radclient -t 1 -r 1 10.0.0.2 auth shared`);
    expect(unknownLines(target).length).toBeGreaterThan(0);
    expect(unknownLines(target)[0] ?? '').toMatch(/ : Error: Ignoring request to auth address \* port 1812 bound to server default from unknown client 10\.0\.0\.1 port 49999 proto udp$/);
  });

  it('an Accounting-Request names the accounting listener, even with a wrong Request Authenticator in the same packet', async () => {
    const { client, target } = await lab('10.0.0.9');
    await client.executeCommand(`printf 'User-Name = "alice"\\nAcct-Status-Type = Start\\nAcct-Session-Id = "x"\\n' | radclient -t 1 -r 1 10.0.0.2 acct wrong`);
    expect(unknownLines(target)[0]).toContain('Ignoring request to acct address * port 1813 bound to server default from unknown client 10.0.0.1 port 49998 proto udp');
  });

  it('a Status-Server from an unknown client is the same line, not the security warning', async () => {
    const { client, target } = await lab('10.0.0.9');
    await client.executeCommand(`${PING} | radclient -t 1 -r 1 10.0.0.2 status shared`);
    expect(unknownLines(target).length).toBeGreaterThan(0);
    expect(vfsOf(target).readFile(LOG) ?? '').not.toContain('security configuration');
  });

  it('daemon mode prints at most one such line per second: three packets in the same instant, one line', async () => {
    const { client, target } = await lab('10.0.0.9');
    const source = client.getPort('eth0')!.getIPAddress()!;
    const packet = (identifier: number) => ({
      sourcePort: 40000, destinationPort: 1812, length: 28, checksum: 0,
      payload: { type: 'radius', code: 'access-request', identifier, authenticator: '11'.repeat(16), attributes: [] },
    }) as never;
    for (const identifier of [1, 2, 3]) target.getRadiusServer().handleUdp('eth0', source, packet(identifier));
    expect(unknownLines(target)).toHaveLength(1);
  });
});
