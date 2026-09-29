import {
  ETHERTYPE_IPV4, IPAddress, MACAddress, type EthernetFrame,
} from '../core/types';
import { DHCP_CLIENT_PORT, DHCP_SERVER_PORT } from '../core/WellKnownPorts';
import { buildUdpOverIpv4 } from '../layers/transport/UdpEgress';
import { DHCP_WIRE_BYTES, type DHCPPacket } from './DHCPPacket';
import type { DhcpReplyRoute } from './DhcpServerExchange';

export interface DhcpLinkDestination {
  readonly address: IPAddress;
  readonly mac: MACAddress;
}

export function dhcpLinkDestination(
  route: Exclude<DhcpReplyRoute, { readonly kind: 'relay' }>, clientMac: string,
): DhcpLinkDestination {
  if (route.kind === 'broadcast') {
    return { address: new IPAddress('255.255.255.255'), mac: MACAddress.broadcast() };
  }
  return { address: new IPAddress(route.address), mac: new MACAddress(clientMac) };
}

export function dhcpServerReplyFrame(
  reply: DHCPPacket, sourceAddress: IPAddress, sourceMac: MACAddress, to: DhcpLinkDestination,
): EthernetFrame {
  return {
    srcMAC: sourceMac,
    dstMAC: to.mac,
    etherType: ETHERTYPE_IPV4,
    payload: buildUdpOverIpv4(sourceAddress, {
      destination: to.address,
      sourcePort: DHCP_SERVER_PORT, destinationPort: DHCP_CLIENT_PORT,
      payload: reply, payloadBytes: DHCP_WIRE_BYTES,
    }),
  };
}
