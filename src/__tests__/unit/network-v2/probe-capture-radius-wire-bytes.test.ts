/*
 * Probe: a RADIUS datagram captured on the wire was written as zero bytes of the wrong length (tcpdump -w, then -r, showed
 * `UDP, length 50` over a block of zeros for an Access-Request that radclient reports as 85 bytes). Source of truth: RFC 2865 §3
 * (Code, Identifier, Length, Authenticator, attributes) and src/network/radius/codec.ts, the one RADIUS encoder, which the capture
 * now calls instead of padding: the UDP length is the real packet length + 8, and the first four payload bytes read
 * Code, Identifier and Length of the very packet the client and the server exchanged. The payload that was captured is the one the
 * client printed: its length equals radclient's `length`.
 *
 * Discriminated with git stash on src: 3 of 4 fall before the fix; the one passing either way is the witness that the capture
 * file holds both datagrams of the exchange.
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

async function lab() {
  const bus = new EventBus();
  const client = new LinuxServer('linux-server', 'CLIENT');
  const target = new LinuxServer('linux-server', 'TARGET');
  const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
  for (const device of [client, target, sw]) device.setEventBus(bus);
  new Cable('a').connect(client.getPort('eth0')!, sw.getPort('FastEthernet0/1')!);
  new Cable('b').connect(target.getPort('eth0')!, sw.getPort('FastEthernet0/2')!);
  client.configureInterface('eth0', new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
  target.configureInterface('eth0', new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));
  write(target, CLIENTS_CONF_PATH, 'client lab {\n  ipaddr = 10.0.0.1\n  secret = shared\n}\nclient localhost {\n  ipaddr = 127.0.0.1\n  secret = testing123\n}\n');
  write(target, USERS_FILE_PATH, 'alice Cleartext-Password := "wonderland"\nbob Cleartext-Password := "builder"\n');
  await target.executeCommand('systemctl restart freeradius');
  return { client, target };
}

async function capture() {
  const { client, target } = await lab();
  await target.executeCommand('tcpdump -c 2 -n -i eth0 -w /tmp/r.pcap udp port 1812 &');
  const exchange = await client.executeCommand(`printf 'User-Name = "alice"\\nUser-Password = "wonderland"\\n' | radclient -r 1 10.0.0.2 auth shared`);
  const text = await target.executeCommand('tcpdump -n -r /tmp/r.pcap');
  const hex = await target.executeCommand('tcpdump -nxx -r /tmp/r.pcap');
  return { exchange, text, hex };
}
const lengthOf = (exchange: string, direction: 'Sent' | 'Received') => Number(new RegExp(`${direction} Access-\\w+ Id \\d+ .* length (\\d+)`).exec(exchange)?.[1] ?? NaN);

describe('RADIUS in a capture file', () => {
  it('witness: the capture holds the request and the reply', async () => {
    const { text } = await capture();
    expect(text).toContain('10.0.0.1.49999 > 10.0.0.2.1812: UDP');
    expect(text).toContain('10.0.0.2.1812 > 10.0.0.1.49999: UDP');
  });

  it('the UDP length of each datagram is the length radclient printed for it', async () => {
    const { exchange, text } = await capture();
    expect(text).toContain(`10.0.0.2.1812: UDP, length ${lengthOf(exchange, 'Sent')}`);
    expect(text).toContain(`10.0.0.1.49999: UDP, length ${lengthOf(exchange, 'Received')}`);
  });

  it('the request payload starts with Access-Request (1), the identifier and the packet length', async () => {
    const { exchange, hex } = await capture();
    const bytes = hex.split('\n').filter((line) => /^\s+0x/.test(line)).map((line) => line.replace(/^\s+0x[0-9a-f]+:\s+/, '').replace(/\s+/g, ''));
    const request = bytes.slice(0, Math.ceil(bytes.length / 2)).join('');
    const length = lengthOf(exchange, 'Sent');
    expect(request.slice(84, 92)).toBe(`0101${length.toString(16).padStart(4, '0')}`);
  });

  it('the reply payload starts with Access-Accept (2) and its own length', async () => {
    const { exchange, hex } = await capture();
    const lines = hex.split('\n');
    const second = lines.slice(lines.findIndex((line) => line.includes('10.0.0.2.1812 > 10.0.0.1.49999')));
    const bytes = second.filter((line) => /^\s+0x/.test(line)).map((line) => line.replace(/^\s+0x[0-9a-f]+:\s+/, '').replace(/\s+/g, '')).join('');
    expect(bytes.slice(84, 92)).toBe(`0201${lengthOf(exchange, 'Received').toString(16).padStart(4, '0')}`);
  });
});
