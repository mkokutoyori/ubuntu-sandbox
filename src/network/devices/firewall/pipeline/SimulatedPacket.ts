import {
  IPAddress,
  IP_PROTO_ICMP,
  IP_PROTO_TCP,
  IP_PROTO_UDP,
  computeIPv4Checksum,
  nextIPv4Id,
  type ICMPPacket,
  type ICMPType,
  type IPv4Packet,
  type TCPPacket,
  type UDPPacket,
} from '../../../core/types';

export type SimulatedProtocol = 'tcp' | 'udp' | 'icmp';

export interface SimulatedFlow {
  readonly protocol: SimulatedProtocol;
  readonly sourceIP: string;
  readonly destinationIP: string;
  readonly sourcePort: number;
  readonly destinationPort: number;
  readonly icmpCode?: number;
  readonly ackOnly?: boolean;
}

export class UnsupportedSimulatedProtocolError extends Error {
  constructor(readonly protocol: string) {
    super(`cannot simulate protocol '${protocol}'`);
    this.name = 'UnsupportedSimulatedProtocolError';
  }
}

const IPV4_HEADER_BYTES = 20;
const TCP_HEADER_BYTES = 20;
const UDP_HEADER_BYTES = 8;
const ICMP_HEADER_BYTES = 8;
const SIMULATED_TTL = 64;

export function buildSimulatedPacket(flow: SimulatedFlow): IPv4Packet {
  const payload = buildPayload(flow);
  const packet: IPv4Packet = {
    type: 'ipv4',
    version: 4,
    ihl: 5,
    tos: 0,
    totalLength: IPV4_HEADER_BYTES + payloadBytes(flow),
    identification: nextIPv4Id(),
    flags: 0,
    fragmentOffset: 0,
    ttl: SIMULATED_TTL,
    protocol: protocolNumber(flow.protocol),
    headerChecksum: 0,
    sourceIP: new IPAddress(flow.sourceIP),
    destinationIP: new IPAddress(flow.destinationIP),
    payload,
  };
  packet.headerChecksum = computeIPv4Checksum(packet);
  return packet;
}

export function protocolNumber(protocol: SimulatedProtocol): number {
  switch (protocol) {
    case 'tcp': return IP_PROTO_TCP;
    case 'udp': return IP_PROTO_UDP;
    case 'icmp': return IP_PROTO_ICMP;
  }
}

export function parseSimulatedProtocol(word: string): SimulatedProtocol {
  const lowered = word.toLowerCase();
  if (lowered === 'tcp' || lowered === 'udp' || lowered === 'icmp') return lowered;
  throw new UnsupportedSimulatedProtocolError(word);
}

function payloadBytes(flow: SimulatedFlow): number {
  switch (flow.protocol) {
    case 'tcp': return TCP_HEADER_BYTES;
    case 'udp': return UDP_HEADER_BYTES;
    case 'icmp': return ICMP_HEADER_BYTES;
  }
}

function buildPayload(flow: SimulatedFlow): TCPPacket | UDPPacket | ICMPPacket {
  switch (flow.protocol) {
    case 'tcp': return simulatedSegment(flow);
    case 'udp': return simulatedDatagram(flow);
    case 'icmp': return simulatedIcmp(flow);
  }
}

function simulatedSegment(flow: SimulatedFlow): TCPPacket {
  return {
    type: 'tcp',
    sourcePort: flow.sourcePort,
    destinationPort: flow.destinationPort,
    sequenceNumber: 0,
    acknowledgementNumber: flow.ackOnly === true ? 1 : 0,
    flags: {
      syn: flow.ackOnly !== true, ack: flow.ackOnly === true,
      fin: false, rst: false, psh: false, urg: false,
    },
    windowSize: 65535,
    checksum: 0,
    payload: null,
  } as TCPPacket;
}

function simulatedDatagram(flow: SimulatedFlow): UDPPacket {
  return {
    type: 'udp',
    sourcePort: flow.sourcePort,
    destinationPort: flow.destinationPort,
    length: UDP_HEADER_BYTES,
    checksum: 0,
    payload: null,
  } as UDPPacket;
}

function simulatedIcmp(flow: SimulatedFlow): ICMPPacket {
  return {
    type: 'icmp',
    icmpType: icmpTypeOf(flow.destinationPort),
    code: flow.icmpCode ?? 0,
    id: flow.sourcePort,
    sequence: 1,
    dataSize: 0,
    payload: null,
  } as ICMPPacket;
}

function icmpTypeOf(numericType: number): ICMPType {
  return numericType === 0 ? 'echo-reply' : 'echo-request';
}
