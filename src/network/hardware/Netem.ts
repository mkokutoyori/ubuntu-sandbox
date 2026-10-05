import { EcnCodepoint } from '@/network/core/IpHeaderFields';
import { carryLineage } from './FrameLineage';
import {
  ETHERTYPE_IPV4, ETHERTYPE_IPV6, computeIPv4Checksum,
  type EthernetFrame, type IPv4Packet, type IPv6Packet,
} from '@/network/core/types';

export interface NetemSpec {
  readonly lossRate: number;
  readonly delayMs: number;
  readonly ecn: boolean;
}

export const NO_NETEM: NetemSpec = { lossRate: 0, delayMs: 0, ecn: false };

export function netemIsActive(spec: NetemSpec | undefined): spec is NetemSpec {
  return spec !== undefined && (spec.lossRate > 0 || spec.delayMs > 0);
}

export function markCongestionExperienced(frame: EthernetFrame): EthernetFrame | null {
  if (frame.etherType === ETHERTYPE_IPV4) {
    const packet = frame.payload as IPv4Packet;
    const ecn = EcnCodepoint.ofField(packet.tos);
    if (!ecn.capable) return null;
    if (ecn.congestionExperienced) return frame;
    const marked: IPv4Packet = { ...packet, tos: packet.tos | EcnCodepoint.CE.bits };
    marked.headerChecksum = computeIPv4Checksum(marked);
    return carried(frame, marked);
  }
  if (frame.etherType === ETHERTYPE_IPV6) {
    const packet = frame.payload as IPv6Packet;
    const ecn = EcnCodepoint.ofField(packet.trafficClass);
    if (!ecn.capable) return null;
    if (ecn.congestionExperienced) return frame;
    const marked: IPv6Packet = { ...packet, trafficClass: packet.trafficClass | EcnCodepoint.CE.bits };
    return carried(frame, marked);
  }
  return null;
}

function carried(frame: EthernetFrame, payload: IPv4Packet | IPv6Packet): EthernetFrame {
  const copy: EthernetFrame = { ...frame, payload };
  carryLineage(frame, copy);
  return copy;
}
