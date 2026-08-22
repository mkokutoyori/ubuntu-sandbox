import {
  IPAddress, IP_PROTO_ICMP, computeIPv4Checksum,
  type ICMPPacket, type IPv4Packet,
} from '../core/types';

export const ECHO_DATA_BYTES = 56;

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

export function echoReplyOf(packet: IPv4Packet): ICMPPacket | null {
  if (packet.protocol !== IP_PROTO_ICMP) return null;
  const icmp = packet.payload as ICMPPacket | undefined;
  return icmp?.type === 'icmp' && icmp.icmpType === 'echo-reply' ? icmp : null;
}
