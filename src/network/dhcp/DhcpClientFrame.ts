import {
  ETHERTYPE_IPV4, IP_PROTO_UDP, IPAddress, MACAddress,
  type EthernetFrame, type IPv4Packet, type UDPPacket,
} from '../core/types';
import { DHCP_CLIENT_PORT, DHCP_SERVER_PORT } from '../core/WellKnownPorts';
import { buildUdpOverIpv4 } from '../layers/transport/UdpEgress';
import { DHCP_WIRE_BYTES, DHCPPacket } from './DHCPPacket';
import type { DhcpIpEmission, DhcpUnicastTarget } from './types';

export interface DhcpClientAddressing {
  readonly source: IPAddress;
  readonly destination: IPAddress;
  readonly destinationMac: MACAddress | null;
}

export function dhcpClientAddressing(pkt: DHCPPacket, target?: DhcpUnicastTarget): DhcpClientAddressing {
  return {
    source: new IPAddress(pkt.ciaddr),
    destination: new IPAddress(target?.ip ?? '255.255.255.255'),
    destinationMac: target?.mac ? new MACAddress(target.mac) : null,
  };
}

export function dhcpClientPacket(
  pkt: DHCPPacket, target?: DhcpUnicastTarget, emission: DhcpIpEmission = {},
): IPv4Packet {
  const addressing = dhcpClientAddressing(pkt, target);
  return buildUdpOverIpv4(addressing.source, {
    destination: addressing.destination,
    sourcePort: DHCP_CLIENT_PORT, destinationPort: DHCP_SERVER_PORT,
    payload: pkt, payloadBytes: DHCP_WIRE_BYTES,
    dontFragment: false,
    ...(emission.ttl === undefined ? {} : { ttl: emission.ttl }),
    ...(emission.tos === undefined ? {} : { tos: emission.tos }),
  });
}

export function dhcpClientFrame(
  pkt: DHCPPacket, sourceMac: MACAddress, target?: DhcpUnicastTarget, emission: DhcpIpEmission = {},
): EthernetFrame {
  return {
    srcMAC: sourceMac,
    dstMAC: dhcpClientAddressing(pkt, target).destinationMac ?? MACAddress.broadcast(),
    etherType: ETHERTYPE_IPV4,
    payload: dhcpClientPacket(pkt, target, emission),
  };
}

export function isDhcpReplyFor(packet: IPv4Packet, clientMac: MACAddress): boolean {
  if (packet.protocol !== IP_PROTO_UDP) return false;
  const udp = packet.payload as UDPPacket | undefined;
  if (udp?.type !== 'udp' || udp.destinationPort !== DHCP_CLIENT_PORT) return false;
  const message = udp.payload;
  return message instanceof DHCPPacket && message.op === 2
    && message.chaddr.toLowerCase() === clientMac.toString().toLowerCase();
}
