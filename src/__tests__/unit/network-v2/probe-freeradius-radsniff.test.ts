/*
 * Probe: radsniff did not exist. Source of truth: FreeRADIUS v3.2.x src/main/radsniff.c (usage; rs_packet_print_fancy: `<Code> Id <n>
 * <file>:<client>:<port> -> <server>:<port> +<elapsed>` for a request, `<-` and an extra `+<latency>` for its response, the prefix
 * `<time> (<count>) ` of RIDEBUG, `** noreq **` for a response seen without its request; attributes and `Authenticator-Field` from
 * the second verbosity level, -q prints nothing but statistics; rs_time_print, with its 6-digit scaling of the microseconds; the
 * default port 1812 also selects 1813 and 3799) and radsniff.h. It reads capture files written by tcpdump -w, whose RADIUS datagrams
 * carry their real bytes since the capture change: the packets are decoded by the one RADIUS codec, a User-Password is decrypted only with -s.
 * What it does not do (a live capture, -w, -f, statistics, the filters of -r/-R...) is refused naming the limit.
 *
 * Discriminated with git stash on src: 7 of 8 fall before the fix (no radsniff command); the one passing either way is the witness that
 * the capture file holds both datagrams of the exchange.
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

async function sniff(args: string, extra = '') {
  const { client, target } = await lab();
  await target.executeCommand('tcpdump -c 2 -n -i eth0 -w /tmp/r.pcap udp port 1812 &');
  await client.executeCommand(`printf 'User-Name = "alice"\\nUser-Password = "wonderland"\\n' | radclient -r 1 10.0.0.2 auth shared`);
  const text = await target.executeCommand('tcpdump -n -r /tmp/r.pcap');
  const output = await target.executeCommand(`radsniff ${args} -- /tmp/r.pcap${extra}`);
  return { text, output: output.trim(), target };
}

describe('radsniff reading a capture file', () => {
  it('witness: the capture holds the request and the reply', async () => {
    const { text } = await sniff('');
    expect(text).toContain('10.0.0.1.49999 > 10.0.0.2.1812: UDP');
    expect(text).toContain('10.0.0.2.1812 > 10.0.0.1.49999: UDP');
  });

  it('prints the request line: time, count, code, identifier, file, endpoints and elapsed', async () => {
    const { output } = await sniff('');
    expect(output.split('\n')[0]).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{6} \(1\) Access-Request Id 1 \/tmp\/r\.pcap:10\.0\.0\.1:49999 -> 10\.0\.0\.2:1812 \+0\.000$/);
  });

  it('prints the response with <-, the elapsed time and the latency of its request', async () => {
    const { output } = await sniff('');
    expect(output.split('\n')[1]).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{6} \(2\) Access-Accept Id 1 \/tmp\/r\.pcap:10\.0\.0\.1:49999 <- 10\.0\.0\.2:1812 \+0\.\d{3} \+0\.\d{3}$/);
  });

  it('-x prints the attributes, the password decrypted with -s, and the authenticator', async () => {
    const { output } = await sniff('-x -s shared');
    expect(output).toContain('\tUser-Name = "alice"');
    expect(output).toContain('\tUser-Password = "wonderland"');
    expect(output).toMatch(/\tAuthenticator-Field = 0x[0-9a-f]{32}/);
  });

  it('without -s the password is not decrypted', async () => {
    const { output } = await sniff('-x');
    expect(output).toMatch(/\tUser-Password = 0x[0-9a-f]{32}/);
    expect(output).not.toContain('wonderland');
  });

  it('-q prints no exchange, -c 1 stops after the first packet, a port that matches nothing prints nothing', async () => {
    expect((await sniff('-q')).output).toBe('');
    expect((await sniff('-c 1')).output.split('\n')).toHaveLength(1);
    expect((await sniff('-p 1900')).output).toBe('');
  });

  it('refuses a live capture and the options it cannot honour, naming the limit', async () => {
    const { target } = await sniff('');
    expect(await target.executeCommand('radsniff -i eth0')).toContain('radsniff: -i is not implemented in this simulator: a live capture');
    expect(await target.executeCommand('radsniff')).toContain('a live capture is not implemented in this simulator');
    expect(await target.executeCommand('radsniff -w out.pcap -- /tmp/r.pcap')).toContain('-w is not implemented in this simulator: writing packets to a file');
    expect(await target.executeCommand('radsniff -xxxx -- /tmp/r.pcap')).toContain('more than -xx');
  });

  it('answers a file that does not exist, and the version', async () => {
    const { target } = await sniff('');
    expect(await target.executeCommand('radsniff -- /tmp/absent.pcap')).toBe('radsniff: Failed opening /tmp/absent.pcap: No such file or directory');
    expect(await target.executeCommand('radsniff -v')).toBe('radsniff version 3.2.11');
  });
});
