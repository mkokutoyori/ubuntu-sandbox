import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { compileFilter } from '@/network/devices/linux/network/tcpdump/TcpdumpFilter';
import { decodeEthernetFrame } from '@/network/devices/linux/network/tcpdump/CaptureFrame';
import {
  MACAddress, IPAddress, resetCounters,
  ETHERTYPE_IPV4, IP_PROTO_TCP, computeIPv4Checksum,
  type EthernetFrame, type IPv4Packet, type TCPPacket,
} from '@/network/core/types';
import type { TaggedEthernetFrame, Dot1QTag } from '@/network/devices/Switch';
import { Logger } from '@/network/core/Logger';

interface TcpConnector {
  getTcpStack(): {
    connect(ip: string, port: number): unknown;
    listen(port: number, opts: { onAccept: (s: unknown) => void }): void;
  };
}

beforeEach(() => {
  resetCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

function buildTcpFrame(flags: Partial<TCPPacket['flags']>, tag?: Dot1QTag): EthernetFrame {
  const tcp: TCPPacket = {
    type: 'tcp', sourcePort: 1234, destinationPort: 80,
    sequenceNumber: 0, acknowledgementNumber: 0,
    flags: { syn: false, ack: false, fin: false, rst: false, psh: false, urg: false, ...flags },
    windowSize: 65535, checksum: 0, payload: null,
  };
  const ip: IPv4Packet = {
    type: 'ipv4', version: 4, ihl: 5, tos: 0, totalLength: 40,
    identification: 1, flags: 0, fragmentOffset: 0, ttl: 64, protocol: IP_PROTO_TCP,
    headerChecksum: 0, sourceIP: new IPAddress('10.0.0.1'), destinationIP: new IPAddress('10.0.0.2'),
    payload: tcp,
  };
  ip.headerChecksum = computeIPv4Checksum(ip);
  const frame: TaggedEthernetFrame = {
    srcMAC: new MACAddress('aa:bb:cc:dd:ee:01'), dstMAC: new MACAddress('aa:bb:cc:dd:ee:02'),
    etherType: ETHERTYPE_IPV4, payload: ip, dot1q: tag,
  };
  return frame;
}

describe('tcpdump byte-slice + vlan filters (PRD-tcpdump.md P4)', () => {
  it('tcp[tcpflags] & tcp-syn != 0 matches SYN but not a plain ACK', () => {
    const synFrame = decodeEthernetFrame(buildTcpFrame({ syn: true }), 'eth0', 'in', new Date());
    const ackFrame = decodeEthernetFrame(buildTcpFrame({ ack: true }), 'eth0', 'in', new Date());
    const filter = compileFilter(['tcp[tcpflags]', '&', 'tcp-syn', '!=', '0']);
    expect(filter.ok).toBe(true);
    if (!filter.ok) return;
    expect(filter.predicate(synFrame)).toBe(true);
    expect(filter.predicate(ackFrame)).toBe(false);
  });

  it('tcp[tcpflags] == (tcp-syn|tcp-ack) matches a SYN-ACK exactly, not a bare SYN', () => {
    const synAck = decodeEthernetFrame(buildTcpFrame({ syn: true, ack: true }), 'eth0', 'in', new Date());
    const synOnly = decodeEthernetFrame(buildTcpFrame({ syn: true }), 'eth0', 'in', new Date());
    const filter = compileFilter(['tcp[tcpflags]', '==', '(', 'tcp-syn|tcp-ack', ')']);
    expect(filter.ok).toBe(true);
    if (!filter.ok) return;
    expect(filter.predicate(synAck)).toBe(true);
    expect(filter.predicate(synOnly)).toBe(false);
  });

  it('ip[0] == 69 matches a standard IHL=5 IPv4 header', () => {
    const frame = decodeEthernetFrame(buildTcpFrame({ syn: true }), 'eth0', 'in', new Date());
    const filter = compileFilter(['ip[0]', '==', '69']);
    expect(filter.ok).toBe(true);
    if (filter.ok) expect(filter.predicate(frame)).toBe(true);
  });

  it('a real TCP SYN over the wire matches tcp[tcpflags] & tcp-syn != 0', async () => {
    const pc1 = new LinuxPC('PC1', 0, 0);
    const pc2 = new LinuxPC('PC2', 100, 0);
    const sw = new CiscoSwitch('sw-id', 'SW1', 24, 50, 50);
    new Cable('c1').connect(pc1.getPort('eth0')!, sw.getPort('FastEthernet0/1')!);
    new Cable('c2').connect(pc2.getPort('eth0')!, sw.getPort('FastEthernet0/2')!);
    await pc1.executeCommand('ifconfig eth0 10.0.0.1 netmask 255.255.255.0');
    await pc2.executeCommand('ifconfig eth0 10.0.0.2 netmask 255.255.255.0');
    (pc2 as unknown as TcpConnector).getTcpStack().listen(9000, { onAccept: () => {} });

    const pending = pc1.executeCommand('tcpdump -c 1 -nn "tcp[tcpflags] & tcp-syn != 0"');
    await new Promise((resolve) => setTimeout(resolve, 50));
    (pc1 as unknown as TcpConnector).getTcpStack().connect('10.0.0.2', 9000);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const output = await pending;

    expect(output).toContain('Flags [S]');
  });

  it('vlan <id> matches only frames tagged with that id', () => {
    const tagged100 = decodeEthernetFrame(buildTcpFrame({ syn: true }, { tpid: 0x8100, pcp: 0, dei: 0, vid: 100 }), 'eth0', 'in', new Date());
    const tagged200 = decodeEthernetFrame(buildTcpFrame({ syn: true }, { tpid: 0x8100, pcp: 0, dei: 0, vid: 200 }), 'eth0', 'in', new Date());
    const untagged = decodeEthernetFrame(buildTcpFrame({ syn: true }), 'eth0', 'in', new Date());
    const filter = compileFilter(['vlan', '100']);
    expect(filter.ok).toBe(true);
    if (!filter.ok) return;
    expect(filter.predicate(tagged100)).toBe(true);
    expect(filter.predicate(tagged200)).toBe(false);
    expect(filter.predicate(untagged)).toBe(false);
  });

  it('a bare vlan filter (no id) matches any tagged frame', () => {
    const tagged = decodeEthernetFrame(buildTcpFrame({ syn: true }, { tpid: 0x8100, pcp: 0, dei: 0, vid: 50 }), 'eth0', 'in', new Date());
    const untagged = decodeEthernetFrame(buildTcpFrame({ syn: true }), 'eth0', 'in', new Date());
    const filter = compileFilter(['vlan']);
    expect(filter.ok).toBe(true);
    if (!filter.ok) return;
    expect(filter.predicate(tagged)).toBe(true);
    expect(filter.predicate(untagged)).toBe(false);
  });
});
