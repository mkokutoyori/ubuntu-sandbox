import { describe, it, expect, beforeEach } from 'vitest';
import {
  MACAddress, IPAddress, resetCounters,
  verifyIPv4Checksum, IP_PROTO_UDP, ETHERTYPE_IPV4,
  type IPv4Packet, type UDPPacket,
} from '@/network/core/types';
import {
  buildIpv4Frame, wrapIpv4InEthernet,
} from '@/network/layers/internet/InternetLayer';
import { buildUdpOverIpv4 } from '@/network/layers/transport/UdpEgress';

beforeEach(() => {
  resetCounters();
  MACAddress.resetCounter();
});

const sourceMac = new MACAddress('00:11:22:33:44:55');
const destinationMac = new MACAddress('01:00:5e:00:00:12');
const sourceIp = new IPAddress('10.0.0.1');
const destinationIp = new IPAddress('224.0.0.18');

describe('buildIpv4Frame', () => {
  it('produces an Ethernet frame with a checksum-valid IPv4 packet', () => {
    const frame = buildIpv4Frame({
      sourceIp, destinationIp, sourceMac, destinationMac,
      protocol: 112, ttl: 255,
      payload: { type: 'vrrp' }, payloadBytes: 12,
    });
    expect(frame.etherType).toBe(ETHERTYPE_IPV4);
    expect(frame.srcMAC.toString()).toBe(sourceMac.toString());
    expect(frame.dstMAC.toString()).toBe(destinationMac.toString());
    const packet = frame.payload as IPv4Packet;
    expect(packet.protocol).toBe(112);
    expect(packet.ttl).toBe(255);
    expect(packet.totalLength).toBe(20 + 12);
    expect(verifyIPv4Checksum(packet)).toBe(true);
  });

  it('honors tos and flags overrides', () => {
    const frame = buildIpv4Frame({
      sourceIp, destinationIp, sourceMac, destinationMac,
      protocol: 112, ttl: 255,
      payload: null, payloadBytes: 0,
      options: { tos: 0xc0, flags: 0 },
    });
    const packet = frame.payload as IPv4Packet;
    expect(packet.tos).toBe(0xc0);
    expect(packet.flags).toBe(0);
    expect(verifyIPv4Checksum(packet)).toBe(true);
  });

  it('defaults to tos 0 and the DF flag like createIPv4Packet', () => {
    const frame = buildIpv4Frame({
      sourceIp, destinationIp, sourceMac, destinationMac,
      protocol: 1, ttl: 64,
      payload: null, payloadBytes: 8,
    });
    const packet = frame.payload as IPv4Packet;
    expect(packet.tos).toBe(0);
    expect(packet.flags).toBe(0b010);
  });
});

describe('buildUdpOverIpv4', () => {
  it('wraps the payload in UDP with correct ports and lengths', () => {
    const packet = buildUdpOverIpv4(sourceIp, {
      destination: destinationIp,
      sourcePort: 1985, destinationPort: 1985,
      payload: { type: 'hsrp' }, payloadBytes: 20,
      ttl: 1,
    });
    expect(packet.protocol).toBe(IP_PROTO_UDP);
    expect(packet.ttl).toBe(1);
    const udp = packet.payload as UDPPacket;
    expect(udp.sourcePort).toBe(1985);
    expect(udp.destinationPort).toBe(1985);
    expect(udp.length).toBe(8 + 20);
    expect(packet.totalLength).toBe(20 + 8 + 20);
    expect(verifyIPv4Checksum(packet)).toBe(true);
  });

  it('handles a zero-length payload (UDP header only)', () => {
    const packet = buildUdpOverIpv4(sourceIp, {
      destination: destinationIp,
      sourcePort: 53, destinationPort: 53,
      payload: undefined, payloadBytes: 0,
    });
    const udp = packet.payload as UDPPacket;
    expect(udp.length).toBe(8);
    expect(packet.totalLength).toBe(28);
  });

  it('defaults the ttl to 64 and carries an explicit tos', () => {
    const plain = buildUdpOverIpv4(sourceIp, {
      destination: destinationIp,
      sourcePort: 520, destinationPort: 520,
      payload: null, payloadBytes: 4,
    });
    expect(plain.ttl).toBe(64);
    expect(plain.tos).toBe(0);

    const marked = buildUdpOverIpv4(sourceIp, {
      destination: destinationIp,
      sourcePort: 3784, destinationPort: 3784,
      payload: null, payloadBytes: 4,
      ttl: 255, tos: 0xc0,
    });
    expect(marked.ttl).toBe(255);
    expect(marked.tos).toBe(0xc0);
  });
});

describe('wrapIpv4InEthernet', () => {
  it('frames an existing packet without mutating it', () => {
    const inner = buildIpv4Frame({
      sourceIp, destinationIp, sourceMac, destinationMac,
      protocol: 89, ttl: 1, payload: null, payloadBytes: 4,
    }).payload as IPv4Packet;
    const checksum = inner.headerChecksum;
    const frame = wrapIpv4InEthernet(inner, sourceMac, destinationMac);
    expect(frame.payload).toBe(inner);
    expect(inner.headerChecksum).toBe(checksum);
    expect(frame.etherType).toBe(ETHERTYPE_IPV4);
  });
});
