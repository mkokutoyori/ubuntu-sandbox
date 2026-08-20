import { IP_PROTO_TCP, type IPv4Packet } from '../../../core/types';
import { icmpEchoReply } from './FirewallEgress';

export interface LocalDeliveryDeps {
  ikeDatagram(packet: IPv4Packet): unknown;
  handleIke(iface: string, packet: IPv4Packet, datagram: unknown): void;
  observedBySdwan(packet: IPv4Packet): boolean;
  handleTcp(iface: string, packet: IPv4Packet): void;
  admitsTcp(iface: string, packet: IPv4Packet): boolean;
  allowsPing(iface: string): boolean;
  reply(iface: string, packet: IPv4Packet): void;
}

export function deliverLocally(
  deps: LocalDeliveryDeps, iface: string, packet: IPv4Packet,
): void {
  const ike = deps.ikeDatagram(packet);
  if (ike) { deps.handleIke(iface, packet, ike); return; }
  if (deps.observedBySdwan(packet)) return;

  if (packet.protocol === IP_PROTO_TCP) {
    if (deps.admitsTcp(iface, packet)) deps.handleTcp(iface, packet);
    return;
  }
  if (!deps.allowsPing(iface)) return;

  const echo = icmpEchoReply(packet);
  if (echo) deps.reply(iface, echo);
}
