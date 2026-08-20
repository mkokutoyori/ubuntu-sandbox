import { IP_PROTO_ICMP, type IPv4Packet } from '../../../core/types';
import type { FirewallLogFacts } from './SyslogCatalog';
import type { PacketContext } from '../pipeline/PacketContext';
import type { ZoneTable } from '../model/ZoneTable';

export function logFactsOf(context: PacketContext, zones: ZoneTable): FirewallLogFacts {
  const packet = context.originalPacket as IPv4Packet;
  const payload = packet.payload as {
    type?: string; sourcePort?: number; destinationPort?: number;
  } | null;
  const ported = payload?.type === 'tcp' || payload?.type === 'udp';

  return {
    protocol: protocolLabel(packet.protocol),
    ingressZone: zones.zoneOf(context.ingressPort) ?? context.ingressPort,
    egressZone: context.egressPort === undefined
      ? (context.egressZone ?? 'any')
      : zones.zoneOf(context.egressPort) ?? context.egressPort,
    sourceIP: packet.sourceIP.toString(),
    sourcePort: ported ? payload?.sourcePort ?? 0 : 0,
    destinationIP: packet.destinationIP.toString(),
    destinationPort: ported ? payload?.destinationPort ?? 0 : 0,
  };
}

function protocolLabel(protocol: number): string {
  if (protocol === 6) return 'TCP';
  if (protocol === 17) return 'UDP';
  if (protocol === IP_PROTO_ICMP) return 'ICMP';
  return String(protocol);
}
