import {
  IPAddress, IP_PROTO_ICMP, computeIPv4Checksum, createIPv4Packet,
  type ICMPPacket, type IPv4Option, type IPv4Packet,
} from '../core/types';
import { reflectRecordRoute, reverseSourceRoute } from '../layers/internet/Ipv4Options';

export const ECHO_DATA_BYTES = 56;

export const IPV4_ICMP_ECHO_OVERHEAD = 28;

export const CISCO_ECHO_DATAGRAM_BYTES = 100;

export function echoDataBytesForDatagram(datagramBytes: number): number {
  return Math.max(IPV4_ICMP_ECHO_OVERHEAD, datagramBytes) - IPV4_ICMP_ECHO_OVERHEAD;
}

export function buildEchoRequest(
  source: string, destination: string,
  identifier: number, sequence: number, dataSize = ECHO_DATA_BYTES,
  ttl = 64,
): IPv4Packet {
  const icmp: ICMPPacket = {
    type: 'icmp', icmpType: 'echo-request', code: 0,
    id: identifier, sequence, dataSize,
  };
  const packet: IPv4Packet = {
    type: 'ipv4', version: 4, ihl: 5, tos: 0,
    totalLength: 20 + 8 + dataSize,
    identification: identifier * 1000 + sequence,
    flags: 0, fragmentOffset: 0, ttl,
    protocol: IP_PROTO_ICMP, headerChecksum: 0,
    sourceIP: new IPAddress(source), destinationIP: new IPAddress(destination),
    payload: icmp,
  };
  packet.headerChecksum = computeIPv4Checksum(packet);
  return packet;
}

export function buildEchoReply(
  request: IPv4Packet, requestIcmp: ICMPPacket, source: IPAddress, ttl: number,
): IPv4Packet {
  const reply: ICMPPacket = {
    type: 'icmp', icmpType: 'echo-reply', code: 0,
    id: requestIcmp.id, sequence: requestIcmp.sequence, dataSize: requestIcmp.dataSize,
  };

  const returnRoute = reverseSourceRoute(request, request.sourceIP);
  const recorded = reflectRecordRoute(request, source);
  const ipOptions: IPv4Option[] = [];
  if (returnRoute) ipOptions.push(returnRoute.option);
  if (recorded) ipOptions.push(recorded);

  return createIPv4Packet(
    source, returnRoute ? returnRoute.firstHop : request.sourceIP,
    IP_PROTO_ICMP, ttl, reply, 8 + requestIcmp.dataSize,
    { flags: request.flags, ...(ipOptions.length > 0 ? { ipOptions } : {}) },
  );
}

export function echoReplyOf(packet: IPv4Packet): ICMPPacket | null {
  if (packet.protocol !== IP_PROTO_ICMP) return null;
  const icmp = packet.payload as ICMPPacket | undefined;
  return icmp?.type === 'icmp' && icmp.icmpType === 'echo-reply' ? icmp : null;
}
