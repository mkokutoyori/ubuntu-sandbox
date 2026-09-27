import { unreachableCodeName } from '../../core/IcmpErrors';
import type { ICMPPacket, IPv4Packet } from '../../core/types';
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
