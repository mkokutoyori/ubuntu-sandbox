import { IP_PROTO_UDP, IPAddress, createIPv4Packet, type IPv4Packet, type UDPPacket } from '../core/types';
import { DHCP_SERVER_PORT } from '../core/WellKnownPorts';
import type { IEventBus } from '../../events/EventBus';
import type { DHCPPacket } from './DHCPPacket';

const MAX_RELAY_HOPS = 16;
const RELAYED_DHCP_BYTES = 300;

export interface DhcpRelayHost {
  readonly deviceId: string;
  hostname(): string;
  bus(): IEventBus;
  interfaceAddress(iface: string): IPAddress | null;
  interfaceOwning(address: string): string | null;
  sendToServer(server: IPAddress, packet: IPv4Packet): boolean;
  broadcastReply(iface: string, reply: DHCPPacket): void;
  relayInformationOption(): boolean;
  countForward(): void;
  countReply(): void;
  countDrop(): void;
}

export function relayDhcpRequest(
  host: DhcpRelayHost, inIface: string, request: DHCPPacket, servers: readonly string[],
): void {
  const inIp = host.interfaceAddress(inIface);
  if (!inIp) return;
  if (request.hops >= MAX_RELAY_HOPS) {
    host.countDrop();
    host.bus().publish({
      topic: 'dhcp.relay.dropped',
      payload: {
        deviceId: host.deviceId, hostname: host.hostname(),
        iface: inIface, reason: 'hops-exceeded', hops: request.hops,
        clientMac: request.chaddr,
      },
    });
    return;
  }
  request.hops++;
  if (request.giaddr === '0.0.0.0') request.giaddr = inIp.toString();
  let option82: { circuitId: string; remoteId: string } | null = null;
  if (host.relayInformationOption()) {
    option82 = { circuitId: inIface, remoteId: host.hostname() };
    request.setOption(82, option82);
  }
  for (const server of servers) {
    const udp: UDPPacket = {
      type: 'udp', sourcePort: DHCP_SERVER_PORT, destinationPort: DHCP_SERVER_PORT,
      length: 8 + RELAYED_DHCP_BYTES, checksum: 0, payload: request,
    };
    host.sendToServer(new IPAddress(server),
      createIPv4Packet(new IPAddress(request.giaddr), new IPAddress(server), IP_PROTO_UDP, 64, udp, 8 + RELAYED_DHCP_BYTES));
  }
  host.countForward();
  host.bus().publish({
    topic: 'dhcp.relay.forwarded',
    payload: {
      deviceId: host.deviceId, hostname: host.hostname(),
      iface: inIface, giaddr: request.giaddr, helpers: [...servers],
      clientMac: request.chaddr, hops: request.hops,
      circuitId: option82?.circuitId ?? null,
      remoteId: option82?.remoteId ?? null,
    },
  });
}

export function relayDhcpReply(host: DhcpRelayHost, reply: DHCPPacket): boolean {
  const iface = host.interfaceOwning(reply.giaddr);
  if (!iface) return false;
  reply.removeOption(82);
  host.broadcastReply(iface, reply);
  host.countReply();
  host.bus().publish({
    topic: 'dhcp.relay.reply-forwarded',
    payload: {
      deviceId: host.deviceId, hostname: host.hostname(),
      iface, clientMac: reply.chaddr, assignedIp: reply.yiaddr,
    },
  });
  return true;
}
