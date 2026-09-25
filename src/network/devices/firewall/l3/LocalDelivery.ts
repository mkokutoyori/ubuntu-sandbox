import { IP_PROTO_ICMP, IP_PROTO_TCP, type IPv4Packet } from '../../../core/types';
import { icmpEchoReply } from './FirewallEgress';
import type { LocalInVerdict } from '../policy/LocalInPolicy';

export interface LocalDeliveryDeps {
  ikeDatagram(packet: IPv4Packet): unknown;
  handleIke(iface: string, packet: IPv4Packet, datagram: unknown): void;
  observedBySdwan(packet: IPv4Packet): boolean;
  answeredByDnsServer(iface: string, packet: IPv4Packet): boolean;
  snmpListens(packet: IPv4Packet): boolean;
  allowsSnmp(iface: string, packet: IPv4Packet): boolean;
  handleSnmp(iface: string, packet: IPv4Packet): void;
  handleTcp(iface: string, packet: IPv4Packet): void;
  admitsTcp(iface: string, packet: IPv4Packet): boolean;
  allowsPing(iface: string, packet: IPv4Packet): boolean;
  reply(iface: string, packet: IPv4Packet): void;
  localInVerdict?(iface: string, packet: IPv4Packet): LocalInVerdict;
  logLocalIn?(iface: string, packet: IPv4Packet, accepted: boolean): void;
}

export function deliverLocally(
  deps: LocalDeliveryDeps, iface: string, packet: IPv4Packet,
): void {
  if (deps.localInVerdict?.(iface, packet) === 'deny') {
    deps.logLocalIn?.(iface, packet, false);
    return;
  }

  const ike = deps.ikeDatagram(packet);
  if (ike) {
    deps.logLocalIn?.(iface, packet, true);
    deps.handleIke(iface, packet, ike);
    return;
  }
  if (deps.observedBySdwan(packet)) return;
  if (deps.answeredByDnsServer(iface, packet)) {
    deps.logLocalIn?.(iface, packet, true);
    return;
  }

  if (deps.snmpListens(packet)) {
    const admitted = deps.allowsSnmp(iface, packet);
    deps.logLocalIn?.(iface, packet, admitted);
    if (admitted) deps.handleSnmp(iface, packet);
    return;
  }

  if (packet.protocol === IP_PROTO_TCP) {
    const admitted = deps.admitsTcp(iface, packet);
    deps.logLocalIn?.(iface, packet, admitted);
    if (admitted) deps.handleTcp(iface, packet);
    return;
  }

  if (packet.protocol === IP_PROTO_ICMP && !deps.allowsPing(iface, packet)) {
    deps.logLocalIn?.(iface, packet, false);
    return;
  }

  deps.logLocalIn?.(iface, packet, true);
  const echo = icmpEchoReply(packet);
  if (echo) deps.reply(iface, echo);
}
