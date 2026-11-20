/*
 * Probe: `radtest alice wonderland localhost 0 testing123`, the first command the FreeRADIUS documentation tells an administrator to type
 * on the server itself, never worked, and a second radtest never got its reply even to a remote server. Measured: the client agents asked
 * the host for a source address to a loopback destination and got none (a loopback has no route, the kernel uses the address itself), so
 * nothing was sent; the server then answered through the frame path, which has no delivery for the machine's own address; and the socket
 * the clients receive on (49999, 49998, 49997) were registered under the names "radtest" and "radclient", the names of the commands that
 * use them, so the machine closed them when such a command ended and the next one waited for a reply that went nowhere (ss -lunp showed
 * the port gone; two radclient acct in a row, or an acct then a status, lost the second answer). The clients now take the destination as their
 * source when it is a loopback address, the server answers a local sender through the host's own UDP path, and the socket is the
 * radclient one that radtest wraps. The default clients.conf has `client localhost { ipaddr = 127.0.0.1 secret = testing123 }`.
 *
 * Discriminated with git stash on src: 5 of 6 fall before the fix; the witness (a remote server answers the first radtest) passes either way.
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
const outcome = (output: string) => output.split('\n').filter((line) => /^Received|No reply/.test(line)).join('|');

async function single() {
  const server = new LinuxServer('linux-server', 'AAA');
  write(server, USERS_FILE_PATH, 'alice Cleartext-Password := "wonderland"\n');
  await server.executeCommand('systemctl reload freeradius');
  return server;
}

describe('radtest on the server itself', () => {
  it('witness: a remote server answers the first radtest', async () => {
    const bus = new EventBus();
    const client = new LinuxServer('linux-server', 'CLIENT');
    const target = new LinuxServer('linux-server', 'TARGET');
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    client.setEventBus(bus); target.setEventBus(bus); sw.setEventBus(bus);
    new Cable('a').connect(client.getPort('eth0')!, sw.getPort('FastEthernet0/1')!);
    new Cable('b').connect(target.getPort('eth0')!, sw.getPort('FastEthernet0/2')!);
    client.configureInterface('eth0', new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
    target.configureInterface('eth0', new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));
    write(target, CLIENTS_CONF_PATH, 'client lab {\n  ipaddr = 10.0.0.1\n  secret = shared\n}\n');
    write(target, USERS_FILE_PATH, 'alice Cleartext-Password := "wonderland"\n');
    await target.executeCommand('systemctl reload freeradius');
    expect(outcome(await client.executeCommand('radtest alice wonderland 10.0.0.2 0 shared'))).toMatch(/^Received Access-Accept/);
  });

  it('radtest to 127.0.0.1 is answered, from and to the loopback address', async () => {
    const server = await single();
    expect(outcome(await server.executeCommand('radtest alice wonderland 127.0.0.1 0 testing123')))
      .toMatch(/^Received Access-Accept Id \d+ from 127\.0\.0\.1:1812 to 127\.0\.0\.1:\d+ length \d+$/);
  });

  it('radtest to localhost is the same, and a wrong password is rejected the same way', async () => {
    const server = await single();
    expect(outcome(await server.executeCommand('radtest alice wonderland localhost 0 testing123'))).toMatch(/^Received Access-Accept/);
    expect(outcome(await server.executeCommand('radtest alice nope localhost 0 testing123'))).toMatch(/^Received Access-Reject/);
  });

  it('three radtest in a row all get their answer, and the receiving socket is still open afterwards', async () => {
    const server = await single();
    for (let round = 0; round < 3; round++) {
      expect(outcome(await server.executeCommand('radtest alice wonderland localhost 0 testing123'))).toMatch(/^Received Access-Accept/);
    }
    expect(await server.executeCommand('ss -lunp | grep 49999')).toContain('49999');
  });

  it('radclient commands in a row, of different kinds, are all answered: the sockets outlive the command that used them', async () => {
    const server = await single();
    const acct = (session: string) => `printf 'User-Name = "alice"\\nAcct-Status-Type = Start\\nAcct-Session-Id = "${session}"\\n' | radclient 127.0.0.1 acct testing123`;
    const auth = `printf 'User-Name = "alice"\\nUser-Password = "wonderland"\\n' | radclient 127.0.0.1 auth testing123`;
    expect(outcome(await server.executeCommand(acct('a1')))).toMatch(/^Received Accounting-Response/);
    expect(outcome(await server.executeCommand(acct('a2')))).toMatch(/^Received Accounting-Response/);
    expect(outcome(await server.executeCommand(auth))).toMatch(/^Received Access-Accept/);
    expect(outcome(await server.executeCommand(auth))).toMatch(/^Received Access-Accept/);
  });

  it('radclient acct and status reach the server on 127.0.0.1 too', async () => {
    const server = await single();
    const acct = await server.executeCommand(`printf 'User-Name = "alice"\\nAcct-Status-Type = Start\\nAcct-Session-Id = "l1"\\n' | radclient 127.0.0.1 acct testing123`);
    expect(outcome(acct)).toMatch(/^Received Accounting-Response/);
    const status = await server.executeCommand(`printf 'Message-Authenticator = 0x00\\n' | radclient 127.0.0.1 status testing123`);
    expect(outcome(status)).toMatch(/^Received Access-Accept/);
  });
});
