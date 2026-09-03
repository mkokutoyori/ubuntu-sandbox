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
}

export function deliverLocally(
  deps: LocalDeliveryDeps, iface: string, packet: IPv4Packet,
): void {
  if (deps.localInVerdict?.(iface, packet) === 'deny') return;

  const ike = deps.ikeDatagram(packet);
  if (ike) { deps.handleIke(iface, packet, ike); return; }
  if (deps.observedBySdwan(packet)) return;
  if (deps.answeredByDnsServer(iface, packet)) return;

  if (packet.protocol === IP_PROTO_TCP) {
    if (deps.admitsTcp(iface, packet)) deps.handleTcp(iface, packet);
    return;
  }
  if (!deps.allowsPing(iface)) return;

  const echo = icmpEchoReply(packet);
  if (echo) deps.reply(iface, echo);
}
