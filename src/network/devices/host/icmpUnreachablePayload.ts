import { icmpv6UnreachableCodeName, unreachableCodeName } from '../../core/IcmpErrors';
import type { ICMPPacket, ICMPv6Packet, IPv4Packet, IPv6Packet } from '../../core/types';
import type { HostDeviceRef, HostIcmpUnreachablePayload } from './events';

export function icmpUnreachablePayload(
  ref: HostDeviceRef, ipPkt: IPv4Packet, icmp: ICMPPacket,
): HostIcmpUnreachablePayload {
  const original = icmp.originalPacket;
  const transport = original?.payload as { sourcePort?: number; destinationPort?: number } | undefined;
  const timeExceeded = icmp.icmpType === 'time-exceeded';
  return {
    ...ref,
    fromIp: ipPkt.sourceIP.toString(),
    toIp: ipPkt.destinationIP.toString(),
    code: timeExceeded ? 'ttl-exceeded' : unreachableCodeName(icmp.code),
    icmpCode: icmp.code,
    ttl: ipPkt.ttl,
    origProtocol: original?.protocol,
    origDestPort: transport?.destinationPort,
    icmpType: timeExceeded ? 'time-exceeded' : 'destination-unreachable',
    ...(icmp.mtu === undefined ? {} : { mtu: icmp.mtu }),
  };
}

export function icmpv6UnreachablePayload(
  ref: HostDeviceRef, ipv6: IPv6Packet, icmpv6: ICMPv6Packet,
): HostIcmpUnreachablePayload {
  const invoking = icmpv6.invokingPacket;
  const transport = invoking?.payload as { destinationPort?: number } | undefined;
  const timeExceeded = icmpv6.icmpType === 'time-exceeded';
  const code = timeExceeded ? 'ttl-exceeded'
    : icmpv6.icmpType === 'packet-too-big' ? 'frag-needed' : icmpv6UnreachableCodeName(icmpv6.code);
  return {
    ...ref,
    fromIp: ipv6.sourceIP.toString(),
    toIp: ipv6.destinationIP.toString(),
    code,
    icmpCode: icmpv6.code,
    ttl: ipv6.hopLimit,
    origProtocol: invoking?.nextHeader,
    origDestPort: transport?.destinationPort,
    icmpType: timeExceeded ? 'time-exceeded' : 'destination-unreachable',
    ...(icmpv6.mtu === undefined ? {} : { mtu: icmpv6.mtu }),
  };
}
