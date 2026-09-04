import { IP_PROTO_TCP, type IPv4Packet } from '../../../core/types';
import { icmpEchoReply } from './FirewallEgress';
import type { LocalInVerdict } from '../policy/LocalInPolicy';

export interface LocalDeliveryDeps {
  ikeDatagram(packet: IPv4Packet): unknown;
  handleIke(iface: string, packet: IPv4Packet, datagram: unknown): void;
  observedBySdwan(packet: IPv4Packet): boolean;
  answeredByDnsServer(iface: string, packet: IPv4Packet): boolean;
  handleTcp(iface: string, packet: IPv4Packet): void;
  admitsTcp(iface: string, packet: IPv4Packet): boolean;
  allowsPing(iface: string): boolean;
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

  if (packet.protocol === IP_PROTO_TCP) {
    const admitted = deps.admitsTcp(iface, packet);
    deps.logLocalIn?.(iface, packet, admitted);
    if (admitted) deps.handleTcp(iface, packet);
    return;
  }

  const echo = icmpEchoReply(packet);
  if (!deps.allowsPing(iface)) {
    deps.logLocalIn?.(iface, packet, false);
    return;
  }

  deps.logLocalIn?.(iface, packet, true);
  if (echo) deps.reply(iface, echo);
}
