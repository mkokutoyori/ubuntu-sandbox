import type { ICMPType, IPv4Packet } from '../../../core/types';
import { icmpTypeNumber } from '../session/FlowKey';

export interface TransportProbeFields {
  sourcePort?: number;
  destPort?: number;
  icmpType?: number;
  icmpCode?: number;
}

export function transportPorts(packet: IPv4Packet): TransportProbeFields {
  const payload = packet.payload as {
    type?: string; sourcePort?: number; destinationPort?: number;
    icmpType?: ICMPType; code?: number;
  } | null;
  if (payload && (payload.type === 'tcp' || payload.type === 'udp')) {
    return { sourcePort: payload.sourcePort, destPort: payload.destinationPort };
  }
  if (payload?.type === 'icmp' && payload.icmpType !== undefined) {
    return { icmpType: icmpTypeNumber(payload.icmpType), icmpCode: payload.code };
  }
  return {};
}
