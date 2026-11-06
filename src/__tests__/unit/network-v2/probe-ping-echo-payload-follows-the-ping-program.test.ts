/*
 * The data of every ICMP echo was synthesised at capture time as 00 01 02 03... whatever sent it, so a 'tcpdump -XX' of a ping showed
 * a payload no ping program emits. iputils (ping.c / ping_common.c, tag 20221126) fills the data with the byte of its own index
 * (setup(): *p++ = i), then pinger() overwrites the first sizeof(struct timeval) = 16 bytes with the send time (tv_sec then tv_usec,
 * 8 bytes each, little endian) when the data is at least that long: 16 timestamp bytes then 10 11 12 ... 37 for the default 56. Windows
 * ping sends the 32 bytes 'abcdefghijklmnopqrstuvwabcdefghi'. The echo reply carries the data of the request back unchanged (RFC 792).
 * ICMPPacket now carries the sender's data (data?), EndHost.echoPayload is the hook each platform overrides (Linux: iputilsEchoData
 * stamped with the host's wall clock; Windows: windowsEchoData), buildEchoReply copies it, and the capture serialises it as it is.
 *
 * Measured against the commit before (worktree): 3 of the 8 cases fall (the timestamp is absent, two probes carry no distinct timestamps, Windows sends 00 01 02...). The 5 that
 * pass either way: the witness (56 bytes, valid checksum) and four NON-REGRESSIONS whose old synthetic i & 0xff happens to equal the right bytes (0x10 .. 0x37 after the
 * timestamp, the reply echoing the request, -s 8, -s 100): they keep the right bytes right now that the data travels in the packet.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

beforeEach(() => {
  EquipmentRegistry.resetInstance();
  resetCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

interface Echo { readonly type: number; readonly checksumValid: boolean; readonly data: number[] }

function checksum(bytes: number[]): number {
  let sum = 0;
  for (let i = 0; i < bytes.length; i += 2) sum += (bytes[i] << 8) | (bytes[i + 1] ?? 0);
  while (sum >> 16) sum = (sum & 0xffff) + (sum >> 16);
  return ~sum & 0xffff;
}

function echoes(dump: string): Echo[] {
  return dump.split(/\n(?=\d\d:\d\d:\d\d\.\d+ )/).filter((block) => /ICMP echo/.test(block)).map((block) => {
    const hex = [...block.matchAll(/^\s+0x[0-9a-f]{4}:\s+([0-9a-f ]+?)\s{2,}/gm)].map((m) => m[1].replace(/ /g, '')).join('');
    const bytes = hex.match(/../g)!.map((pair) => parseInt(pair, 16));
    const ip = bytes.slice(14);
    ip.length = Math.min(ip.length, (ip[2] << 8) | ip[3]);
    const icmp = ip.slice((ip[0] & 15) * 4);
    return { type: icmp[0], checksumValid: checksum(icmp) === 0, data: icmp.slice(8) };
  });
}

async function capturedPing(client: { executeCommand(c: string): Promise<string> }, server: LinuxServer, command: string): Promise<Echo[]> {
  await server.executeCommand('tcpdump -nn -i eth0 -w /tmp/echo.pcap &');
  await client.executeCommand(command);
  await server.executeCommand('pkill tcpdump');
  return echoes(await server.executeCommand('tcpdump -nn -XX -r /tmp/echo.pcap icmp'));
}

async function lab(): Promise<{ pc: LinuxPC; srv: LinuxServer }> {
  const pc = new LinuxPC('PC1', 0, 0);
  const srv = new LinuxServer('linux-server', 'SRV', 100, 0);
  new Cable('c1').connect(pc.getPort('eth0')!, srv.getPort('eth0')!);
  await pc.executeCommand('sudo ifconfig eth0 10.0.0.1 netmask 255.255.255.0');
  await srv.executeCommand('ifconfig eth0 10.0.0.2 netmask 255.255.255.0');
  return { pc, srv };
}

const sequence = (from: number, to: number): number[] => Array.from({ length: to - from + 1 }, (_, i) => from + i);
const littleEndian = (bytes: number[]): number => bytes.reduceRight((value, byte) => value * 256 + byte, 0);

describe('ICMP echo data as the ping programs send it', () => {
  it('WITNESS: a default ping carries 56 data bytes and a valid checksum', async () => {
    const { pc, srv } = await lab();
    const [request] = await capturedPing(pc, srv, 'ping -c 1 10.0.0.2');
    expect(request.type).toBe(8);
    expect(request.data).toHaveLength(56);
    expect(request.checksumValid).toBe(true);
  });

  it('after the 16-byte timestamp the data runs 0x10 .. 0x37', async () => {
    const { pc, srv } = await lab();
    const [request] = await capturedPing(pc, srv, 'ping -c 1 10.0.0.2');
    expect(request.data.slice(16)).toEqual(sequence(0x10, 0x37));
  });

  it('the first 16 bytes are tv_sec and tv_usec, little endian, close to the capture time', async () => {
    const { pc, srv } = await lab();
    const [request] = await capturedPing(pc, srv, 'ping -c 1 10.0.0.2');
    const seconds = littleEndian(request.data.slice(0, 8));
    const microseconds = littleEndian(request.data.slice(8, 16));
    expect(Math.abs(seconds - Date.now() / 1000)).toBeLessThan(60);
    expect(microseconds).toBeLessThan(1_000_000);
  });

  it('the echo reply carries the data of the request back unchanged', async () => {
    const { pc, srv } = await lab();
    const [request, reply] = await capturedPing(pc, srv, 'ping -c 1 10.0.0.2');
    expect(reply.type).toBe(0);
    expect(reply.data).toEqual(request.data);
    expect(reply.checksumValid).toBe(true);
  });

  it('a request shorter than a timestamp has no timestamp: ping -s 8 sends 00 .. 07', async () => {
    const { pc, srv } = await lab();
    const [request] = await capturedPing(pc, srv, 'ping -c 1 -s 8 10.0.0.2');
    expect(request.data).toEqual(sequence(0, 7));
  });

  it('a longer request keeps counting: ping -s 100 sends the timestamp then 0x10 .. 0x63', async () => {
    const { pc, srv } = await lab();
    const [request] = await capturedPing(pc, srv, 'ping -c 1 -s 100 10.0.0.2');
    expect(request.data).toHaveLength(100);
    expect(request.data.slice(16)).toEqual(sequence(0x10, 0x63));
  });

  it('two probes carry two different timestamps', async () => {
    const { pc, srv } = await lab();
    const requests = (await capturedPing(pc, srv, 'ping -c 2 10.0.0.2')).filter((echo) => echo.type === 8);
    expect(requests).toHaveLength(2);
    expect(requests[0].data.slice(0, 16)).not.toEqual(requests[1].data.slice(0, 16));
  });

  it('Windows ping sends abcdefghijklmnopqrstuvwabcdefghi', async () => {
    const { srv } = await lab();
    const windows = new WindowsPC('windows-pc', 'WIN', 200, 0);
    new Cable('c2').connect(windows.getPort('eth0')!, srv.getPort('eth1')!);
    await srv.executeCommand('ifconfig eth1 10.0.1.2 netmask 255.255.255.0');
    await windows.executeCommand('netsh interface ip set address "Ethernet 0" static 10.0.1.1 255.255.255.0');
    await srv.executeCommand('tcpdump -nn -i eth1 -w /tmp/echo.pcap &');
    await windows.executeCommand('ping -n 1 10.0.1.2');
    await srv.executeCommand('pkill tcpdump');
    const [request] = echoes(await srv.executeCommand('tcpdump -nn -XX -r /tmp/echo.pcap icmp'));
    expect(String.fromCharCode(...request.data)).toBe('abcdefghijklmnopqrstuvwabcdefghi');
  });
});
