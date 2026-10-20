import type { LinuxPC } from '@/network/devices/LinuxPC';
import {
  IPAddress, IPv6Address, createIPv4Packet, createIPv6Packet,
  type ICMPPacket, type IPv4Packet, type IPv6Packet,
} from '@/network/core/types';
import { noFlags, type TcpFlags, type TcpSegment } from '@/network/tcp/types';

export interface NatDecision { action: string; address?: string }

export interface NatHooks {
  evaluatePreRouting(inPort: string, packet: IPv4Packet): NatDecision | null;
  evaluateNat(packet: IPv4Packet, inPort: string, outPort: string): NatDecision | null;
  evaluatePreRouting6(inPort: string, packet: IPv6Packet): NatDecision | null;
  firewallAcceptsInboundTcp(srcIP: string, dstIP: string, dstPort: number): 'accept' | 'drop' | 'reject';
}

const withoutRange = (result: (NatDecision & { range?: unknown }) | null): NatDecision | null => {
  if (result === null) return null;
  const { range: _range, ...decision } = result;
  return decision;
};

export const hooksOf = (host: LinuxPC): NatHooks => {
  const raw = host as unknown as NatHooks;
  return {
    evaluatePreRouting: (inPort, packet) => withoutRange(raw.evaluatePreRouting(inPort, packet)),
    evaluateNat: (packet, inPort, outPort) => withoutRange(raw.evaluateNat(packet, inPort, outPort)),
    evaluatePreRouting6: (inPort, packet) => withoutRange(raw.evaluatePreRouting6(inPort, packet)),
    firewallAcceptsInboundTcp: (srcIP, dstIP, dstPort) => raw.firewallAcceptsInboundTcp(srcIP, dstIP, dstPort),
  };
};

export const segment = (flags: Partial<TcpFlags>, destinationPort = 80): TcpSegment => ({
  type: 'tcp', sourcePort: 40000, destinationPort, sequence: 1, acknowledgement: 0, dataOffset: 5,
  flags: { ...noFlags(), ...flags }, window: 64240, checksum: 0, urgentPointer: 0, options: [], payload: undefined,
});

export const tcp4 = (flags: Partial<TcpFlags>, destinationPort = 80): IPv4Packet =>
  createIPv4Packet(new IPAddress('10.0.0.9'), new IPAddress('10.0.0.1'), 6, 64, segment(flags, destinationPort), 20);

export const echo4 = (icmpType: ICMPPacket['icmpType']): IPv4Packet => createIPv4Packet(
  new IPAddress('10.0.0.9'), new IPAddress('10.0.0.1'), 1, 64,
  { type: 'icmp', icmpType, code: 0, id: 7, sequence: 1, dataSize: 56 } as ICMPPacket, 64,
);

export const tcp6 = (flags: Partial<TcpFlags>): IPv6Packet =>
  createIPv6Packet(new IPv6Address('2001:db8::9'), new IPv6Address('2001:db8::1'), 6, 64, segment(flags), 20);
