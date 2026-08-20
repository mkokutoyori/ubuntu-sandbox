import {
  ETHERTYPE_ARP, ETHERTYPE_IPV4, IP_PROTO_ICMP, MACAddress, computeIPv4Checksum,
  type ARPPacket, type EthernetFrame, type ICMPPacket, type IPv4Packet,
} from '../../../core/types';

export interface BridgedFrame {
  readonly srcMAC: MACAddress;
  readonly dstMAC: MACAddress;
}

export interface EgressDeps {
  readonly nextHopFor: (iface: string, destination: string) => string | undefined;
  readonly resolvedMac: (ip: string) => MACAddress | undefined;
  readonly buildRequest: (ip: string, iface: string) => ARPPacket | undefined;
  readonly emitArp: (request: ARPPacket, iface: string) => void;
  readonly portMac: (iface: string) => MACAddress;
}

export interface EgressHost {
  nextHopFor(iface: string, destination: string): string | undefined;
  resolvedMac(ip: string): MACAddress | undefined;
  buildRequest(ip: string, iface: string): ARPPacket | undefined;
  portMac(iface: string): MACAddress;
  sendFrame(iface: string, frame: EthernetFrame): void;
}

export function egressDepsOf(host: EgressHost): EgressDeps {
  return {
    nextHopFor: (iface, to) => host.nextHopFor(iface, to),
    resolvedMac: (ip) => host.resolvedMac(ip),
    buildRequest: (ip, iface) => host.buildRequest(ip, iface),
    emitArp: (request, iface) =>
      { host.sendFrame(iface, arpFrame(host.portMac(iface), request)); },
    portMac: (iface) => host.portMac(iface),
  };
}

export function buildEgressFrame(
  deps: EgressDeps, egressPort: string, packet: IPv4Packet,
  gateway?: string, bridged?: BridgedFrame,
): EthernetFrame | null {
  const destination = packet.destinationIP.toString();
  const nextHop = gateway ?? deps.nextHopFor(egressPort, destination) ?? destination;
  const mac = bridged?.dstMAC ?? resolveNextHopMac(deps, nextHop, egressPort);
  if (!mac) return null;

  return {
    srcMAC: bridged?.srcMAC ?? deps.portMac(egressPort),
    dstMAC: mac,
    etherType: ETHERTYPE_IPV4,
    payload: packet,
  };
}

export function resolveNextHopMac(
  deps: EgressDeps, nextHop: string, egressPort: string,
): MACAddress | undefined {
  const known = deps.resolvedMac(nextHop);
  if (known) return known;

  const request = deps.buildRequest(nextHop, egressPort);
  if (!request) return undefined;

  deps.emitArp(request, egressPort);
  return deps.resolvedMac(nextHop);
}

export function arpFrame(source: MACAddress, packet: ARPPacket): EthernetFrame {
  return {
    srcMAC: source,
    dstMAC: packet.operation === 'request' ? MACAddress.broadcast() : packet.targetMAC,
    etherType: ETHERTYPE_ARP,
    payload: packet,
  };
}

export function icmpEchoReply(packet: IPv4Packet): IPv4Packet | null {
  if (packet.protocol !== IP_PROTO_ICMP) return null;

  const icmp = packet.payload as ICMPPacket | undefined;
  if (icmp?.type !== 'icmp' || icmp.icmpType !== 'echo-request') return null;

  const reply: IPv4Packet = {
    ...packet,
    ttl: 64,
    headerChecksum: 0,
    sourceIP: packet.destinationIP,
    destinationIP: packet.sourceIP,
    payload: { ...icmp, icmpType: 'echo-reply' },
  };
  reply.headerChecksum = computeIPv4Checksum(reply);
  return reply;
}
