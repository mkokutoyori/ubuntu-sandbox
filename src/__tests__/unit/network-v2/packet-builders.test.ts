import { describe, it, expect, beforeEach } from 'vitest';
import {
  MACAddress, IPAddress, resetCounters,
  verifyIPv4Checksum, IP_PROTO_UDP, ETHERTYPE_IPV4,
  type IPv4Packet, type UDPPacket,
} from '@/network/core/types';
import {
  buildIpv4Frame, buildUdpIpv4Frame, wrapIpv4InEthernet,
} from '@/network/core/packetBuilders';

beforeEach(() => {
  resetCounters();
  MACAddress.resetCounter();
});

const srcMac = new MACAddress('00:11:22:33:44:55');
const dstMac = new MACAddress('01:00:5e:00:00:12');
const srcIp = new IPAddress('10.0.0.1');
const dstIp = new IPAddress('224.0.0.18');

describe('buildIpv4Frame', () => {
  it('produces an Ethernet frame with a checksum-valid IPv4 packet', () => {
    const frame = buildIpv4Frame({
      srcIp, dstIp, srcMac, dstMac,
      protocol: 112, ttl: 255,
      payload: { type: 'vrrp' }, payloadLength: 12,
    });
    expect(frame.etherType).toBe(ETHERTYPE_IPV4);
    expect(frame.srcMAC.toString()).toBe(srcMac.toString());
    expect(frame.dstMAC.toString()).toBe(dstMac.toString());
    const pkt = frame.payload as IPv4Packet;
    expect(pkt.protocol).toBe(112);
    expect(pkt.ttl).toBe(255);
    expect(pkt.totalLength).toBe(20 + 12);
    expect(verifyIPv4Checksum(pkt)).toBe(true);
  });

  it('honors tos and flags overrides', () => {
    const frame = buildIpv4Frame({
      srcIp, dstIp, srcMac, dstMac,
      protocol: 112, ttl: 255,
      payload: null, payloadLength: 0,
      options: { tos: 0xc0, flags: 0 },
    });
    const pkt = frame.payload as IPv4Packet;
    expect(pkt.tos).toBe(0xc0);
    expect(pkt.flags).toBe(0);
    expect(verifyIPv4Checksum(pkt)).toBe(true);
  });

  it('defaults to tos 0 and the DF flag like createIPv4Packet', () => {
    const frame = buildIpv4Frame({
      srcIp, dstIp, srcMac, dstMac,
      protocol: 1, ttl: 64,
      payload: null, payloadLength: 8,
    });
    const pkt = frame.payload as IPv4Packet;
    expect(pkt.tos).toBe(0);
    expect(pkt.flags).toBe(0b010);
  });
});

describe('buildUdpIpv4Frame', () => {
  it('wraps the payload in UDP with correct ports and lengths', () => {
    const frame = buildUdpIpv4Frame({
      srcIp, dstIp, srcMac, dstMac,
      srcPort: 1985, dstPort: 1985,
      payload: { type: 'hsrp' }, payloadLength: 20,
      ttl: 1, options: { flags: 0 },
    });
    const pkt = frame.payload as IPv4Packet;
    expect(pkt.protocol).toBe(IP_PROTO_UDP);
    expect(pkt.ttl).toBe(1);
    const udp = pkt.payload as UDPPacket;
    expect(udp.sourcePort).toBe(1985);
    expect(udp.destinationPort).toBe(1985);
    expect(udp.length).toBe(8 + 20);
    expect(pkt.totalLength).toBe(20 + 8 + 20);
    expect(verifyIPv4Checksum(pkt)).toBe(true);
  });

  it('handles a zero-length payload (UDP header only)', () => {
    const frame = buildUdpIpv4Frame({
      srcIp, dstIp, srcMac, dstMac,
      srcPort: 53, dstPort: 53,
      payload: undefined, payloadLength: 0,
      ttl: 64,
    });
    const pkt = frame.payload as IPv4Packet;
    const udp = pkt.payload as UDPPacket;
    expect(udp.length).toBe(8);
    expect(pkt.totalLength).toBe(28);
  });
});

describe('wrapIpv4InEthernet', () => {
  it('frames an existing packet without mutating it', () => {
    const inner = buildIpv4Frame({
      srcIp, dstIp, srcMac, dstMac,
      protocol: 89, ttl: 1, payload: null, payloadLength: 4,
    }).payload as IPv4Packet;
    const checksum = inner.headerChecksum;
    const frame = wrapIpv4InEthernet(inner, srcMac, dstMac);
    expect(frame.payload).toBe(inner);
    expect(inner.headerChecksum).toBe(checksum);
    expect(frame.etherType).toBe(ETHERTYPE_IPV4);
  });
});
